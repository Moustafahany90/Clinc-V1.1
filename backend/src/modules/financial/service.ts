import { prisma } from '../../lib/prisma.js';
import { getClinicSettings } from '../../lib/clinic.js';
import { clinicDayRange, dateOnlyToDb, CLINIC_CURRENCY } from '../../lib/time.js';

/**
 * Daily financial statistics. Extracted from `financialRouter.get('/daily')`
 * so both the API and the Quick Actions module can reuse the exact same
 * accounting query without duplication. Behavior is identical to the original
 * `dailyFigures`.
 */
export interface DailyMethodRow {
  key: string;
  label: string;
  paymentsCount: number;
  paymentsMinor: number;
  refundsMinor: number;
  netMinor: number;
}

export interface DailyStats {
  date: string;
  timezone: string;
  currency: string;
  charges: { count: number; totalMinor: number };
  payments: { count: number; totalMinor: number };
  refunds: { count: number; totalMinor: number };
  expenses: {
    count: number;
    totalMinor: number;
    byCategory: Array<{ name: string; totalMinor: number }>;
  };
  byMethod: DailyMethodRow[];
  totals: {
    collectedMinor: number;
    netCashMinor: number;
    billedMinor: number;
  };
}

/** Full expense record, used only when EXPENSES_READ permission is granted. */
export interface ExpenseRow {
  id: string;
  expenseDate: Date;
  amountMinor: number;
  category: { name: string };
  description: string | null;
  methodKey: string | null;
  reference: string | null;
  status: string;
}

export async function getDailyStats(dateOnly: string): Promise<DailyStats> {
  const { start, end } = clinicDayRange(dateOnly);
  const dbDate = dateOnlyToDb(dateOnly);

  const [charges, payments, refunds, expenses, methods] = await Promise.all([
    prisma.charge.findMany({
      where: { status: { not: 'VOID' }, createdAt: { gte: start, lt: end } },
      select: { amountMinor: true },
    }),
    prisma.payment.findMany({
      where: { status: 'COMPLETED', receivedAt: { gte: start, lt: end } },
      select: { amountMinor: true, methodKey: true },
    }),
    prisma.refund.findMany({
      where: { refundedAt: { gte: start, lt: end } },
      select: { amountMinor: true, payment: { select: { methodKey: true } } },
    }),
    prisma.expense.findMany({
      where: { expenseDate: dbDate, status: 'RECORDED' },
      select: { amountMinor: true, category: { select: { name: true } } },
    }),
    prisma.paymentMethod.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
  ]);

  const chargesMinor = charges.reduce((sum, row) => sum + row.amountMinor, 0);
  const paymentsMinor = payments.reduce((sum, row) => sum + row.amountMinor, 0);
  const refundsMinor = refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  const expensesMinor = expenses.reduce((sum, row) => sum + row.amountMinor, 0);

  const byMethod: DailyMethodRow[] = methods.map((method) => {
    const paid = payments
      .filter((row) => row.methodKey === method.key)
      .reduce((sum, row) => sum + row.amountMinor, 0);
    const refunded = refunds
      .filter((row) => row.payment?.methodKey === method.key)
      .reduce((sum, row) => sum + row.amountMinor, 0);
    return {
      key: method.key,
      label: method.label,
      paymentsCount: payments.filter((row) => row.methodKey === method.key).length,
      paymentsMinor: paid,
      refundsMinor: refunded,
      netMinor: paid - refunded,
    };
  });

  const byCategory: Array<{ name: string; totalMinor: number }> = [];
  const categoryMap = new Map<string, number>();
  for (const expense of expenses) {
    categoryMap.set(expense.category.name, (categoryMap.get(expense.category.name) ?? 0) + expense.amountMinor);
  }
  for (const [name, totalMinor] of categoryMap.entries()) {
    byCategory.push({ name, totalMinor });
  }

  return {
    date: dateOnly,
    timezone: (await getClinicSettings()).timezone,
    currency: CLINIC_CURRENCY,
    charges: { count: charges.length, totalMinor: chargesMinor },
    payments: { count: payments.length, totalMinor: paymentsMinor },
    refunds: { count: refunds.length, totalMinor: refundsMinor },
    expenses: {
      count: expenses.length,
      totalMinor: expensesMinor,
      byCategory,
    },
    byMethod,
    totals: {
      collectedMinor: paymentsMinor - refundsMinor,
      netCashMinor: paymentsMinor - refundsMinor - expensesMinor,
      billedMinor: chargesMinor,
    },
  };
}
