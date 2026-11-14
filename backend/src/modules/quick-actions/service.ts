import type { AppointmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import type { AuthUser } from '../../lib/authTypes.js';
import {
  addDaysDateOnly,
  clinicDateString,
  clinicDayRange,
  clinicWeekRange,
  isoWeekday,
} from '../../lib/time.js';
import { getClinicSettings } from '../../lib/clinic.js';
import { buildSlotsForDoctorDates } from '../appointments/service.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_DOCTOR_SCHEDULE_DAYS,
  MAX_LIST_LIMIT,
  NEXT_AVAILABLE_HORIZON_DAYS,
} from './constants.js';

export interface DoctorSummary {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * A doctor only ever sees their own calendar. Administrators and receptionists
 * may ask for any active doctor, or for every active doctor when they omit the
 * filter.
 */
function scopedDoctorId(me: AuthUser, requested?: string): string | undefined {
  return me.role === 'DOCTOR' ? me.id : requested;
}

async function loadActiveDoctors(doctorId?: string): Promise<DoctorSummary[]> {
  const doctors = await prisma.user.findMany({
    where: { role: 'DOCTOR', isActive: true, ...(doctorId ? { id: doctorId } : {}) },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  if (doctorId && doctors.length === 0) throw badRequest('Select an active doctor.');
  return doctors;
}

/** Resolve the clinic settings (and therefore the active timezone) plus the
 * appointment duration the booking engine would use for this request. */
async function loadServiceContext(serviceId?: string) {
  const settings = await getClinicSettings();
  if (!serviceId) {
    return { settings, durationMinutes: settings.defaultAppointmentMinutes, service: null };
  }
  const service = await prisma.service.findFirst({
    where: { id: serviceId, isActive: true },
    select: { id: true, name: true, durationMinutes: true },
  });
  if (!service) throw badRequest('Select an active service.');
  return { settings, durationMinutes: service.durationMinutes, service };
}

function clampLimit(value?: number): number {
  if (!value) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(value)));
}

/** Whole days from `from` to `to`, inclusive, on the calendar (DST-safe). */
function inclusiveDaySpan(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000) + 1;
}

const appointmentSelect = {
  id: true,
  startAt: true,
  endAt: true,
  durationMinutes: true,
  status: true,
  reason: true,
  doctor: { select: { id: true, firstName: true, lastName: true } },
  service: { select: { id: true, name: true } },
  patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
  queueEntry: { select: { status: true } },
} as const;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof appointmentSelect }>;

function serialiseAppointment(row: AppointmentRow, canViewPatientNames: boolean) {
  return {
    id: row.id,
    startAt: row.startAt,
    endAt: row.endAt,
    durationMinutes: row.durationMinutes,
    status: row.status,
    reason: row.reason,
    doctor: row.doctor,
    service: row.service,
    // Patient identities are only returned to callers with PATIENTS_READ.
    patient: canViewPatientNames ? row.patient : null,
    queueStatus: row.queueEntry?.status ?? null,
  };
}

/**
 * Action 1 - available slots today, grouped by doctor. Slots come from the same
 * engine that powers `GET /appointments/agenda`, so occupied, past and
 * out-of-hours times are never offered.
 */
export async function getAvailableAppointmentsToday(
  me: AuthUser,
  query: { doctorId?: string; serviceId?: string } = {},
) {
  const { settings, durationMinutes } = await loadServiceContext(query.serviceId);
  const today = clinicDateString();
  const requested = scopedDoctorId(me, query.doctorId);
  const doctors = await loadActiveDoctors(requested);

  const schedules = await buildSlotsForDoctorDates(
    doctors.map((doctor) => doctor.id),
    [today],
    durationMinutes,
    settings.slotIntervalMinutes,
  );
  const byDoctor = new Map(schedules.map((schedule) => [schedule.doctorId, schedule]));

  const doctorRows = doctors.map((doctor) => {
    const schedule = byDoctor.get(doctor.id)!;
    const available = schedule.slots.filter((slot) => slot.available);
    return {
      doctor,
      isOpen: schedule.window.isOpen,
      openingHours: schedule.window,
      availableCount: available.length,
      slots: available,
    };
  });

  return {
    date: today,
    timezone: settings.timezone,
    durationMinutes,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    doctorId: requested ?? null,
    serviceId: query.serviceId ?? null,
    totalAvailable: doctorRows.reduce((sum, row) => sum + row.availableCount, 0),
    doctors: doctorRows,
  };
}

