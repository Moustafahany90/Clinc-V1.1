import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound, forbidden } from '../../lib/errors.js';
import {
  clinicDateString,
  clinicLocalToUtc,
  clinicMinutesOfDay,
  clinicDayRange,
} from '../../lib/time.js';
import { parseBody, parseParams, parseQuery, uuidSchema, dateOnlySchema } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { hasPermission } from '../../lib/permissions.js';
import { auditFromRequest } from '../../lib/audit.js';
import {
  ACTIVE_STATUSES,
  assertTransitionAllowed,
  buildDaySlots,
  findOverlap,
  isWithinWindow,
  lockDoctorCalendar,
  resolveSchedule,
} from './service.js';
import { syncQueueForStatus } from '../queue/service.js';
import { getClinicSettings } from '../../lib/clinic.js';
import type { AppointmentStatus } from '@prisma/client';

export const appointmentsRouter = Router();
appointmentsRouter.use(authenticate);

const appointmentInclude = {
  patient: {
    select: { id: true, patientNumber: true, firstName: true, lastName: true, phone: true },
  },
  doctor: { select: { id: true, firstName: true, lastName: true } },
  service: { select: { id: true, name: true, durationMinutes: true, priceMinor: true } },
  queueEntry: { select: { id: true, status: true, arrivedAt: true } },
  visit: { select: { id: true, status: true } },
} as const;

/** A doctor may only ever see / touch their own calendar. */
function scopeDoctor(req: ReturnType<typeof currentUser>): string | null {
  return req.role === 'DOCTOR' ? req.id : null;
}

const listSchema = z.object({
  date: dateOnlySchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  doctorId: z.string().trim().optional().transform((v) => v || undefined).pipe(uuidSchema.optional()),
  patientId: z.string().trim().optional().transform((v) => v || undefined).pipe(uuidSchema.optional()),
  status: z
    .enum([
      'BOOKED',
      'CONFIRMED',
      'ARRIVED',
      'WAITING',
      'IN_EXAM',
      'REPORT_REVIEW',
      'DONE',
      'CANCELLED',
      'NO_SHOW',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

appointmentsRouter.get(
  '/',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(listSchema, req);
    const forcedDoctor = scopeDoctor(me);

    let startAt: { gte?: Date; lt?: Date } | undefined;
    if (query.date) {
      const range = clinicDayRange(query.date);
      startAt = { gte: range.start, lt: range.end };
    } else if (query.from || query.to) {
      startAt = {
        ...(query.from ? { gte: clinicDayRange(query.from).start } : {}),
        ...(query.to ? { lt: clinicDayRange(query.to).end } : {}),
      };
    }

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId: forcedDoctor ?? query.doctorId,
        patientId: query.patientId,
        status: query.status,
        ...(startAt ? { startAt } : {}),
      },
      include: appointmentInclude,
      orderBy: [{ startAt: 'asc' }],
      take: query.limit,
    });

    res.json({ appointments });
  }),
);

const agendaSchema = z.object({
  date: dateOnlySchema,
  doctorId: uuidSchema.optional(),
  serviceId: uuidSchema.optional(),
});

/** Calendar slots + day schedule for the booking UI. */
appointmentsRouter.get(
  '/agenda',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(agendaSchema, req);
    const settings = await getClinicSettings();
    const forcedDoctor = scopeDoctor(me);

    const service = query.serviceId
      ? await prisma.service.findUnique({ where: { id: query.serviceId } })
      : null;

    const durationMinutes = service?.durationMinutes ?? settings.defaultAppointmentMinutes;
    const doctorId = forcedDoctor ?? query.doctorId ?? null;

    const appointments = await prisma.appointment.findMany({
      where: {
        doctorId: doctorId ?? undefined,
        status: { in: ACTIVE_STATUSES },
        startAt: { gte: clinicDayRange(query.date).start, lt: clinicDayRange(query.date).end },
      },
      include: appointmentInclude,
      orderBy: { startAt: 'asc' },
    });

    let slots: Awaited<ReturnType<typeof buildDaySlots>>['slots'] = [];
    let window: Awaited<ReturnType<typeof resolveSchedule>> | null = null;
    if (doctorId) {
      const built = await buildDaySlots(
        doctorId,
        query.date,
        durationMinutes,
        settings.slotIntervalMinutes,
      );
      slots = built.slots;
      window = built.window;
    }

    res.json({
      date: query.date,
      doctorId,
      durationMinutes,
      slotIntervalMinutes: settings.slotIntervalMinutes,
      openingHours: window,
      slots,
      appointments,
    });
  }),
);

