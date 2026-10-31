export const DEFAULT_TZ = 'Africa/Cairo';
export const DEFAULT_CURRENCY = 'EGP';

const pad = (n: number) => String(n).padStart(2, '0');

export function todayInZone(timeZone = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
}

/** Add or subtract whole days from a YYYY-MM-DD string without timezone drift. */
export function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(dateOnly: string, months: number): string {
  const d = new Date(`${dateOnly}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function startOfMonth(dateOnly: string): string {
  return `${dateOnly.slice(0, 7)}-01`;
}

export function endOfMonth(dateOnly: string): string {
  const d = new Date(`${dateOnly.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export function weekdayName(dateOnly: string, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: style, timeZone: 'UTC' }).format(
    new Date(`${dateOnly}T12:00:00Z`),
  );
}

export function formatDateOnly(dateOnly: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!dateOnly) return '—';
  const d = new Date(`${dateOnly.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
    ...opts,
  }).format(d);
}

export function formatLongDate(dateOnly: string): string {
  return formatDateOnly(dateOnly, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "October 2026" for a YYYY-MM or YYYY-MM-DD value. */
export function formatMonthLabel(dateOnly: string): string {
  const d = new Date(`${dateOnly.slice(0, 7)}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export function formatTime(iso: string | Date | null | undefined, timeZone = DEFAULT_TZ, hour12 = true): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12,
    timeZone,
  }).format(d);
}

export function formatDateTime(iso: string | null | undefined, timeZone = DEFAULT_TZ, hour12 = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12,
    timeZone,
  }).format(d);
}

export function formatDateInZone(iso: string | null | undefined, timeZone = DEFAULT_TZ): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(d);
}

export function dateOnlyInZone(iso: string, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/** Clock label for a minute offset from midnight (780 -> 1:00 PM). */
export function minutesToLabel(minutes: number, hour12 = true): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const min = pad(m % 60);
  if (!hour12) {
    return `${pad(hour24)}:${min}`;
  }
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12Val = hour24 % 12 || 12;
  return `${hour12Val}:${min} ${period}`;
}

/** Parse HH:MM or HH:MM AM/PM into minutes from midnight; returns null when invalid. */
export function labelToMinutes(label: string): number | null {
  const trimmed = label.trim();
  const match = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i.exec(trimmed);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (m < 0 || m > 59) return null;
  if (period) {
    if (h < 1 || h > 12) return null;
    if (period === 'PM' && h < 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
  } else {
    if (h < 0 || h > 23) return null;
  }
  return h * 60 + m;
}

export function minutesToHours(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function secondsToClock(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}

export function ageFromDob(dateOfBirth: string | null | undefined): string {
  if (!dateOfBirth) return '';
  const dob = new Date(`${dateOfBirth.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(dob.getTime())) return '';
  const now = new Date();
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (years < 0) return '';
  return `${years} yrs`;
}
