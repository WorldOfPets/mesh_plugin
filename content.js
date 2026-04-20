function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
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
      console.log(`✅ Absence set for group ${groupId} on ${absenceDate}`);
      return await response.json();
    } else {
      console.error(`❌ Error for group ${groupId}: ${response.status} ${response.statusText}`);
      return { error: response.statusText, status: response.status };
    }
  } catch (e) {
    console.error(`❌ Request failed: ${e}`);
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
      console.error('Failed to get groups');
      return [];
    }
  } catch (e) {
    console.error(`Error fetching groups: ${e}`);
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
  console.log('Starting to set homework absences...');
  const groups = await getGroups();
  console.log('Groups:', groups);

  const period = getCurrentAcademicPeriod();

    if (period) {
        console.log(`📅 Обработка периода: ${period.startMonth}-${period.endMonth} / ${period.year}`);
        
        for (const group of groups) {
            console.log(`👥 Группа: ${group}`);
            
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
                console.error(`❌ Ошибка для ${absenceDate}:`, error.message);
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
    
    console.log(response); // Как в оригинале
    return response;
    
  } catch (error) {
    console.error(`❌ Ошибка в calendarPlans(${journal}):`, error.message);
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
    
    console.log(arrCalIds);
    return arrCalIds;
    
  } catch (error) {
    console.error('❌ Ошибка при получении календарных планов:', error.message);
    console.log(error); // Пробрасываем ошибку выше для обработки
  }
}

async function syncKTP() {
  if (!token || !teacherId || !aid || !subsystemId) {
    throw new Error('Required cookies not found. Please ensure you are logged in to school.mos.ru');
  }
  console.log('Starting to set homework absences...');
  const groups = await getGroups();
  console.log('Groups:', groups);

  const academPlans = await getAcademicYear(groups);
  console.log(`📋 Найдено календарей: ${academPlans.length}`);
  for(const calc of academPlans){
    try{
        await calendarPlans(calc);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await calendarPlans(calc, 'recalc');
        console.log(`✅ Календарь ${calc} обработан успешно`);
    }catch(error){
        console.error(`❌ Ошибка при синхронизации KTP для календарного плана ${calc}:`, error.message);
    }

  }

}

// Listen for messages from popup
console.log('Content script loaded on school.mos.ru');
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request);
  if (request.action === 'setAbsences') {
    main().then(() => {
      console.log('Process completed successfully');
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Error in main:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  }else if (request.action === 'syncKTP') {
  
    // Placeholder for KTP sync logic
    console.log('KTP sync action received');
    syncKTP().then(() => {
      console.log('KTP sync completed successfully');
      sendResponse({ success: true });
    }).catch(error => {
      console.error('Error in syncKTP:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep the message channel open for async response
  }
});