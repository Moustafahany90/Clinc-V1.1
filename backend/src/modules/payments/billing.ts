import { z } from 'zod';
import type { Charge, Payment, Prisma } from '@prisma/client';
import { badRequest } from '../../lib/errors.js';

export type Tx = Prisma.TransactionClient;

/**
 * Optional payment capture supplied while booking an appointment or adding a
 * walk-in. Pending is the default so registration stays fast and a booking is
 * never mistaken for a payment.
 */
export const bookingPaymentSchema = z
  .object({
    status: z.enum(['PENDING', 'DEPOSIT', 'PAID']).default('PENDING'),
    amountMinor: z.number().int().min(0).max(1_000_000_000).optional(),
    methodKey: z.string().trim().min(1).max(40).optional(),
    reference: z.string().trim().max(120).optional().or(z.literal('')),
    notes: z.string().trim().max(1000).optional().or(z.literal('')),
  })
  .optional();

export type BookingPaymentInput = z.infer<typeof bookingPaymentSchema>;

export interface ServiceBillingInput {
  patientId: string;
  appointmentId: string;
  visitId?: string | null;
  service: { id: string; name: string; priceMinor: number };
  createdById: string;
  payment?: BookingPaymentInput;
}

export interface ServiceBillingResult {
  charge: Charge | null;
  payment: Payment | null;
}

/**
 * Create the revenue charge for a service and, when requested, the matching
 * payment + allocation in the same database transaction.
 *
 * - The service price is copied into `Charge.amountMinor` so later Settings
 *   changes never rewrite history.
 * - `Charge.appointmentId` is unique, so an appointment can only ever be billed
 *   once. Retries return the existing charge instead of duplicating it.
 * - The booking payment uses a deterministic idempotency key, so a retried
 *   request can never create a second payment or allocation.
 * - Zero-priced services are intentionally not billed automatically.
 */
export async function recordServiceRevenue(
  tx: Tx,
  input: ServiceBillingInput,
): Promise<ServiceBillingResult> {
  if (input.service.priceMinor <= 0) {
    return { charge: null, payment: null };
  }

  const paymentKey = `booking:${input.appointmentId}`;

  // Retry protection: if this appointment's booking payment already exists,
  // return both records untouched.
  const existingPayment = await tx.payment.findUnique({
    where: { idempotencyKey: paymentKey },
    include: { allocations: true },
  });
  if (existingPayment) {
    const charge = await tx.charge.findUnique({
      where: { appointmentId: input.appointmentId },
    });
    return { charge, payment: existingPayment };
  }

  let charge = await tx.charge.findUnique({
    where: { appointmentId: input.appointmentId },
    include: { allocations: { select: { amountMinor: true } } },
  });

  if (!charge) {
    charge = await tx.charge.create({
      data: {
        patientId: input.patientId,
        visitId: input.visitId ?? null,
        appointmentId: input.appointmentId,
        serviceId: input.service.id,
        // Snapshot the service name and price at registration time.
        description: input.service.name,
        amountMinor: input.service.priceMinor,
        createdById: input.createdById,
      },
      include: { allocations: { select: { amountMinor: true } } },
    });
  }

  const payment = await createBookingPayment(tx, charge, input, paymentKey);

  return { charge, payment };
}

async function createBookingPayment(
  tx: Tx,
  charge: Charge & { allocations: Array<{ amountMinor: number }> },
  input: ServiceBillingInput,
  paymentKey: string,
): Promise<Payment | null> {
  const requested = input.payment;
  if (!requested || requested.status === 'PENDING') return null;

  if (charge.status === 'VOID') {
    throw badRequest('This charge was voided. Re-bill the service before taking a payment.');
  }

  const allocatedMinor = charge.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
  const balanceMinor = charge.amountMinor - allocatedMinor;

  let amountMinor: number;
  if (requested.status === 'PAID') {
    // Fully paid means the outstanding balance, which is the service price for
    // a new charge. If it is already settled there is nothing left to collect.
    if (balanceMinor <= 0) return null;
    amountMinor = balanceMinor;
  } else {
    amountMinor = requested.amountMinor ?? 0;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw badRequest('Enter a deposit greater than zero.');
    }
    if (amountMinor > balanceMinor) {
      throw badRequest('The deposit cannot exceed the outstanding balance.');
    }
  }

  if (!requested.methodKey) {
    throw badRequest('Select a payment method.');
  }

  const method = await tx.paymentMethod.findFirst({
    where: { key: requested.methodKey, isActive: true },
  });
  if (!method) throw badRequest('Select an active payment method.');
  if (method.requiresReference && !requested.reference?.trim()) {
    throw badRequest(`${method.label} payments require a reference number.`);
  }

  const payment = await tx.payment.create({
    data: {
      patientId: charge.patientId,
      amountMinor,
      methodKey: method.key,
      reference: requested.reference?.trim() || null,
      notes: requested.notes?.trim() || null,
      visitId: input.visitId ?? null,
      receivedById: input.createdById,
      idempotencyKey: paymentKey,
      allocations: {
        create: [{ chargeId: charge.id, amountMinor }],
      },
    },
    include: {
      method: { select: { label: true, key: true } },
      allocations: true,
    },
  });

  if (allocatedMinor + amountMinor >= charge.amountMinor) {
    await tx.charge.update({ where: { id: charge.id }, data: { status: 'SETTLED' } });
    charge.status = 'SETTLED';
  }

  return payment;
}
