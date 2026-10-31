import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest } from '../../lib/errors.js';
import { dateOnlySchema, parseQuery } from '../../lib/validate.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import {
  clinicDayRange,
  clinicMonthRange,
  clinicDateString,
  dateOnlyToDb,
  formatClinicDateTime,
  CLINIC_CURRENCY,
} from '../../lib/time.js';

export const financialRouter = Router();
financialRouter.use(authenticate);

async function allTimePosition() {
  const [chargeAgg, paymentAgg, refundAgg, allocationAgg] = await Promise.all([
    prisma.charge.aggregate({ where: { status: { not: 'VOID' } }, _sum: { amountMinor: true } }),
    prisma.payment.aggregate({ where: { status: 'COMPLETED' }, _sum: { amountMinor: true } }),
    prisma.refund.aggregate({ _sum: { amountMinor: true } }),
    prisma.paymentAllocation.aggregate({
      where: { charge: { status: { not: 'VOID' } } },
      _sum: { amountMinor: true },
    }),
  ]);

  const chargesMinor = chargeAgg._sum.amountMinor ?? 0;
  const paymentsMinor = paymentAgg._sum.amountMinor ?? 0;
  const refundsMinor = refundAgg._sum.amountMinor ?? 0;
  const allocatedMinor = allocationAgg._sum.amountMinor ?? 0;

  const outstandingMinor = chargesMinor - allocatedMinor;
  const unallocatedMinor = paymentsMinor - refundsMinor - allocatedMinor;

  return {
    chargesMinor,
    paymentsMinor,
    refundsMinor,
    allocatedMinor,
    outstandingMinor,
    unallocatedMinor,
    /** Positive: money held for the patient. Negative: patient owes extra. */
    balanceMinor: outstandingMinor - unallocatedMinor,
  };
}

async function dailyFigures(dateOnly: string) {
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

  const chargesMinor = charges.reduce((s, c) => s + c.amountMinor, 0);
  const paymentsMinor = payments.reduce((s, p) => s + p.amountMinor, 0);
  const refundsMinor = refunds.reduce((s, r) => s + r.amountMinor, 0);
  const expensesMinor = expenses.reduce((s, e) => s + e.amountMinor, 0);

  const byMethod = methods.map((method) => {
    const paid = payments
      .filter((p) => p.methodKey === method.key)
      .reduce((s, p) => s + p.amountMinor, 0);
    const refunded = refunds
      .filter((r) => r.payment.methodKey === method.key)
      .reduce((s, r) => s + r.amountMinor, 0);
    return {
      key: method.key,
      label: method.label,
      paymentsCount: payments.filter((p) => p.methodKey === method.key).length,
      paymentsMinor: paid,
      refundsMinor: refunded,
      netMinor: paid - refunded,
    };
  });

  const byCategory = new Map<string, number>();
  for (const expense of expenses) {
    byCategory.set(
      expense.category.name,
      (byCategory.get(expense.category.name) ?? 0) + expense.amountMinor,
    );
  }

  return {
    date: dateOnly,
    currency: CLINIC_CURRENCY,
    charges: { count: charges.length, totalMinor: chargesMinor },
    payments: { count: payments.length, totalMinor: paymentsMinor },
    refunds: { count: refunds.length, totalMinor: refundsMinor },
    expenses: {
      count: expenses.length,
      totalMinor: expensesMinor,
      byCategory: [...byCategory.entries()].map(([name, totalMinor]) => ({ name, totalMinor })),
    },
    byMethod,
    totals: {
      collectedMinor: paymentsMinor - refundsMinor,
      netCashMinor: paymentsMinor - refundsMinor - expensesMinor,
      billedMinor: chargesMinor,
    },
  };
}

financialRouter.get(
  '/daily',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(z.object({ date: dateOnlySchema.optional() }), req);
    const dateOnly = query.date ?? clinicDateString();
    const [figures, position] = await Promise.all([dailyFigures(dateOnly), allTimePosition()]);
    res.json({ ...figures, position });
  }),
);

