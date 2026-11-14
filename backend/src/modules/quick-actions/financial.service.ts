import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import type { AuthUser } from '../../lib/authTypes.js';
import { clinicDateString, clinicWeekRange } from '../../lib/time.js';
import { getDailyStats } from '../financial/service.js';

/** Shared row shape for money rows (minor units, EGP). */
export interface MoneyRow {
  date: string;
  revenueMinor: number;
  paymentsCount: number;
  paymentsMinor: number;
  refundsMinor: number;
}

/** Action 6 - today's revenue. Reuses the existing daily accounting query. */
export async function getTodayRevenue(me: AuthUser): Promise<{
  date: string;
  timezone: string;
  currency: string;
  totalRevenueMinor: number;
  refundsMinor: number;
  paymentsCount: number;
  paymentsTotalMinor: number;
  byMethod: import('../financial/service.js').DailyMethodRow[];
}> {
  const today = clinicDateString();
  const stats = await getDailyStats(today);
  return {
    date: today,
    timezone: stats.timezone,
    currency: stats.currency,
    totalRevenueMinor: stats.totals.collectedMinor,
    refundsMinor: stats.refunds.totalMinor,
    paymentsCount: stats.payments.count,
    paymentsTotalMinor: stats.payments.totalMinor,
    byMethod: stats.byMethod,
  };
}

/** Action 7 - weekly revenue for the clinic's Saturday-start week. */
export async function getWeeklyRevenue(me: AuthUser, query: { weekStart?: string } = {}): Promise<{
  weekStart: string;
  weekEnd: string;
  timezone: string;
  currency: string;
  totalRevenueMinor: number;
  totalPaymentsMinor: number;
  totalRefundsMinor: number;
  totalPaymentsCount: number;
  days: MoneyRow[];
}> {
  const today = clinicDateString();
  const week = clinicWeekRange(query.weekStart ?? today);

  const days: MoneyRow[] = [];
  let totalRevenue = 0;
  let totalPayments = 0;
  let totalRefunds = 0;
  let totalPaymentsCount = 0;

  for (const date of week.dates) {
    const stats = await getDailyStats(date);
    days.push({
      date,
      revenueMinor: stats.totals.collectedMinor,
      paymentsCount: stats.payments.count,
      paymentsMinor: stats.payments.totalMinor,
      refundsMinor: stats.refunds.totalMinor,
    });
    totalRevenue += stats.totals.collectedMinor;
    totalPayments += stats.payments.totalMinor;
    totalRefunds += stats.refunds.totalMinor;
    totalPaymentsCount += stats.payments.count;
  }

  const firstDate = week.dates[0];
  const firstStats = firstDate ? await getDailyStats(firstDate) : null;
  return {
    weekStart: week.start,
    weekEnd: week.end,
    timezone: firstStats ? firstStats.timezone : '',
    currency: firstStats ? firstStats.currency : '',
    totalRevenueMinor: totalRevenue,
    totalPaymentsMinor: totalPayments,
    totalRefundsMinor: totalRefunds,
    totalPaymentsCount,
    days,
  };
}

/** Action 8 - today's expenses. Row-level details only where EXPENSES_READ. */
export async function getTodayExpenses(me: AuthUser): Promise<{
  date: string;
  timezone: string;
  currency: string;
  totalMinor: number;
  count: number;
  byCategory: Array<{ name: string; totalMinor: number }>;
  details?: import('../financial/service.js').ExpenseRow[];
}> {
  const today = clinicDateString();
  const stats = await getDailyStats(today);

  const details = hasPermission(me, 'EXPENSES_READ')
    ? await prisma.expense.findMany({
        where: { expenseDate: new Date(`${today}T00:00:00Z`), status: 'RECORDED' },
        select: {
          id: true,
          expenseDate: true,
          amountMinor: true,
          category: { select: { name: true } },
          description: true,
          methodKey: true,
          reference: true,
          status: true,
        },
        orderBy: { expenseDate: 'desc' },
      })
    : undefined;

  return {
    date: today,
    timezone: stats.timezone,
    currency: stats.currency,
    totalMinor: stats.expenses.totalMinor,
    count: stats.expenses.count,
    byCategory: stats.expenses.byCategory,
    details,
  };
}

/** Action 9 - financial summary: today's revenue, expenses and net. */
export async function getFinancialSummary(me: AuthUser): Promise<{
  date: string;
  currency: string;
  revenueTodayMinor: number;
  expensesTodayMinor: number;
  netMinor: number;
}> {
  const today = clinicDateString();
  const stats = await getDailyStats(today);
  return {
    date: today,
    currency: stats.currency,
    revenueTodayMinor: stats.totals.collectedMinor,
    expensesTodayMinor: stats.expenses.totalMinor,
    netMinor: stats.totals.collectedMinor - stats.expenses.totalMinor,
  };
}
