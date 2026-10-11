import type { CalendarId } from '../src/data/marketTypes';

/**
 * Exchange calendars and time-zone handling.
 * NYSE regular holidays and scheduled early closes are computed from the published rules.
 * Ad hoc closures (national days of mourning, weather, system outages) are NOT modelled.
 */

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
export const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Anonymous Gregorian algorithm for Easter Sunday. */
export function easterSunday(year: number): { m: number; d: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

const utcDate = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const weekday = (date: Date) => date.getUTCDay(); // 0 Sunday
const keyOf = (date: Date) => dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

function nthWeekday(year: number, month: number, dow: number, n: number) {
  const first = utcDate(year, month, 1);
  const offset = (dow - weekday(first) + 7) % 7;
  return utcDate(year, month, 1 + offset + (n - 1) * 7);
}
function lastWeekday(year: number, month: number, dow: number) {
  const last = utcDate(year, month + 1, 0);
  return utcDate(year, month, last.getUTCDate() - ((weekday(last) - dow + 7) % 7));
}
/** Saturday holidays are observed on Friday and Sunday holidays on Monday, except New Year's Day falling on a Saturday. */
function observed(date: Date, isNewYear = false): Date | null {
  if (weekday(date) === 6) return isNewYear ? null : new Date(date.getTime() - DAY);
  if (weekday(date) === 0) return new Date(date.getTime() + DAY);
  return date;
}

const holidayCache = new Map<number, Map<string, string>>();

export function nyseHolidays(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const map = new Map<string, string>();
  const add = (date: Date | null, name: string) => { if (date) map.set(keyOf(date), name); };
  add(observed(utcDate(year, 1, 1), true), "New Year's Day");
  add(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  add(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  const easter = easterSunday(year);
  add(new Date(utcDate(year, easter.m, easter.d).getTime() - 2 * DAY), 'Good Friday');
  add(lastWeekday(year, 5, 1), 'Memorial Day');
  if (year >= 2022) add(observed(utcDate(year, 6, 19)), 'Juneteenth National Independence Day');
  add(observed(utcDate(year, 7, 4)), 'Independence Day');
  add(nthWeekday(year, 9, 1, 1), 'Labor Day');
  add(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  add(observed(utcDate(year, 12, 25)), 'Christmas Day');
  // A Saturday New Year's Day is not observed on the Friday, but the following New Year's Eve Friday is a normal day.
  holidayCache.set(year, map);
  return map;
}

export function nyseEarlyCloses(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const holidays = nyseHolidays(year);
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  map.set(keyOf(new Date(thanksgiving.getTime() + DAY)), 'Day after Thanksgiving');
  const jul3 = utcDate(year, 7, 3);
  if (weekday(jul3) >= 1 && weekday(jul3) <= 4 && !holidays.has(keyOf(jul3)) && weekday(utcDate(year, 7, 4)) >= 2 && weekday(utcDate(year, 7, 4)) <= 5) map.set(keyOf(jul3), 'Day before Independence Day');
  const dec24 = utcDate(year, 12, 24);
  if (weekday(dec24) >= 1 && weekday(dec24) <= 4 && !holidays.has(keyOf(dec24))) map.set(keyOf(dec24), 'Christmas Eve');
  return map;
}

// ---------------------------------------------------------------- time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(tz, f);
  }
  return f;
}

export type ZonedParts = { date: string; hour: number; minute: number; dow: number };

export function zonedParts(instant: Date | number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')), dow: dowNames.indexOf(get('weekday')) };
}

/** UTC instant of a local wall-clock time (handles daylight-saving offsets). */
export function localToUtc(date: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let utc = guess;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(utc, tz);
    const shown = Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)), p.hour, p.minute);
    const diff = guess - shown;
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

export const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return keyOf(new Date(Date.UTC(y, m - 1, d) + n * DAY));
};
const dowOfDate = (date: string) => { const [y, m, d] = date.split('-').map(Number); return weekday(utcDate(y, m, d)); };

// ---------------------------------------------------------------- sessions

export function isTradingDay(calendar: CalendarId, date: string): boolean {
  if (calendar !== 'XNYS') return true;
  const dow = dowOfDate(date);
  if (dow === 0 || dow === 6) return false;
  return !nyseHolidays(Number(date.slice(0, 4))).has(date);
}

export function sessionName(calendar: CalendarId, date: string): string | null {
  if (calendar !== 'XNYS') return null;
  return nyseHolidays(Number(date.slice(0, 4))).get(date) ?? null;
}