financialRouter.get(
  '/monthly',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      z.object({
        year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
        month: z.coerce.number().int().min(1).max(12).default(new Date().getMonth() + 1),
      }),
      req,
    );

    const { start, end } = clinicMonthRange(query.year, query.month);
    const monthFrom = `${query.year}-${String(query.month).padStart(2, '0')}-01`;
    const daysInMonth = new Date(Date.UTC(query.year, query.month, 0)).getUTCDate();
    const monthTo = `${query.year}-${String(query.month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
    const [payments, refunds, expenses, charges] = await Promise.all([
      prisma.payment.findMany({
        where: { status: 'COMPLETED', receivedAt: { gte: start, lt: end } },
        select: { amountMinor: true, receivedAt: true, methodKey: true },
      }),
      prisma.refund.findMany({
        where: { refundedAt: { gte: start, lt: end } },
        select: { amountMinor: true, refundedAt: true },
      }),
      prisma.expense.findMany({
        where: {
          status: 'RECORDED',
          expenseDate: { gte: dateOnlyToDb(monthFrom), lte: dateOnlyToDb(monthTo) },
        },
        select: { amountMinor: true, expenseDate: true },
      }),
      prisma.charge.findMany({
        where: { status: { not: 'VOID' }, createdAt: { gte: start, lt: end } },
        select: { amountMinor: true, createdAt: true },
      }),
    ]);

    const days = new Map<
      string,
      { date: string; paymentsMinor: number; refundsMinor: number; expensesMinor: number; billedMinor: number }
    >();

    const bucket = (date: string) => {
      const existing = days.get(date);
      if (existing) return existing;
      const created = {
        date,
        paymentsMinor: 0,
        refundsMinor: 0,
        expensesMinor: 0,
        billedMinor: 0,
      };
      days.set(date, created);
      return created;
    };

    for (const p of payments) bucket(clinicDateString(p.receivedAt)).paymentsMinor += p.amountMinor;
    for (const r of refunds) bucket(clinicDateString(r.refundedAt)).refundsMinor += r.amountMinor;
    for (const e of expenses) bucket(e.expenseDate.toISOString().slice(0, 10)).expensesMinor += e.amountMinor;
    for (const c of charges) bucket(clinicDateString(c.createdAt)).billedMinor += c.amountMinor;

    const rows = [...days.values()]
      .map((d) => ({ ...d, netCashMinor: d.paymentsMinor - d.refundsMinor - d.expensesMinor }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals = rows.reduce(
      (acc, row) => ({
        paymentsMinor: acc.paymentsMinor + row.paymentsMinor,
        refundsMinor: acc.refundsMinor + row.refundsMinor,
        expensesMinor: acc.expensesMinor + row.expensesMinor,
        billedMinor: acc.billedMinor + row.billedMinor,
      }),
      { paymentsMinor: 0, refundsMinor: 0, expensesMinor: 0, billedMinor: 0 },
    );

    res.json({
      year: query.year,
      month: query.month,
      currency: CLINIC_CURRENCY,
      from: start,
      to: end,
      days: rows,
      totals: {
        ...totals,
        collectedMinor: totals.paymentsMinor - totals.refundsMinor,
        netCashMinor: totals.paymentsMinor - totals.refundsMinor - totals.expensesMinor,
      },
    });
  }),
);

financialRouter.get(
  '/position',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (_req, res) => {
    res.json({ position: await allTimePosition(), currency: CLINIC_CURRENCY });
  }),
);

// ---------------------------------------------------------------------------
// Accounting CSV export (Phase 2 feature, delivered behind a permission)
// ---------------------------------------------------------------------------

const rangeSchema = z.object({
  from: dateOnlySchema,
  to: dateOnlySchema,
});

async function exportRows(from: string, to: string) {
  const { start } = clinicDayRange(from);
  const { end } = clinicDayRange(to);
  if (end <= start) throw badRequest('The end date must be on or after the start date.');

  const [charges, payments, refunds, expenses] = await Promise.all([
    prisma.charge.findMany({
      where: { status: { not: 'VOID' }, createdAt: { gte: start, lt: end } },
      include: { patient: { select: { patientNumber: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.payment.findMany({
      where: { status: 'COMPLETED', receivedAt: { gte: start, lt: end } },
      include: {
        patient: { select: { patientNumber: true, firstName: true, lastName: true } },
        method: { select: { label: true } },
      },
      orderBy: { receivedAt: 'asc' },
    }),
    prisma.refund.findMany({
      where: { refundedAt: { gte: start, lt: end } },
      include: {
        patient: { select: { patientNumber: true, firstName: true, lastName: true } },
        payment: { select: { method: { select: { label: true } } } },
      },
      orderBy: { refundedAt: 'asc' },
    }),
    prisma.expense.findMany({
      where: {
        status: 'RECORDED',
        expenseDate: { gte: dateOnlyToDb(from), lte: dateOnlyToDb(to) },
      },
      include: { category: { select: { name: true } } },
      orderBy: { expenseDate: 'asc' },
    }),
  ]);

  return [
    ...charges.map((c) => ({
      date: formatClinicDateTime(c.createdAt),
      type: 'CHARGE',
      flow: 'BILLED',
      reference: c.id,
      patientNumber: c.patient.patientNumber,
      patientName: `${c.patient.firstName} ${c.patient.lastName}`,
      description: c.description,
      method: '',
      amountMinor: c.amountMinor,
    })),
    ...payments.map((p) => ({
      date: formatClinicDateTime(p.receivedAt),
      type: 'PAYMENT',
      flow: 'IN',
      reference: p.reference ?? p.id,
      patientNumber: p.patient.patientNumber,
      patientName: `${p.patient.firstName} ${p.patient.lastName}`,
      description: 'Payment received',
      method: p.method.label,
      amountMinor: p.amountMinor,
    })),
    ...refunds.map((r) => ({
      date: formatClinicDateTime(r.refundedAt),
      type: 'REFUND',
      flow: 'OUT',
      reference: r.paymentId,
      patientNumber: r.patient.patientNumber,
      patientName: `${r.patient.firstName} ${r.patient.lastName}`,
      description: r.reason,
      method: r.payment.method.label,
      amountMinor: -r.amountMinor,
    })),
    ...expenses.map((e) => ({
      date: e.expenseDate.toISOString().slice(0, 10),
      type: 'EXPENSE',
      flow: 'OUT',
      reference: e.reference ?? e.id,
      patientNumber: '',
      patientName: '',
      description: `${e.category.name}: ${e.description}`,
      method: e.methodKey ?? '',
      amountMinor: -e.amountMinor,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

financialRouter.get(
  '/statement',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const { from, to } = parseQuery(rangeSchema, req);
    const rows = await exportRows(from, to);
    const totals = rows.reduce(
      (acc, row) => {
        if (row.type === 'CHARGE') acc.chargesMinor += row.amountMinor;
        if (row.type === 'PAYMENT') acc.paymentsMinor += row.amountMinor;
        if (row.type === 'REFUND') acc.refundsMinor += Math.abs(row.amountMinor);
        if (row.type === 'EXPENSE') acc.expensesMinor += Math.abs(row.amountMinor);
        return acc;
      },
      { chargesMinor: 0, paymentsMinor: 0, refundsMinor: 0, expensesMinor: 0 },
    );
    const clinic = await prisma.clinicSettings.findFirst();
    res.json({
      clinic: {
        name: clinic?.name ?? 'Ultrasound Clinic',
        legalName: clinic?.legalName ?? null,
        phone: clinic?.phone ?? null,
        email: clinic?.email ?? null,
        address: clinic?.address ?? null,
        timezone: clinic?.timezone ?? 'Africa/Cairo',
      },
      from,
      to,
      currency: CLINIC_CURRENCY,
      counts: {
        charges: rows.filter((r) => r.type === 'CHARGE').length,
        payments: rows.filter((r) => r.type === 'PAYMENT').length,
        refunds: rows.filter((r) => r.type === 'REFUND').length,
        expenses: rows.filter((r) => r.type === 'EXPENSE').length,
      },
      totals: {
        ...totals,
        collectedMinor: totals.paymentsMinor - totals.refundsMinor,
        netCashMinor: totals.paymentsMinor - totals.refundsMinor - totals.expensesMinor,
      },
      rows,
    });
  }),
);

financialRouter.get(
  '/accounting-export/preview',
  requirePermission('FINANCE_EXPORT'),
  asyncHandler(async (req, res) => {
    const { from, to } = parseQuery(rangeSchema, req);
    const rows = await exportRows(from, to);
    const totals = rows.reduce(
      (acc, row) => {
        if (row.type === 'CHARGE') acc.chargesMinor += row.amountMinor;
        if (row.type === 'PAYMENT') acc.paymentsMinor += row.amountMinor;
        if (row.type === 'REFUND') acc.refundsMinor += Math.abs(row.amountMinor);
        if (row.type === 'EXPENSE') acc.expensesMinor += Math.abs(row.amountMinor);
        return acc;
      },
      { chargesMinor: 0, paymentsMinor: 0, refundsMinor: 0, expensesMinor: 0 },
    );
    res.json({
      from,
      to,
      currency: CLINIC_CURRENCY,
      counts: {
        charges: rows.filter((r) => r.type === 'CHARGE').length,
        payments: rows.filter((r) => r.type === 'PAYMENT').length,
        refunds: rows.filter((r) => r.type === 'REFUND').length,
        expenses: rows.filter((r) => r.type === 'EXPENSE').length,
      },
      totals: {
        ...totals,
        collectedMinor: totals.paymentsMinor - totals.refundsMinor,
        netCashMinor: totals.paymentsMinor - totals.refundsMinor - totals.expensesMinor,
      },
      columns: [
        'date',
        'type',
        'flow',
        'reference',
        'patient_number',
        'patient_name',
        'description',
        'method',
        'amount_minor',
        'currency',
      ],
    });
  }),
);

financialRouter.get(
  '/accounting-export/run',
  requirePermission('FINANCE_EXPORT'),
  asyncHandler(async (req, res) => {
    const { from, to } = parseQuery(rangeSchema, req);
    const rows = await exportRows(from, to);

    const header = [
      'date',
      'type',
      'flow',
      'reference',
      'patient_number',
      'patient_name',
      'description',
      'method',
      'amount_minor',
      'currency',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.date,
          row.type,
          row.flow,
          row.reference,
          row.patientNumber,
          row.patientName,
          row.description,
          row.method,
          String(row.amountMinor),
          CLINIC_CURRENCY,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    const filename = `accounting-${from}-to-${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // BOM keeps Excel happy with UTF-8 names.
    res.send(`\uFEFF${lines.join('\r\n')}`);
  }),
);

function csvCell(value: string): string {
  // Guard against CSV formula injection in spreadsheet software.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
