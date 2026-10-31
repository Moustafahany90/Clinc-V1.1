import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, forbidden, notFound } from '../../lib/errors.js';
import {
  dateOnlySchema,
  paginationSchema,
  parseBody,
  parseParams,
  parseQuery,
  uuidSchema,
} from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { hasPermission } from '../../lib/permissions.js';
import { auditFromRequest } from '../../lib/audit.js';
import { assertClinicalRead, assertClinicalWrite, forcedDoctorId } from '../../lib/clinical.js';
import { clinicDayRange } from '../../lib/time.js';

export const visitsRouter = Router();
visitsRouter.use(authenticate);

const visitIncludeSafe = {
  patient: {
    select: { id: true, patientNumber: true, firstName: true, lastName: true, dateOfBirth: true },
  },
  doctor: { select: { id: true, firstName: true, lastName: true } },
  appointment: { select: { id: true, startAt: true, status: true } },
  reports: {
    select: { id: true, status: true, versionNumber: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' as const },
  },
  _count: { select: { measurements: true, files: true } },
} as const;

const listSchema = paginationSchema.extend({
  patientId: z.string().trim().optional().transform((v) => v || undefined).pipe(uuidSchema.optional()),
  date: dateOnlySchema.optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'COMPLETED']).optional(),
});

visitsRouter.get(
  '/',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { page, pageSize, patientId, date, status } = parseQuery(listSchema, req);
    const doctorId = forcedDoctorId(me);

    const where = {
      ...(doctorId ? { doctorId } : {}),
      ...(patientId ? { patientId } : {}),
      ...(status ? { status } : {}),
      ...(date
        ? { visitDate: { gte: clinicDayRange(date).start, lt: clinicDayRange(date).end } }
        : {}),
    };

    const [total, visits] = await prisma.$transaction([
      prisma.visit.count({ where }),
      prisma.visit.findMany({
        where,
        include: visitIncludeSafe,
        orderBy: { visitDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ visits, total, page, pageSize });
  }),
);

const createVisitSchema = z.object({
  patientId: uuidSchema,
  appointmentId: uuidSchema.optional().nullable(),
  doctorId: uuidSchema.optional(),
  chiefComplaint: z.string().trim().max(2000).optional().or(z.literal('')),
  examinationType: z.string().trim().max(200).optional().or(z.literal('')),
  visitDate: z.string().datetime({ offset: true }).optional(),
});

visitsRouter.post(
  '/',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const payload = parseBody(createVisitSchema, req);

    // Doctors always create their own visits; an explicitly privileged admin
    // may specify the responsible doctor.
    const doctorId = me.role === 'DOCTOR' ? me.id : payload.doctorId;
    if (!doctorId) throw badRequest('Select the responsible doctor.');
    assertClinicalWrite(me, doctorId);

    const [patient, appointment] = await Promise.all([
      prisma.patient.findFirst({ where: { id: payload.patientId, isActive: true } }),
      payload.appointmentId
        ? prisma.appointment.findUnique({ where: { id: payload.appointmentId }, include: { visit: true } })
        : Promise.resolve(null),
    ]);

    if (!patient) throw badRequest('Select an active patient.');
    if (payload.appointmentId) {
      if (!appointment) throw notFound('Appointment not found');
      if (appointment.doctorId !== doctorId) {
        throw forbidden('The appointment belongs to another doctor.');
      }
      if (appointment.visit) throw badRequest('This appointment already has a visit.');
    }

    const visit = await prisma.visit.create({
      data: {
        patientId: payload.patientId,
        doctorId,
        appointmentId: payload.appointmentId ?? null,
        chiefComplaint: payload.chiefComplaint || null,
        examinationType: payload.examinationType || assessmentDefault(appointment?.serviceId),
        ...(payload.visitDate ? { visitDate: new Date(payload.visitDate) } : {}),
      },
      include: visitIncludeSafe,
    });

    await auditFromRequest(req, {
      action: 'visit.created',
      entityType: 'Visit',
      entityId: visit.id,
      patientId: visit.patientId,
      metadata: { doctorId },
    });

    res.status(201).json({ visit });
  }),
);

visitsRouter.get(
  '/:id',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const me = currentUser(req);
    const visit = await prisma.visit.findUnique({
      where: { id },
      include: {
        ...visitIncludeSafe,
        measurements: { orderBy: { measuredAt: 'desc' } },
        files: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
            kind: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!visit) throw notFound('Visit not found');
    assertClinicalRead(me, visit.doctorId);
    res.json({ visit });
  }),
);

const updateVisitSchema = z.object({
  chiefComplaint: z.string().trim().max(2000).nullable().optional(),
  examinationType: z.string().trim().max(200).nullable().optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'COMPLETED']).optional(),
  overrideReason: z.string().trim().max(300).optional().or(z.literal('')),
});