/**
 * Action 2 - every appointment scheduled today, including cancelled and
 * no-show rows so reception can see the full day.
 */
export async function getTodayAppointments(
  me: AuthUser,
  query: { doctorId?: string; status?: AppointmentStatus; limit?: number } = {},
) {
  const settings = await getClinicSettings();
  const today = clinicDateString();
  const range = clinicDayRange(today);
  const requested = scopedDoctorId(me, query.doctorId);
  if (requested) await loadActiveDoctors(requested);

  const canViewPatientNames = hasPermission(me, 'PATIENTS_READ');
  const limit = clampLimit(query.limit);
  const where: Prisma.AppointmentWhereInput = {
    ...(requested ? { doctorId: requested } : {}),
    ...(query.status ? { status: query.status } : {}),
    startAt: { gte: range.start, lt: range.end },
  };

  const [total, rows] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      orderBy: [{ startAt: 'asc' }],
      take: limit,
      select: appointmentSelect,
    }),
  ]);

  return {
    date: today,
    timezone: settings.timezone,
    doctorId: requested ?? null,
    status: query.status ?? null,
    canViewPatientNames,
    total,
    limit,
    hasMore: total > limit,
    appointments: rows.map((row) => serialiseAppointment(row, canViewPatientNames)),
  };
}

/**
 * Action 3 - available slots for the clinic week (Saturday -> Friday),
 * grouped by date with the doctor attached to every slot.
 */
export async function getWeeklyAvailability(
  me: AuthUser,
  query: { weekStart?: string; doctorId?: string; serviceId?: string } = {},
) {
  const { settings, durationMinutes } = await loadServiceContext(query.serviceId);
  const today = clinicDateString();
  const week = clinicWeekRange(query.weekStart ?? today);
  const requested = scopedDoctorId(me, query.doctorId);
  const doctors = await loadActiveDoctors(requested);
  const doctorById = new Map(doctors.map((doctor) => [doctor.id, doctor]));

  const schedules = await buildSlotsForDoctorDates(
    doctors.map((doctor) => doctor.id),
    week.dates,
    durationMinutes,
    settings.slotIntervalMinutes,
  );

  const days = week.dates.map((date) => {
    const daySchedules = schedules.filter((schedule) => schedule.date === date);
    const doctorRows = daySchedules.map((schedule) => {
      const available = schedule.slots.filter((slot) => slot.available);
      return {
        doctor: doctorById.get(schedule.doctorId)!,
        isOpen: schedule.window.isOpen,
        openingHours: schedule.window,
        availableCount: available.length,
        slots: available,
      };
    });
    const slots = doctorRows
      .flatMap((row) => row.slots.map((slot) => ({ ...slot, doctor: row.doctor })))
      .sort(
        (a, b) =>
          a.start.localeCompare(b.start) || a.doctor.id.localeCompare(b.doctor.id),
      );
    return {
      date,
      weekday: isoWeekday(date),
      isOpen: doctorRows.some((row) => row.isOpen),
      totalAvailable: slots.length,
      doctors: doctorRows,
      slots,
    };
  });

  return {
    weekStart: week.start,
    weekEnd: week.end,
    timezone: settings.timezone,
    durationMinutes,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    doctorId: requested ?? null,
    serviceId: query.serviceId ?? null,
    totalAvailable: days.reduce((sum, day) => sum + day.totalAvailable, 0),
    availableDays: days.filter((day) => day.totalAvailable > 0).map((day) => day.date),
    days,
  };
}

/**
 * Action 4 - one doctor's appointments and remaining availability for a single
 * date or a bounded date range.
 */