/** Close of the daily bar for a session date, as a UTC instant. */
export function dailyCloseUtc(calendar: CalendarId, date: string): number {
  if (calendar === 'XNYS') {
    const early = nyseEarlyCloses(Number(date.slice(0, 4))).has(date);
    return localToUtc(date, early ? 13 : 16, 0, 'America/New_York');
  }
  return localToUtc(addDays(date, 1), 0, 0, 'UTC');
}

/** Close instants of every daily bar between two dates (inclusive of dates that are trading days). */
export function dailyCloseOn(calendar: CalendarId, date: string): number | null {
  return isTradingDay(calendar, date) ? dailyCloseUtc(calendar, date) : null;
}

/** First daily close at or after `instant` (searches up to 14 days). */
export function firstDailyCloseAtOrAfter(calendar: CalendarId, instant: number): number {
  const tz = calendar === 'XNYS' ? 'America/New_York' : 'UTC';
  let date = addDays(zonedParts(instant, tz).date, -1);
  for (let i = 0; i < 20; i += 1) {
    const close = dailyCloseOn(calendar, date);
    if (close !== null && close >= instant) return close;
    date = addDays(date, 1);
  }
  return instant;
}

/** Last daily close at or before `instant`, with its session date. */
export function lastDailyCloseAtOrBefore(calendar: CalendarId, instant: number): { date: string; close: number } {
  const tz = calendar === 'XNYS' ? 'America/New_York' : 'UTC';
  let date = addDays(zonedParts(instant, tz).date, 1);
  for (let i = 0; i < 20; i += 1) {
    const close = dailyCloseOn(calendar, date);
    if (close !== null && close <= instant) return { date, close };
    date = addDays(date, -1);
  }
  return { date, close: instant };
}

/** Bar close instant for a stored daily bar date. */
export const barCloseForDate = (calendar: CalendarId, date: string) => dailyCloseUtc(calendar, date);

export type SessionMapping = {
  state: 'open' | 'after-close' | 'before-open' | 'weekend' | 'holiday' | 'continuous' | 'daily-spot';
  note: string;
  /** The first daily close that falls after the event. */
  firstCloseAfter: number | null;
};

const fmt = (instant: number, tz: string) => {
  const p = zonedParts(instant, tz);
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)} ${tz === 'UTC' ? 'UTC' : tz === 'America/New_York' ? 'New York time' : tz}`;
};

/** Plain-language disclosure of how an event time maps onto the asset's trading sessions. */
export function mapEventToSession(calendar: CalendarId, anchorMs: number): SessionMapping {
  if (calendar === '24x7') {
    return { state: 'continuous', note: 'Trades continuously, so the event time falls inside a trading period. Prices are taken at hourly and daily bar boundaries (UTC), not at the exact minute of publication.', firstCloseAfter: null };
  }
  if (calendar === 'DAILY_SPOT') {
    return { state: 'daily-spot', note: 'Only one value is published per day and its measurement time is unknown, so each value is treated as known at the end of its UTC day. The pre-event reference is the last full day that ended before publication.', firstCloseAfter: firstDailyCloseAtOrAfter(calendar, anchorMs + 1) };
  }
  const p = zonedParts(anchorMs, 'America/New_York');
  const first = firstDailyCloseAtOrAfter(calendar, anchorMs + 1);
  const closeText = fmt(first, 'America/New_York');
  const holiday = sessionName(calendar, p.date);
  if (holiday) return { state: 'holiday', note: `Published on a market holiday (${holiday}); the market was closed. The reference is the last close before publication and the first close after it is ${closeText}.`, firstCloseAfter: first };
  if (p.dow === 0 || p.dow === 6) return { state: 'weekend', note: `Published at the weekend while the market was closed. The reference is the last close before publication and the first close after it is ${closeText}.`, firstCloseAfter: first };
  const close = dailyCloseUtc(calendar, p.date);
  const open = localToUtc(p.date, 9, 30, 'America/New_York');
  if (anchorMs < open) return { state: 'before-open', note: `Published before the market opened. The reference is the previous close; the first close after publication is ${closeText}.`, firstCloseAfter: first };
  if (anchorMs >= close) return { state: 'after-close', note: `Published after the close. The reference is that day's close and the first close after publication is ${closeText}, so the first reaction appears at the next session.`, firstCloseAfter: first };
  return { state: 'open', note: `Published while the market was open. Daily data cannot isolate the minute of publication: the reference is the previous close, so the first measured return also contains price moves from before publication. The first close after publication is ${closeText}.`, firstCloseAfter: first };
}
