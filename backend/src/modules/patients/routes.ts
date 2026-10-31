import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import { nextPatientNumber } from '../../lib/sequence.js';
import { parseBody, parseQuery, paginationSchema, uuidSchema, dateOnlySchema } from '../../lib/validate.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import { summariseLedger, type LedgerRow } from '../../lib/money.js';

export const patientsRouter = Router();
patientsRouter.use(authenticate);

/** Egypt-friendly normalisation: digits only, local 0-prefixed form. */
export function normalisePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0020')) digits = digits.slice(4);
  if (digits.startsWith('20') && digits.length === 12) digits = `0${digits.slice(2)}`;
  if (digits.length < 4) return null;
  return digits;
}

const patientSelect = {
  id: true,
  patientNumber: true,
  firstName: true,
  lastName: true,
  phone: true,
  referringDoctor: true,
  dateOfBirth: true,
  gender: true,
  nationalId: true,
  address: true,
  notes: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const searchSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
});

patientsRouter.get(
  '/',
  requirePermission('PATIENTS_READ'),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search, phone } = parseQuery(searchSchema, req);
    const normalisedPhone = normalisePhone(phone);

    const where = {
      isActive: true,
      ...(normalisedPhone ? { phoneNormalized: { contains: normalisedPhone } } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName: { contains: search, mode: 'insensitive' as const } },
              { patientNumber: { contains: search, mode: 'insensitive' as const } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, patients] = await prisma.$transaction([
      prisma.patient.count({ where }),
      prisma.patient.findMany({
        where,
        select: {
          ...patientSelect,
          _count: { select: { appointments: true } },
        },
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ patients, total, page, pageSize });
  }),
);

const duplicateSchema = z.object({
  phone: z.string().trim().max(30).optional(),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
});

/**
 * Soft duplicate lookup. Never blocks by itself and never merges records.
 * Deliberately returns demographics only - no clinical hints.
 */
patientsRouter.get(
  '/duplicates',
  requirePermission('PATIENTS_READ'),
  asyncHandler(async (req, res) => {
    const { phone, firstName, lastName } = parseQuery(duplicateSchema, req);
    const normalisedPhone = normalisePhone(phone);

    const or: object[] = [];
    if (normalisedPhone) or.push({ phoneNormalized: normalisedPhone });
    if (firstName && lastName) {
      or.push({
        firstName: { equals: firstName, mode: 'insensitive' as const },
        lastName: { equals: lastName, mode: 'insensitive' as const },
      });
    }
    if (or.length === 0) {
      res.json({ matches: [] });
      return;
    }

    const matches = await prisma.patient.findMany({
      where: { isActive: true, OR: or },
      select: {
        id: true,
        patientNumber: true,
        firstName: true,
        lastName: true,
        phone: true,
        dateOfBirth: true,
      },
      take: 10,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ matches });
  }),
);

const createPatientSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().min(1, 'Last name is required').max(80),
  phone: z.string().trim().min(1, 'Phone number is required').max(30),
  referringDoctor: z.string().trim().max(120).optional().or(z.literal('')),
  dateOfBirth: dateOnlySchema.optional().or(z.literal('')),
  gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNSPECIFIED']).optional(),
  nationalId: z.string().trim().max(40).optional().or(z.literal('')),
  address: z.string().trim().max(400).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  /** Set only after the user has seen and dismissed the duplicate warning. */
  acknowledgeDuplicates: z.boolean().default(false),
});

