const CONFIG = {
  API_BASE: 'https://school.mos.ru/api',
  COOKIES: {
    TOKEN: 'aupd_token',
    PROFILE_ID: 'profile_id',
    AID: 'aid',
    SUBSYSTEM_ID: 'subsystem_id'
  },
  STORAGE: {
    AUTH_CONTEXT: 'meshAuthContext',
    LAST_REFRESH: 'meshLastTokenRefresh'
  },
  TOKEN_SOFT_TTL: 5 * 60 * 1000, // 5 минут — после этого пробуем тихо обновить токен
  DELAYS: {
    ABSENCE: 100, // мс между запросами "Без ДЗ"
    KTP: 1000     // мс между действиями КТП
  }
};

const getCookie = (name) => {
  const match = document.cookie.match(`(^|;)\\s*${name}\\s*=\\s*([^;]+)`);
  return match ? decodeURIComponent(match.pop()) : null;
};


function sendLog(message) {
  chrome.runtime.sendMessage({ type: 'log', message: message });
}

function sendError(message) {
  chrome.runtime.sendMessage({ type: 'error', message: message });
}

// --- Кэш авторизационных данных (chrome.storage + web storage fallback) ---
// Куки aupd_token/profile_id/aid/subsystem_id иногда недоступны при чтении
// document.cookie (или "мигают"), что приводит к запросам с пустыми заголовками
// и ошибкам 500/401. Кэшируем последние валидные значения и используем их как
// фолбэк, а также храним время последнего обновления токена.
let _authCache = null;
let _authCacheLoaded = false;
let _lastCookieStoreSync = 0; // троттлинг чтения cookie store через chrome.cookies
const COOKIE_STORE_SYNC_INTERVAL = 2000; // мс

/**
 * Читает значение из localStorage/sessionStorage (значения могут быть
 * обёрнуты в кавычки как JSON-строки).
 */
function readWebStorageValue(key) {
  const stores = [];
  try { stores.push(window.localStorage); } catch (e) { /* ignore */ }
  try { stores.push(window.sessionStorage); } catch (e) { /* ignore */ }
  for (const store of stores) {
    if (!store) continue;
    try {
      const raw = store.getItem(key);
      if (raw != null && raw !== '' && raw !== 'null' && raw !== 'undefined') {
        return raw.replace(/^"|"$/g, '');
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function loadAuthCache() {
  return new Promise((resolve) => {
    if (_authCacheLoaded) {
      resolve(_authCache);
      return;
    }
    try {
      chrome.storage.local.get({ [CONFIG.STORAGE.AUTH_CONTEXT]: null }, (data) => {
        const stored = data[CONFIG.STORAGE.AUTH_CONTEXT];
        if (stored && typeof stored === 'object') {
          _authCache = stored;
        }
        _authCacheLoaded = true;
        resolve(_authCache);
      });
    } catch (e) {
      _authCacheLoaded = true;
      resolve(null);
    }
  });
}

function saveAuthCache(ctx) {
  if (!ctx) return;
  _authCache = Object.assign({}, _authCache, ctx);
  _authCacheLoaded = true;
  try {
    chrome.storage.local.set({ [CONFIG.STORAGE.AUTH_CONTEXT]: _authCache });
  } catch (e) { /* ignore */ }
}

/**
 * Запрашивает авторизационные куки из cookie store браузера через service worker
 * (chrome.cookies). Это надёжнее, чем document.cookie, если кука httpOnly или
 * почему-то не видна из контент-скрипта.
 * @returns {Promise<{token?:string, profileId?:string, aid?:string, subsystemId?:string}>}
 */
function getCookieStoreAuthContext() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getAuthCookies' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.success) {
          resolve({});
          return;
        }
        resolve({
          token: resp.token || undefined,
          profileId: resp.profileId || undefined,
          aid: resp.aid || undefined,
          subsystemId: resp.subsystemId || undefined
        });
      });
    } catch (e) {
      resolve({});
    }
  });
}

/**
 * Просит service worker записать набор авторизационных кук в cookie store
 * и вернуть итоговый контекст. Так «обновлённые» значения реально попадают в
 * куки (access-токен может быть httpOnly/поставлен не туда, где мы его искали).
 * @param {{token?:string, profileId?:string, aid?:string, subsystemId?:string}} ctx
 * @returns {Promise<{success:boolean, written?:number, total?:number, cookies?:object, error?:string}>}
 */
