import { api } from './api';
import type { AppointmentStatus } from './types';

/**
 * Typed access to the Phase 1 Quick Actions endpoints. Response shapes mirror
 * `backend/src/modules/quick-actions/service.ts`; availability always comes
 * from the same engine that serves the agenda.
 */

export interface QuickActionDoctor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface QuickActionSlot {
  start: string;
  end: string;
  minute: number;
  available: boolean;
  conflictWith?: string;
}

export interface QuickActionOpeningHours {
  isOpen: boolean;
  openMinute: number;
  closeMinute: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
  source: 'doctor' | 'clinic' | 'exception' | 'none';
  reason?: string;
}

export interface QuickActionPatient {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
}

export interface QuickActionAppointment {
  id: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  reason: string | null;
  doctor: QuickActionDoctor;
  service: { id: string; name: string } | null;
  /** Null when the caller cannot view patient identities. */
  patient: QuickActionPatient | null;
  queueStatus: string | null;
}

export interface DoctorAvailabilityRow {
  doctor: QuickActionDoctor;
  isOpen: boolean;
  openingHours: QuickActionOpeningHours;
  availableCount: number;
  slots: QuickActionSlot[];
}

export interface AvailabilityTodayResponse {
  date: string;
  timezone: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  doctorId: string | null;
  serviceId: string | null;
  totalAvailable: number;
  doctors: DoctorAvailabilityRow[];
}

export interface TodayAppointmentsResponse {
  date: string;
  timezone: string;
  doctorId: string | null;
  status: AppointmentStatus | null;
  canViewPatientNames: boolean;
  total: number;
  limit: number;
  hasMore: boolean;
  appointments: QuickActionAppointment[];
}

export interface WeeklyAvailabilityDay {
  date: string;
  weekday: number;
  isOpen: boolean;
  totalAvailable: number;
  doctors: DoctorAvailabilityRow[];
  slots: (QuickActionSlot & { doctor: QuickActionDoctor })[];
}

export interface WeeklyAvailabilityResponse {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  doctorId: string | null;
  serviceId: string | null;
  totalAvailable: number;
  availableDays: string[];
  days: WeeklyAvailabilityDay[];
}

export interface DoctorScheduleDay {
  date: string;
  weekday: number;
  isOpen: boolean;
  openingHours: QuickActionOpeningHours;
  availableCount: number;
  slots: QuickActionSlot[];
  appointments: QuickActionAppointment[];
}

export interface DoctorScheduleResponse {
  doctor: QuickActionDoctor;
  from: string;
  to: string;
  timezone: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  canViewPatientNames: boolean;
  totalAvailable: number;
  totalAppointments: number;
  truncated: boolean;
  days: DoctorScheduleDay[];
}

export interface NextAvailableResponse {
  from: string;
  to: string;
  horizonDays: number;
  timezone: string;
  durationMinutes: number;
  doctorId: string | null;
  serviceId: string | null;
  found: boolean;
  result: {
    date: string;
    startAt: string;
    endAt: string;
    minute: number;
    doctor: QuickActionDoctor;
    slot: QuickActionSlot;
  } | null;
  message: string | null;
}

export interface AvailabilityFilters {
  doctorId?: string;
  serviceId?: string;
}

export interface TodayAppointmentsFilters {
  doctorId?: string;
  status?: AppointmentStatus;
  limit?: number;
}

export interface WeeklyFilters extends AvailabilityFilters {
  /** Any date inside the wanted week; the server normalises to Saturday. */
  weekStart?: string;
}

export interface DoctorScheduleFilters {
  doctorId: string;
  from: string;
  to?: string;
}

async function get<T>(
  url: string,
  params: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await api.get<T>(url, { params, signal });
  return response.data;
}

export function fetchTodayAvailability(
  filters: AvailabilityFilters = {},
  signal?: AbortSignal,
): Promise<AvailabilityTodayResponse> {
  return get('/quick-actions/availability/today', filters, signal);
}

export function fetchTodayAppointments(
  filters: TodayAppointmentsFilters = {},
  signal?: AbortSignal,
): Promise<TodayAppointmentsResponse> {
  return get('/quick-actions/appointments/today', filters, signal);
}

export function fetchWeeklyAvailability(
  filters: WeeklyFilters = {},
  signal?: AbortSignal,
): Promise<WeeklyAvailabilityResponse> {
  return get('/quick-actions/availability/week', filters, signal);
}

export function fetchDoctorSchedule(
  filters: DoctorScheduleFilters,
  signal?: AbortSignal,
): Promise<DoctorScheduleResponse> {
  return get(
    '/quick-actions/doctor-schedule',
    { doctorId: filters.doctorId, date: filters.from, to: filters.to },
    signal,
  );
}

export function fetchNextAvailable(
  filters: AvailabilityFilters = {},
  signal?: AbortSignal,
): Promise<NextAvailableResponse> {
  return get('/quick-actions/next-available', filters, signal);
}

/** Statuses offered by the today's-appointments filter (server enum order). */
export const QUICK_ACTION_STATUSES: AppointmentStatus[] = [
  'BOOKED',
  'CONFIRMED',
  'ARRIVED',
  'WAITING',
  'IN_EXAM',
  'REPORT_REVIEW',
  'DONE',
  'CANCELLED',
  'NO_SHOW',
];

/** Mirrors the server cap for the today's-appointments list. */
export const QUICK_ACTION_LIMITS = [25, 50, 100, 200] as const;