export async function getDoctorSchedule(
  me: AuthUser,
  query: { doctorId?: string; date: string; to?: string },
) {
  const settings = await getClinicSettings();
  const requested = scopedDoctorId(me, query.doctorId);
  if (!requested) throw badRequest('Select a doctor.');

  const [doctor] = await loadActiveDoctors(requested);
  if (!doctor) throw badRequest('Select an active doctor.');
  const to = query.to ?? query.date;
  if (to < query.date) throw badRequest('The end date must not be before the start date.');

  const span = inclusiveDaySpan(query.date, to);
  if (span > MAX_DOCTOR_SCHEDULE_DAYS) {
    throw badRequest(`Select a range of at most ${MAX_DOCTOR_SCHEDULE_DAYS} days.`);
  }

  const dates = Array.from({ length: span }, (_, index) => addDaysDateOnly(query.date, index));
  const rangeStart = clinicDayRange(query.date).start;
  const rangeEnd = clinicDayRange(to).end;
  const canViewPatientNames = hasPermission(me, 'PATIENTS_READ');

  const [schedules, appointmentRows] = await Promise.all([
    buildSlotsForDoctorDates(
      [doctor.id],
      dates,
      settings.defaultAppointmentMinutes,
      settings.slotIntervalMinutes,
    ),
    prisma.appointment.findMany({
      where: { doctorId: doctor.id, startAt: { gte: rangeStart, lt: rangeEnd } },
      orderBy: [{ startAt: 'asc' }],
      take: 500,
      select: appointmentSelect,
    }),
  ]);

  const appointments = appointmentRows.map((row) =>
    serialiseAppointment(row, canViewPatientNames),
  );
  const byDate = new Map<string, typeof appointments>();
  for (const appointment of appointments) {
    const date = clinicDateString(appointment.startAt);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(appointment);
    else byDate.set(date, [appointment]);
  }

  const days = dates.map((date) => {
    const schedule = schedules.find((entry) => entry.date === date)!;
    const available = schedule.slots.filter((slot) => slot.available);
    return {
      date,
      weekday: isoWeekday(date),
      isOpen: schedule.window.isOpen,
      openingHours: schedule.window,
      availableCount: available.length,
      slots: available,
      appointments: byDate.get(date) ?? [],
    };
  });

  return {
    doctor,
    from: query.date,
    to,
    timezone: settings.timezone,
    durationMinutes: settings.defaultAppointmentMinutes,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    canViewPatientNames,
    totalAvailable: days.reduce((sum, day) => sum + day.availableCount, 0),
    totalAppointments: appointments.length,
    truncated: appointmentRows.length === 500,
    days,
  };
}

/**
 * Action 5 - earliest available slot within the horizon, either for one doctor
 * or across every active doctor, using the same slot engine as the agenda.
 */
export async function getNextAvailableAppointment(
  me: AuthUser,
  query: { doctorId?: string; serviceId?: string } = {},
) {
  const { settings, durationMinutes } = await loadServiceContext(query.serviceId);
  const today = clinicDateString();
  const requested = scopedDoctorId(me, query.doctorId);
  const doctors = await loadActiveDoctors(requested);
  const doctorById = new Map(doctors.map((doctor) => [doctor.id, doctor]));

  const dates = Array.from({ length: NEXT_AVAILABLE_HORIZON_DAYS }, (_, index) =>
    addDaysDateOnly(today, index),
  );
  const schedules = await buildSlotsForDoctorDates(
    doctors.map((doctor) => doctor.id),
    dates,
    durationMinutes,
    settings.slotIntervalMinutes,
  );

  const candidates = schedules.flatMap((schedule) =>
    schedule.slots
      .filter((slot) => slot.available)
      .map((slot) => ({
        date: schedule.date,
        doctor: doctorById.get(schedule.doctorId)!,
        slot,
      })),
  );
  candidates.sort(
    (a, b) =>
      a.slot.start.localeCompare(b.slot.start) || a.doctor.id.localeCompare(b.doctor.id),
  );

  const first = candidates[0];
  return {
    from: today,
    to: dates[dates.length - 1]!,
    horizonDays: NEXT_AVAILABLE_HORIZON_DAYS,
    timezone: settings.timezone,
    durationMinutes,
    doctorId: requested ?? null,
    serviceId: query.serviceId ?? null,
    found: Boolean(first),
    result: first
      ? {
          date: first.date,
          startAt: first.slot.start,
          endAt: first.slot.end,
          minute: first.slot.minute,
          doctor: first.doctor,
          slot: first.slot,
        }
      : null,
  }
}


