const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatUsDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function normalizeWeekday(day) {
  return day.slice(0, 1).toUpperCase() + day.slice(1, 3).toLowerCase();
}

export function getReservationPlan(config, now = new Date()) {
  const preferredWeekdays = new Set(config.preferredWeekdays.map(normalizeWeekday));

  if (config.targetDate) {
    const explicitDate = new Date(`${config.targetDate}T12:00:00`);
    return [explicitDate]
      .filter((date) => !Number.isNaN(date.getTime()))
      .filter((date) => preferredWeekdays.has(WEEKDAYS[date.getDay()]))
      .map((date) => ({
        isoDate: formatIsoDate(date),
        usDate: formatUsDate(date),
        weekday: WEEKDAYS[date.getDay()]
      }));
  }

  return getReservationPlanForOffset(config, 2, now);
}

export function getReservationPlanForOffset(config, offsetDays, now = new Date()) {
  const preferredWeekdays = new Set(config.preferredWeekdays.map(normalizeWeekday));
  const candidates = [addDays(now, offsetDays)];

  return candidates
    .filter((date) => preferredWeekdays.has(WEEKDAYS[date.getDay()]))
    .map((date) => ({
      isoDate: formatIsoDate(date),
      usDate: formatUsDate(date),
      weekday: WEEKDAYS[date.getDay()]
    }));
}

export function addOneHour(time) {
  const [hoursText, minutesText] = time.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const totalMinutes = hours * 60 + minutes + 60;
  const endHours = Math.floor(totalMinutes / 60) % 24;
  const endMinutes = totalMinutes % 60;
  return `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;
}