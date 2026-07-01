/**
 * Direct API submission to bypass the brittle Civic Permits UI
 * Reverse-engineered from DateForm.js and NewPermitRequest.js
 */

import https from 'https';
import { URL } from 'url';
import { addOneHour } from './date-planner.js';

/**
 * Construct the permit submission payload without UI automation
 */
async function buildPermitPayload(page, court, dates, startTime) {
  const endTime = addOneHour(startTime);
  
  // Get the site ID for the selected court
  const siteId = await page.locator('#site').inputValue();
  
  // Get facility information from site helper
  const facilityInfo = await page.evaluate(async (siteId) => {
    return new Promise((resolve) => {
      window.getFacilityTypes(siteId, (facilities) => {
        const tennis = facilities.find(f => f.Name === 'Tennis Courts');
        resolve({
          facilityId: tennis.UniqueId,
          facilityName: 'Tennis Courts',
          siteId: siteId
        });
      });
    });
  }, siteId);

  // Build dates array in ISO format
  const eventsArray = [];
  for (const date of dates) {
    const [year, month, day] = date.usDate.split('/');
    const startDateTime = new Date(year, month - 1, day, 
      parseInt(startTime.split(':')[0]), 
      parseInt(startTime.split(':')[1]));
    const endDateTime = new Date(year, month - 1, day,
      parseInt(endTime.split(':')[0]),
      parseInt(endTime.split(':')[1]));
    
    eventsArray.push({
      FacilityNames: [court],
      FacilityIds: [facilityInfo.facilityId],
      Comments: '',
      Dates: [{
        Start: formatDateISO(startDateTime),
        Stop: formatDateISO(endDateTime)
      }]
    });
  }

  // Get all permit question responses from the form
  const responses = await page.evaluate(() => {
    const result = [];
    const questions = document.querySelectorAll('#permitQuestions li[data-elementid]');
    questions.forEach((li) => {
      const elementId = li.getAttribute('data-elementid');
      if (!elementId) return;
      
      // Collect checked values for checkboxes
      const checkboxValues = [];
      li.querySelectorAll(':checked').forEach((input) => {
        checkboxValues.push(input.value);
      });
      
      // Get string value from input or select
      let stringValue = '';
      const input = li.querySelector('input:not([type="checkbox"]), select');
      if (input) {
        stringValue = input.value;
      }
      
      result.push({
        Id: elementId,
        StringValue: stringValue,
        CheckboxValue: checkboxValues
      });
    });
    return result;
  });

  // Build final payload
  const payload = {
    Activity: 'Tennis court reservation',
    Note: '',
    Comments: '',
    Events: eventsArray,
    IsPrivate: false,
    Responses: responses
  };

  return payload;
}

/**
 * Format date to ISO string: yyyy-MM-ddTHH:mm:ss
 */
function formatDateISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = '00';
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * Add one hour to time string HH:mm
 * (Note: imported from date-planner.js, kept here for reference)
 */
// function addOneHour(timeStr) {
//   const [hour, minute] = timeStr.split(':');
//   const nextHour = String((parseInt(hour) + 1) % 24).padStart(2, '0');
//   return `${nextHour}:${minute}`;
// }

/**
 * Submit permit directly to API endpoint, bypassing UI
 */
async function submitPermitDirectly(baseURL, payload, authCookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL);
    url.pathname = '/Permits';
    
    const postData = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': authCookie,
        'X-Requested-With': 'XMLHttpRequest'
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            success: true,
            statusCode: res.statusCode,
            responseData: responseData
          });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Main function: Build and submit permit payload directly
 */
async function submitPermitViaAPI(page, court, dates, startTime, authCookie) {
  try {
    console.log('[API] Building permit payload...');
    const payload = await buildPermitPayload(page, court, dates, startTime);
    
    console.log('[API] Payload structure:', {
      Activity: payload.Activity,
      Events: payload.Events.length,
      Responses: payload.Responses.length
    });
    
    console.log('[API] Submitting directly to /Permits endpoint...');
    const result = await submitPermitDirectly('https://rioc.civicpermits.com', payload, authCookie);
    
    console.log(`[API] Submission successful (${result.statusCode})`);
    return result;
  } catch (error) {
    console.error('[API] Submission failed:', error.message);
    throw error;
  }
}

export {
  buildPermitPayload,
  submitPermitDirectly,
  submitPermitViaAPI,
  formatDateISO
};
