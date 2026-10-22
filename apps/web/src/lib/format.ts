const TZ = 'Europe/Dublin';

export const fmtDate = (v: string | Date | null | undefined) =>
  v ? new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(v)) : '—';

export const fmtDateTime = (v: string | Date | null | undefined) =>
  v ? new Intl.DateTimeFormat('en-IE', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v)) : '—';

export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return 'never';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (Math.abs(diff) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en-IE', { numeric: 'auto' });
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31557600],
    ['month', 2629800],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of table) if (Math.abs(diff) >= secs) return rtf.format(-Math.round(diff / secs), unit);
  return rtf.format(-Math.round(diff), 'second');
}

export const fmtNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-IE').format(n));
export const fmtEuro = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '—' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const fmtBytes = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
export const fmtDuration = (ms: number | null | undefined) => (ms ? `${(ms / 1000).toFixed(1)} s` : '—');

/** "2026-10-22T09:00" for <input type="datetime-local">, in Dublin time. */
export function toLocalInput(v: string | Date): string {
  const d = new Date(v);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Interprets a datetime-local value as Dublin wall-clock time and returns an ISO instant. */
export function fromLocalInput(value: string): string {
  const [date, time] = value.split('T');
  const [y, mo, d] = date!.split('-').map(Number);
  const [h, mi] = time!.split(':').map(Number);
  // Start from the UTC guess, then correct by Dublin's offset at that instant (handles DST).
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const local = new Date(toLocalInput(new Date(guess)) + ':00Z').getTime();
  return new Date(guess - (local - guess)).toISOString();
}

export const minutesToHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hhmmToMinutes = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return h! * 60 + m!;
};
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