const createSchema = z.object({
  patientId: uuidSchema,
  doctorId: uuidSchema,
  serviceId: uuidSchema.optional().nullable(),
  date: dateOnlySchema,
  startMinute: z.number().int().min(0).max(1439),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  overrideReason: z.string().trim().max(300).optional().or(z.literal('')),
});

appointmentsRouter.post(
  '/',
  requirePermission('APPOINTMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const payload = parseBody(createSchema, req);
    const settings = await getClinicSettings();

    const [patient, doctor, service] = await Promise.all([
      prisma.patient.findFirst({ where: { id: payload.patientId, isActive: true } }),
      prisma.user.findFirst({ where: { id: payload.doctorId, role: 'DOCTOR', isActive: true } }),
      payload.serviceId
        ? prisma.service.findFirst({ where: { id: payload.serviceId, isActive: true } })
        : Promise.resolve(null),
    ]);

    if (!patient) throw badRequest('Select an active patient.');
    if (!doctor) throw badRequest('Select an active doctor.');
    if (payload.serviceId && !service) throw badRequest('Select an active service.');

    const durationMinutes =
      payload.durationMinutes ?? service?.durationMinutes ?? settings.defaultAppointmentMinutes;
    const startAt = clinicLocalToUtc(payload.date, payload.startMinute);
    const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

    if (endAt.getTime() <= startAt.getTime()) throw badRequest('Invalid appointment duration.');
    if (startAt.getTime() < Date.now() - 60_000) {
      throw badRequest('Appointments cannot be created in the past.');
    }
    if (clinicDateString(endAt) !== payload.date) {
      throw badRequest('An appointment must start and end on the same clinic day.');
    }

    const window = await resolveSchedule(doctor.id, payload.date);
    const within = isWithinWindow(
      window,
      clinicMinutesOfDay(startAt),
      clinicMinutesOfDay(endAt) === 0 ? 1440 : clinicMinutesOfDay(endAt),
    );

    if (!within.ok) {
      if (!hasPermission(me, 'APPOINTMENTS_OVERRIDE')) {
        throw forbidden(
          `${within.reason}. Only an administrator can approve a booking outside the configured schedule.`,
        );
      }
      if (!payload.overrideReason) {
        throw badRequest(
          `${within.reason}. Provide a reason to book outside the configured schedule.`,
          { requiresOverride: true, reason: within.reason },
        );
      }
    }

    const appointment = await prisma.$transaction(async (tx) => {
      await lockDoctorCalendar(tx, doctor.id);

      const overlap = await findOverlap(tx, doctor.id, startAt, endAt);
      if (overlap) {
        throw conflict('This doctor already has an appointment during that time.', {
          conflictWith: overlap.id,
          startAt: overlap.startAt,
          endAt: overlap.endAt,
        });
      }

      const created = await tx.appointment.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service?.id ?? null,
          startAt,
          endAt,
          durationMinutes,
          status: 'BOOKED',
          reason: payload.reason || null,
          notes: payload.notes || null,
          isManualOverride: !within.ok,
          overrideReason: !within.ok ? payload.overrideReason || null : null,
          createdById: me.id,
        },
        include: appointmentInclude,
      });

      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: created.id,
          fromStatus: null,
          toStatus: 'BOOKED',
          changedById: me.id,
        },
      });

      return created;
    });

    await auditFromRequest(req, {
      action: 'appointment.created',
      entityType: 'Appointment',
      entityId: appointment.id,
      patientId: appointment.patientId,
      metadata: {
        doctorId: appointment.doctorId,
        startAt: appointment.startAt.toISOString(),
        durationMinutes,
        manualOverride: !within.ok,
        ...(!within.ok ? { overrideReason: payload.overrideReason ?? null } : {}),
      },
    });

    res.status(201).json({ appointment });
  }),
);

appointmentsRouter.get(
  '/:id',
  requirePermission('APPOINTMENTS_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        ...appointmentInclude,
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          include: { changedBy: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!appointment) throw notFound('Appointment not found');
    if (me.role === 'DOCTOR' && appointment.doctorId !== me.id) {
      throw forbidden('This appointment belongs to another doctor.');
    }
    res.json({ appointment });
  }),
);