visitsRouter.patch(
  '/:id',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(updateVisitSchema, req);
    const me = currentUser(req);

    const existing = await prisma.visit.findUnique({
      where: { id },
      include: { reports: { select: { id: true, status: true } } },
    });
    if (!existing) throw notFound('Visit not found');
    assertClinicalWrite(me, existing.doctorId);

    if (existing.status === 'COMPLETED') {
      throw forbidden(
        'Completed visits are locked. Correct the finalized report through an amendment instead.',
      );
    }

    if (payload.status === 'COMPLETED') {
      const hasFinal = existing.reports.some((r) => r.status !== 'DRAFT');
      if (!hasFinal) {
        if (!hasPermission(me, 'VISITS_OVERRIDE')) {
          throw forbidden(
            'Finalize a report before completing this visit. Only an administrator can override this rule.',
          );
        }
        if (!payload.overrideReason) {
          throw badRequest('Finalize a report before completing this visit.', {
            requiresOverride: true,
          });
        }
      }
    }

    const visit = await prisma.visit.update({
      where: { id },
      data: {
        chiefComplaint: payload.chiefComplaint === undefined ? undefined : payload.chiefComplaint,
        examinationType:
          payload.examinationType === undefined ? undefined : payload.examinationType,
        status: payload.status,
      },
      include: visitIncludeSafe,
    });

    await auditFromRequest(req, {
      action: payload.status ? 'visit.status_changed' : 'visit.updated',
      entityType: 'Visit',
      entityId: id,
      patientId: visit.patientId,
      metadata: {
        status: payload.status ?? null,
        override: Boolean(payload.overrideReason),
        ...(payload.overrideReason ? { overrideReason: payload.overrideReason } : {}),
      },
    });

    res.json({ visit });
  }),
);

const measurementSchema = z.object({
  label: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(120),
  unit: z.string().trim().max(40).optional().or(z.literal('')),
  measuredAt: z.string().datetime({ offset: true }).optional(),
});

visitsRouter.post(
  '/:id/measurements',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(measurementSchema, req);
    const me = currentUser(req);

    const visit = await prisma.visit.findUnique({ where: { id } });
    if (!visit) throw notFound('Visit not found');
    assertClinicalWrite(me, visit.doctorId);

    if (visit.status === 'COMPLETED') {
      throw forbidden('Measurements cannot be added to a completed visit.');
    }

    const measurement = await prisma.measurement.create({
      data: {
        visitId: id,
        doctorId: visit.doctorId,
        label: payload.label,
        value: payload.value,
        unit: payload.unit || null,
        ...(payload.measuredAt ? { measuredAt: new Date(payload.measuredAt) } : {}),
      },
    });

    await auditFromRequest(req, {
      action: 'measurement.created',
      entityType: 'Measurement',
      entityId: measurement.id,
      patientId: visit.patientId,
    });

    res.status(201).json({ measurement });
  }),
);

visitsRouter.delete(
  '/:id/measurements/:measurementId',
  requirePermission('CLINICAL_WRITE'),
  asyncHandler(async (req, res) => {
    const { id, measurementId } = parseParams(
      z.object({ id: uuidSchema, measurementId: uuidSchema }),
      req,
    );
    const me = currentUser(req);
    const visit = await prisma.visit.findUnique({ where: { id } });
    if (!visit) throw notFound('Visit not found');
    assertClinicalWrite(me, visit.doctorId);

    if (visit.status === 'COMPLETED') {
      throw forbidden('Measurements cannot be changed on a completed visit.');
    }

    const measurement = await prisma.measurement.findFirst({
      where: { id: measurementId, visitId: id },
    });
    if (!measurement) throw notFound('Measurement not found');

    await prisma.measurement.delete({ where: { id: measurementId } });
    await auditFromRequest(req, {
      action: 'measurement.deleted',
      entityType: 'Measurement',
      entityId: measurementId,
      patientId: visit.patientId,
    });
    res.status(204).end();
  }),
);

/** A doctor's own clinical history for one patient. */
visitsRouter.get(
  '/patient/:patientId',
  requirePermission('CLINICAL_READ'),
  asyncHandler(async (req, res) => {
    const { patientId } = parseParams(z.object({ patientId: uuidSchema }), req);
    const me = currentUser(req);
    const doctorFilter = forcedDoctorId(me);

    const visits = await prisma.visit.findMany({
      where: { patientId, ...(doctorFilter ? { doctorId: doctorFilter } : {}) },
      include: {
        reports: {
          select: { id: true, status: true, versionNumber: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
      orderBy: { visitDate: 'desc' },
      take: 100,
    });

    res.json({ visits });
  }),
);

function assessmentDefault(_serviceId?: string | null): string | null {
  return null;
}