function persistAuthCookies(ctx) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'setAuthCookies', context: ctx }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          resolve({ success: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response' });
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

/**
 * Возвращает актуальный контекст авторизации: приоритет у свежих кук, затем
 * localStorage/sessionStorage, затем кэш в chrome.storage.local.
 * @param {boolean} [syncFromCookieStore] - если true, дополнительно читает куки
 *        через chrome.cookies (набор куки авторизации, а не только токен).
 * @returns {Promise<{token?:string, profileId?:string, aid?:string, subsystemId?:string, tokenAddedAt?:number}>}
 */
async function getAuthContext(syncFromCookieStore = false) {
  await loadAuthCache();

  let fromStore = {};
  if (syncFromCookieStore && (Date.now() - _lastCookieStoreSync > COOKIE_STORE_SYNC_INTERVAL)) {
    _lastCookieStoreSync = Date.now();
    fromStore = await getCookieStoreAuthContext();
  }

  const fromCookies = {
    token: getCookie(CONFIG.COOKIES.TOKEN),
    profileId: getCookie(CONFIG.COOKIES.PROFILE_ID),
    aid: getCookie(CONFIG.COOKIES.AID),
    subsystemId: getCookie(CONFIG.COOKIES.SUBSYSTEM_ID)
  };
  const fromWeb = {
    token: readWebStorageValue('aupd_token'),
    profileId: readWebStorageValue('profile_id'),
    aid: readWebStorageValue('aid'),
    subsystemId: readWebStorageValue('subsystem_id')
  };
  const cached = _authCache || {};
  // tokenOverride имеет наивысший приоритет: это токен, полученный в теле ответа
  // refresh. Пока действует override, НЕ доверяем возможно устаревшей куке/кэшу.
  const overrideActive = cached.tokenOverride && cached.overrideExpiresAt && Date.now() < cached.overrideExpiresAt;
  const overrideToken = overrideActive ? cached.tokenOverride : null;
  const token = overrideToken || fromCookies.token || fromStore.token || fromWeb.token || cached.token || null;
  const merged = {
    token: token,
    profileId: fromCookies.profileId || fromStore.profileId || fromWeb.profileId || cached.profileId || null,
    aid: fromCookies.aid || fromStore.aid || fromWeb.aid || cached.aid || null,
    subsystemId: fromCookies.subsystemId || fromStore.subsystemId || fromWeb.subsystemId || cached.subsystemId || null,
    tokenAddedAt: (token && token !== cached.token) ? Date.now() : (cached.tokenAddedAt || null),
    tokenOverride: overrideToken,
    overrideExpiresAt: overrideActive ? cached.overrideExpiresAt : null
  };
  if (merged.token !== cached.token ||
      merged.profileId !== cached.profileId ||
      merged.aid !== cached.aid ||
      merged.subsystemId !== cached.subsystemId) {
    saveAuthCache(merged);
  }
  return merged;
}

function createHeadersFromContext(ctx) {
  const base = CONFIG.API_BASE.replace('/api', '');
  const headers = {
    'x-mes-subsystem': 'journalw',
    'Content-Type': 'application/json',
    'origin': base,
    'referer': `${base}/`
  };
  // Не отправляем заголовки со значением null — сервер на это отвечает 500.
  if (ctx.token) headers['Authorization'] = `Bearer ${ctx.token}`;
  if (ctx.aid) headers['aid'] = ctx.aid;
  if (ctx.profileId) headers['profile-id'] = ctx.profileId;
  if (ctx.subsystemId) headers['x-mes-hostid'] = ctx.subsystemId;
  return headers;
}

async function getProfileId() {
  const ctx = await getAuthContext();
  return ctx.profileId;
}

/**
 * Пытается получить academic_year_id (aid) из других источников:
 *  1) полезная нагрузка JWT-токена (поля aid/academic_year_id/...)
 *  2) localStorage/sessionStorage (ключи aid/academic_year_id/academicYearId)
 * @param {string} token
 * @returns {string|null}
 */
function deriveAid({ token, webStorage } = {}) {
  // 1) из JWT
  try {
    if (token) {
      const parts = String(token).split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64));
        const candidates = [
          payload.aid, payload.academic_year_id, payload.academicYearId,
          payload.ay_id, payload.academicYear, payload.year_id,
          payload.data && payload.data.aid,
          payload.context && payload.context.aid,
          payload.user && (payload.user.aid || payload.user.academic_year_id)
        ];
        for (const c of candidates) {
          if (c != null && c !== '' && c !== 'null') return String(c);
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 2) из web storage (точные ключи + поиск по ключам, содержащим academic/aid)
  if (webStorage) {
    const keys = ['aid', 'academic_year_id', 'academicYearId', 'academicYearID', 'ay_id'];
    for (const k of keys) {
      const v = readWebStorageValue(k);
      if (v && /^\d+$/.test(v)) return v;
    }

    const stores = [];
    try { stores.push(window.localStorage); } catch (e) { /* ignore */ }
    try { stores.push(window.sessionStorage); } catch (e) { /* ignore */ }
    for (const store of stores) {
      if (!store) continue;
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          if (!/academic|ay_|_aid$|^aid$|year/i.test(key)) continue;
          const raw = store.getItem(key);
          if (!raw) continue;
          // Прямое число или JSON вида {"id": 123}
          if (/^\d+$/.test(raw)) return raw;
          try {
            const parsed = JSON.parse(raw);
            const id = parsed && (parsed.id || parsed.aid || parsed.academic_year_id);
            if (id != null && /^\d+$/.test(String(id))) return String(id);
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

let _aidResolution = null;

/**
 * Определяет aid для текущего контекста:
 *  - из куки/web storage/JWT ([`getAuthContext`](content.js:1) уже пробует куки+web storage);
 *  - если нет — из ответа teacher profile API.
 * Результат кэшируется.
 * @returns {Promise<string|null>}
 */
async function getAid() {
  const ctx = await getAuthContext(true);
  if (ctx.aid) return ctx.aid;

  const fromToken = deriveAid({ token: ctx.token, webStorage: true });
  if (fromToken) {
    saveAuthCache(Object.assign({}, ctx, { aid: fromToken }));
    sendLog(`🆔 aid определён из токена/хранилища: ${fromToken}`);
    return fromToken;
  }

  if (!_aidResolution) {
    _aidResolution = (async () => {
      try {
        const profileId = ctx.profileId;
        if (!profileId) return null;
        const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/teacher_profiles/${profileId}?with_assigned_groups=true&with_replacement_groups=true`;
        const response = await apiFetch(url, { method: 'GET' });
        if (!response.ok) return null;
        const data = await response.json();
        const fromProfile =
          data.academic_year_id || data.current_academic_year_id ||
          (data.academic_year && (data.academic_year.id || data.academic_year)) ||
          (Array.isArray(data.academic_years) && data.academic_years[0] &&
            (data.academic_years[0].id || data.academic_years[0]));
        if (fromProfile) {
          const aid = String(fromProfile);
          const fresh = await getAuthContext(false);
          saveAuthCache(Object.assign({}, fresh, { aid }));
          sendLog(`🆔 aid определён из профиля: ${aid}`);
          return aid;
        }
        sendLog('⚠️ Не удалось определить aid из профиля учителя.');
        return null;
      } catch (e) {
        sendLog('⚠️ Ошибка определения aid из профиля: ' + e.message);
        return null;
      }
    })();
  }
  return await _aidResolution;
}

/**
 * Обновляет токен сессии через first-party эндпоинт school.mos.ru.
 * @returns {Promise<{success:boolean, status?:number, message?:string, error?:string}>}
 */
async function doTokenRefresh() {
  const url = 'https://school.mos.ru/v3/token/refresh';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      'origin': 'https://school.mos.ru',
      'referer': 'https://school.mos.ru/'
    },
    body: null,
    credentials: 'include'
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      status: response.status,
      error: `${response.status} ${response.statusText} ${errorText}`.trim()
    };
  }

  // Иногда новый токен приходит в теле ответа, а не (только) в куке —
  // пробуем достать его оттуда (а также aid/subsystem, если они там есть).
  let fromBody = {};
  try {
    const raw = await response.clone().text();
    if (raw) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      // Возможные обёртки
      const scopes = [parsed,
        parsed && parsed.data,
        parsed && parsed.result,
        parsed && parsed.data && parsed.data.user,
        parsed && parsed.user].filter(Boolean);
      for (const obj of scopes) {
        const token = obj.token || obj.access_token;
        if (token) fromBody.token = token;
        const aid = obj.aid || obj.academic_year_id || obj.academicYearId;
        if (aid != null && aid !== '') fromBody.aid = String(aid);
        const sub = obj.subsystem_id || obj.subsystemId || obj['x-mes-hostid'];
        if (sub != null && sub !== '') fromBody.subsystemId = String(sub);
      }
    }
  } catch (e) { /* ignore */ }

  const now = Date.now();
  const prev = _authCache || {};
  // После обновления токена перечитываем весь набор авторизационных кук
  // (profile_id/aid/subsystem_id тоже могли обновиться).
  const fromStore = {};
  try {
    const store = await getCookieStoreAuthContext();
    Object.assign(fromStore, store);
  } catch (e) { /* ignore */ }
  const cookieToken = getCookie(CONFIG.COOKIES.TOKEN) || fromStore.token || readWebStorageValue('aupd_token') || prev.token || null;
  const effectiveToken = fromBody.token || cookieToken;
  const resolvedAid = fromBody.aid || getCookie(CONFIG.COOKIES.AID) || fromStore.aid ||
    readWebStorageValue('aid') || prev.aid || deriveAid({ token: effectiveToken, webStorage: true }) || null;
  const ctx = {
    token: effectiveToken,
    profileId: getCookie(CONFIG.COOKIES.PROFILE_ID) || fromStore.profileId || readWebStorageValue('profile_id') || prev.profileId || null,
    aid: resolvedAid,
    subsystemId: fromBody.subsystemId || getCookie(CONFIG.COOKIES.SUBSYSTEM_ID) || fromStore.subsystemId || readWebStorageValue('subsystem_id') || prev.subsystemId || null,
    tokenAddedAt: now
  };
  // Если refresh вернул токен в теле, а кука ещё не обновилась — держим токен
  // из тела как override на несколько минут, чтобы не отправить устаревший
  // токен из куки (это и давало 500).
  if (fromBody.token && fromBody.token !== getCookie(CONFIG.COOKIES.TOKEN) && fromBody.token !== fromStore.token) {
    ctx.tokenOverride = fromBody.token;
    ctx.overrideExpiresAt = now + 10 * 60 * 1000;
  } else {
    ctx.tokenOverride = null;
    ctx.overrideExpiresAt = null;
  }
  saveAuthCache(ctx);
  // Токен сменился — сбрасываем кэш определения aid, чтобы он перерезолвился.
  _aidResolution = null;
  try {
    chrome.storage.local.set({ [CONFIG.STORAGE.LAST_REFRESH]: now });
  } catch (e) { /* ignore */ }

  // Активно записываем найденные значения в куки через service worker, чтобы
  // даже httpOnly/кривопутные куки были приведены к рабочему состоянию.
  try {
    const persisted = await persistAuthCookies({
      token: ctx.token,
      profileId: ctx.profileId,
      aid: ctx.aid,
      subsystemId: ctx.subsystemId
    });
    if (persisted && persisted.success) {
      sendLog(`🍪 Куки записаны: ${persisted.written}/${persisted.total}`);
      // После записи обновляем кэш фактическими значениями из cookie store.
      if (persisted.cookies) {
        const fresh = {
          token: persisted.cookies.token || ctx.token,
          profileId: persisted.cookies.profileId || ctx.profileId,
          aid: persisted.cookies.aid || ctx.aid,
          subsystemId: persisted.cookies.subsystemId || ctx.subsystemId,
          tokenAddedAt: now,
          tokenOverride: ctx.tokenOverride,
          overrideExpiresAt: ctx.overrideExpiresAt
        };
        saveAuthCache(fresh);
      }
    } else {
      sendLog('⚠️ Не удалось записать куки: ' + ((persisted && persisted.error) || 'неизвестная ошибка'));
    }
  } catch (e) {
    sendLog('⚠️ Ошибка записи кук: ' + e.message);
  }

  // Диагностика: откуда взяли токен и когда он истекает (по JWT exp).
  const source = fromBody.token ? 'тело ответа' : (getCookie(CONFIG.COOKIES.TOKEN) ? 'кука aupd_token' : (fromStore.token ? 'cookie store' : 'кэш'));
  let expInfo = '';
  try {
    const parts = String(ctx.token).split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload && payload.exp) {
        const expDate = new Date(payload.exp * 1000);
        const minsLeft = Math.round((expDate.getTime() - Date.now()) / 60000);
        expInfo = `, действует ещё ~${minsLeft} мин`;
      }
    }
  } catch (e) { /* ignore */ }
  sendLog(`🔎 Токен (${source})${expInfo}`);

  const missing = !ctx.token || !ctx.profileId || !ctx.aid || !ctx.subsystemId;
  return {
    success: true,
    status: response.status,
    message: 'Токен обновлён' + (missing ? ' (часть кук не найдена)' : '')
  };
}

/**
 * Публичная обёртка обновления токена (логирует в popup).
 */
async function refreshToken() {
  try {
    const result = await doTokenRefresh();
    if (result.success) {
      sendLog('🔑 Токен успешно обновлён');
    } else {
      sendError(`❌ Не удалось обновить токен: ${result.status || ''} ${result.error || ''}`.trim());
    }
    return result;
  } catch (e) {
    sendError(`❌ Ошибка запроса обновления токена: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Универсальная обёртка над fetch для запросов к API МЭШ:
 *  - подставляет актуальные заголовки авторизации (из кук/кэша);
 *  - при истечении мягкого TTL тихо обновляет токен перед запросом;
 *  - при ответе 401/403/500 один раз обновляет токен и повторяет запрос.
 * @param {string} url
 * @param {Object} [options] - { method, body, mode ('journalw'|'teacherspow'), credentials }
 * @returns {Promise<Response>}
 */
async function apiFetch(url, options = {}) {
  const mode = options.mode || 'journalw';
  const init = {
    method: options.method || 'GET',
    credentials: options.credentials || 'include'
  };
  if (options.body !== undefined) {
    init.body = options.body;
  }

  const buildHeaders = async (syncFromStore) => {
    const ctx = await getAuthContext(syncFromStore);
    const headers = createHeadersFromContext(ctx);
    if (mode === 'teacherspow') {
      headers['x-mes-subsystem'] = 'teacherspow';
    }
    return headers;
  };

  // Мягкое проактивное обновление токена (с перечитыванием набора кук авторизации).
  const ctxBefore = await getAuthContext(true);
  if (ctxBefore.tokenAddedAt && (Date.now() - ctxBefore.tokenAddedAt > CONFIG.TOKEN_SOFT_TTL)) {
    await doTokenRefresh().catch(() => { /* ignore */ });
  }

  init.headers = await buildHeaders(false);
  let response = await fetch(url, init);

  if (response.status === 401 || response.status === 403 || response.status === 500) {
    const refreshed = await doTokenRefresh().catch(() => ({ success: false }));
    if (refreshed && refreshed.success) {
      // После refresh берём куки напрямую из cookie store (в обход троттлинга),
      // чтобы повторить запрос уже с обновлённым токеном.
      _lastCookieStoreSync = Date.now();
      init.headers = await buildHeaders(true);
      response = await fetch(url, init);
    }
  }

  // Диагностика: какой именно запрос упал и что ответил сервер.
  if (!response.ok && response.status >= 400) {
    logFailedResponse(init.method, url, response, init.headers);
  }
  return response;
}

/**
 * Краткая сводка авторизационных заголовков (без полного токена).
 */
function summarizeAuthHeaders(headers) {
  try {
    const h = headers || {};
    const auth = h['Authorization'] || '';
    const tokenLen = auth ? auth.replace('Bearer ', '').length : 0;
    return `aid=${h['aid'] ?? '—'}, profile-id=${h['profile-id'] ?? '—'}, hostid=${h['x-mes-hostid'] ?? '—'}, subsystem=${h['x-mes-subsystem'] ?? '—'}, token=${tokenLen ? tokenLen + ' симв.' : 'НЕТ'}`;
  } catch (e) {
    return '';
  }
}

/**
 * Логирует в popup метод, URL и тело ответа для ошибочного запроса.
 * Не потребляет исходный ответ (использует clone).
 */
function logFailedResponse(method, url, response, headers) {
  try {
    const shortUrl = String(url).replace(CONFIG.API_BASE, '');
    const headerInfo = summarizeAuthHeaders(headers);
    response.clone().text().then((text) => {
      const snippet = (text || '').slice(0, 400);
      const msg = `❌ ${method} ${shortUrl} → HTTP ${response.status} ${response.statusText}` + (snippet ? ` — ${snippet}` : '') + `\n   ↳ ${headerInfo}`;
      sendLog(msg);
      console.warn('[МЫШЬ]', msg);
    }).catch(() => {
      const msg = `❌ ${method} ${shortUrl} → HTTP ${response.status} ${response.statusText}\n   ↳ ${headerInfo}`;
      sendLog(msg);
      console.warn('[МЫШЬ]', msg);
    });
  } catch (e) { /* ignore */ }
}

async function setHomeworkAbsences(groupId, absenceDate) {
  const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/homework_absences`;
  const profileId = await getProfileId();
  const payload = {
    group_id: groupId,
    date: absenceDate,
    created_by: profileId ? profileId.toString() : null
  };

  try {
    const response = await apiFetch(url, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      sendLog(`✅ Absence set for group ${groupId} on ${absenceDate}`);
      return await response.json();
    } else {
      //sendError(`❌ Error for group ${groupId}: ${response.status} ${response.statusText}`);
      return { error: response.statusText, status: response.status };
    }
  } catch (e) {
    //sendError(`❌ Request failed: ${e}`);
    return { error: e.message };
  }
}

async function getGroups() {
  const profileId = await getProfileId();
  const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/teacher_profiles/${profileId}?with_assigned_groups=true&with_replacement_groups=true`;
  try {
    const response = await apiFetch(url, { method: 'GET' });
    if (response.ok) {
      const data = await response.json();

      // Попутно кэшируем aid (academic_year_id) из профиля, если кука отсутствует.
      const fromProfile =
        data.academic_year_id || data.current_academic_year_id ||
        (data.academic_year && (data.academic_year.id || data.academic_year)) ||
        (Array.isArray(data.academic_years) && data.academic_years[0] &&
          (data.academic_years[0].id || data.academic_years[0]));
      if (fromProfile) {
        const aid = String(fromProfile);
        const ctx = await getAuthContext(false);
        if (ctx.aid !== aid) {
          saveAuthCache(Object.assign({}, ctx, { aid }));
          sendLog(`🆔 aid закэширован из профиля: ${aid}`);
        }
      }

      return data.assigned_group_ids || [];
    } else {
      sendError('Failed to get groups');
      return [];
    }
  } catch (e) {
    sendError(`Error fetching groups: ${e}`);
    return [];
  }
}

/**
 * Определяет текущий учебный период и год
 * @returns {Object|null} { year, startMonth, endMonth } или null, если август (промежуток)
 */
function getCurrentAcademicPeriod() {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // JS: 0-11 → 1-12
  
  // Период 1: 01.09.xxxx — 31.12.xxxx
  if (currentMonth >= 8 && currentMonth <= 12) {
    return {
      year: currentYear,
      startMonth: 9,
      endMonth: 12,
      startDay: 1,
      endDay: 31
    };
  }
  
  // Период 2: 01.01.xxxx — 31.07.xxxx
  if (currentMonth >= 1 && currentMonth <= 7) {
    return {
      year: currentYear,
      startMonth: 1,
      endMonth: 7,
      startDay: 1,
      endDay: 31
    };
  }
  
  // Август — промежуток между периодами
  // Можно вернуть предыдущий период, следующий или null
  return null;
}

/**
 * Получает количество дней в месяце для указанного года
 */
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month: 1-12
}

async function main() {
  const auth = await getAuthContext(true);
  if (!auth.token || !auth.profileId) {
    sendError('Перезайдите в учетную запись МЭШ.');
  }
  sendLog('Starting to set homework absences...');
  const groups = await getGroups();
  sendLog('Groups: ' + JSON.stringify(groups));

  const period = getCurrentAcademicPeriod();

    if (period) {
        sendLog(`📅 Обработка периода: ${period.startMonth}-${period.endMonth} / ${period.year}`);
        let current = 0;
        const total = groups.length * (period.endMonth - period.startMonth + 1) * 31; // Максимум 31 день в месяце
        sendProgress(0);
        for (const group of groups) {
            sendLog(`👥 Группа: ${group}`);
            
            for (let month = period.startMonth; month <= period.endMonth; month++) {
            const daysInMonth = getDaysInMonth(period.year, month);
            const startDay = (month === period.startMonth) ? period.startDay : 1;
            const endDay = (month === period.endMonth) ? period.endDay : daysInMonth;
            
            for (let day = startDay; day <= endDay; day++) {
                const absenceDate = `${day.toString().padStart(2, '0')}.${month.toString().padStart(2, '0')}.${period.year}`;
                
                try {
                await setHomeworkAbsences(group, absenceDate);
                // Небольшая задержка, чтобы не перегружать сервер
                await new Promise(resolve => setTimeout(resolve, 100));
                  current++;
                  sendProgress((current / total) * 100);
                } catch (error) {
                  current++;
                  sendProgress((current / total) * 100);
                //sendError(`❌ Ошибка для ${absenceDate}: ${error.message}`);
                }
            }
            }
        }
    }
    sendProgress(100);
}

/**
 * Завершает календарный план (вызывает /finish)
 * @param {number|string} journal - ID журнала (по умолчанию 209819)
 * @returns {Promise<Response>} - Ответ от сервера
 */
async function calendarPlans(journal, finistOrRecalc = 'finish') {
   //  'recalc' в зависимости от нужного действия
  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/calendar_plans/${journal}/${finistOrRecalc}?ignore_IA=true`;
  
  try {
    const response = await apiFetch(url, { method: 'POST' });
    
    sendLog('Calendar plans response: ' + response.status);
    return response;
    
  } catch (error) {
    sendError(`❌ Ошибка в calendarPlans(${journal}): ${error.message}`);
  }
}

/**
 * Получает ID календарных планов для групп
 * @param {Array<number|string>} groups - Массив ID групп
 * @returns {Promise<Array<number>>} - Массив ID календарей
 */
async function getAcademicYear(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    sendError('❌ Не удалось получить список групп (проверьте авторизацию/токен).');
    throw new Error('Нет доступных групп (пустой список). Возможно, токен ещё не применён — нажмите «⟳ Токен» и перезагрузите страницу.');
  }
  // Преобразуем массив в строку "1,2,3"
  const groupsStr = groups.map(String).join(',');
  const aid = await getAid();
  
  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/calendar_plans?academic_year_id=${aid}&group_ids=${groupsStr}`;
  
  try {
    const response = await apiFetch(url, { method: 'GET' });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const arrCalendars = await response.json();
    const arrCalIds = arrCalendars.map(cal => cal.id);
    
    sendLog('Calendar IDs: ' + JSON.stringify(arrCalIds));
    return arrCalIds;
    
  } catch (error) {
    sendError('❌ Ошибка при получении календарных планов: ' + error.message);
    throw error; // Пробрасываем ошибку выше для обработки
  }
}

async function syncKTP() {
  const auth = await getAuthContext(true);
  if (!auth.token || !auth.profileId) {
    sendError('Перезайдите в учетную запись МЭШ.');
  }
  sendLog('Starting to set homework absences...');
  const groups = await getGroups();
  sendLog('Groups: ' + JSON.stringify(groups));

  const academPlans = await getAcademicYear(groups);
  sendLog(`📋 Найдено календарей: ${academPlans.length}`);
  let current = 0;
  const total = academPlans.length;
  sendProgress(0);
  for(const calc of academPlans){
    try{
        await calendarPlans(calc);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await calendarPlans(calc, 'recalc');
        current++;
        sendProgress((current / total) * 100  );
        sendLog(`✅ Календарь ${calc} обработан успешно`);
    }catch(error){
      current++;
      sendProgress((current / total) * 100);
        sendError(`❌ Ошибка при синхронизации KTP для календарного плана ${calc}: ${error.message}`);
    }

  }
  sendProgress(100);

}

async function selectGroups() {
  const auth = await getAuthContext(true);
  if (!auth.token || !auth.profileId) {
    sendError('Перезайдите в учетную запись МЭШ.');
  }
  const groups = await getGroups();
  if (!Array.isArray(groups) || groups.length === 0) {
    sendError('❌ Не удалось получить список групп (проверьте авторизацию/токен).');
    throw new Error('Нет доступных групп (пустой список). Возможно, токен ещё не применён — нажмите «⟳ Токен» и перезагрузите страницу.');
  }
  const groupsStr = groups.map(String).join(',');
  // aid не всегда лежит в куке — резолвим его (токен/профиль).
  const aid = auth.aid || await getAid();
  if (!aid) {
    throw new Error('Не удалось определить academic_year_id (aid). Перезайдите в МЭШ и нажмите «⟳ Токен».');
  }
  const url = CONFIG.API_BASE + '/profeducation/plan/teacher/v1/groups' +
    '?academic_year_id=' + aid +
    '&group_ids=' + groupsStr +
    '&with_periods_schedule_id=true' +
    '&with_parallel_curriculum_id=true' +
    '&with_lesson_plans_info=true';
  try {
    const response = await apiFetch(url, { method: 'GET' });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const subjects = await response.json();

    return subjects;
    
  } catch (error) {
    sendError('Ошибка: ' + error.message);
    throw error; // Пробрасываем ошибку выше для обработки
  }
}

let _CONTROL_FORM_ID = null;
let _GRADE_SYSTEM_ID = null;
let _COURSE_LESSON_TOPIC_ID = null;
function formatDateForApi(dateString) {
  if (!dateString) {
    return null;
  }
  const [year, month, day] = dateString.split('-');
  if (!year || !month || !day) {
    return null;
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function setDefaultForMarks(group_id, subject_id, classlevel_id, student_ids, use_lesson_date_range = false, lesson_date_from = '', lesson_date_to = '') {
  try {
    const auth = await getAuthContext(true);
    if (!auth.token || !auth.profileId) {
      sendError('Перезайдите в учетную запись МЭШ.');
    }
    const period = getCurrentAcademicPeriod();
    dateFrom = period ? `${period.startDay.toString().padStart(2, '0')}.${period.startMonth.toString().padStart(2, '0')}.${period.year}` : null;
    dateTo = period ? `${period.endDay.toString().padStart(2, '0')}.${period.endMonth.toString().padStart(2, '0')}.${period.year}` : null;
    const urlmarks = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/marks?` +
      `group_ids=${group_id}&` +
      `subject_id=${subject_id}&` +
      
      `created_at_from=${dateFrom}&` +
      `created_at_to=${dateTo}&` 
    const response = await apiFetch(urlmarks, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    const obj = data[0]; // Берём первый элемент массива, как в оригинале

    
    _CONTROL_FORM_ID = obj.control_form_id;
    _GRADE_SYSTEM_ID = obj.grade_system_id;
    const courselevelvalue = obj.course_lesson_topic_id;
    _COURSE_LESSON_TOPIC_ID = (courselevelvalue !== "null" && courselevelvalue != null) 
      ? courselevelvalue 
      : null;
    const averageMarks = await getAverageMarks(group_id, subject_id, student_ids);
    const lessonsIds = await getLessons(group_id, subject_id, {
      useDateRange: use_lesson_date_range,
      from: lesson_date_from,
      to: lesson_date_to
    });

    return {
      controlFormId: _CONTROL_FORM_ID,
      gradeSystemId: _GRADE_SYSTEM_ID,
      courseLessonTopicId: _COURSE_LESSON_TOPIC_ID,
      averageMarks: averageMarks,
      lessonsIds: lessonsIds
    };
  }catch(error){
    sendError('Error in setMark: ' + error.message);
    throw error; 
  }

}

async function getLessons(group_id, subject_id, options = {}){
  const auth = await getAuthContext();
  const aid = auth.aid || await getAid();
  const period = getCurrentAcademicPeriod();
  let dateFrom = period ? `${period.year}-${period.startMonth.toString().padStart(2, '0')}-${period.startDay.toString().padStart(2, '0')}` : null;
  let dateTo = period ? `${period.year}-${period.endMonth.toString().padStart(2, '0')}-${period.endDay.toString().padStart(2, '0')}` : null;

  if (options.useDateRange && options.from && options.to) {
    const customFrom = formatDateForApi(options.from);
    const customTo = formatDateForApi(options.to);

    if (customFrom && customTo) {
      if (new Date(customFrom) <= new Date(customTo)) {
        dateFrom = customFrom;
        dateTo = customTo;
      } else {
        sendError('Дата "От" должна быть меньше или равна дате "До". Используется стандартный период.');
      }
    }
  }

  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/schedule_items?` +
      `academic_year_id=${aid}&` +
      `group_ids=${group_id}&` +
      `subject_id=${subject_id}&` +
      `teacher_id=${auth.profileId}&` +
      `from=${dateFrom}&` +
      `to=${dateTo}&` +
      `with_group_class_subject_info=true&` +
      `with_course_calendar_info=true&` +
      `with_lesson_info=true&` +
      `with_rooms_info=true&` +
      `with_availability_info=true&`;

  const response = await apiFetch(url, { method: 'GET' });
  if (!response.ok) {
    console.error(`❌ Error getting lessons: HTTP ${response.status} ${response.statusText}`);
    return [];
  }
  const data = await response.json();
  const lessonIds = [];
    
    if (Array.isArray(data)) {
      for (const item of data) {
        const lessonId = item.id;
        if (lessonId != null) {
          lessonIds.push(Number(lessonId));
        }
      }
    }

    console.log(`📚 Получено ${lessonIds.length} уроков:`, lessonIds);
    return lessonIds;
}

async function getAverageMarks(group_id, subject_id, student_ids, defaultMark = 0) {
  try{
    const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/average_marks_year?group_ids=${group_id}&student_profile_ids=${student_ids}&subject_id=${subject_id}`;
    const response = await apiFetch(url, { method: 'GET' });
    const allStudentIds = student_ids
        .split(',')
        .map(id => id.trim())
        .filter(id => id)
        .map(id => Number(id));
    const data = await response.json();
    const marksMap = new Map();
      if (Array.isArray(data)) {
        const markField = `average_mark_five`;
        for (const item of data) {
          const rawMark = item[markField];
          const hasMark = rawMark != null && rawMark !== '';
          marksMap.set(item.student_id, {
            average_mark: hasMark ? Number(rawMark) : defaultMark,
            has_mark: hasMark
          });
        }
      }
    const result = allStudentIds.map(id => {
        const markData = marksMap.get(id);
        return {
          student_id: id,
          average_mark: markData ? markData.average_mark : defaultMark,
          has_mark: markData ? markData.has_mark : false
        };
      });
    return result;
  }catch(error){
    sendError('Error in getAverageMarks: ' + error.message);
    throw error; 
  }
  
}
function randomizeMark(mark) {
  mark = Math.round(mark)
  if (mark === 5) return Math.random() < 0.2 ? 4 : 5;
  if (Math.random() >= 0.2) return mark;
  
  const delta = Math.random() < 0.5 ? -1 : 1;
  const candidate = mark + delta;
  return (candidate >= 1 && candidate <= 5) ? candidate : mark;
}

/**
 * Создаёт/добавляет домашнее задание для группы через API
 * @param {Object} params - Параметры домашнего задания
 * @param {number|string} params.group_id - ID группы
 * @param {number|string} params.subject_id - ID предмета
 * @param {number|string} params.teacher_id - ID учителя (profile_id)
 * @param {string} params.student_ids - Строка ID учеников через запятую
 * @param {string} params.description - Описание домашнего задания
 * @param {number|string} params.duration - Длительность в минутах
 * @param {string} params.date_assigned_on - Дата выдачи (ДД.ММ.ГГГГ)
 * @param {string} params.date_prepared_for - Дата сдачи (ДД.ММ.ГГГГ)
 * @returns {Promise<Object>} - Результат от сервера
 */
async function addHomework({ group_id, subject_id, teacher_id, student_ids, description, duration, date_assigned_on, date_prepared_for }) {
  const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/homeworks`;

  // Если teacher_id не передан (null), берём из кэша/куки profile_id
  const auth = await getAuthContext();
  const effectiveTeacherId = teacher_id || auth.profileId;

  const payload = {
    group_id: Number(group_id),
    teacher_id: Number(effectiveTeacherId),
    date_assigned_on: date_assigned_on,
    date_prepared_for: date_prepared_for,
    subject_id: Number(subject_id),
    homework_entries_attributes: [{
      description: description,
      duration: Number(duration),
      attachment_ids: [],
      attachments: [],
      scripts: null,
      student_ids: student_ids
        .split(',')
        .map(id => Number(id.trim()))
        .filter(id => !isNaN(id) && id > 0)
    }]
  };

  try {
    sendLog(`📝 Добавление ДЗ: группа=${group_id}, предмет=${subject_id}, дата=${date_assigned_on}`);
    const response = await apiFetch(url, {
      method: 'POST',
      mode: 'teacherspow',
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      sendLog(`✅ ДЗ успешно добавлено для группы ${group_id}`);
      return { success: true, result };
    } else {
      const errorText = await response.text();
      sendError(`❌ Ошибка при добавлении ДЗ: ${response.status} ${response.statusText} — ${errorText}`);
      return { success: false, error: errorText, status: response.status };
    }
  } catch (e) {
    sendError(`❌ Ошибка запроса ДЗ: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Массовое добавление ДЗ на указанный диапазон дат для всех групп.
 * @param {Object} params
 * @param {string} params.description - Описание ДЗ
 * @param {string} params.date_from - Начало диапазона (ДД.ММ.ГГГГ)
 * @param {string} params.date_to - Конец диапазона (ДД.ММ.ГГГГ)
 */
async function addHomeworkForPeriod({ description, date_from, date_to }) {
  const authForPeriod = await getAuthContext();
  if (!authForPeriod.token || !authForPeriod.profileId || !authForPeriod.aid || !authForPeriod.subsystemId) {
    sendError('Перезайдите в учетную запись МЭШ.');
    return;
  }

  sendLog('📚 Начинаю массовое добавление ДЗ...');

  const groupIds = await getGroups();
  sendLog('👥 Группы (ID): ' + JSON.stringify(groupIds));

  if (!groupIds || groupIds.length === 0) {
    sendError('Нет доступных групп.');
    return;
  }

  const detailedGroups = await selectGroups();
  sendLog('📋 Детальная информация по группам: получено ' + (detailedGroups?.length || 0));

  const groupMap = new Map();
  if (Array.isArray(detailedGroups)) {
    for (const g of detailedGroups) {
      groupMap.set(Number(g.id), {
        subject_id: g.subject_id,
        student_ids: Array.isArray(g.student_ids) ? g.student_ids.join(',') : '',
        name: g.name || ''
      });
    }
  }

  const teacher_id = authForPeriod.profileId;
  const DURATION = 15; // фиксированная длительность 15 минут

  // Парсим date_from и date_to (формат ДД.ММ.ГГГГ)
  const parseDate = (str) => {
    const [d, m, y] = str.split('.');
    return new Date(Number(y), Number(m) - 1, Number(d));
  };

  const startDate = parseDate(date_from);
  const endDate = parseDate(date_to);

  if (isNaN(startDate) || isNaN(endDate)) {
    sendError('❌ Неверный формат дат.');
    return;
  }

  if (startDate > endDate) {
    sendError('❌ Дата начала больше даты окончания.');
    return;
  }

  // Собираем все даты в диапазоне
  const dates = [];
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    dates.push(`${currentDate.getDate().toString().padStart(2, '0')}.${(currentDate.getMonth() + 1).toString().padStart(2, '0')}.${currentDate.getFullYear()}`);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const total = groupIds.length * dates.length;
  let progressCount = 0;
  sendProgress(0);

  for (const groupId of groupIds) {
    const groupInfo = groupMap.get(Number(groupId));
    if (!groupInfo || !groupInfo.subject_id || !groupInfo.student_ids) {
      sendLog(`⚠️ Пропускаю группу ${groupId}: нет данных о предмете или студентах`);
      continue;
    }

    sendLog(`👥 Группа: ${groupId} (${groupInfo.name}), предмет: ${groupInfo.subject_id}`);

    for (const dateStr of dates) {
      try {
        const result = await addHomework({
          group_id: groupId,
          subject_id: groupInfo.subject_id,
          teacher_id: teacher_id,
          student_ids: groupInfo.student_ids,
          description: description,
          duration: DURATION,
          date_assigned_on: dateStr,        // дата выдачи = каждый день из диапазона
          date_prepared_for: dateStr        // дата сдачи = та же дата (как в оригинальном примере)
        });

        progressCount++;
        sendProgress((progressCount / total) * 100);

        if (!result.success) {
          sendLog(`⚠️ Ошибка для группы ${groupId} на ${dateStr}: ${result.error || result.status}`);
        }
      } catch (error) {
        progressCount++;
        sendProgress((progressCount / total) * 100);
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  sendProgress(100);
  sendLog('✅ Массовое добавление ДЗ завершено!');
}

/**
 * Материал по умолчанию, который добавляется ко всем занятиям
 * в основной фиче без галочек.
 */
const DEFAULT_MATERIAL = {
  uuid: '15a55adf-5096-5627-ab95-d616d55b016f',
  original_uuid: '6b061b7c-b94f-43ca-8140-eb1e766da214',
  name: 'Материалы занятия:\nhttps://metanit.com/\nhttps://www.freecodecamp.org/\nhttp://labex.io/'
};

/**
 * Получает занятия с их структурой (lesson_plan_id/module_id/topic_id/lesson_id),
 * необходимой для добавления материалов.
 * @param {Object} params
 * @param {string} params.group_id - ID группы
 * @param {string} params.subject_id - ID предмета
 * @param {string} params.date_from - Начало (ДД.ММ.ГГГГ)
 * @param {string} params.date_to - Конец (ДД.ММ.ГГГГ)
 * @returns {Promise<Array<Object>>} - Массив занятий
 */
async function getLessonsWithStructure({ group_id, subject_id, date_from, date_to }) {
  const auth = await getAuthContext();
  const aid = auth.aid || await getAid();
  const from = formatDateForApi(date_from.split('.').reverse().join('-'));
  const to = formatDateForApi(date_to.split('.').reverse().join('-'));

  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/schedule_items?` +
    `academic_year_id=${aid}&` +
    `group_ids=${group_id}&` +
    `subject_id=${subject_id}&` +
    `teacher_id=${auth.profileId}&` +
    `from=${from}&` +
    `to=${to}&` +
    `with_group_class_subject_info=true&` +
    `with_course_calendar_info=true&` +
    `with_lesson_info=true&` +
    `with_rooms_info=true&` +
    `with_availability_info=true&`;

  try {
    const response = await apiFetch(url, { method: 'GET' });
    if (!response.ok) {
      sendError(`❌ Не удалось получить занятия: HTTP ${response.status} ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(item => item && item.lesson_plan_id && item.module_id && item.topic_id && item.lesson_id)
      .map(item => ({
        lesson_plan_id: item.lesson_plan_id,
        module_id: item.module_id,
        topic_id: item.topic_id,
        lesson_id: item.lesson_id,
        lesson_name: item.lesson_name || '',
        date: Array.isArray(item.date) ? item.date.join('-') : ''
      }));
  } catch (e) {
    sendError(`❌ Ошибка при получении занятий: ${e.message}`);
    return [];
  }
}

/**
 * Получает полный объект занятия (GET).
 * @returns {Promise<Object>} - объект занятия как отдаёт сервер
 */
async function fetchLesson(lessonPlanId, moduleId, topicId, lessonId) {
  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/lesson_plans/${lessonPlanId}/modules/${moduleId}/topics/${topicId}/lessons/${lessonId}`;
  const response = await apiFetch(url, { method: 'GET', mode: 'teacherspow' });
  if (!response.ok) {
    throw new Error(`GET lesson HTTP ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

/**
 * Строит JSON-строку scripts, объединяя уже прикреплённые материалы с новыми.
 * @param {Object} lesson - полный объект занятия от GET
 * @param {Array<{uuid:string, original_uuid:string}>} materials
 * @returns {string|null}
 */
function mergeScripts(lesson, materials) {
  let scripts = [];
  if (lesson && lesson.scripts) {
    try {
      const parsed = JSON.parse(lesson.scripts);
      if (Array.isArray(parsed)) scripts = parsed;
    } catch (e) {
      scripts = [];
    }
  }

  const existing = new Set(scripts.map(s => s && s.uuid).filter(Boolean));
  for (const m of materials) {
    if (!m || !m.uuid || existing.has(m.uuid)) continue;
    existing.add(m.uuid);
    scripts.push({
      uuid: m.uuid,
      original_uuid: m.original_uuid || m.uuid,
      learningTargets: { forLesson: true, forHome: false },
      isHiddenFromStudents: false
    });
  }

  if (scripts.length === 0) return null;
  return JSON.stringify(scripts);
}

/**
 * Добавляет материалы к одному занятию.
 * Делает GET занятия, подставляет scripts и отправляет PUT полный объект
 * (как это делает сам сайт МЭШ), а не только поле scripts.
 * @param {Object} lesson - { lesson_plan_id, module_id, topic_id, lesson_id }
 * @param {Array<{uuid:string, original_uuid:string}>} materials
 * @returns {Promise<Object>} - { success, status, error, added }
 */
async function addMaterialToLesson(lesson, materials) {
  const url = `${CONFIG.API_BASE}/profeducation/plan/teacher/v1/lesson_plans/${lesson.lesson_plan_id}/modules/${lesson.module_id}/topics/${lesson.topic_id}/lessons/${lesson.lesson_id}`;

  try {
    // 1) Берём полный объект занятия
    const lessonObj = await fetchLesson(
      lesson.lesson_plan_id,
      lesson.module_id,
      lesson.topic_id,
      lesson.lesson_id
    );

    const beforeCount = (() => {
      try { return (JSON.parse(lessonObj.scripts || '[]') || []).length; } catch (e) { return 0; }
    })();

    // 2) Объединяем материалы
    const mergedScripts = mergeScripts(lessonObj, materials);
    if (!mergedScripts) {
      return { success: false, error: 'Нет материалов для добавления' };
    }

    // 3) Отправляем PUT с полным объектом (scripts заменяется)
    const payload = Object.assign({}, lessonObj, { scripts: mergedScripts });

    const response = await fetch(url, {
      method: 'PUT',
      mode: 'teacherspow',
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      let afterCount = beforeCount;
      try {
        const data = await response.clone().json();
        afterCount = (JSON.parse(data.scripts || '[]') || []).length;
      } catch (e) { /* ignore */ }
      return { success: true, added: afterCount - beforeCount, beforeCount, afterCount };
    }

    const errorText = await response.text();
    console.error('[МЫШЬ] PUT lesson failed', { url, status: response.status, body: payload, response: errorText });
    return { success: false, status: response.status, error: errorText };
  } catch (e) {
    console.error('[МЫШЬ] addMaterialToLesson error', e);
    return { success: false, error: e.message };
  }
}

/**
 * Массовое добавление материалов ко всем занятиям на диапазон дат.
 * @param {Object} params
 * @param {string} params.date_from - Начало диапазона (ДД.ММ.ГГГГ)
 * @param {string} params.date_to - Конец диапазона (ДД.ММ.ГГГГ)
 * @param {Array<{uuid:string, original_uuid:string}>} [params.materials] -
 *        Материалы для добавления. Если не переданы — используется DEFAULT_MATERIAL.
 */
async function addMaterialForPeriod({ date_from, date_to, materials }) {
  const auth = await getAuthContext(true);
  if (!auth.token || !auth.profileId) {
    sendError('Перезайдите в учетную запись МЭШ.');
    return;
  }

  const materialsToAdd = (Array.isArray(materials) && materials.length > 0)
    ? materials
    : [DEFAULT_MATERIAL];

  sendLog(`📎 Начинаю добавление материалов (${materialsToAdd.length} шт.) на период...`);

  const groupIds = await getGroups();
  if (!groupIds || groupIds.length === 0) {
    sendError('Нет доступных групп.');
    return;
  }

  const detailedGroups = await selectGroups();
  const groupMap = new Map();
  if (Array.isArray(detailedGroups)) {
    for (const g of detailedGroups) {
      groupMap.set(Number(g.id), {
        subject_id: g.subject_id,
        name: g.name || ''
      });
    }
  }

  // Собираем список всех занятий для обработки
  const allLessons = [];
  for (const groupId of groupIds) {
    const groupInfo = groupMap.get(Number(groupId));
    if (!groupInfo || !groupInfo.subject_id) {
      sendLog(`⚠️ Пропускаю группу ${groupId}: нет данных о предмете`);
      continue;
    }
    sendLog(`👥 Группа: ${groupId} (${groupInfo.name}), предмет: ${groupInfo.subject_id}`);

    const lessons = await getLessonsWithStructure({
      group_id: groupId,
      subject_id: groupInfo.subject_id,
      date_from: date_from,
      date_to: date_to
    });
    for (const lesson of lessons) {
      allLessons.push({ lesson, groupId });
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (allLessons.length === 0) {
    sendLog('⚠️ Не найдено занятий на указанный период.');
    sendProgress(100);
    return;
  }

  sendLog(`📚 Найдено занятий: ${allLessons.length}`);
  let current = 0;
  const total = allLessons.length;
  let successCount = 0;
  let failCount = 0;
  let addedCount = 0;
  let firstError = null;
  sendProgress(0);

  for (const { lesson, groupId } of allLessons) {
    try {
      const result = await addMaterialToLesson(lesson, materialsToAdd);
      if (result.success) {
        successCount++;
        addedCount += (result.added || 0);
        sendLog(`✅ Занятие ${lesson.lesson_id} (${lesson.lesson_name}): материал добавлен (+${result.added || 0}, всего ${result.afterCount})`);
      } else {
        failCount++;
        const errMsg = `${result.status || ''} ${result.error || ''}`.trim();
        if (!firstError) firstError = errMsg;
        sendError(`❌ Занятие ${lesson.lesson_id}: ${errMsg}`);
      }
    } catch (error) {
      failCount++;
      if (!firstError) firstError = error.message;
      sendError(`❌ Исключение для занятия ${lesson.lesson_id}: ${error.message}`);
    }
    current++;
    sendProgress((current / total) * 100);
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  sendProgress(100);
  sendLog(`📊 Итог: успешно ${successCount}, ошибок ${failCount}, добавлено материалов ${addedCount}.`);
  if (failCount > 0) {
    sendLog(`❌ Первая ошибка: ${firstError}`);
  }
  return { successCount, failCount, addedCount, firstError };
}

/**
 * Сохраняет зарегистрированный материал в chrome.storage.local,
 * убирая дубликаты по uuid (самые свежие — сверху).
 */
function saveRegisteredMaterials(newMaterials) {
  try {
    chrome.storage.local.get({ meshRegisteredMaterials: [] }, (data) => {
      const existing = Array.isArray(data.meshRegisteredMaterials) ? data.meshRegisteredMaterials : [];
      const map = new Map();
      for (const m of [...newMaterials, ...existing]) {
        if (m && m.uuid) map.set(m.uuid, m);
      }
      const merged = Array.from(map.values());
      chrome.storage.local.set({ meshRegisteredMaterials: merged });
    });
  } catch (e) {
    /* ignore */
  }
}

function sendProgress(value) {
  chrome.runtime.sendMessage({ type: 'progress', value: value });
}

async function setMarks(students_marks, lessons, control_form_id, grade_system_id, course_lesson_topic_id){
  const auth = await getAuthContext(true);
  if (!auth.token || !auth.profileId) {
    sendError('Перезайдите в учетную запись МЭШ.');
  }
  const results = {
    success: [],  // Успешные запросы
    errors: []    // Ошибки с деталями
  };
  const marksToSet = students_marks.filter(st => st.has_mark);
  const total = lessons.length * marksToSet.length;
  let current = 0;
  sendProgress(0);
  if (total === 0) {
    sendProgress(100);
    return results;
  }
  for(const lesson of lessons){
    for(const stMark of marksToSet){
      try{
        const url = `${CONFIG.API_BASE}/profeducation/core/teacher/v1/marks`;
        const payload = {
          comment: "",
          is_exam: false,
          is_criterion: false,
          is_point: false,
          point_date: "",
          schedule_lesson_id: lesson,
          student_profile_id: stMark.student_id,
          teacher_id: auth.profileId,           // Глобальная константа
          control_form_id: control_form_id, // Глобальная переменная
          weight: 1,
          theme_frame_integration_id: null,  // Python None → JS null
          course_lesson_topic_id: course_lesson_topic_id,
          grade_origins: [
            {
              grade_origin: String(randomizeMark(stMark.average_mark)), // Гарантируем строку, как в Python str()
              grade_system_id: grade_system_id
            }
          ],
          grade_system_type: false
        };
        const response = await apiFetch(url, {
          method: 'POST',
          body: JSON.stringify(payload) // Аналог json.dumps()
        });
        current++;
        sendProgress((current / total) * 100);
        if (!response.ok) {
          // 🔸 Логируем, но НЕ прерываем выполнение
          const errorInfo = {
            lesson,
            student_id: stMark.student_id,
            status: response.status,
            statusText: response.statusText
          };
          
          console.warn(`⚠️ HTTP ${response.status}: урок ${lesson}, студент ${stMark.student_id}`);
          results.errors.push(errorInfo);
          
          continue; // ➡️ Переходим к следующей итерации цикла
        }
        const result = await response.json();
        //return result;
        results.success.push({
          lesson,
          student_id: stMark.student_id,
          average_mark: stMark.average_mark,
          response: result
        });
      }catch(error){
        current++;
        sendProgress((current / total) * 100);
        sendError('Error in setMarks: ' + error.message);
        results.errors.push({
          lesson,
          student_id: stMark.student_id,
          error: error.message,
          type: 'network_or_parse_error'
        });
      }
      
    }
  }
  sendProgress(100); // Завершающий прогресс
  return results;
}
// Слушаем перехваченные материалы из MAIN-мира (material_interceptor.js)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'MESH_MATERIAL_TRACKER') return;
  if (data.type === 'registered' && Array.isArray(data.materials)) {
    saveRegisteredMaterials(data.materials);
    sendLog(`📎 Зарегистрирован материал(ы): ${data.materials.map(m => m.name || m.uuid).join('; ')}`);
  }
});

// Listen for messages from popup
sendLog('Content script loaded on school.mos.ru');
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  sendLog('Message received: ' + JSON.stringify(request));
  if (request.action === 'setAbsences') {
    main().then(() => {
      sendLog('Process completed successfully');
      sendResponse({ success: true });
    }).catch(error => {
      sendError('Error in main: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  }else if (request.action === 'syncKTP') {
  
    // Placeholder for KTP sync logic
    sendLog('KTP sync action received');
    syncKTP().then(() => {
      sendLog('KTP sync completed successfully');
      sendResponse({ success: true });
    }).catch(error => {
      sendError('Error in syncKTP: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === "getGroups"){
    selectGroups().then(groups => { 
      sendResponse({ success: true, groups: groups });
    }).catch(error => {
      sendError('Error in getGroups: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === "setDefaultForMarks"){
    setDefaultForMarks(
      request.group_id,
      request.subject_id,
      request.class_level_id,
      request.student_ids,
      request.use_lesson_date_range,
      request.lesson_date_from,
      request.lesson_date_to
    ).then(result => {
      sendResponse({ success: true, result: result });
    }).catch(error => {
      sendError('Error in setDefaultForMarks: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  } else if (request.action === "setMarks"){
    setMarks(request.students_marks, request.lessons, request.control_form_id, request.grade_system_id, request.course_lesson_topic_id).then(result => {
      sendResponse({ success: true, result: result });
    }).catch(error => {
      sendError('Error in setDefaultForMarks: ' + error.message);
      sendResponse({ success: false, error: error.message });
    })
  } else if (request.action === "addHomework"){
    addHomework({
      group_id: request.group_id,
      subject_id: request.subject_id,
      teacher_id: request.teacher_id,
      student_ids: request.student_ids,
      description: request.description,
      duration: request.duration,
      date_assigned_on: request.date_assigned_on,
      date_prepared_for: request.date_prepared_for
    }).then(result => {
      // Прокидываем result.success как outer success (результат самой addHomework)
      sendResponse({ success: result.success, result: result });
    }).catch(error => {
      sendError('Error in addHomework: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (request.action === "addHomeworkForPeriod"){
    addHomeworkForPeriod({
      description: request.description,
      date_from: request.date_from,
      date_to: request.date_to
    }).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendError('Error in addHomeworkForPeriod: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (request.action === "addMaterialForPeriod"){
    addMaterialForPeriod({
      date_from: request.date_from,
      date_to: request.date_to,
      materials: request.materials
    }).then((summary) => {
      sendResponse({
        success: !summary || summary.failCount === 0,
        result: summary
      });
    }).catch(error => {
      sendError('Error in addMaterialForPeriod: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  } else if (request.action === "refreshToken") {
    refreshToken().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendError('Error in refreshToken: ' + error.message);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  }
});