const updateSchema = z.object({
  date: dateOnlySchema.optional(),
  startMinute: z.number().int().min(0).max(1439).optional(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
  doctorId: uuidSchema.optional(),
  serviceId: uuidSchema.nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  overrideReason: z.string().trim().max(300).optional().or(z.literal('')),
  rescheduleReason: z.string().trim().max(300).optional().or(z.literal('')),
});

appointmentsRouter.patch(
  '/:id',
  requirePermission('APPOINTMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(updateSchema, req);
    const me = currentUser(req);
    const settings = await getClinicSettings();

    const existing = await prisma.appointment.findUnique({ where: { id } });
    if (!existing) throw notFound('Appointment not found');
    if (['DONE', 'CANCELLED', 'NO_SHOW'].includes(existing.status)) {
      throw badRequest('Completed or cancelled appointments cannot be rescheduled.');
    }

    const doctorId = payload.doctorId ?? existing.doctorId;
    if (payload.doctorId && payload.doctorId !== existing.doctorId) {
      const doctor = await prisma.user.findFirst({
        where: { id: doctorId, role: 'DOCTOR', isActive: true },
      });
      if (!doctor) throw badRequest('Select an active doctor.');
    }

    const serviceId = payload.serviceId === undefined ? existing.serviceId : payload.serviceId;
    const service = serviceId ? await prisma.service.findUnique({ where: { id: serviceId } }) : null;
    if (serviceId && !service) throw badRequest('Select a valid service.');

    const dateOnly = payload.date ?? clinicDateString(existing.startAt);
    const startMinute = payload.startMinute ?? clinicMinutesOfDay(existing.startAt);
    const durationMinutes =
      payload.durationMinutes ?? service?.durationMinutes ?? existing.durationMinutes;

    const startAt = clinicLocalToUtc(dateOnly, startMinute);
    const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
    if (clinicDateString(endAt) !== dateOnly) {
      throw badRequest('An appointment must start and end on the same clinic day.');
    }

    const window = await resolveSchedule(doctorId, dateOnly);
    const within = isWithinWindow(
      window,
      clinicMinutesOfDay(startAt),
      clinicMinutesOfDay(endAt) === 0 ? 1440 : clinicMinutesOfDay(endAt),
    );
    if (!within.ok) {
      if (!hasPermission(me, 'APPOINTMENTS_OVERRIDE')) {
        throw forbidden(
          `${within.reason}. Only an administrator can approve a booking outside the configured schedule.`,
        );
      }
      if (!payload.overrideReason) {
        throw badRequest(
          `${within.reason}. Provide a reason to book outside the configured schedule.`,
          { requiresOverride: true, reason: within.reason },
        );
      }
    }

    const appointment = await prisma.$transaction(async (tx) => {
      await lockDoctorCalendar(tx, doctorId);
      const overlap = await findOverlap(tx, doctorId, startAt, endAt, id);
      if (overlap) {
        throw conflict('This doctor already has an appointment during that time.', {
          conflictWith: overlap.id,
          startAt: overlap.startAt,
          endAt: overlap.endAt,
        });
      }

      const updated = await tx.appointment.update({
        where: { id },
        data: {
          doctorId,
          serviceId: serviceId ?? null,
          startAt,
          endAt,
          durationMinutes,
          reason: payload.reason === undefined ? undefined : payload.reason,
          notes: payload.notes === undefined ? undefined : payload.notes,
          isManualOverride: !within.ok,
          overrideReason: !within.ok ? payload.overrideReason || null : null,
        },
        include: appointmentInclude,
      });

      if (updated.queueEntry) {
        await tx.queueEntry.update({
          where: { id: updated.queueEntry.id },
          data: {
            doctorId,
            queueDate: new Date(`${clinicDateString(startAt)}T00:00:00.000Z`),
          },
        });
      }

      return updated;
    });

    await auditFromRequest(req, {
      action: 'appointment.rescheduled',
      entityType: 'Appointment',
      entityId: id,
      patientId: appointment.patientId,
      metadata: {
        from: existing.startAt.toISOString(),
        to: startAt.toISOString(),
        doctorId,
        durationMinutes,
        reason: payload.rescheduleReason ?? null,
        manualOverride: !within.ok,
        overrideReason: within.ok ? null : (payload.overrideReason ?? null),
      },
    });

    // settings is used indirectly by defaults; keep reference meaningful.
    void settings;
    res.json({ appointment });
  }),
);

