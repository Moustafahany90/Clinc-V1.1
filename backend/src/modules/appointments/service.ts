import type {
  AppointmentStatus,
  DoctorAvailability,
  Prisma,
  ScheduleException,
  WorkingHours,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  clinicDateString,
  clinicDayRange,
  clinicLocalToUtc,
  clinicMinutesOfDay,
  dateOnlyToDb,
  isoWeekday,
} from '../../lib/time.js';

/** Statuses that still occupy the doctor's calendar. */
export const ACTIVE_STATUSES: AppointmentStatus[] = [
  'BOOKED',
  'CONFIRMED',
  'ARRIVED',
  'WAITING',
  'IN_EXAM',
  'REPORT_REVIEW',
];

export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  BOOKED: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['ARRIVED', 'CANCELLED', 'NO_SHOW'],
  ARRIVED: ['WAITING', 'CANCELLED', 'NO_SHOW'],
  WAITING: ['IN_EXAM', 'CANCELLED', 'NO_SHOW'],
  IN_EXAM: ['REPORT_REVIEW', 'CANCELLED'],
  REPORT_REVIEW: ['DONE', 'IN_EXAM'],
  DONE: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export type Tx = Prisma.TransactionClient;

/**
 * Serialise all writes for one doctor's calendar. A Postgres advisory lock
 * makes concurrent booking attempts queue up, and the exclusion constraint
 * (see migration) is the final backstop.
 */
