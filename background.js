/**
 * background.js (MV3 service worker)
 *
 * Задачи:
 *  1) Отдавать контент-скрипту авторизационные куки из cookie store браузера
 *     (chrome.cookies) — надёжнее, чем document.cookie (работает и для httpOnly,
 *     и когда кука не видна из контент-скрипта).
 *  2) Держать chrome.storage.local.meshAuthContext в актуальном состоянии:
 *     при любом изменении авторизационных кук обновляем сохранённый снимок.
 *
 * Само обновление токена (POST /v3/token/refresh) выполняется в контент-скрипте
 * как first-party запрос; здесь только чтение/синхронизация кук.
 */

const COOKIE_NAMES = {
  token: 'aupd_token',
  profileId: 'profile_id',
  aid: 'aid',
  subsystemId: 'subsystem_id'
};

const AUTH_CONTEXT_KEY = 'meshAuthContext';

// Домены, по которым ищем куки.
const LOOKUP_DOMAINS = [
  'school.mos.ru',
  'mos.ru'
];

/**
 * Пытается достать exp (в секундах) из JWT-строки; 0 — если не удалось.
 */
function jwtExp(valueStr) {
  try {
    const parts = String(valueStr).split('.');
    if (parts.length !== 3) return 0;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const payload = JSON.parse(json);
    return (payload && typeof payload.exp === 'number') ? payload.exp : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Промис-обёртка над chrome.cookies.getAll.
 * getAll надёжнее, чем get по имени: возвращает все варианты куки для всех
 * путей/доменов. Если куки-токена несколько (например, на разных path), выбираем
 * самый свежий по JWT-exp, а при равенстве — с наиболее длинным path.
 * @returns {Promise<string|null>}
 */
function getCookieValue(name) {
  return new Promise((resolve) => {
    let pending = LOOKUP_DOMAINS.length;
    let best = null;
    let bestScore = -1;

    const finish = () => {
      pending--;
      if (pending <= 0) resolve(best);
    };

    for (const domain of LOOKUP_DOMAINS) {
      try {
        chrome.cookies.getAll({ domain, name }, (cookies) => {
          if (chrome.runtime.lastError) {
            finish();
            return;
          }
          if (Array.isArray(cookies)) {
            for (const c of cookies) {
              if (c && c.value) {
                // Сначала по exp JWT (свежесть), затем по длине path.
                const score = jwtExp(c.value) * 1000 + (c.path || '').length;
                if (score > bestScore) {
                  bestScore = score;
                  best = c.value;
                }
              }
            }
          }
          finish();
        });
      } catch (e) {
        finish();
      }
    }
  });
}

/**
 * Читает весь набор авторизационных кук.
 * @returns {Promise<{token:?string, profileId:?string, aid:?string, subsystemId:?string}>}
 */
async function readAuthCookies() {
  const [token, profileId, aid, subsystemId] = await Promise.all([
    getCookieValue(COOKIE_NAMES.token),
    getCookieValue(COOKIE_NAMES.profileId),
    getCookieValue(COOKIE_NAMES.aid),
    getCookieValue(COOKIE_NAMES.subsystemId)
  ]);
  return { token, profileId, aid, subsystemId };
}

/**
 * Обновляет сохранённый контекст авторизации (не перезатирая уже известные
 * значения пустыми/отсутствующими).
 */
async function syncAuthContextToStorage() {
  try {
    const cookies = await readAuthCookies();
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get({ [AUTH_CONTEXT_KEY]: null }, (data) => resolve(data[AUTH_CONTEXT_KEY]));
    });
    const prev = (stored && typeof stored === 'object') ? stored : {};
    const now = Date.now();

    // Не перезатираем токен-override из тела ответа refresh, пока он действует:
    // кука может обновиться позже, и её значение ещё невалидно.
    const overrideActive = prev.tokenOverride && prev.overrideExpiresAt && now < prev.overrideExpiresAt;
    const tokenOverride = overrideActive ? prev.tokenOverride : null;
    const overrideExpiresAt = overrideActive ? prev.overrideExpiresAt : null;

    const effectiveToken = tokenOverride || cookies.token || prev.token || null;
    const ctx = {
      token: effectiveToken,
      profileId: cookies.profileId || prev.profileId || null,
      aid: cookies.aid || prev.aid || null,
      subsystemId: cookies.subsystemId || prev.subsystemId || null,
      tokenAddedAt: (effectiveToken && effectiveToken !== prev.token) ? now : (prev.tokenAddedAt || null),
      tokenOverride,
      overrideExpiresAt
    };
    chrome.storage.local.set({ [AUTH_CONTEXT_KEY]: ctx });
  } catch (e) {
    /* ignore */
  }
}

/**
 * Находит существующий вариант куки (для сохранения корректного domain/path).
 * @returns {Promise<chrome.cookies.Cookie|null>}
 */
