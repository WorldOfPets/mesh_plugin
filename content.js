function sendLog(message) {
  chrome.runtime.sendMessage({ type: 'log', message: message });
}

function sendError(message) {
  chrome.runtime.sendMessage({ type: 'error', message: message });
}

const BASE_URL = "https://school.mos.ru/api";
const token = getCookie('aupd_token');
const teacherId = getCookie('profile_id');
const aid = getCookie('aid');
const subsystemId = getCookie('subsystem_id');

const HEADERS = {
  'Authorization': `Bearer ${token}`,
  'x-mes-subsystem': 'journalw',
  'Content-Type': 'application/json',
    'aid': aid,
    'profile-id': teacherId.toString(),
    'x-mes-hostid': subsystemId,
    'origin': 'https://school.mos.ru',
    'referer': 'https://school.mos.ru/',
};

async function setHomeworkAbsences(groupId, absenceDate) {
  const url = `${BASE_URL}/profeducation/core/teacher/v1/homework_absences`;
  const headers = {
    ...HEADERS,
  };
  const payload = {
    group_id: groupId,
    date: absenceDate,
    created_by: teacherId.toString()
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      sendLog(`✅ Absence set for group ${groupId} on ${absenceDate}`);
      return await response.json();
    } else {
      sendError(`❌ Error for group ${groupId}: ${response.status} ${response.statusText}`);
      return { error: response.statusText, status: response.status };
    }
  } catch (e) {
    sendError(`❌ Request failed: ${e}`);
    return { error: e.message };
  }
}

async function getGroups() {
  const url = `${BASE_URL}/profeducation/core/teacher/v1/teacher_profiles/${teacherId}?with_assigned_groups=true&with_replacement_groups=true`;
  const headers = { ...HEADERS, };
  try {
    const response = await fetch(url, { headers });
    if (response.ok) {
      const data = await response.json();
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
  if (!token || !teacherId || !aid || !subsystemId) {
    throw new Error('Required cookies not found. Please ensure you are logged in to school.mos.ru');
  }
  sendLog('Starting to set homework absences...');
  const groups = await getGroups();
  sendLog('Groups: ' + JSON.stringify(groups));

  const period = getCurrentAcademicPeriod();

    if (period) {
        sendLog(`📅 Обработка периода: ${period.startMonth}-${period.endMonth} / ${period.year}`);
        
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
                } catch (error) {
                sendError(`❌ Ошибка для ${absenceDate}: ${error.message}`);
                }
            }
            }
        }
    }
}

/**
 * Завершает календарный план (вызывает /finish)
 * @param {number|string} journal - ID журнала (по умолчанию 209819)
 * @returns {Promise<Response>} - Ответ от сервера
 */
async function calendarPlans(journal, finistOrRecalc = 'finish') {
   //  'recalc' в зависимости от нужного действия
  const url = `${BASE_URL}/profeducation/plan/teacher/v1/calendar_plans/${journal}/${finistOrRecalc}?ignore_IA=true`;
  
  const headers = { ...HEADERS, };
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
    });
    
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
  // Преобразуем массив в строку "1,2,3"
  const groupsStr = groups.map(String).join(',');
  
  const url = `${BASE_URL}/profeducation/plan/teacher/v1/calendar_plans?academic_year_id=${aid}&group_ids=${groupsStr}`;
  const headers = { ...HEADERS, };
  
  try {
    const response = await fetch(url, { 
      method: 'GET',
      headers,
    });
    
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
  if (!token || !teacherId || !aid || !subsystemId) {
    throw new Error('Required cookies not found. Please ensure you are logged in to school.mos.ru');
  }
  sendLog('Starting to set homework absences...');
  const groups = await getGroups();
  sendLog('Groups: ' + JSON.stringify(groups));

  const academPlans = await getAcademicYear(groups);
  sendLog(`📋 Найдено календарей: ${academPlans.length}`);
  for(const calc of academPlans){
    try{
        await calendarPlans(calc);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await calendarPlans(calc, 'recalc');
        sendLog(`✅ Календарь ${calc} обработан успешно`);
    }catch(error){
        sendError(`❌ Ошибка при синхронизации KTP для календарного плана ${calc}: ${error.message}`);
    }

  }

}

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
  }
});