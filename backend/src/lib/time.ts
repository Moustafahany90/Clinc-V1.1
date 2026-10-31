import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { env } from '../config/env.js';

/**
 * Active clinic timezone. Starts from the deployment default and is replaced
 * with the value stored in ClinicSettings as soon as settings are loaded, so
 * scheduling follows the timezone the administrator configured in the UI.
 */
let clinicTimezone = process.env.APP_TIMEZONE || 'Africa/Cairo';
export const CLINIC_CURRENCY = process.env.APP_CURRENCY || 'EGP';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function clinicTimezoneName(): string {
  return clinicTimezone;
}

export function setClinicTimezone(timezone: string): void {
  if (!timezone || timezone === clinicTimezone) return;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    return;
  }
  clinicTimezone = timezone;
}

/** True for YYYY-MM-DD that is a real calendar date. */
export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Clinic-local calendar date for an instant, e.g. 2026-03-01. */
export function clinicDateString(instant: Date = new Date()): string {
  return formatInTimeZone(instant, clinicTimezone, 'yyyy-MM-dd');
}

/**
 * Convert a clinic-local date (and optional time) to a UTC instant.
 * `minutesFromMidnight` 13:00 = 780.
 */
export function clinicLocalToUtc(dateOnly: string, minutesFromMidnight = 0): Date {
  if (!isValidDateOnly(dateOnly)) throw new Error(`Invalid date: ${dateOnly}`);
  const hh = String(Math.floor(minutesFromMidnight / 60)).padStart(2, '0');
  const mm = String(minutesFromMidnight % 60).padStart(2, '0');
  return fromZonedTime(`${dateOnly}T${hh}:${mm}:00`, clinicTimezone);
}

/** UTC range [start, end) covering one clinic-local day. */
export function clinicDayRange(dateOnly: string): { start: Date; end: Date } {
  const start = clinicLocalToUtc(dateOnly, 0);
  // Advance the calendar date in UTC, then convert the next local midnight.
  // Adding a flat 24 h is wrong on DST transition days.
  const next = new Date(`${dateOnly}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = clinicLocalToUtc(next.toISOString().slice(0, 10), 0);
  return { start, end };
}

/** UTC range [start, end) covering one clinic-local month (month = 1..12). */
export function clinicMonthRange(year: number, month: number): { start: Date; end: Date } {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const start = clinicLocalToUtc(startDate, 0);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = clinicLocalToUtc(
    `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    0,
  );
  return { start, end };
}

/** Postgres @db.Date value for a clinic-local date. */
export function dateOnlyToDb(dateOnly: string): Date {
  if (!isValidDateOnly(dateOnly)) throw new Error(`Invalid date: ${dateOnly}`);
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

export function dbDateToDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export function isoWeekday(dateOnly: string): number {
  const day = new Date(`${dateOnly}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** Minutes from midnight for an instant, in clinic-local time. */
export function clinicMinutesOfDay(instant: Date): number {
  const local = toZonedTime(instant, clinicTimezone);
  return local.getHours() * 60 + local.getMinutes();
}

export function formatClinicDateTime(instant: Date): string {
  return formatInTimeZone(instant, clinicTimezone, 'yyyy-MM-dd HH:mm');
}

export function formatClinicTime(instant: Date): string {
  return formatInTimeZone(instant, clinicTimezone, 'HH:mm');
}

export function formatMoney(minor: number): string {
  const amount = (minor / 100).toFixed(2);
  return `${CLINIC_CURRENCY} ${amount}`;
}

export function minutesToLabel(minutes: number): string {
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const DEFAULT_APP_ORIGIN = env.APP_ORIGIN;