const statusSchema = z.object({
  status: z.enum([
    'CONFIRMED',
    'ARRIVED',
    'WAITING',
    'IN_EXAM',
    'REPORT_REVIEW',
    'DONE',
    'CANCELLED',
    'NO_SHOW',
  ]),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  overrideReason: z.string().trim().max(500).optional().or(z.literal('')),
});

appointmentsRouter.post(
  '/:id/status',
  requirePermission('APPOINTMENTS_WRITE', 'CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(statusSchema, req);
    const me = currentUser(req);

    const existing = await prisma.appointment.findUnique({
      where: { id },
      include: {
        visit: {
          select: {
            id: true,
            status: true,
            reports: { select: { id: true, status: true } },
          },
        },
      },
    });
    if (!existing) throw notFound('Appointment not found');
    if (me.role === 'DOCTOR' && existing.doctorId !== me.id) {
      throw forbidden('This appointment belongs to another doctor.');
    }

    const target = payload.status as AppointmentStatus;
    const check = assertTransitionAllowed(existing.status, target);
    if (!check.ok) throw badRequest(check.reason ?? 'Invalid status change.');

    // Completion is gated on the clinical workflow unless explicitly overridden.
    if (target === 'DONE') {
      const blockedReason = !existing.visit
        ? 'Start a visit and finalize the report before completing this appointment.'
        : existing.visit.status !== 'COMPLETED'
          ? 'Complete the visit before marking the appointment done.'
          : existing.visit.reports.some((r) => r.status === 'DRAFT')
            ? 'Finalize the report before completing this appointment.'
            : null;
      if (blockedReason) {
        if (!hasPermission(me, 'APPOINTMENTS_OVERRIDE')) {
          throw forbidden(
            `${blockedReason} Only an administrator can override this rule.`,
          );
        }
        if (!payload.overrideReason) {
          throw badRequest(blockedReason, { requiresOverride: true });
        }
      }
    }

    const appointment = await prisma.$transaction(async (tx) => {
      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: target,
          ...(target === 'CANCELLED'
            ? { cancellationReason: payload.reason || 'Cancelled' }
            : {}),
          ...(payload.overrideReason
            ? { isManualOverride: true, overrideReason: payload.overrideReason }
            : {}),
        },
        include: appointmentInclude,
      });

      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: id,
          fromStatus: existing.status,
          toStatus: target,
          changedById: me.id,
          reason: payload.reason || payload.overrideReason || null,
        },
      });

      await syncQueueForStatus(tx, updated, target, me.id);
      return updated;
    });

    await auditFromRequest(req, {
      action: 'appointment.status_changed',
      entityType: 'Appointment',
      entityId: id,
      patientId: appointment.patientId,
      metadata: {
        from: existing.status,
        to: target,
        reason: payload.reason || null,
        override: Boolean(payload.overrideReason),
        ...(payload.overrideReason ? { overrideReason: payload.overrideReason } : {}),
      },
    });

    res.json({ appointment });
  }),
);

/** Bill a visit/exam explicitly. A booking is never evidence of payment. */
const chargeSchema = z.object({
  description: z.string().trim().min(1).max(200),
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  serviceId: uuidSchema.optional().nullable(),
});

appointmentsRouter.post(
  '/:id/charge',
  requirePermission('PAYMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(chargeSchema, req);
    const me = currentUser(req);

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { charge: { select: { id: true } }, visit: { select: { id: true } } },
    });
    if (!appointment) throw notFound('Appointment not found');
    if (appointment.charge) throw conflict('This appointment has already been billed.');

    const charge = await prisma.charge.create({
      data: {
        patientId: appointment.patientId,
        visitId: appointment.visit?.id ?? null,
        appointmentId: appointment.id,
        serviceId: payload.serviceId ?? appointment.serviceId,
        description: payload.description,
        amountMinor: payload.amountMinor,
        createdById: me.id,
      },
    });

    await auditFromRequest(req, {
      action: 'charge.created',
      entityType: 'Charge',
      entityId: charge.id,
      patientId: appointment.patientId,
      metadata: { amountMinor: charge.amountMinor, appointmentId: appointment.id },
    });

    res.status(201).json({ charge });
  }),
);
