import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  dateOnlySchema,
  paginationSchema,
  parseBody,
  parseParams,
  parseQuery,
  uuidSchema,
} from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import { clinicDayRange } from '../../lib/time.js';

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

async function lockLedger(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  patientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`;
}

const allocationSchema = z.object({
  chargeId: uuidSchema,
  amountMinor: z.number().int().min(1),
});

const createPaymentSchema = z.object({
  patientId: uuidSchema,
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  methodKey: z.string().trim().min(1).max(40),
  reference: z.string().trim().max(120).optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  visitId: uuidSchema.optional().nullable(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  allocations: z.array(allocationSchema).max(50).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

paymentsRouter.post(
  '/',
  requirePermission('PAYMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const payload = parseBody(createPaymentSchema, req);

    const [patient, method] = await Promise.all([
      prisma.patient.findFirst({ where: { id: payload.patientId, isActive: true } }),
      prisma.paymentMethod.findFirst({ where: { key: payload.methodKey, isActive: true } }),
    ]);
    if (!patient) throw badRequest('Select an active patient.');
    if (!method) throw badRequest('Select an active payment method.');
    if (method.requiresReference && !payload.reference) {
      throw badRequest(`${method.label} payments require a reference number.`);
    }

    if (payload.idempotencyKey) {
      const duplicate = await prisma.payment.findUnique({
        where: { idempotencyKey: payload.idempotencyKey },
        select: { id: true },
      });
      if (duplicate) {
        throw conflict('This payment was already recorded.', { paymentId: duplicate.id });
      }
    }

    const allocations = payload.allocations ?? [];
    const totalAllocated = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    if (totalAllocated > payload.amountMinor) {
      throw badRequest('Allocated amounts cannot exceed the payment total.');
    }
    if (new Set(allocations.map((a) => a.chargeId)).size !== allocations.length) {
      throw badRequest('Each charge can only be allocated once per payment.');
    }

    const payment = await prisma.$transaction(async (tx) => {
      await lockLedger(tx, patient.id);

      if (allocations.length > 0) {
        const charges = await tx.charge.findMany({
          where: { id: { in: allocations.map((a) => a.chargeId) }, patientId: patient.id },
          include: { allocations: { select: { amountMinor: true } } },
        });
        const chargeMap = new Map(charges.map((c) => [c.id, c]));

        for (const allocation of allocations) {
          const charge = chargeMap.get(allocation.chargeId);
          if (!charge) throw badRequest('One of the selected charges does not belong to this patient.');
          if (charge.status === 'VOID') throw badRequest('A void charge cannot receive a payment.');
          const already = charge.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
          if (allocation.amountMinor > charge.amountMinor - already) {
            throw badRequest('An allocation exceeds the remaining balance of its charge.');
          }
        }
      }

      const created = await tx.payment.create({
        data: {
          patientId: patient.id,
          amountMinor: payload.amountMinor,
          methodKey: method.key,
          reference: payload.reference || null,
          notes: payload.notes || null,
          visitId: payload.visitId ?? null,
          receivedById: me.id,
          ...(payload.receivedAt ? { receivedAt: new Date(payload.receivedAt) } : {}),
          idempotencyKey: payload.idempotencyKey ?? null,
          allocations: {
            create: allocations.map((a) => ({
              chargeId: a.chargeId,
              amountMinor: a.amountMinor,
            })),
          },
        },
        include: {
          method: { select: { label: true, key: true } },
          allocations: true,
        },
      });

      // Mark fully allocated charges as settled.
      for (const allocation of allocations) {
        const charge = await tx.charge.findUnique({
          where: { id: allocation.chargeId },
          include: { allocations: { select: { amountMinor: true } } },
        });
        if (!charge) continue;
        const allocated = charge.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
        if (allocated >= charge.amountMinor && charge.status !== 'SETTLED') {
          await tx.charge.update({ where: { id: charge.id }, data: { status: 'SETTLED' } });
        }
      }

      return created;
    });

    await auditFromRequest(req, {
      action: 'payment.recorded',
      entityType: 'Payment',
      entityId: payment.id,
      patientId: patient.id,
      metadata: {
        amountMinor: payment.amountMinor,
        methodKey: payment.methodKey,
        allocatedMinor: totalAllocated,
      },
    });

    res.status(201).json({ payment });
  }),
);

paymentsRouter.get(
  '/',
  requirePermission('PAYMENTS_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      paginationSchema.extend({
        patientId: uuidSchema.optional(),
        date: dateOnlySchema.optional(),
        from: dateOnlySchema.optional(),
        to: dateOnlySchema.optional(),
        methodKey: z.string().trim().max(40).optional(),
      }),
      req,
    );

    const receivedAt =
      query.date
        ? { gte: clinicDayRange(query.date).start, lt: clinicDayRange(query.date).end }
        : query.from || query.to
          ? {
              ...(query.from ? { gte: clinicDayRange(query.from).start } : {}),
              ...(query.to ? { lt: clinicDayRange(query.to).end } : {}),
            }
          : undefined;

    const where = {
      patientId: query.patientId,
      methodKey: query.methodKey,
      ...(receivedAt ? { receivedAt } : {}),
    };

    const [total, payments] = await prisma.$transaction([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        include: {
          method: { select: { label: true, key: true } },
          patient: {
            select: { id: true, patientNumber: true, firstName: true, lastName: true },
          },
          allocations: { select: { chargeId: true, amountMinor: true } },
          refunds: { select: { id: true, amountMinor: true, refundedAt: true } },
          receivedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { receivedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    res.json({ payments, total, page: query.page, pageSize: query.pageSize });
  }),
);

paymentsRouter.get(
  '/:id',
  requirePermission('PAYMENTS_READ'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        method: true,
        patient: {
          select: { id: true, patientNumber: true, firstName: true, lastName: true, phone: true },
        },
        allocations: { include: { charge: { select: { id: true, description: true } } } },
        refunds: { include: { refundedBy: { select: { firstName: true, lastName: true } } } },
        receivedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!payment) throw notFound('Payment not found');
    res.json({ payment });
  }),
);

/** Refunds are separate records; the original payment is never rewritten. */
paymentsRouter.post(
  '/:id/refund',
  requirePermission('REFUNDS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(
      z.object({
        amountMinor: z.number().int().min(1).max(1_000_000_000),
        reason: z.string().trim().min(3, 'Give a reason for the refund.').max(500),
      }),
      req,
    );
    const me = currentUser(req);

    const refund = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id },
        include: { refunds: { select: { amountMinor: true } } },
      });
      if (!payment) throw notFound('Payment not found');
      if (payment.status !== 'COMPLETED') throw badRequest('This payment cannot be refunded.');

      await lockLedger(tx, payment.patientId);
      const alreadyRefunded = payment.refunds.reduce((sum, r) => sum + r.amountMinor, 0);
      const refundable = payment.amountMinor - alreadyRefunded;
      if (payload.amountMinor > refundable) {
        throw badRequest(`At most ${(refundable / 100).toFixed(2)} remains refundable on this payment.`);
      }

      return tx.refund.create({
        data: {
          paymentId: payment.id,
          patientId: payment.patientId,
          amountMinor: payload.amountMinor,
          reason: payload.reason,
          refundedById: me.id,
        },
        include: { payment: { select: { method: { select: { label: true } } } } },
      });
    });

    await auditFromRequest(req, {
      action: 'refund.recorded',
      entityType: 'Refund',
      entityId: refund.id,
      patientId: refund.patientId,
      metadata: { paymentId: id, amountMinor: refund.amountMinor, reason: payload.reason },
    });

    res.status(201).json({ refund });
  }),
);

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

const createChargeSchema = z.object({
  patientId: uuidSchema,
  description: z.string().trim().min(1).max(200),
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  serviceId: uuidSchema.optional().nullable(),
  visitId: uuidSchema.optional().nullable(),
});

paymentsRouter.post(
  '/charges',
  requirePermission('PAYMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(createChargeSchema, req);
    const me = currentUser(req);

    const patient = await prisma.patient.findFirst({
      where: { id: payload.patientId, isActive: true },
    });
    if (!patient) throw badRequest('Select an active patient.');

    const charge = await prisma.charge.create({
      data: {
        patientId: patient.id,
        description: payload.description,
        amountMinor: payload.amountMinor,
        serviceId: payload.serviceId ?? null,
        visitId: payload.visitId ?? null,
        createdById: me.id,
      },
    });

    await auditFromRequest(req, {
      action: 'charge.created',
      entityType: 'Charge',
      entityId: charge.id,
      patientId: patient.id,
      metadata: { amountMinor: charge.amountMinor, description: charge.description },
    });

    res.status(201).json({ charge });
  }),
);

paymentsRouter.get(
  '/charges/list',
  requirePermission('PAYMENTS_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      paginationSchema.extend({
        patientId: uuidSchema.optional(),
        status: z.enum(['OPEN', 'SETTLED', 'VOID']).optional(),
      }),
      req,
    );

    const where = { patientId: query.patientId, status: query.status };
    const [total, charges] = await prisma.$transaction([
      prisma.charge.count({ where }),
      prisma.charge.findMany({
        where,
        include: {
          allocations: { select: { amountMinor: true } },
          service: { select: { name: true } },
          patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    res.json({
      charges: charges.map((charge) => {
        const allocatedMinor = charge.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
        return {
          ...charge,
          allocatedMinor,
          balanceMinor: charge.amountMinor - allocatedMinor,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  }),
);

paymentsRouter.post(
  '/charges/:id/void',
  requirePermission('PAYMENTS_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(
      z.object({ reason: z.string().trim().min(3).max(300) }),
      req,
    );

    const charge = await prisma.charge.findUnique({
      where: { id },
      include: { allocations: true },
    });
    if (!charge) throw notFound('Charge not found');
    if (charge.status === 'VOID') throw badRequest('This charge is already void.');
    if (charge.allocations.length > 0) {
      throw badRequest('Refund or reallocate the payments on this charge before voiding it.');
    }

    const updated = await prisma.charge.update({
      where: { id },
      data: { status: 'VOID', voidReason: payload.reason, voidedAt: new Date() },
    });

    await auditFromRequest(req, {
      action: 'charge.voided',
      entityType: 'Charge',
      entityId: id,
      patientId: charge.patientId,
      metadata: { reason: payload.reason, amountMinor: charge.amountMinor },
    });

    res.json({ charge: updated });
  }),
);
