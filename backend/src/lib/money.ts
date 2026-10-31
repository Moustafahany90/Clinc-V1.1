import type { Prisma } from '@prisma/client';

/** Money is always an integer number of piasters (EGP minor units). */
export function toMinor(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

export function fromMinor(amountMinor: number): number {
  return amountMinor / 100;
}

export function isValidMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000_000;
}

export type LedgerRow = {
  id: string;
  type: 'CHARGE' | 'PAYMENT' | 'REFUND' | 'ALLOCATION';
  date: Date;
  amountMinor: number;
  description: string;
  reference?: string | null;
  method?: string | null;
  status?: string | null;
  chargeId?: string | null;
  paymentId?: string | null;
};

export interface LedgerSummary {
  chargesMinor: number;
  paymentsMinor: number;
  refundsMinor: number;
  allocatedMinor: number;
  /** Charges minus allocations: what the patient still owes for billed work. */
  outstandingMinor: number;
  /** Payment money not yet attached to a charge. */
  unallocatedMinor: number;
  /** Negative means the patient has credit with the clinic. */
  balanceMinor: number;
}

/**
 * Documented ledger rules (see docs/finance-rules.md):
 *   charges      = sum of non-void charges
 *   payments     = sum of completed payments
 *   refunds      = sum of refunds against completed payments
 *   allocated    = sum of payment allocations to non-void charges
 *   outstanding  = charges - allocated
 *   unallocated  = (payments - refunds) - allocated
 *   balance      = outstanding - unallocated  (positive = owes clinic)
 *
 * Deposits are payments with no allocation, so they are counted once: as
 * unallocated credit. They are never added to charges as well.
 */
export function summariseLedger(rows: LedgerRow[]): LedgerSummary {
  let chargesMinor = 0;
  let paymentsMinor = 0;
  let refundsMinor = 0;
  let allocatedMinor = 0;

  for (const row of rows) {
    if (row.type === 'CHARGE') chargesMinor += row.amountMinor;
    if (row.type === 'PAYMENT') paymentsMinor += row.amountMinor;
    if (row.type === 'REFUND') refundsMinor += row.amountMinor;
    if (row.type === 'ALLOCATION') allocatedMinor += row.amountMinor;
  }

  const outstandingMinor = chargesMinor - allocatedMinor;
  const unallocatedMinor = paymentsMinor - refundsMinor - allocatedMinor;

  return {
    chargesMinor,
    paymentsMinor,
    refundsMinor,
    allocatedMinor,
    outstandingMinor,
    unallocatedMinor,
    balanceMinor: outstandingMinor - unallocatedMinor,
  };
}

export function decimalToMinor(value: Prisma.Decimal | number | string): number {
  return Math.round(Number(value) * 100);
}
