import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { URL } from 'url';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { addOneHour, getReservationPlan, getReservationPlanForOffset } from './date-planner.js';
import { notify } from './notify.js';
import { submitPermitViaAPI } from './api.js';

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TRIM_TO_BYTES = 4 * 1024 * 1024;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function saveScreenshot(page, name) {
  const dir = path.resolve('artifacts', 'screenshots');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
  return target;
}

async function appendRunLog(entry) {
  const dir = path.resolve('logs');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'booking-run.ndjson');
  await trimLogFileIfNeeded(filePath);
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    ...entry
  })}\n`;
  await fs.appendFile(filePath, line, 'utf8');
}

async function trimLogFileIfNeeded(filePath) {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return {
      trimmed: false,
      sizeBefore: 0,
      sizeAfter: 0
    };
  }

  if (stats.size <= LOG_MAX_BYTES) {
    return {
      trimmed: false,
      sizeBefore: stats.size,
      sizeAfter: stats.size
    };
  }

  const fd = await fs.open(filePath, 'r');
  try {
    const keepBytes = Math.min(LOG_TRIM_TO_BYTES, stats.size);
    const start = Math.max(0, stats.size - keepBytes);
    const buffer = Buffer.alloc(keepBytes);
    await fd.read(buffer, 0, keepBytes, start);

    let output = buffer.toString('utf8');
    const firstNewline = output.indexOf('\n');
    if (firstNewline >= 0 && firstNewline + 1 < output.length) {
      output = output.slice(firstNewline + 1);
    }

    await fs.writeFile(filePath, output, 'utf8');

    return {
      trimmed: true,
      sizeBefore: stats.size,
      sizeAfter: Buffer.byteLength(output)
    };
  } finally {
    await fd.close();
  }
}

async function logRunLogStatus() {
  const dir = path.resolve('logs');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'booking-run.ndjson');
  const trimResult = await trimLogFileIfNeeded(filePath);
  console.log(`[LOG] booking-run.ndjson sizeBefore=${trimResult.sizeBefore} sizeAfter=${trimResult.sizeAfter} trimmed=${trimResult.trimmed}`);
}

async function setCheckboxValue(locator, checked) {
  await locator.evaluate((node, nextChecked) => {
    node.checked = nextChecked;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new Event('click', { bubbles: true }));
  }, checked);
}

function toTimeLabel(time24) {
  const [hoursText, minutesText] = time24.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function getWeekdayCheckboxId(weekday) {
  return {
    Sun: 'repeatSun',
    Mon: 'repeatMon',
    Tue: 'repeatTue',
    Wed: 'repeatWed',
    Thu: 'repeatThu',
    Fri: 'repeatFri',
    Sat: 'repeatSat'
  }[weekday];
}

async function clickByText(page, pattern) {
  const locator = page.getByRole('link', { name: pattern }).or(page.getByRole('button', { name: pattern }));
  const first = locator.first();
  if (await first.count()) {
    await first.evaluate((node) => node.click());
    return;
  }

  throw new Error(`Could not find control matching ${pattern}`);
}

async function populateCourtBooking(page, plannedDates, startTime, courtLabel) {
  const endTime = addOneHour(startTime);
  const facilityId = await page.evaluate(async (siteLabel) => {
    const siteSelect = document.querySelector('#site');
    const siteId = siteSelect ? siteSelect.value : '';

    const facilities = await new Promise((resolve, reject) => {
      window.getFacilityTypes(siteId, (data) => {
        if (!Array.isArray(data)) {
          reject(new Error('Facility type lookup returned an unexpected payload.'));
          return;
        }

        resolve(data);
      });
    });

    const courtFacility = facilities.find((item) => item.Name === 'Tennis Courts');
    if (!courtFacility) {
      throw new Error(`Could not find facility data for ${siteLabel}.`);
    }

    const facilityList = document.querySelector('.facilityList');
    if (!facilityList) {
      throw new Error('Facility list container was not found.');
    }

    facilityList.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'facility';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'facilities';
    checkbox.value = courtFacility.UniqueId;
    checkbox.id = `facility-${courtFacility.UniqueId}`;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = courtFacility.Name;

    wrapper.append(checkbox, label);
    facilityList.append(wrapper);

    window.resetDateForm();

    const selectedCheckbox = facilityList.querySelector('input[name="facilities"]');
    if (selectedCheckbox) {
      selectedCheckbox.checked = true;
      selectedCheckbox.dispatchEvent(new Event('input', { bubbles: true }));
      selectedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const row = document.querySelector('#eventDates tbody tr');
    if (!row) {
      throw new Error('Event date row was not added.');
    }

    return courtFacility.UniqueId;
  }, courtLabel);

  const firstRow = page.locator('#eventDates tbody tr').first();
  await firstRow.locator('.manualDate').fill(plannedDates[0].usDate);
  await firstRow.locator('select[name="startHour"]').selectOption({ label: toTimeLabel(startTime) });
  await firstRow.locator('select[name="startMinute"]').selectOption({ label: startTime.split(':')[1] });
  await firstRow.locator('select[name="endHour"]').selectOption({ label: toTimeLabel(endTime) });
  await firstRow.locator('select[name="endMinute"]').selectOption({ label: endTime.split(':')[1] });

  return facilityId;
}

async function maybeSelect(page, labelPattern, valuePatternOrText) {
  const select = page.getByLabel(labelPattern);
  if (await select.count()) {
    const optionValue = String(valuePatternOrText);
    try {
      await select.selectOption({ label: optionValue });
      return true;
    } catch {
      try {
        await select.selectOption({ value: optionValue });
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

async function maybeFill(page, labelPattern, value, alternatives = []) {
  const fields = [page.getByLabel(labelPattern), ...alternatives.map((pattern) => page.locator(pattern))];

  for (const field of fields) {
    if (await field.count()) {
      await field.first().fill(value);
      return true;
    }
  }

  return false;
}

async function chooseTime(page, labelPattern, value) {
  if (await maybeSelect(page, labelPattern, value)) {
    return true;
  }

  return maybeFill(page, labelPattern, value, [
    'input[name*="StartTime"]',
    'input[name*="EndTime"]',
    'input[id*="StartTime"]',
    'input[id*="EndTime"]'
  ]);
}

async function setQuestionDefaults(page, config) {
  const textAnswers = [
    {
      label: /what activity will be taking place/i,
      value: 'Tennis court reservation'
    },
    {
      label: /how many people are expected/i,
      value: '2'
    },
    {
      label: /are participants charged/i,
      value: 'No'
    },
    {
      label: /are spectators charged/i,
      value: 'No'
    },
    {
      label: /table\/chair/i,
      value: 'N/A'
    },
    {
      label: /live entertainment\/amplified sound/i,
      value: 'No'
    },
    {
      label: /will the event be advertised/i,
      value: 'No'
    },
    {
      label: /describe parking needs/i,
      value: 'None'
    }
  ];

  for (const answer of textAnswers) {
    const field = page.getByLabel(answer.label);
    if (await field.count()) {
      await field.first().fill(answer.value);
    }
  }

  const yesNoAnswers = [
    {
      label: /have you had a permit on roosevelt island/i,
      value: 'No'
    },
    {
      label: /will there be on site security/i,
      value: 'No'
    }
  ];

  for (const answer of yesNoAnswers) {
    const field = page.getByLabel(answer.label);
    if (await field.count()) {
      await field.first().selectOption({ label: answer.value }).catch(() => {});
    }
  }

  await fillPermitQuestions(page, config.questionDefault);
}

async function fillPermitQuestions(page, fallbackAnswer) {
  const textInputs = page.locator('input[type="text"], textarea');
  const textCount = await textInputs.count();
  for (let index = 0; index < textCount; index += 1) {
    const input = textInputs.nth(index);
    const current = await input.inputValue().catch(() => '');
    const disabled = await input.isDisabled().catch(() => false);
    const readOnly = await input.evaluate((node) => node.readOnly).catch(() => false);
    if (!disabled && !readOnly && !current) {
      await input.fill(fallbackAnswer);
    }
  }

  const selects = page.locator('select');
  const selectCount = await selects.count();
  for (let index = 0; index < selectCount; index += 1) {
    const select = selects.nth(index);
    const options = await select.locator('option').allTextContents();
    const noLike = options.find((option) => /^(no|n\/a|not applicable)$/i.test(option.trim()));
    if (noLike) {
      await select.selectOption({ label: noLike.trim() }).catch(() => {});
    }
  }
}

async function agreeToTerms(page) {
  const labels = [
    /i agree to the facility use terms and conditions/i,
    /i agree/i,
    /terms and conditions/i
  ];

  for (const label of labels) {
    const checkbox = page.getByLabel(label);
    if (await checkbox.count()) {
      await checkbox.check();
      return true;
    }
  }

  const genericCheckbox = page.locator('input[type="checkbox"]').last();
  if (await genericCheckbox.count()) {
    await genericCheckbox.check().catch(() => {});
    return true;
  }

  return false;
}

async function addDatesForPlans(page, plannedDates, startTime) {
  const endTime = addOneHour(startTime);
  await page.evaluate(({ dateText, startTimeValue, endTimeValue }) => {
    let row = document.querySelector('#eventDates tbody tr');
    if (!row && typeof window.addDate === 'function') {
      window.addDate();
      row = document.querySelector('#eventDates tbody tr');
    }
    if (!row) {
      throw new Error('Event date row was not found.');
    }

    const dateInput = row.querySelector('.manualDate');
    const startHour = row.querySelector('select[name="startHour"]');
    const startMinute = row.querySelector('select[name="startMinute"]');
    const endHour = row.querySelector('select[name="endHour"]');
    const endMinute = row.querySelector('select[name="endMinute"]');

    if (!dateInput || !startHour || !startMinute || !endHour || !endMinute) {
      throw new Error('Event date controls are missing.');
    }

    dateInput.value = dateText;
    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));

    startHour.value = String(startTimeValue.hour);
    startHour.dispatchEvent(new Event('change', { bubbles: true }));
    startMinute.value = startTimeValue.minute;
    startMinute.dispatchEvent(new Event('change', { bubbles: true }));
    endHour.value = String(endTimeValue.hour);
    endHour.dispatchEvent(new Event('change', { bubbles: true }));
    endMinute.value = endTimeValue.minute;
    endMinute.dispatchEvent(new Event('change', { bubbles: true }));
  }, {
    dateText: plannedDates[0].usDate,
    startTimeValue: {
      hour: Number(startTime.split(':')[0]),
      minute: startTime.split(':')[1]
    },
    endTimeValue: {
      hour: Number(endTime.split(':')[0]),
      minute: endTime.split(':')[1]
    }
  });
}

async function bookViaDirectAPI(page, config, plannedDates, startTime, courtLabel) {
  // Navigate to the new permit page to establish session context
  console.log('[BOOKING] Opening new permit form for session context...');
  await clickByText(page, /new permit request/i);
  await page.waitForLoadState('networkidle');

  // Verify we have court options available
  const courtSelected = await maybeSelect(page, /location requested/i, courtLabel);
  if (!courtSelected) {
    throw new Error(`Could not select court ${courtLabel}.`);
  }

  console.log('[BOOKING] Court selected. Waiting for permit questions to load...');
  
  // Wait for questions to appear in the DOM
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#permitQuestions li').length > 0,
      { timeout: 10000 }
    );
  } catch (e) {
    console.log('[BOOKING] No permit questions found after waiting');
    // Log the page content for debugging
    const html = await page.content();
    const permitQuestionsMatch = html.match(/<ul id="permitQuestions"[\s\S]*?<\/ul>/);
    if (permitQuestionsMatch) {
      console.log('[DEBUG] permitQuestions div found:', permitQuestionsMatch[0].slice(0, 500));
    } else {
      console.log('[DEBUG] No permitQuestions div found in page');
    }
  }
  
  let questionCount = await page.locator('#permitQuestions li').count();
  console.log(`[BOOKING] Found ${questionCount} permit questions after wait`);

  // Ensure at least one facility is selected so FacilityIds is populated.
  await page.waitForSelector('.facilityList input[type="checkbox"]', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => {
    const facility = document.querySelector('.facilityList input[type="checkbox"]');
    if (facility && !facility.checked) {
      facility.checked = true;
      facility.dispatchEvent(new Event('input', { bubbles: true }));
      facility.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Fill visible permit questions using conservative defaults.
  await page.evaluate((fallbackAnswer) => {
    const defaults = {
      'what activity': 'Tennis court reservation',
      'how many people': '2',
      'are participants charged': 'No',
      'are spectators charged': 'No',
      'table/chair': 'N/A',
      'have you had a permit': 'No',
      'live entertainment': 'No',
      'will the event be advertised': 'No',
      'will there be on site security': 'No',
      'parking needs': 'None'
    };

    const rows = Array.from(document.querySelectorAll('#permitQuestions li'));
    for (const row of rows) {
      const text = (row.textContent || '').toLowerCase();
      let answer = fallbackAnswer;
      for (const [key, value] of Object.entries(defaults)) {
        if (text.includes(key)) {
          answer = value;
          break;
        }
      }

      const select = row.querySelector('select');
      if (select) {
        const options = Array.from(select.options).map((o) => o.text.trim().toLowerCase());
        const noOption = options.find((o) => o === 'no');
        const yesOption = options.find((o) => o === 'yes');
        const target = String(answer).toLowerCase();
        const chosen = options.find((o) => o === target) || (target === 'no' ? noOption : yesOption) || options[0];
        if (chosen) {
          select.value = Array.from(select.options).find((o) => o.text.trim().toLowerCase() === chosen)?.value || select.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        continue;
      }

      const input = row.querySelector('input[type="text"], textarea');
      if (input && !input.value) {
        input.value = answer;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, config.questionDefault);

  console.log('[BOOKING] Building payload for direct API submission...');

  // Get form questions and build responses.
  const responses = await page.evaluate(() => {
    const result = [];
    const questions = document.querySelectorAll('#permitQuestions li');

    questions.forEach((li) => {
      const input = li.querySelector('input:not([type="checkbox"]), select, textarea');
      if (!input) return;

      const elementId = input.getAttribute('name') || input.getAttribute('id');
      if (!elementId) return;

      const stringValue = input.value || '';

      // Collect checkbox values if this is a multi-select
      const checkboxValues = [];
      li.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
        checkboxValues.push(cb.value);
      });

      result.push({
        Id: elementId,
        StringValue: stringValue,
        CheckboxValue: checkboxValues
      });
    });
    
    return result;
  });

  console.log(`[BOOKING] Extracted ${responses.length} permit question responses`);
  if (responses.length === 0) {
    throw new Error('Could not extract permit responses from form.');
  }

  await addDatesForPlans(page, plannedDates, startTime);

  // Build and stage the event group using site-native helpers so submit uses
  // the same internal model as manual form submission.
  const stagedEventInfo = await page.evaluate(() => {
    if (typeof window.getEventGroupInfo !== 'function' || typeof window.addEventGroup !== 'function') {
      return null;
    }

    const eventInfo = window.getEventGroupInfo();
    if (!eventInfo || !Array.isArray(eventInfo.FacilityIds) || !Array.isArray(eventInfo.Dates)) {
      return null;
    }

    window.addEventGroup(eventInfo);
    return {
      facilityCount: eventInfo.FacilityIds.length,
      dateCount: eventInfo.Dates.length,
      eventInfo
    };
  });

  if (!stagedEventInfo || stagedEventInfo.facilityCount === 0 || stagedEventInfo.dateCount === 0) {
    throw new Error('Could not stage event info via native form helpers.');
  }

  console.log(`[BOOKING] Staged native event group: facilities=${stagedEventInfo.facilityCount}, dates=${stagedEventInfo.dateCount}`);

  const selectedFacilities = await page.evaluate(() => {
    const checked = Array.from(document.querySelectorAll('.facilityList input[type="checkbox"]:checked'));
    const all = Array.from(document.querySelectorAll('.facilityList input[type="checkbox"]'));
    const source = checked.length ? checked : all;

    return source.map((input) => {
      const label = input.parentElement?.querySelector('label')?.textContent?.trim() || 'Tennis Courts';
      return {
        facilityId: input.value,
        facilityName: label
      };
    });
  });

  if (selectedFacilities.length === 0) {
    const siteId = await page.locator('#site').inputValue().catch(() => '');
    const fallbackFacility = await page.evaluate(async (currentSiteId) => {
      if (!currentSiteId || typeof window.getFacilityTypes !== 'function') {
        return null;
      }

      return await new Promise((resolve) => {
        window.getFacilityTypes(currentSiteId, (facilities) => {
          const tennis = Array.isArray(facilities)
            ? facilities.find((item) => /tennis/i.test(item?.Name || ''))
            : null;
          if (!tennis) {
            resolve(null);
            return;
          }

          resolve({
            facilityId: tennis.UniqueId,
            facilityName: tennis.Name || 'Tennis Courts'
          });
        });
      });
    }, siteId);

    if (fallbackFacility) {
      selectedFacilities.push(fallbackFacility);
    }
  }

  if (selectedFacilities.length === 0) {
    throw new Error('Could not resolve any facility IDs for payload.');
  }

  // Build events array
  const endTime = addOneHour(startTime);
  const eventsArray = [];
  
  for (const date of plannedDates) {
    // date.usDate format is "MM/DD/YYYY"
    const [month, day, year] = date.usDate.split('/');
    const startDateTime = new Date(
      parseInt(year),
      parseInt(month) - 1,  // Month is 0-indexed in JS Date
      parseInt(day),
      parseInt(startTime.split(':')[0]),
      parseInt(startTime.split(':')[1]));
    const endDateTime = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(endTime.split(':')[0]),
      parseInt(endTime.split(':')[1]));

    console.log(`[BOOKING] Event date: ${formatDateISO(startDateTime)} to ${formatDateISO(endDateTime)}`);

    eventsArray.push({
      FacilityNames: selectedFacilities.map((item) => item.facilityName),
      FacilityIds: selectedFacilities.map((item) => item.facilityId),
      Comments: '',
      Dates: [{
        Start: formatDateISO(startDateTime),
        Stop: formatDateISO(endDateTime)
      }]
    });
  }

  // Build final payload
  // Build final payload with all potentially required fields
  const payload = {
    Activity: 'Tennis court reservation',
    Note: '',
    Comments: '',
    Events: eventsArray,
    IsPrivate: false,
    Responses: responses
  };

  console.log('[BOOKING] Payload built:', JSON.stringify(payload, null, 2).slice(0, 500) + '...');
  return payload;
}

async function submitPermitViaNativeForm(page) {
  const permitResponsePromise = page.waitForResponse((response) => {
    return response.url().includes('/Permits') && response.request().method() === 'POST';
  }, { timeout: 20000 });

  await page.evaluate(() => {
    // Ensure required visible fields are set before invoking native submit path.
    const activity = document.querySelector('#activity');
    if (activity && !activity.value) {
      activity.value = 'Tennis court reservation';
      activity.dispatchEvent(new Event('input', { bubbles: true }));
      activity.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const termsLink = document.querySelector('a[href="/api/FacilityUseTerms"]');
    const termsCheckbox = termsLink
      ? termsLink.closest('p')?.querySelector('input[type="checkbox"]')
      : null;
    if (termsCheckbox && !termsCheckbox.checked) {
      termsCheckbox.checked = true;
      termsCheckbox.dispatchEvent(new Event('input', { bubbles: true }));
      termsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      termsCheckbox.dispatchEvent(new Event('click', { bubbles: true }));
    }

    // Preferred path: call the same function the site uses after form validation.
    if (typeof window.sendEventData === 'function') {
      const addedEvents = [];
      if (window.jQuery) {
        window.jQuery('#addedFacilities li').filter(':visible').not('#noFacilities').each(function () {
          const eventInfo = window.jQuery(this).data('eventInfo');
          if (eventInfo) {
            addedEvents.push(eventInfo);
          }
        });
      }

      if (addedEvents.length > 0) {
        window.sendEventData({
          Activity: activity ? activity.value : 'Tennis court reservation',
          Note: document.querySelector('#requestNotes')?.value || '',
          Comments: document.querySelector('#comments')?.value || '',
          Events: addedEvents
        });
        return;
      }
    }

    // Fallback to form submit if sendEventData is unavailable.
    if (window.jQuery && window.jQuery('#venueInformation').length) {
      window.jQuery('#venueInformation').submit();
      return;
    }

    const form = document.querySelector('#venueInformation');
    if (!form) {
      throw new Error('Venue form not found.');
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  const response = await permitResponsePromise;
  const body = await response.text().catch(() => '');
  return {
    status: response.status(),
    body
  };
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

async function ensureLoggedIn(page, config) {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

  if (page.url().toLowerCase().includes('/account/login')) {
    throw new Error('No authenticated session found. Run npm run bootstrap-login first.');
  }
}

async function submitPermit(page, config, attemptSummary, payload, authCookie) {
  const screenshot = await saveScreenshot(page, 'ready');
  const message = `${attemptSummary}\nScreenshot: ${screenshot}`;

  if (config.planOnly || config.dryRun || config.mode === 'safe') {
    await notify(config, `${message}\nSafe mode active. Final submit was skipped.`);
    return { submitted: false, screenshot };
  }

  try {
    console.log('[BOOKING] Submitting permit via native form submit path...');
    const result = await submitPermitViaNativeForm(page);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status}: ${result.body.slice(0, 500)}`);
    }
    
    const finalShot = await saveScreenshot(page, 'submitted');
    await notify(config, `${attemptSummary}\n✅ Reservation submitted successfully via native Civic submit flow! Screenshot: ${finalShot}`);
    return { submitted: true, screenshot: finalShot };
  } catch (error) {
    console.error('[BOOKING] API submission failed:', error.message);
    throw error;
  }
}

