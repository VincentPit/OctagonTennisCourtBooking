import dotenv from 'dotenv';

dotenv.config();

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseList(value, fallback = []) {
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig() {
  return {
    baseUrl: process.env.BASE_URL || 'https://rioc.civicpermits.com',
    loginUrl: process.env.LOGIN_URL || 'https://rioc.civicpermits.com/Account/Login',
    statePath: process.env.STATE_PATH || '.auth/storage-state.json',
    mode: process.env.MODE || 'safe',
    headless: parseBool(process.env.HEADLESS, false),
    dryRun: parseBool(process.env.DRY_RUN, true),
    planOnly: parseBool(process.env.PLAN_ONLY, false),
    activityType: process.env.ACTIVITY_TYPE || 'Tennis',
    location: process.env.LOCATION || '',
    facilityLabel: process.env.FACILITY_LABEL || 'Tennis Courts',
    courtOptions: parseList(process.env.COURT_OPTIONS, [
      'Octagon Tennis court 3',
      'Octagon Tennis Court 1',
      'Octagon Tennis court 2',
      'Octagon Tennis Court 4',
      'Octagon Tennis Court 5',
      'Octagon Tennis Court 6'
    ]),
    preferredWeekdays: parseList(process.env.PREFERRED_WEEKDAYS, [
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun'
    ]),
    preferredTimes: parseList(process.env.PREFERRED_TIMES, ['20:00']),
    targetDate: process.env.TARGET_DATE || '',
    questionDefault: process.env.QUESTION_DEFAULT || 'N/A',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
  };
}