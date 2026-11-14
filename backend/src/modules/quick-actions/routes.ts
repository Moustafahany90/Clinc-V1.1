import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errors.js';
import {
  dateOnlySchema,
  parseQuery,
  uuidSchema,
} from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './constants.js';
import {
  getAvailableAppointmentsToday,
  getDoctorSchedule,
  getNextAvailableAppointment,
  getTodayAppointments,
  getWeeklyAvailability,
} from './service.js';

export const quickActionsRouter = Router();
quickActionsRouter.use(authenticate);

/** Empty query strings are treated as "no filter" before UUID validation. */
const optionalUuid = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined)
  .pipe(uuidSchema.optional());

const statusSchema = z.enum([
  'BOOKED',
  'CONFIRMED',
  'ARRIVED',
  'WAITING',
  'IN_EXAM',
  'REPORT_REVIEW',
  'DONE',
  'CANCELLED',
  'NO_SHOW',
]);

const availabilityQuery = z.object({
  doctorId: optionalUuid,
  serviceId: optionalUuid,
});

const todayAppointmentsQuery = z.object({
  doctorId: optionalUuid,
  status: statusSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIST_LIMIT)
    .default(DEFAULT_LIST_LIMIT),
});

const weeklyQuery = z.object({
  weekStart: dateOnlySchema.optional(),
  doctorId: optionalUuid,
  serviceId: optionalUuid,
});

const doctorScheduleQuery = z.object({
  doctorId: optionalUuid,
  date: dateOnlySchema,
  to: dateOnlySchema.optional(),
});

/** Action 1 - available slots today, grouped by doctor. */
quickActionsRouter.get(
  '/availability/today',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(availabilityQuery, req);
    res.json(await getAvailableAppointmentsToday(me, query));
  }),
);

/** Action 2 - today's appointments. */
quickActionsRouter.get(
  '/appointments/today',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(todayAppointmentsQuery, req);
    res.json(await getTodayAppointments(me, query));
  }),
);

/** Action 3 - available slots for the current (Saturday-start) week. */
quickActionsRouter.get(
  '/availability/week',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(weeklyQuery, req);
    res.json(await getWeeklyAvailability(me, query));
  }),
);

/** Action 4 - one doctor's schedule for a date or a bounded range. */
quickActionsRouter.get(
  '/doctor-schedule',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(doctorScheduleQuery, req);
    res.json(await getDoctorSchedule(me, query));
  }),
);

/** Action 5 - earliest available slot within the 60-day horizon. */
quickActionsRouter.get(
  '/next-available',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(availabilityQuery, req);
    res.json(await getNextAvailableAppointment(me, query));
  }),
);