patientsRouter.post(
  '/',
  requirePermission('PATIENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(createPatientSchema, req);
    const phoneNormalized = normalisePhone(payload.phone);

    if (!payload.acknowledgeDuplicates && (phoneNormalized || (payload.firstName && payload.lastName))) {
      const possible = await prisma.patient.findMany({
        where: {
          isActive: true,
          OR: [
            ...(phoneNormalized ? [{ phoneNormalized }] : []),
            {
              firstName: { equals: payload.firstName, mode: 'insensitive' as const },
              lastName: { equals: payload.lastName, mode: 'insensitive' as const },
            },
          ],
        },
        select: {
          id: true,
          patientNumber: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
        },
        take: 10,
      });

      if (possible.length > 0) {
        throw conflict(
          'A patient with similar details already exists. Select the existing record or confirm to create a new one.',
          { matches: possible, canOverride: true },
        );
      }
    }

    const patient = await prisma.$transaction(async (tx) => {
      const patientNumber = await nextPatientNumber(tx);
      return tx.patient.create({
        data: {
          patientNumber,
          firstName: payload.firstName,
          lastName: payload.lastName,
          phone: payload.phone || null,
          phoneNormalized,
          referringDoctor: payload.referringDoctor || null,
          dateOfBirth: payload.dateOfBirth ? new Date(`${payload.dateOfBirth}T00:00:00Z`) : null,
          gender: payload.gender ?? null,
          nationalId: payload.nationalId || null,
          address: payload.address || null,
          notes: payload.notes || null,
          createdById: req.user?.id ?? null,
        },
        select: patientSelect,
      });
    });

    await auditFromRequest(req, {
      action: 'patient.created',
      entityType: 'Patient',
      entityId: patient.id,
      patientId: patient.id,
      metadata: { patientNumber: patient.patientNumber },
    });

    res.status(201).json({ patient });
  }),
);

patientsRouter.get(
  '/:id',
  requirePermission('PATIENTS_READ'),
  asyncHandler(async (req, res) => {
    const rawId = req.params.id?.trim();
    if (!rawId || rawId === 'undefined' || rawId === 'null') {
      throw notFound('Patient not found');
    }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const patient = await prisma.patient.findFirst({
      where: isUuid ? { id: rawId } : { patientNumber: rawId },
      select: {
        ...patientSelect,
        _count: { select: { appointments: true } },
      },
    });
    if (!patient) throw notFound('Patient not found');
    res.json({ patient });
  }),
);

const updatePatientSchema = createPatientSchema
  .omit({ acknowledgeDuplicates: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

patientsRouter.patch(
  '/:id',
  requirePermission('PATIENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const payload = parseBody(updatePatientSchema, req);

    const existing = await prisma.patient.findUnique({ where: { id } });
    if (!existing) throw notFound('Patient not found');

    const phone =
      payload.phone === undefined ? undefined : payload.phone ? payload.phone : null;

    const patient = await prisma.patient.update({
      where: { id },
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        phone,
        phoneNormalized:
          payload.phone === undefined ? undefined : normalisePhone(payload.phone),
        referringDoctor:
          payload.referringDoctor === undefined ? undefined : payload.referringDoctor || null,
        dateOfBirth:
          payload.dateOfBirth === undefined
            ? undefined
            : payload.dateOfBirth
              ? new Date(`${payload.dateOfBirth}T00:00:00Z`)
              : null,
        gender: payload.gender,
        nationalId: payload.nationalId === undefined ? undefined : payload.nationalId || null,
        address: payload.address === undefined ? undefined : payload.address || null,
        notes: payload.notes === undefined ? undefined : payload.notes || null,
        isActive: payload.isActive,
      },
      select: patientSelect,
    });

    await auditFromRequest(req, {
      action: 'patient.updated',
      entityType: 'Patient',
      entityId: id,
      patientId: id,
      metadata: { fields: Object.keys(payload) },
    });

    res.json({ patient });
  }),
);

/**
 * Patient ledger. Charges are kept distinct from money received; deposits are
 * payments without allocations and are counted exactly once.
 */
