import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import { clinicDateString, dateOnlyToDb, clinicDayRange } from '../../lib/time.js';
import { dateOnlySchema, parseBody, parseParams, parseQuery, uuidSchema } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import type { QueueStatus } from '@prisma/client';

export const queueRouter = Router();
queueRouter.use(authenticate);

const queueInclude = {
  patient: {
    select: { id: true, patientNumber: true, firstName: true, lastName: true, phone: true },
  },
  doctor: { select: { id: true, firstName: true, lastName: true } },
  appointment: {
    select: { id: true, startAt: true, endAt: true, status: true, service: { select: { name: true } } },
  },
} as const;

function secondsSince(from: Date | null, to: Date = new Date()): number | null {
  if (!from) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

queueRouter.get(
  '/',
  requirePermission('QUEUE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(
      z.object({
        date: dateOnlySchema.optional(),
        doctorId: uuidSchema.optional(),
        status: z.enum(['WAITING', 'CALLED', 'IN_EXAM', 'SKIPPED', 'DONE']).optional(),
      }),
      req,
    );
    const dateOnly = query.date ?? clinicDateString();
    const forcedDoctor = me.role === 'DOCTOR' ? me.id : query.doctorId;

    const entries = await prisma.queueEntry.findMany({
      where: {
        queueDate: dateOnlyToDb(dateOnly),
        doctorId: forcedDoctor,
        status: query.status,
      },
      include: queueInclude,
      orderBy: [{ position: 'asc' }, { arrivedAt: 'asc' }],
    });

    const now = new Date();
    res.json({
      date: dateOnly,
      entries: entries.map((entry) => ({
        ...entry,
        waitingSeconds:
          entry.status === 'WAITING' || entry.status === 'CALLED'
            ? secondsSince(entry.arrivedAt, now)
            : null,
        examSeconds:
          entry.status === 'IN_EXAM' ? secondsSince(entry.examStartedAt, now) : null,
      })),
    });
  }),
);

queueRouter.get(
  '/summary',
  requirePermission('QUEUE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(z.object({ date: dateOnlySchema.optional() }), req);
    const dateOnly = query.date ?? clinicDateString();
    const forcedDoctor = me.role === 'DOCTOR' ? me.id : undefined;

    const entries = await prisma.queueEntry.findMany({
      where: { queueDate: dateOnlyToDb(dateOnly), doctorId: forcedDoctor },
      select: {
        status: true,
        arrivedAt: true,
        examStartedAt: true,
        examEndedAt: true,
      },
    });

    const waits = entries
      .filter((e) => e.arrivedAt && e.examStartedAt)
      .map((e) => Math.round((e.examStartedAt!.getTime() - e.arrivedAt!.getTime()) / 60000));

    res.json({
      date: dateOnly,
      counts: {
        total: entries.length,
        waiting: entries.filter((e) => e.status === 'WAITING').length,
        called: entries.filter((e) => e.status === 'CALLED').length,
        inExam: entries.filter((e) => e.status === 'IN_EXAM').length,
        skipped: entries.filter((e) => e.status === 'SKIPPED').length,
        done: entries.filter((e) => e.status === 'DONE').length,
      },
      waitingTime: {
        measuredPatients: waits.length,
        averageMinutes: waits.length
          ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length)
          : null,
        longestMinutes: waits.length ? Math.max(...waits) : null,
      },
    });
  }),
);

const QUEUE_TRANSITIONS: Record<QueueStatus, QueueStatus[]> = {
  WAITING: ['CALLED', 'IN_EXAM', 'SKIPPED'],
  CALLED: ['IN_EXAM', 'WAITING', 'SKIPPED'],
  IN_EXAM: ['DONE'],
  SKIPPED: ['WAITING'],
  DONE: [],
};

const APPOINTMENT_FOR_QUEUE: Record<QueueStatus, 'WAITING' | 'IN_EXAM' | 'DONE' | 'NO_SHOW' | null> = {
  WAITING: 'WAITING',
  CALLED: 'WAITING',
  IN_EXAM: 'IN_EXAM',
  DONE: 'DONE',
  SKIPPED: 'NO_SHOW',
};

