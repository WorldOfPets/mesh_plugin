document.getElementById('startBtn').addEventListener('click', () => {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = 'Starting...';
  console.log('Button clicked, querying tabs...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('Active tab:', tabs[0]);
    if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
      console.log('Sending message to tab:', tabs[0].id);
      let responded = false;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'setAbsences' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Перезагрузите страницу.';
          return;
        }
        responded = true;
        console.log('Response received:', response);
        if (response && response.success) {
          statusDiv.textContent = 'Process completed!';
        } else {
          statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
        }
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          console.log('No response within timeout');
          statusDiv.textContent = 'Warning: Timeout - no response from content script';
        }
      }, 100000);
    } else {
      statusDiv.textContent = 'Перейдите в МЭШ.';
    }
  });
});

// document.getElementById('syncKTP').addEventListener('click', () => {
//   const statusDiv = document.getElementById('status');
//   statusDiv.textContent = 'Starting KTP sync...';
//   console.log('Sync KTP button clicked, querying tabs...');

//   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
//     console.log('Active tab:', tabs[0]);
//     if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
//       console.log('Sending syncKTP message to tab:', tabs[0].id);
//       let responded = false;
//       chrome.tabs.sendMessage(tabs[0].id, { action: 'syncKTP' }, (response) => {
//         if (chrome.runtime.lastError) {
//           console.error('Runtime error:', chrome.runtime.lastError);
//           statusDiv.textContent = 'Error: ' + chrome.runtime.lastError.message + '. Try reloading the page.';
//           return;
//         }
//         responded = true;
//         console.log('Response received:', response);
//         if (response && response.success) {
//           statusDiv.textContent = 'KTP sync completed!';
//         } else {
//           statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
//         }
//       });
//       // Timeout after 30 seconds for sync
//       setTimeout(() => {
//         if (!responded) {
//           console.log('No response within timeout');
//           statusDiv.textContent = 'Error: Timeout - no response from content script';
//         }
//       }, 30000);
//     } else {
//       statusDiv.textContent = 'Please navigate to school.mos.ru first.';
//     }
//   });
// });

// Listen for log messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'log') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent += '\n' + message.message;
  } else if (message.type === 'error') {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent += '\nError: ' + message.message;
  } else if (message.type === 'progress') {
    const progressBar = document.getElementById('progressBar');
    progressBar.value = message.value;
    progressBar.textContent = message.value + '%';
  }
});
let STUDENTS_MARKS = [];
let LESSONS = [];
let CONTROL_FORM_ID = null;
let GROUP_ID = null;
let SUBJECT_ID = null;
let GRADE_SYSTEM_ID = null;
let COURSE_LESSON_TOPIC_ID = null;