patientsRouter.get(
  '/:id/ledger',
  requirePermission('PAYMENTS_READ', 'FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const rawId = req.params.id?.trim();
    if (!rawId || rawId === 'undefined' || rawId === 'null') {
      throw notFound('Patient not found');
    }
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const patient = await prisma.patient.findFirst({
      where: isUuid ? { id: rawId } : { patientNumber: rawId },
      select: {
        id: true,
        patientNumber: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    });
    if (!patient) throw notFound('Patient not found');
    const id = patient.id;

    const [charges, payments, refunds] = await Promise.all([
      prisma.charge.findMany({
        where: { patientId: id },
        include: {
          allocations: { select: { amountMinor: true } },
          service: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.findMany({
        where: { patientId: id },
        include: {
          method: { select: { label: true } },
          refunds: { select: { amountMinor: true } },
          allocations: { select: { amountMinor: true, chargeId: true } },
        },
        orderBy: { receivedAt: 'desc' },
      }),
      prisma.refund.findMany({
        where: { patientId: id },
        include: { payment: { select: { methodKey: true } } },
        orderBy: { refundedAt: 'desc' },
      }),
    ]);

    const rows: LedgerRow[] = [];
    for (const charge of charges) {
      if (charge.status === 'VOID') continue;
      rows.push({
        id: charge.id,
        type: 'CHARGE',
        date: charge.createdAt,
        amountMinor: charge.amountMinor,
        description: charge.description,
        status: charge.status,
      });
      for (const alloc of charge.allocations) {
        rows.push({
          id: `${charge.id}:${alloc.amountMinor}`,
          type: 'ALLOCATION',
          date: charge.createdAt,
          amountMinor: alloc.amountMinor,
          description: `Allocated to ${charge.description}`,
          chargeId: charge.id,
        });
      }
    }
    for (const payment of payments) {
      if (payment.status !== 'COMPLETED') continue;
      rows.push({
        id: payment.id,
        type: 'PAYMENT',
        date: payment.receivedAt,
        amountMinor: payment.amountMinor,
        description: 'Payment received',
        method: payment.method.label,
        reference: payment.reference,
        paymentId: payment.id,
      });
    }
    for (const refund of refunds) {
      rows.push({
        id: refund.id,
        type: 'REFUND',
        date: refund.refundedAt,
        amountMinor: refund.amountMinor,
        description: refund.reason,
        method: refund.payment.methodKey,
        paymentId: refund.paymentId,
      });
    }

    const summary = summariseLedger(rows);

    const chargeRows = charges.map((charge) => {
      const allocatedMinor = charge.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
      return {
        id: charge.id,
        description: charge.description,
        service: charge.service?.name ?? null,
        amountMinor: charge.amountMinor,
        allocatedMinor,
        balanceMinor: charge.status === 'VOID' ? 0 : charge.amountMinor - allocatedMinor,
        status: charge.status,
        createdAt: charge.createdAt,
      };
    });

    const paymentRows = payments.map((payment) => {
      const allocatedMinor = payment.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
      const refundedMinor = payment.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
      return {
        id: payment.id,
        amountMinor: payment.amountMinor,
        allocatedMinor,
        refundedMinor,
        unallocatedMinor: payment.amountMinor - allocatedMinor - refundedMinor,
        method: payment.method.label,
        methodKey: payment.methodKey,
        reference: payment.reference,
        status: payment.status,
        receivedAt: payment.receivedAt,
        notes: payment.notes,
      };
    });

    res.json({
      patient,
      summary,
      charges: chargeRows,
      payments: paymentRows,
      refunds: refunds.map((r) => ({
        id: r.id,
        paymentId: r.paymentId,
        amountMinor: r.amountMinor,
        reason: r.reason,
        refundedAt: r.refundedAt,
      })),
      timeline: rows
        .filter((r) => r.type !== 'ALLOCATION')
        .sort((a, b) => b.date.getTime() - a.date.getTime()),
    });
  }),
);

/** Soft-deactivate rather than delete: history must survive. */
patientsRouter.delete(
  '/:id',
  requirePermission('PATIENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const openCharges = await prisma.charge.count({
      where: { patientId: id, status: 'OPEN' },
    });
    if (openCharges > 0) {
      throw badRequest('This patient has an open balance and cannot be deactivated yet.');
    }
    const patient = await prisma.patient.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true },
    });
    await auditFromRequest(req, {
      action: 'patient.deactivated',
      entityType: 'Patient',
      entityId: id,
      patientId: id,
    });
    res.json({ patient });
  }),
);