export async function lockDoctorCalendar(tx: Tx, doctorId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${doctorId}))`;
}

export async function findOverlap(
  tx: Tx,
  doctorId: string,
  startAt: Date,
  endAt: Date,
  excludeId?: string,
) {
  return tx.appointment.findFirst({
    where: {
      doctorId,
      status: { in: ACTIVE_STATUSES },
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, startAt: true, endAt: true, patientId: true },
  });
}

export interface ScheduleWindow {
  isOpen: boolean;
  openMinute: number;
  closeMinute: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  source: 'doctor' | 'clinic' | 'exception' | 'none';
  reason?: string;
}

function closedWindow(
  source: ScheduleWindow['source'],
  reason: string,
): ScheduleWindow {
  return {
    isOpen: false,
    openMinute: 0,
    closeMinute: 0,
    breakStartMinute: null,
    breakEndMinute: null,
    source,
    reason,
  };
}

interface Window {
  openMinute: number;
  closeMinute: number;
}

/**
 * A doctor's availability further restricts the clinic window; it never
 * extends it and never re-opens a day the clinic is closed.
 */
function combineWindows(
  clinic: Window,
  doctor: { isWorking: boolean; openMinute: number; closeMinute: number } | null,
  doctorBreak: { start: number; end: number } | null,
  source: ScheduleWindow['source'],
): ScheduleWindow {
  if (doctor && !doctor.isWorking) {
    return closedWindow('doctor', 'Doctor is not working on this weekday');
  }

  const openMinute = Math.max(clinic.openMinute, doctor?.openMinute ?? clinic.openMinute);
  const closeMinute = Math.min(clinic.closeMinute, doctor?.closeMinute ?? clinic.closeMinute);

  if (openMinute >= closeMinute) {
    return closedWindow(
      doctor ? 'doctor' : source,
      'Doctor working hours do not overlap the clinic opening hours',
    );
  }

  // Clip the clinic break to the effective window. A break that falls entirely
  // outside the doctor's shifted hours must not make the whole day unbookable.
  let breakStartMinute: number | null = null;
  let breakEndMinute: number | null = null;
  if (doctorBreak) {
    const start = Math.max(doctorBreak.start, openMinute);
    const end = Math.min(doctorBreak.end, closeMinute);
    if (start < end) {
      breakStartMinute = start;
      breakEndMinute = end;
    }
  }

  return {
    isOpen: true,
    openMinute,
    closeMinute,
    breakStartMinute,
    breakEndMinute,
    source,
  };
}

/** Everything `resolveScheduleFromRows` needs for one doctor/day. */
export interface ScheduleRows {
  weekday: number;
  doctorException: ScheduleException | null;
  clinicException: ScheduleException | null;
  doctorHours: DoctorAvailability | null;
  clinicHours: WorkingHours | null;
}

/**
 * Pure schedule decision. `resolveSchedule` (single day) and
 * `buildSlotsForDates` (ranges) both funnel through this function so the
 * precedence rules only exist in one place.
 */
export function resolveScheduleFromRows(rows: ScheduleRows): ScheduleWindow {
  const { doctorException, clinicException, doctorHours, clinicHours } = rows;

  const clinicBreak =
    clinicHours?.breakStartMinute != null && clinicHours.breakEndMinute != null
      ? { start: clinicHours.breakStartMinute, end: clinicHours.breakEndMinute }
      : null;

  // Most specific first: a per-doctor exception is an explicit instruction for
  // this doctor only, so it may open an otherwise closed day/shift.
  if (doctorException) {
    if (doctorException.isClosed) {
      return closedWindow(
        'exception',
        doctorException.reason ?? 'Doctor unavailable on this date',
      );
    }
    const fallback = combineWindows(
      {
        openMinute: clinicHours?.isOpen ? clinicHours.openMinute : 780,
        closeMinute: clinicHours?.isOpen ? clinicHours.closeMinute : 1260,
      },
      doctorHours,
      null,
      'exception',
    );
    return {
      isOpen: true,
      openMinute: doctorException.openMinute ?? (fallback.isOpen ? fallback.openMinute : 780),
      closeMinute: doctorException.closeMinute ?? (fallback.isOpen ? fallback.closeMinute : 1260),
      breakStartMinute: fallback.breakStartMinute,
      breakEndMinute: fallback.breakEndMinute,
      source: 'exception',
    };
  }

  // A clinic-wide exception changes the clinic window. It never overrides an
  // individual doctor's day off or availability.
  if (clinicException) {
    if (clinicException.isClosed) {
      return closedWindow(
        'exception',
        clinicException.reason ?? 'Clinic closed on this date',
      );
    }
    const clinicWindow = {
      openMinute: clinicException.openMinute ?? clinicHours?.openMinute ?? 780,
      closeMinute: clinicException.closeMinute ?? clinicHours?.closeMinute ?? 1260,
    };
    if (clinicWindow.openMinute >= clinicWindow.closeMinute) {
      return closedWindow('exception', 'The special opening hours are invalid');
    }
    return combineWindows(clinicWindow, doctorHours, clinicBreak, 'exception');
  }

  if (!clinicHours || !clinicHours.isOpen) {
    return closedWindow('clinic', 'Clinic is closed on this weekday');
  }

  return combineWindows(
    { openMinute: clinicHours.openMinute, closeMinute: clinicHours.closeMinute },
    doctorHours,
    clinicBreak,
    doctorHours ? 'doctor' : 'clinic',
  );
}

export async function resolveSchedule(
  doctorId: string,
  dateOnly: string,
): Promise<ScheduleWindow> {
  const weekday = isoWeekday(dateOnly);
  const dbDate = dateOnlyToDb(dateOnly);

  const [doctorException, clinicException, doctorHours, clinicHours] = await Promise.all([
    prisma.scheduleException.findFirst({
      where: { doctorId, date: dbDate },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.scheduleException.findFirst({
      where: { doctorId: null, date: dbDate },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.doctorAvailability.findUnique({
      where: { doctorId_dayOfWeek: { doctorId, dayOfWeek: weekday } },
    }),
    prisma.workingHours.findUnique({ where: { dayOfWeek: weekday } }),
  ]);

  return resolveScheduleFromRows({
    weekday,
    doctorException,
    clinicException,
    doctorHours,
    clinicHours,
  });
}

/**
 * Bulk schedule lookup for a range of days with one query per source instead
 * of one per day. Feeds `buildSlotsForDates`.
 */
export async function resolveScheduleForDates(
  doctorId: string,
  dates: string[],
): Promise<Map<string, ScheduleWindow>> {
  if (dates.length === 0) return new Map();
  const rows = await loadScheduleRows(doctorId, dates);
  return new Map(dates.map((date) => [date, resolveScheduleFromRows(rows.get(date)!)]));
}

async function loadScheduleRows(
  doctorId: string,
  dates: string[],
): Promise<Map<string, ScheduleRows>> {
  const dbDates = new Map(dates.map((date) => [date, dateOnlyToDb(date)]));

  const [workingHours, availability, exceptions] = await Promise.all([
    prisma.workingHours.findMany(),
    prisma.doctorAvailability.findMany({ where: { doctorId } }),
    prisma.scheduleException.findMany({
      where: { date: { in: [...dbDates.values()] }, OR: [{ doctorId }, { doctorId: null }] },
      orderBy: [{ date: 'asc' }, { createdAt: 'desc' }],
    }),
  ]);

  const hoursByWeekday = new Map(workingHours.map((row) => [row.dayOfWeek, row]));
  const availabilityByWeekday = new Map(availability.map((row) => [row.dayOfWeek, row]));

  const result = new Map<string, ScheduleRows>();
  for (const date of dates) {
    const dbDate = dbDates.get(date)!;
    const dayExceptions = exceptions.filter((row) => row.date.getTime() === dbDate.getTime());
    const weekday = isoWeekday(date);
    result.set(date, {
      weekday,
      doctorException: dayExceptions.find((row) => row.doctorId === doctorId) ?? null,
      clinicException: dayExceptions.find((row) => row.doctorId === null) ?? null,
      doctorHours: availabilityByWeekday.get(weekday) ?? null,
      clinicHours: hoursByWeekday.get(weekday) ?? null,
    });
  }
  return result;
}

export function isWithinWindow(
  window: ScheduleWindow,
  startMinute: number,
  endMinute: number,
): { ok: boolean; reason?: string } {
  if (!window.isOpen) return { ok: false, reason: window.reason ?? 'Outside working hours' };
  if (startMinute < window.openMinute) return { ok: false, reason: 'Starts before opening time' };
  if (endMinute > window.closeMinute) return { ok: false, reason: 'Ends after closing time' };
  if (
    window.breakStartMinute !== null &&
    window.breakEndMinute !== null &&
    startMinute < window.breakEndMinute &&
    endMinute > window.breakStartMinute
  ) {
    return { ok: false, reason: 'Overlaps the clinic break' };
  }
  return { ok: true };
}

export interface Slot {
  start: string; // ISO UTC
  end: string;
  minute: number;
  available: boolean;
  conflictWith?: string;
}

/** A day of availability for a doctor, used by range endpoints. */
export interface DateSchedule {
  date: string;
  window: ScheduleWindow;
  slots: Slot[];
}

/**
 * Pure slot grid for one resolved window. `buildDaySlots` and
 * `buildSlotsForDates` share it so availability cannot diverge.
 */
export function slotsForWindow(
  window: ScheduleWindow,
  dateOnly: string,
  durationMinutes: number,
  slotIntervalMinutes: number,
  booked: Array<{ id: string; startAt: Date; endAt: Date }>,
  now: Date = new Date(),
): Slot[] {
  if (!window.isOpen) return [];

  const slots: Slot[] = [];
  const interval = Math.max(5, slotIntervalMinutes);

  for (let minute = window.openMinute; minute + durationMinutes <= window.closeMinute; minute += interval) {
    if (
      window.breakStartMinute !== null &&
      window.breakEndMinute !== null &&
      minute < window.breakEndMinute &&
      minute + durationMinutes > window.breakStartMinute
    ) {
      continue;
    }
    const start = clinicLocalToUtc(dateOnly, minute);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    if (start.getTime() < now.getTime()) continue;

    const conflict = booked.find((b) => b.startAt < end && b.endAt > start);
    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      minute,
      available: !conflict,
      ...(conflict ? { conflictWith: conflict.id } : {}),
    });
  }

  return slots;
}

export async function buildDaySlots(
  doctorId: string,
  dateOnly: string,
  durationMinutes: number,
  slotIntervalMinutes: number,
): Promise<{ window: ScheduleWindow; slots: Slot[] }> {
  const [window, booked] = await Promise.all([
    resolveSchedule(doctorId, dateOnly),
    prisma.appointment.findMany({
      where: {
        doctorId,
        status: { in: ACTIVE_STATUSES },
        startAt: { lt: clinicDayRange(dateOnly).end },
        endAt: { gt: clinicDayRange(dateOnly).start },
      },
      select: { id: true, startAt: true, endAt: true },
    }),
  ]);

  return {
    window,
    slots: slotsForWindow(window, dateOnly, durationMinutes, slotIntervalMinutes, booked),
  };
}

/**
 * Availability for several consecutive clinic days with a bounded number of
 * queries (one per source for the whole range). Used by quick actions; the
 * per-day result is identical to calling `buildDaySlots` for each date.
 */
export async function buildSlotsForDates(
  doctorId: string,
  dates: string[],
  durationMinutes: number,
  slotIntervalMinutes: number,
  now: Date = new Date(),
): Promise<DateSchedule[]> {
  if (dates.length === 0) return [];
  const ordered = [...dates].sort();
  const rows = await loadScheduleRows(doctorId, ordered);

  const rangeStart = clinicDayRange(ordered[0]!).start;
  const rangeEnd = clinicDayRange(ordered[ordered.length - 1]!).end;
  const booked = await prisma.appointment.findMany({
    where: {
      doctorId,
      status: { in: ACTIVE_STATUSES },
      startAt: { lt: rangeEnd },
      endAt: { gt: rangeStart },
    },
    select: { id: true, startAt: true, endAt: true },
  });

  return ordered.map((date) => {
    const window = resolveScheduleFromRows(rows.get(date)!);
    const { start, end } = clinicDayRange(date);
    const dayBooked = booked.filter((b) => b.startAt < end && b.endAt > start);
    return {
      date,
      window,
      slots: slotsForWindow(window, date, durationMinutes, slotIntervalMinutes, dayBooked, now),
    };
  });
}

export function assertTransitionAllowed(
  from: AppointmentStatus,
  to: AppointmentStatus,
): { ok: boolean; reason?: string } {
  if (from === to) return { ok: true };
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `Cannot move an appointment from ${from} to ${to}.` };
  }
  return { ok: true };
}

export function appointmentDay(date: Date = new Date()): string {
  return clinicDateString(date);
}

export function minutesOfDay(date: Date): number {
  return clinicMinutesOfDay(date);
}
