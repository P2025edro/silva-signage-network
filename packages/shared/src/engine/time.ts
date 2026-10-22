import type { DayKey, OpeningHours, WeeklySchedule } from './types.js';

export const DEFAULT_TIMEZONE = 'Europe/Dublin';
const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const SHORT_TO_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  isoWeekday: number;
  minuteOfDay: number;
  /** YYYY-MM-DD in local time. */
  date: string;
}

/** Wall-clock parts of an instant in a time zone. Handles daylight saving via the IANA database. */
export function localParts(instant: Date, timeZone: string = DEFAULT_TIMEZONE): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const isoWeekday = SHORT_TO_ISO[parts.weekday ?? ''];
  if (!isoWeekday) throw new Error(`Unexpected weekday from Intl: ${parts.weekday}`);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    isoWeekday,
    minuteOfDay: hour * 60 + minute,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function parseHHMM(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}

export function isWithinSchedule(schedule: WeeklySchedule | null, instant: Date, timeZone: string): boolean {
  if (!schedule) return true;
  const { isoWeekday, minuteOfDay } = localParts(instant, timeZone);
  return schedule.days.includes(isoWeekday) && minuteOfDay >= schedule.startMinute && minuteOfDay < schedule.endMinute;
}

/**
 * Whether a location is open. null opening hours means "not recorded": treated as open,
 * because the TV's own power schedule is the practical limit in that case.
 */
export function isLocationOpen(hours: OpeningHours | null, instant: Date, timeZone: string): boolean {
  if (!hours) return true;
  const { isoWeekday, minuteOfDay } = localParts(instant, timeZone);
  const today = DAY_KEYS[isoWeekday - 1]!;
  const yesterday = DAY_KEYS[(isoWeekday + 5) % 7]!;

  for (const interval of hours[today] ?? []) {
    const open = parseHHMM(interval.open);
    const close = parseHHMM(interval.close);
    if (close > open) {
      if (minuteOfDay >= open && minuteOfDay < close) return true;
    } else if (minuteOfDay >= open) {
      return true; // overnight interval, before midnight
    }
  }
  for (const interval of hours[yesterday] ?? []) {
    const open = parseHHMM(interval.open);
    const close = parseHHMM(interval.close);
    if (close <= open && minuteOfDay < close) return true; // overnight interval, after midnight
  }
  return false;
}

/** Minutes the location is open on a given ISO weekday (used for capacity estimates). */
export function openMinutesOnDay(hours: OpeningHours | null, isoWeekday: number): number {
  if (!hours) return 24 * 60;
  const key = DAY_KEYS[isoWeekday - 1]!;
  let total = 0;
  for (const interval of hours[key] ?? []) {
    const open = parseHHMM(interval.open);
    const close = parseHHMM(interval.close);
    total += close > open ? close - open : 24 * 60 - open + close;
  }
  return Math.min(total, 24 * 60);
}

const QUARTER_MS = 15 * 60 * 1000;
/**
 * Next 15-minute boundary strictly after the instant. Irish (and all whole-hour)
 * UTC offsets keep UTC and local quarter-hours aligned, and schedules are
 * restricted to 15-minute steps, so playlists regenerated on these boundaries
 * never miss a schedule edge.
 */
export function nextQuarterHour(instant: Date): Date {
  return new Date((Math.floor(instant.getTime() / QUARTER_MS) + 1) * QUARTER_MS);
}

export function validateSchedule(schedule: WeeklySchedule): string[] {
  const errors: string[] = [];
  if (schedule.days.length === 0) errors.push('At least one day is required');
  if (schedule.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) errors.push('Days must be 1 (Mon) to 7 (Sun)');
  if (new Set(schedule.days).size !== schedule.days.length) errors.push('Days must not repeat');
  for (const [name, v] of [
    ['startMinute', schedule.startMinute],
    ['endMinute', schedule.endMinute],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 1440 || v % 15 !== 0) errors.push(`${name} must be a multiple of 15 between 0 and 1440`);
  }
  if (schedule.endMinute <= schedule.startMinute) errors.push('endMinute must be after startMinute');
  return errors;
}