function findExistingCookie(name) {
  return new Promise((resolve) => {
    let pending = LOOKUP_DOMAINS.length;
    let found = null;
    const finish = () => {
      pending--;
      if (pending <= 0) resolve(found);
    };
    for (const domain of LOOKUP_DOMAINS) {
      try {
        chrome.cookies.getAll({ domain, name }, (cookies) => {
          if (!chrome.runtime.lastError && Array.isArray(cookies) && cookies.length > 0 && !found) {
            // Берём с самым свежим exp (или первый).
            let best = cookies[0];
            let bestScore = -1;
            for (const c of cookies) {
              const score = jwtExp(c.value) * 1000 + (c.path || '').length;
              if (score > bestScore) { bestScore = score; best = c; }
            }
            found = best;
          }
          finish();
        });
      } catch (e) {
        finish();
      }
    }
  });
}

/**
 * Записывает куку авторизации в cookie store браузера, сохраняя существующий
 * domain/path, чтобы не создать дубликат/расхождение.
 * @param {string} name
 * @param {string} value
 * @returns {Promise<boolean>}
 */
function normalizeSameSite(existing) {
  const s = existing && existing.sameSite;
  if (s === 'no_restriction' || s === 'lax' || s === 'strict' || s === 'unspecified') {
    return s;
  }
  return 'unspecified';
}

async function writeCookie(name, value) {
  if (!value) return false;
  const existing = await findExistingCookie(name);
  const domain = existing && existing.domain ? existing.domain : 'school.mos.ru';
  const path = existing && existing.path ? existing.path : '/';
  const url = `https://${domain.replace(/^\./, '')}${path}`;
  const details = {
    url,
    domain,
    path,
    name,
    value: String(value),
    secure: existing && typeof existing.secure === 'boolean' ? existing.secure : true,
    httpOnly: existing && typeof existing.httpOnly === 'boolean' ? existing.httpOnly : false,
    sameSite: normalizeSameSite(existing)
  };
  return new Promise((resolve) => {
    try {
      chrome.cookies.set(details, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * Безусловная запись набора кук авторизации (например, после refresh).
 * @param {{token?:string,profileId?:string,aid?:string,subsystemId?:string}} ctx
 * @returns {Promise<{written:number, total:number}>}
 */
async function writeAuthCookies(ctx) {
  const pairs = [
    [COOKIE_NAMES.token, ctx && ctx.token],
    [COOKIE_NAMES.profileId, ctx && ctx.profileId],
    [COOKIE_NAMES.aid, ctx && ctx.aid],
    [COOKIE_NAMES.subsystemId, ctx && ctx.subsystemId]
  ];
  const results = await Promise.all(pairs.map(([n, v]) => writeCookie(n, v)));
  return { written: results.filter(Boolean).length, total: pairs.length };
}

// --- Обработка сообщений от контент-скрипта ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'getAuthCookies') {
    readAuthCookies()
      .then((cookies) => {
        sendResponse({ success: true, ...cookies });
      })
      .catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
    return true; // async response
  }

  if (request && request.action === 'setAuthCookies') {
    writeAuthCookies(request.context || {})
      .then(async (info) => {
        // Сразу перечитаем и синхронизируем кэш в storage.
        const cookies = await readAuthCookies();
        const stored = await new Promise((resolve) => {
          chrome.storage.local.get({ [AUTH_CONTEXT_KEY]: null }, (data) => resolve(data[AUTH_CONTEXT_KEY]));
        });
        const prev = (stored && typeof stored === 'object') ? stored : {};
        const now = Date.now();
        const ctx = {
          token: cookies.token || prev.token || null,
          profileId: cookies.profileId || prev.profileId || null,
          aid: cookies.aid || prev.aid || null,
          subsystemId: cookies.subsystemId || prev.subsystemId || null,
          tokenAddedAt: now,
          tokenOverride: null,
          overrideExpiresAt: null
        };
        chrome.storage.local.set({ [AUTH_CONTEXT_KEY]: ctx });
        sendResponse({ success: true, written: info.written, total: info.total, cookies });
      })
      .catch((e) => {
        sendResponse({ success: false, error: e.message });
      });
    return true; // async response
  }
});

// --- Поддержание кэша авторизации в актуальном состоянии ---
const WATCHED = new Set(Object.values(COOKIE_NAMES));

chrome.cookies.onChanged.addListener((changeInfo) => {
  try {
    const name = changeInfo && changeInfo.cookie && changeInfo.cookie.name;
    if (name && WATCHED.has(name)) {
      syncAuthContextToStorage();
    }
  } catch (e) {
    /* ignore */
  }
});

// Первичная синхронизация при старте service worker.
syncAuthContextToStorage();
