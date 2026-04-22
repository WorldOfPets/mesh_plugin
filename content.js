function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}


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
      //sendError(`❌ Error for group ${groupId}: ${response.status} ${response.statusText}`);
      return { error: response.statusText, status: response.status };
    }
  } catch (e) {
    //sendError(`❌ Request failed: ${e}`);
    return { error: e.message };
  }
}

async function getGroups() {
  const url = `${BASE_URL}/profeducation/core/teacher/v1/teacher_profiles/${teacherId}?with_assigned_groups=true&with_replacement_groups=true`;
  const headers = { ...HEADERS};
  try {
    const response = await fetch(url, { 
      method: 'GET',
      headers,
      credentials: 'include'
    });
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
    throw new Error('Перезайдите в учетную запись МЭШ.');
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
    throw new Error('Перезайдите в учетную запись МЭШ.');
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
  const groups = await getGroups();
  const groupsStr = groups.map(String).join(',');
  const url = BASE_URL + '/profeducation/plan/teacher/v1/groups' +
    '?academic_year_id=' + aid +
    '&group_ids=' + groupsStr +
    '&with_periods_schedule_id=true' +
    '&with_parallel_curriculum_id=true' +
    '&with_lesson_plans_info=true';
  const headers = { ...HEADERS};
  try {
    const response = await fetch(url, { 
      method: 'GET',
      headers, 
      credentials: 'include'
    });
    
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
    const period = getCurrentAcademicPeriod();
    dateFrom = period ? `${period.startDay.toString().padStart(2, '0')}.${period.startMonth.toString().padStart(2, '0')}.${period.year}` : null;
    dateTo = period ? `${period.endDay.toString().padStart(2, '0')}.${period.endMonth.toString().padStart(2, '0')}.${period.year}` : null;
    const urlmarks = `${BASE_URL}/profeducation/core/teacher/v1/marks?` +
      `group_ids=${group_id}&` +
      `subject_id=${subject_id}&` +
      
      `created_at_from=${dateFrom}&` +
      `created_at_to=${dateTo}&` 
    const response = await fetch(urlmarks, {
      method: 'GET',
      headers: {
        ...HEADERS,
      },
      credentials: 'include' // Важно: отправляет cookies сессии (аналог requests с сессией)
    });
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

  const url = `${BASE_URL}/profeducation/plan/teacher/v1/schedule_items?` +
      `academic_year_id=${aid}&` +
      `group_ids=${group_id}&` +
      `subject_id=${subject_id}&` +
      `teacher_id=${teacherId}&` +
      `from=${dateFrom}&` +
      `to=${dateTo}&` +
      `with_group_class_subject_info=true&` +
      `with_course_calendar_info=true&` +
      `with_lesson_info=true&` +
      `with_rooms_info=true&` +
      `with_availability_info=true&`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {...HEADERS},

  });
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

async function getAverageMarks(group_id, subject_id, student_ids, defaultMark = 3) {
  try{
    const url = `${BASE_URL}/profeducation/core/teacher/v1/average_marks_year?group_ids=${group_id}&student_profile_ids=${student_ids}&subject_id=${subject_id}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...HEADERS,
        },
        credentials: 'include' // Важно: отправляет cookies сессии (аналог requests с сессией)
      });
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
          marksMap.set(item.student_id, {
            average_mark: Number(item[markField] ?? defaultMark),
            has_mark: true
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
  if (mark === 5) return Math.random() < 0.2 ? 4 : 5;
  if (Math.random() >= 0.2) return mark;
  
  const delta = Math.random() < 0.5 ? -1 : 1;
  const candidate = mark + delta;
  return (candidate >= 1 && candidate <= 5) ? candidate : mark;
}

function sendProgress(value) {
  chrome.runtime.sendMessage({ type: 'progress', value: value });
}

async function setMarks(students_marks, lessons, control_form_id, grade_system_id, course_lesson_topic_id){
  const results = {
    success: [],  // Успешные запросы
    errors: []    // Ошибки с деталями
  };
  const total = lessons.length * students_marks.length;
  let current = 0;
  sendProgress(0); // Начальный прогресс
  for(const lesson of lessons){
    for(const stMark of students_marks){
      try{
        const url = `${BASE_URL}/profeducation/core/teacher/v1/marks`;
        const payload = {
          comment: "",
          is_exam: false,
          is_criterion: false,
          is_point: false,
          point_date: "",
          schedule_lesson_id: lesson,
          student_profile_id: stMark.student_id,
          teacher_id: teacherId,           // Глобальная константа
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
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...HEADERS},
          body: JSON.stringify(payload), // Аналог json.dumps()
          credentials: 'include'         // Отправка cookies сессии
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
  }
});