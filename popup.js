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
          statusDiv.textContent = 'Error: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Please navigate to school.mos.ru first.';
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
          statusDiv.textContent = 'Error: Timeout - no response from content script';
        }
      }, 10000);
    } else {
      statusDiv.textContent = 'Please navigate to school.mos.ru first.';
    }
  });
});