async function submitPermitDirectly(payload, authCookie) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'rioc.civicpermits.com',
      port: 443,
      path: '/Permits',
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
        console.log(`[API] Response: HTTP ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[API] Success! Response data:`, responseData.slice(0, 300));
          resolve({ statusCode: res.statusCode, data: responseData });
        } else {
          console.log(`[API] Error response:`, responseData.slice(0, 1000));
          reject(new Error(`HTTP ${res.statusCode}: ${responseData.slice(0, 500)}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('[API] Network error:', error.message);
      reject(error);
    });
    
    console.log('[API] Sending POST to /Permits with payload size:', Buffer.byteLength(postData), 'bytes');
    req.write(postData);
    req.end();
  });
}

async function main() {
  const config = loadConfig();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await logRunLogStatus();
  const now = new Date();
  const primaryPlannedDates = getReservationPlan(config, now);
  const fallbackPlannedDates = config.targetDate
    ? []
    : getReservationPlanForOffset(config, 1, now)
      .filter((candidate) => !primaryPlannedDates.some((item) => item.isoDate === candidate.isoDate));

  const planMessage = primaryPlannedDates.length
    ? `Primary planned dates (+2d): ${primaryPlannedDates.map((item) => `${item.weekday} ${item.isoDate}`).join(', ')}. Preferred times: ${config.preferredTimes.join(', ')}. Courts: ${config.courtOptions.join(', ')}${fallbackPlannedDates.length ? ` | Fallback (+1d if +2d fails): ${fallbackPlannedDates.map((item) => `${item.weekday} ${item.isoDate}`).join(', ')}` : ''}`
    : 'No eligible reservation dates for the current rule set and preferred weekdays.';

  await notify(config, planMessage);

  if (config.planOnly || primaryPlannedDates.length === 0) {
    return;
  }

  if (!(await fileExists(config.statePath))) {
    throw new Error(`Missing auth state at ${config.statePath}. Run npm run bootstrap-login first.`);
  }

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ storageState: config.statePath });
  const page = await context.newPage();

  try {
    await ensureLoggedIn(page, config);

    const planSets = [
      { label: '+2d', offsetDays: 2, dates: primaryPlannedDates },
      { label: '+1d fallback', offsetDays: 1, dates: fallbackPlannedDates }
    ].filter((item) => item.dates.length > 0);

    for (const planSet of planSets) {
      if (planSet.offsetDays === 1) {
        await notify(config, `Primary +2d attempts failed. Retrying with +1d fallback dates: ${planSet.dates.map((item) => `${item.weekday} ${item.isoDate}`).join(', ')}`);
      }

      for (const startTime of config.preferredTimes) {
        for (const courtLabel of config.courtOptions) {
          const summary = `[${planSet.label}] Attempting ${planSet.dates.map((item) => `${item.weekday} ${item.isoDate}`).join(', ')} at ${startTime} on ${courtLabel}`;
          await notify(config, summary);

          try {
            const payload = await bookViaDirectAPI(page, config, planSet.dates, startTime, courtLabel);

            // Extract authentication cookies
            const cookies = await page.context().cookies();
            const authCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

            const submitResult = await submitPermit(page, config, summary, payload, authCookie);

            await appendRunLog({
              runId,
              status: submitResult.submitted ? 'submitted' : 'safe-skipped',
              mode: config.mode,
              dryRun: config.dryRun,
              courtLabel,
              startTime,
              targetOffsetDays: planSet.offsetDays,
              plannedDates: planSet.dates.map((item) => item.isoDate),
              screenshot: submitResult.screenshot,
              responsesCount: Array.isArray(payload?.Responses) ? payload.Responses.length : 0,
              facilitiesCount: Array.isArray(payload?.Events?.[0]?.FacilityIds) ? payload.Events[0].FacilityIds.length : 0
            });

            // Stop after the first completed attempt (submitted or safe-mode skip).
            return;
          } catch (error) {
            const screenshot = await saveScreenshot(page, 'attempt-failed');
            await appendRunLog({
              runId,
              status: 'failed',
              mode: config.mode,
              dryRun: config.dryRun,
              courtLabel,
              startTime,
              targetOffsetDays: planSet.offsetDays,
              plannedDates: planSet.dates.map((item) => item.isoDate),
              screenshot,
              error: error.message
            });
            await notify(config, `${summary}\nFailed before submit: ${error.message}\nScreenshot: ${screenshot}`);
            await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
          }
        }
      }
    }

    throw new Error('No reservation attempt was executed.');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(async (error) => {
  const config = loadConfig();
  await appendRunLog({
    status: 'run-failed',
    mode: config.mode,
    dryRun: config.dryRun,
    error: error.message
  }).catch(() => {});
  try {
    await notify(config, `Booking run failed: ${error.message}`);
  } catch {
    console.error('Failed to send notification.');
  }

  console.error(error.stack || error.message);
  process.exit(1);
});