/** Action 10 - today's appointments summary (total + byStatus). */
export interface TodayAppointmentsSummaryResponse {
  date: string;
  timezone: string;
  total: number;
  byStatus: Record<AppointmentStatus, number>;
}

export async function getTodayAppointmentsSummary(me: AuthUser) {
  const today = clinicDateString();
  const range = clinicDayRange(today);
  const appointments = await prisma.appointment.findMany({
    where: {
      startAt: { gte: range.start, lt: range.end },
    },
    select: { status: true },
  });
  const byStatus: Record<AppointmentStatus, number> = {
    BOOKED: 0,
    CONFIRMED: 0,
    ARRIVED: 0,
    WAITING: 0,
    IN_EXAM: 0,
    REPORT_REVIEW: 0,
    DONE: 0,
    CANCELLED: 0,
    NO_SHOW: 0,
  };
  for (const appt of appointments) {
    byStatus[appt.status] = (byStatus[appt.status] ?? 0) + 1;
  }
  return {
    date: today,
    timezone: (await getClinicSettings()).timezone,
    total: appointments.length,
    byStatus,
  };
}

/** Action 11 - today's queue status (waiting / called / inExam / done / skipped). */
export interface QueueStatusTodayResponse {
  date: string;
  timezone: string;
  waiting: number;
  called: number;
  inExam: number;
  skipped: number;
  done: number;
}

export async function getQueueStatusToday(me: AuthUser) {
  const today = clinicDateString();
  const queueEntries = await prisma.queueEntry.groupBy({
    by: ['status'],
    where: {
      queueDate: new Date(`${today}T00:00:00.000Z`),
    },
    _count: { _all: true },
  });
  const totals: Record<string, number> = {
    WAITING: 0,
    CALLED: 0,
    IN_EXAM: 0,
    SKIPPED: 0,
    DONE: 0,
  };
  for (const entry of queueEntries) {
    totals[entry.status] = entry._count._all;
  }
  return {
    date: today,
    timezone: (await getClinicSettings()).timezone,
    waiting: totals.WAITING,
    called: totals.CALLED,
    inExam: totals.IN_EXAM,
    skipped: totals.SKIPPED,
    done: totals.DONE,
  };
}

/** Action 12 - patients served today (distinct patients). */
export interface PatientsServedTodayResponse {
  date: string;
  timezone: string;
  total: number;
}

export async function getPatientsServedToday(me: AuthUser) {
  const today = clinicDateString();
  const range = clinicDayRange(today);
  const appointments = await prisma.appointment.findMany({
    where: {
      startAt: { gte: range.start, lt: range.end },
    },
    select: { patient: true },
  });
  const patientIds = new Set(appointments.map((appt) => appt.patient.id));
  return {
    date: today,
    timezone: (await getClinicSettings()).timezone,
    total: patientIds.size,
  };
}

/** Action 13 - weekly appointments summary (total + byStatus). */
export interface WeeklyAppointmentsSummaryResponse {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  total: number;
  byStatus: Record<AppointmentStatus, number>;
}

export async function getWeeklyAppointmentsSummary(me: AuthUser) {
  const today = clinicDateString();
  const week = clinicWeekRange(today);
  const appointments = await prisma.appointment.findMany({
    where: {
      startAt: { gte: week.start, lt: week.end },
    },
    select: { status: true },
  });
  const byStatus: Record<AppointmentStatus, number> = {
    BOOKED: 0,
    CONFIRMED: 0,
    ARRIVED: 0,
    WAITING: 0,
    IN_EXAM: 0,
    REPORT_REVIEW: 0,
    DONE: 0,
    CANCELLED: 0,
    NO_SHOW: 0,
  };
  for (const appt of appointments) {
    byStatus[appt.status] = (byStatus[appt.status] ?? 0) + 1;
  }
  return {
    weekStart: week.start,
    weekEnd: week.end,
    timezone: (await getClinicSettings()).timezone,
    total: appointments.length,
    byStatus,
  };
}