queueRouter.patch(
  '/:id/status',
  requirePermission('QUEUE_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(
      z.object({
        status: z.enum(['WAITING', 'CALLED', 'IN_EXAM', 'SKIPPED', 'DONE']),
        reason: z.string().trim().max(300).optional().or(z.literal('')),
      }),
      req,
    );
    const me = currentUser(req);

    const entry = await prisma.queueEntry.findUnique({
      where: { id },
      include: { appointment: true },
    });
    if (!entry) throw notFound('Queue entry not found');
    if (me.role === 'DOCTOR' && entry.doctorId !== me.id) {
      throw forbidden('This queue entry belongs to another doctor.');
    }
    if (entry.queueDate.toISOString().slice(0, 10) !== clinicDateString()) {
      throw badRequest('Only today\'s queue can be changed.');
    }

    const allowed = QUEUE_TRANSITIONS[entry.status];
    if (payload.status !== entry.status && !allowed.includes(payload.status)) {
      throw badRequest(`Cannot move a patient from ${entry.status} to ${payload.status}.`);
    }
    if (payload.status === 'SKIPPED' && !payload.reason) {
      throw badRequest('Record a reason when skipping a patient.');
    }
    if (payload.status === 'DONE' && !entry.examStartedAt) {
      throw badRequest('Start the exam before completing it.');
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.queueEntry.update({
        where: { id },
        data: {
          status: payload.status,
          ...(payload.status === 'CALLED' ? { calledAt: now } : {}),
          ...(payload.status === 'IN_EXAM' ? { examStartedAt: now } : {}),
          ...(payload.status === 'DONE' ? { examEndedAt: now } : {}),
          ...(payload.status === 'SKIPPED' ? { skipReason: payload.reason } : {}),
          ...(payload.status === 'WAITING' ? { skipReason: null, arrivedAt: entry.arrivedAt ?? now } : {}),
        },
        include: queueInclude,
      });

      const appointmentStatus = APPOINTMENT_FOR_QUEUE[payload.status];
      if (appointmentStatus && entry.appointment.status !== appointmentStatus) {
        // Keep the appointment in step; skip the graph when the move is
        // not a legal appointment transition (e.g. skipping a booked visit).
        const legal =
          (appointmentStatus === 'WAITING' &&
            ['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(entry.appointment.status)) ||
          (appointmentStatus === 'IN_EXAM' &&
            ['BOOKED', 'CONFIRMED', 'ARRIVED', 'WAITING'].includes(entry.appointment.status)) ||
          (appointmentStatus === 'DONE' &&
            ['BOOKED', 'CONFIRMED', 'ARRIVED', 'WAITING', 'IN_EXAM', 'REPORT_REVIEW'].includes(
              entry.appointment.status,
            )) ||
          appointmentStatus === 'NO_SHOW';

        if (legal) {
          await tx.appointment.update({
            where: { id: entry.appointmentId },
            data: {
              status: appointmentStatus,
              ...(appointmentStatus === 'NO_SHOW'
                ? { cancellationReason: payload.reason || 'Skipped in queue' }
                : {}),
            },
          });
          await tx.appointmentStatusHistory.create({
            data: {
              appointmentId: entry.appointmentId,
              fromStatus: entry.appointment.status,
              toStatus: appointmentStatus === 'NO_SHOW' ? 'NO_SHOW' : appointmentStatus,
              changedById: me.id,
              reason: payload.reason || null,
            },
          });
        }
      }

      return next;
    });

    await auditFromRequest(req, {
      action: 'queue.status_changed',
      entityType: 'QueueEntry',
      entityId: id,
      patientId: entry.patientId,
      metadata: { from: entry.status, to: payload.status, reason: payload.reason || null },
    });

    res.json({ entry: updated });
  }),
);

/** Add a walk-in to the queue, creating a same-day appointment. */
queueRouter.post(
  '/walk-in',
  requirePermission('QUEUE_WRITE', 'APPOINTMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(
      z.object({
        patientId: uuidSchema,
        doctorId: uuidSchema,
        serviceId: uuidSchema.optional().nullable(),
        durationMinutes: z.number().int().min(5).max(240).optional(),
      }),
      req,
    );
    const me = currentUser(req);

    const [patient, doctor] = await Promise.all([
      prisma.patient.findFirst({ where: { id: payload.patientId, isActive: true } }),
      prisma.user.findFirst({ where: { id: payload.doctorId, role: 'DOCTOR', isActive: true } }),
    ]);
    if (!patient) throw badRequest('Select an active patient.');
    if (!doctor) throw badRequest('Select an active doctor.');

    const service = payload.serviceId
      ? await prisma.service.findUnique({ where: { id: payload.serviceId } })
      : null;
    const durationMinutes = payload.durationMinutes ?? service?.durationMinutes ?? 15;

    const now = new Date();
    const existingToday = await prisma.queueEntry.count({
      where: { queueDate: dateOnlyToDb(clinicDateString()), doctorId: doctor.id },
    });

    const result = await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.create({
        data: {
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service?.id ?? null,
          startAt: now,
          endAt: new Date(now.getTime() + durationMinutes * 60_000),
          durationMinutes,
          status: 'ARRIVED',
          isManualOverride: true,
          overrideReason: 'Walk-in patient',
          createdById: me.id,
        },
      });
      await tx.appointmentStatusHistory.create({
        data: {
          appointmentId: appointment.id,
          fromStatus: null,
          toStatus: 'ARRIVED',
          changedById: me.id,
          reason: 'Walk-in patient',
        },
      });
      const entry = await tx.queueEntry.create({
        data: {
          appointmentId: appointment.id,
          patientId: patient.id,
          doctorId: doctor.id,
          queueDate: dateOnlyToDb(clinicDateString()),
          status: 'WAITING',
          arrivedAt: now,
          position: existingToday + 1,
          createdById: me.id,
        },
        include: queueInclude,
      });
      return { appointment, entry };
    });

    await auditFromRequest(req, {
      action: 'queue.walk_in_added',
      entityType: 'QueueEntry',
      entityId: result.entry.id,
      patientId: patient.id,
      metadata: { doctorId: doctor.id },
    });

    res.status(201).json(result);
  }),
);

// Referenced by the shared day-range helper in future reports.
void clinicDayRange;