function getLessonDateRange() {
  const useLessonDateRange = document.getElementById('useLessonDateRange');
  const lessonDateFrom = document.getElementById('lessonDateFrom');
  const lessonDateTo = document.getElementById('lessonDateTo');

  const isEnabled = Boolean(useLessonDateRange?.checked);
  const dateFrom = lessonDateFrom?.value || '';
  const dateTo = lessonDateTo?.value || '';

  return {
    useLessonDateRange: isEnabled,
    dateFrom,
    dateTo
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const groupSelect = document.getElementById('groupSelect');
  const statusDiv = document.getElementById('status');
  const useLessonDateRange = document.getElementById('useLessonDateRange');
  const lessonDateFrom = document.getElementById('lessonDateFrom');
  const lessonDateTo = document.getElementById('lessonDateTo');
  const lessonDateRange = document.getElementById('lessonDateRange');

  const updateLessonDateInputs = () => {
    const disabled = !useLessonDateRange.checked;
    lessonDateRange.style.display = disabled ? 'none' : 'flex';
    lessonDateFrom.disabled = disabled;
    lessonDateTo.disabled = disabled;
  };

  updateLessonDateInputs();
  useLessonDateRange.addEventListener('change', updateLessonDateInputs);

  statusDiv.textContent = 'Starting...';
  console.log('Button clicked, querying tabs...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('Active tab:', tabs[0]);
    if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
      console.log('Sending message to tab:', tabs[0].id);
      let responded = false;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getGroups' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Перезагрузите страницу.';
          return;
        }
        responded = true;
        console.log('Response received:', response);
        if (response && response.success && response.groups) {
          // Populate the select element with groups
          groupSelect.innerHTML = ""; // Clear existing options
          const optionSelectSub = document.createElement('option');
          optionSelectSub.value = "";
          optionSelectSub.textContent = "Выберите группу";
          optionSelectSub.selected = true;
          groupSelect.appendChild(optionSelectSub);
          response.groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = `${group.class_level_id} - ${group.name}`;
            option.dataset.subjectId = group.subject_id;
            option.dataset.classLevelId = group.class_level_id;
            option.dataset.studentIds = group.student_ids.join(',');
            groupSelect.appendChild(option);
          });
          statusDiv.textContent = 'Groups loaded successfully!';
        } else {
          statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
        }
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          console.log('No response within timeout');
          statusDiv.textContent = 'Warning: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Перейдите в МЭШ.';
    }
  });
  // Пример получения subject_id при выборе:
  document.getElementById('groupSelect').addEventListener('change', function(e) {
    const selectedOption = e.target.options[e.target.selectedIndex];
    //const subjectId = selectedOption.dataset.subjectId;
    const classLevelId = selectedOption.dataset.classLevelId;
    SUBJECT_ID = selectedOption.dataset.subjectId;
    GROUP_ID = e.target.value;
    const studentIds = selectedOption.dataset.studentIds;
    const lessonDateRange = getLessonDateRange();

    if (lessonDateRange.useLessonDateRange && (!lessonDateRange.dateFrom || !lessonDateRange.dateTo)) {
      statusDiv.textContent = 'Выберите обе даты: от и до.';
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('Active tab:', tabs[0]);
    if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
      console.log('Sending message to tab:', tabs[0].id);
      let responded = false;
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'setDefaultForMarks',
        group_id: GROUP_ID,
        subject_id: SUBJECT_ID,
        class_level_id: classLevelId,
        student_ids: studentIds,
        use_lesson_date_range: lessonDateRange.useLessonDateRange,
        lesson_date_from: lessonDateRange.dateFrom,
        lesson_date_to: lessonDateRange.dateTo
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Перезагрузите страницу.';
          
          return;
        }
        responded = true;
        console.log('Response received:', response);
        if (response && response.success && response.result) {
          //statusDiv.textContent = `Control form: ${response.result.controlFormId} \n Class level id: ${classLevelId} \n Grade system id: ${response.result.gradeSystemId} \n Course Lessont topic id: ${response.result.courseLessonTopicId} \n Average marks: ${JSON.stringify(response.result.averageMarks)} \n Lessons: ${response.result.lessonsIds.join(', ')}`;
          STUDENTS_MARKS = response.result.averageMarks;
          LESSONS = response.result.lessonsIds;
          CONTROL_FORM_ID = response.result.controlFormId;
          GRADE_SYSTEM_ID = response.result.gradeSystemId;
          COURSE_LESSON_TOPIC_ID = response.result.courseLessonTopicId;
          statusDiv.textContent = `G: ${GROUP_ID}\n`+
          `S: ${SUBJECT_ID}\n`+
          `SM: ${STUDENTS_MARKS}\n`+
          `L: ${LESSONS}\n`+
          `CF: ${CONTROL_FORM_ID}\n`+
          `GS: ${GRADE_SYSTEM_ID}\n`+
          `CLT: ${COURSE_LESSON_TOPIC_ID}`;
        } else {
          statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
        }
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          console.log('No response within timeout');
          statusDiv.textContent = 'Warning: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Перейдите в МЭШ.';
    }
  });
  });
});
document.getElementById('setMarks').addEventListener('click', () => {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = 'Starting...';
  console.log('Button clicked, querying tabs...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('Active tab:', tabs[0]);
    if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
      console.log('Sending message to tab:', tabs[0].id);
      let responded = false;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'setMarks', students_marks: STUDENTS_MARKS, lessons: LESSONS, control_form_id: CONTROL_FORM_ID, grade_system_id: GRADE_SYSTEM_ID, course_lesson_topic_id: COURSE_LESSON_TOPIC_ID }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Error: ' + chrome.runtime.lastError.message + '. Try reloading the page.';
          return;
        }
        responded = true;
        console.log('Response received:', response);
        if (response && response.success) {
          statusDiv.textContent = 'Process completed!';
        } else {
          statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
        }
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          console.log('No response within timeout');
          statusDiv.textContent = 'Warning: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Перейдите в МЭШ.';
    }
  });
});
document.getElementById('syncKTP').addEventListener('click', () => {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = 'Starting...';
  console.log('Button clicked, querying tabs...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('Active tab:', tabs[0]);
    if (tabs[0] && tabs[0].url.includes('school.mos.ru')) {
      console.log('Sending message to tab:', tabs[0].id);
      let responded = false;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'syncKTP' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Runtime error:', chrome.runtime.lastError);
          statusDiv.textContent = 'Перезагрузите страницу.';
          return;
        }
        responded = true;
        console.log('Response received:', response);
        if (response && response.success) {
          statusDiv.textContent = 'Process completed!';
        } else {
          statusDiv.textContent = 'Error: ' + (response ? response.error : 'No response');
        }
      });
      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          console.log('No response within timeout');
          statusDiv.textContent = 'Error: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Перейдите в МЭШ.';
    }
  });
});