import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clinicDateString } from '../src/lib/time.js';

/**
 * Phase 3 production-readiness audit: end-to-end financial workflows.
 *
 * All amounts are integer piasters. Each assertion independently recomputes
 * the expected ledger totals instead of trusting a single report endpoint.
 * Destructive: refuses to run unless the database name ends in `_test`.
 */

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!/_test$/.test(databaseName)) {
  throw new Error(
    'Refusing to run destructive tests: DATABASE_URL must point at a database whose name ends in "_test".',
  );
}

let server: Server;
let baseUrl = '';
let adminToken = '';
let patientId = '';

interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
  text: string;
  bytes: Uint8Array;
}

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers, text, bytes };
}

async function createPatient(label: string, phone: string): Promise<string> {
  const result = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Finance',
      lastName: label,
      phone,
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.patient.id as string;
}

async function createCharge(patient: string, amountMinor: number): Promise<string> {
  const result = await api('/payments/charges', {
    method: 'POST',
    token: adminToken,
    body: { patientId: patient, description: `Phase 3 charge ${amountMinor}`, amountMinor },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.charge.id as string;
}

async function createPayment(
  patient: string,
  amountMinor: number,
  allocations: Array<{ chargeId: string; amountMinor: number }> = [],
  extra: Record<string, unknown> = {},
): Promise<ApiResult> {
  return api('/payments', {
    method: 'POST',
    token: adminToken,
    body: {
      patientId: patient,
      amountMinor,
      methodKey: 'CASH',
      ...(allocations.length > 0 ? { allocations } : {}),
      ...extra,
    },
  });
}

before(async () => {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length > 0) {
    const list = tables.map((row) => `"${row.tablename.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

  const setup = await api('/setup', {
    method: 'POST',
    body: {
      admin: {
        firstName: 'Phase3',
        lastName: 'Finance Admin',
        email: 'phase3.finance.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Phase 3 Finance Clinic',
        phone: '+20 100 000 0000',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: Array.from({ length: 7 }, (_, index) => ({
        dayOfWeek: index + 1,
        isOpen: true,
        openMinute: 540,
        closeMinute: 1260,
        breakStartMinute: null,
        breakEndMinute: null,
      })),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;
  patientId = await createPatient('Reconciliation', '01110000001');
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('charges, payments, refunds and expenses reconcile across ledger, reports and CSV export', async () => {
  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { name: 'Supplies' } });

  const chargeA = await createCharge(patientId, 10_000);
  const chargeB = await createCharge(patientId, 5_000);

  const payment = await createPayment(patientId, 12_000, [
    { chargeId: chargeA, amountMinor: 10_000 },
    { chargeId: chargeB, amountMinor: 2_000 },
  ]);
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  const paymentId = payment.body.payment.id as string;
  // Use the clinic calendar day of the actual payment instant so timezone
  // boundaries cannot make the daily/monthly assertions flaky.
  const today = clinicDateString(new Date(payment.body.payment.receivedAt));
  const [year, month] = today.split('-').map(Number);

  const partialRefund = await api(`/payments/${paymentId}/refund`, {
    method: 'POST',
    token: adminToken,
    body: { amountMinor: 2_000, reason: 'Phase 3 reconciliation refund' },
  });
  assert.equal(partialRefund.status, 201, JSON.stringify(partialRefund.body));

  const expense = await api('/expenses', {
    method: 'POST',
    token: adminToken,
    body: {
      expenseDate: today,
      amountMinor: 1_500,
      categoryId: category.id,
      description: 'Phase 3 synthetic supplies',
      methodKey: 'CASH',
    },
  });
  assert.equal(expense.status, 201, JSON.stringify(expense.body));

  // Independently computed expectations from the primitive records.
  const expected = {
    chargesMinor: 15_000,
    paymentsMinor: 12_000,
    refundsMinor: 2_000,
    allocatedMinor: 12_000,
    outstandingMinor: 3_000,
    unallocatedMinor: -2_000,
    balanceMinor: 5_000,
  };

  const ledger = await api(`/patients/${patientId}/ledger`, { token: adminToken });
  assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(ledger.body.summary[key], value, `ledger summary ${key}`);
  }

  const position = await api('/financial-reports/position', { token: adminToken });
  assert.equal(position.status, 200, JSON.stringify(position.body));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(position.body.position[key], value, `position ${key}`);
  }

  const daily = await api(`/financial-reports/daily?date=${today}`, { token: adminToken });
  assert.equal(daily.status, 200, JSON.stringify(daily.body));
  assert.equal(daily.body.charges.totalMinor, 15_000);
  assert.equal(daily.body.payments.totalMinor, 12_000);
  assert.equal(daily.body.refunds.totalMinor, 2_000);
  assert.equal(daily.body.expenses.totalMinor, 1_500);
  assert.equal(daily.body.totals.billedMinor, 15_000);
  assert.equal(daily.body.totals.collectedMinor, 10_000);
  assert.equal(daily.body.totals.netCashMinor, 8_500);

  const monthly = await api(`/financial-reports/monthly?year=${year}&month=${month}`, {
    token: adminToken,
  });
  assert.equal(monthly.status, 200, JSON.stringify(monthly.body));
  assert.equal(monthly.body.totals.paymentsMinor, 12_000);
  assert.equal(monthly.body.totals.refundsMinor, 2_000);
  assert.equal(monthly.body.totals.expensesMinor, 1_500);
  assert.equal(monthly.body.totals.billedMinor, 15_000);
  assert.equal(monthly.body.totals.collectedMinor, 10_000);
  assert.equal(monthly.body.totals.netCashMinor, 8_500);

  const statement = await api(`/financial-reports/statement?from=${today}&to=${today}`, {
    token: adminToken,
  });
  assert.equal(statement.status, 200, JSON.stringify(statement.body));
  assert.deepEqual(statement.body.counts, { charges: 2, payments: 1, refunds: 1, expenses: 1 });
  assert.equal(statement.body.totals.chargesMinor, 15_000);
  assert.equal(statement.body.totals.collectedMinor, 10_000);
  assert.equal(statement.body.totals.netCashMinor, 8_500);
  assert.equal(statement.body.rows.find((row: any) => row.type === 'REFUND').amountMinor, -2_000);

  const preview = await api(
    `/financial-reports/accounting-export/preview?from=${today}&to=${today}`,
    { token: adminToken },
  );
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.totals.expensesMinor, 1_500);
  assert.deepEqual(preview.body.columns, [
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
  ]);

  const csv = await api(`/financial-reports/accounting-export/run?from=${today}&to=${today}`, {
    token: adminToken,
  });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') ?? '', /accounting-.*\.csv/);
  assert.deepEqual(
    Array.from(csv.bytes.slice(0, 3)),
    [0xef, 0xbb, 0xbf],
    'CSV export must include the UTF-8 BOM for Excel',
  );
  const lines = csv.text.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 6, `expected header + 5 transaction rows, got ${lines.length}`);
  const parsed = lines.map((line) => line.replace(/^\uFEFF/, '').split(','));
  assert.equal(parsed[0][8], 'amount_minor');
  const cell = (row: string[], index: number) => row[index].replace(/^"|"$/g, '');
  const refundRow = parsed.find((row) => cell(row, 1) === 'REFUND');
  const expenseRow = parsed.find((row) => cell(row, 1) === 'EXPENSE');
  assert.ok(refundRow);
  assert.ok(expenseRow);
  assert.equal(cell(refundRow, 8), '-2000', 'refund amounts must stay numeric and signed in CSV');
  assert.equal(cell(expenseRow, 8), '-1500', 'expense amounts must stay numeric and signed in CSV');
});

test('invalid, duplicate and out-of-bounds financial operations leave the ledger unchanged', async () => {
  const patient = await createPatient('InvalidOps', '01110000002');
  const charge = await createCharge(patient, 8_000);

  const overTotal = await createPayment(patient, 5_000, [{ chargeId: charge, amountMinor: 5_001 }]);
  assert.equal(overTotal.status, 400);
  const duplicateCharge = await createPayment(patient, 8_000, [
    { chargeId: charge, amountMinor: 1_000 },
    { chargeId: charge, amountMinor: 1_000 },
  ]);
  assert.equal(duplicateCharge.status, 400);
  const overCharge = await createPayment(patient, 9_000, [{ chargeId: charge, amountMinor: 9_000 }]);
  assert.equal(overCharge.status, 400);
  const missingReference = await api('/payments', {
    method: 'POST',
    token: adminToken,
    body: { patientId: patient, amountMinor: 100, methodKey: 'INSTAPAY' },
  });
  assert.equal(missingReference.status, 400);

  let financials = await prisma.payment.count({ where: { patientId: patient } });
  assert.equal(financials, 0, 'failed payments must never be persisted');
  assert.equal(await prisma.paymentAllocation.count({ where: { chargeId: charge } }), 0);

  const payment = await createPayment(patient, 8_000, [{ chargeId: charge, amountMinor: 8_000 }]);
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  const paymentId = payment.body.payment.id as string;
  assert.equal((await prisma.charge.findUniqueOrThrow({ where: { id: charge } })).status, 'SETTLED');

  const voidSettled = await api(`/payments/charges/${charge}/void`, {
    method: 'POST',
    token: adminToken,
    body: { reason: 'Attempt to void a settled charge' },
  });
  assert.equal(voidSettled.status, 400);

  const overRefund = await api(`/payments/${paymentId}/refund`, {
    method: 'POST',
    token: adminToken,
    body: { amountMinor: 8_001, reason: 'Attempt to refund too much' },
  });
  assert.equal(overRefund.status, 400);

  const firstRefund = await api(`/payments/${paymentId}/refund`, {
    method: 'POST',
    token: adminToken,
    body: { amountMinor: 5_000, reason: 'Synthetic partial refund one' },
  });
  assert.equal(firstRefund.status, 201, JSON.stringify(firstRefund.body));
  const secondRefund = await api(`/payments/${paymentId}/refund`, {
    method: 'POST',
    token: adminToken,
    body: { amountMinor: 3_000, reason: 'Synthetic partial refund two' },
  });
  assert.equal(secondRefund.status, 201, JSON.stringify(secondRefund.body));
  const extraRefund = await api(`/payments/${paymentId}/refund`, {
    method: 'POST',
    token: adminToken,
    body: { amountMinor: 1, reason: 'Attempt to exceed refundable amount' },
  });
  assert.equal(extraRefund.status, 400);
  assert.equal(
    (
      await prisma.refund.aggregate({ where: { paymentId }, _sum: { amountMinor: true } })
    )._sum.amountMinor,
    8_000,
  );

  const idempotencyKey = 'phase3-finance-idempotency-001';
  const firstIdempotent = await createPayment(patient, 1_000, [], { idempotencyKey });
  const secondIdempotent = await createPayment(patient, 1_000, [], { idempotencyKey });
  assert.equal(firstIdempotent.status, 201, JSON.stringify(firstIdempotent.body));
  assert.equal(secondIdempotent.status, 409, JSON.stringify(secondIdempotent.body));
  financials = await prisma.payment.count({ where: { idempotencyKey } });
  assert.equal(financials, 1);

  const category = await prisma.expenseCategory.findFirstOrThrow({ where: { name: 'Rent' } });
  const expenseBody = {
    expenseDate: clinicDateString(),
    amountMinor: 700,
    categoryId: category.id,
    description: 'Phase 3 duplicate expense probe',
    idempotencyKey: 'phase3-expense-idempotency-001',
  };
  const firstExpense = await api('/expenses', {
    method: 'POST',
    token: adminToken,
    body: expenseBody,
  });
  const duplicateExpense = await api('/expenses', {
    method: 'POST',
    token: adminToken,
    body: expenseBody,
  });
  assert.equal(firstExpense.status, 201, JSON.stringify(firstExpense.body));
  assert.equal(duplicateExpense.status, 400, JSON.stringify(duplicateExpense.body));
  assert.equal(
    await prisma.expense.count({ where: { idempotencyKey: expenseBody.idempotencyKey } }),
    1,
  );

  const voidExpense = await api(`/expenses/${firstExpense.body.expense.id}/void`, {
    method: 'POST',
    token: adminToken,
    body: { reason: 'Synthetic duplicate void probe' },
  });
  assert.equal(voidExpense.status, 200, JSON.stringify(voidExpense.body));
  const repeatedVoid = await api(`/expenses/${firstExpense.body.expense.id}/void`, {
    method: 'POST',
    token: adminToken,
    body: { reason: 'Second synthetic void attempt' },
  });
  assert.equal(repeatedVoid.status, 400);
  const voided = await prisma.expense.findUniqueOrThrow({
    where: { id: firstExpense.body.expense.id },
  });
  assert.equal(voided.status, 'VOID');
  assert.ok(voided.voidReason && voided.voidedAt);
});

test('unallocated deposits and voided charges are counted exactly once', async () => {
  const patient = await createPatient('Deposits', '01110000003');
  const before = await api('/financial-reports/position', { token: adminToken });
  assert.equal(before.status, 200);
  const startingCredit = before.body.position.unallocatedMinor;
  const startingCharges = before.body.position.chargesMinor;

  const deposit = await createPayment(patient, 3_000);
  assert.equal(deposit.status, 201, JSON.stringify(deposit.body));
  const charge = await createCharge(patient, 2_500);
  const voided = await api(`/payments/charges/${charge}/void`, {
    method: 'POST',
    token: adminToken,
    body: { reason: 'Synthetic cancellation before treatment' },
  });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  const after = await api('/financial-reports/position', { token: adminToken });
  assert.equal(after.status, 200);
  assert.equal(after.body.position.unallocatedMinor, startingCredit + 3_000);
  assert.equal(after.body.position.chargesMinor, startingCharges, 'voided charge must be excluded');
  assert.equal(after.body.position.allocatedMinor, before.body.position.allocatedMinor);
  const voidedCharge = await prisma.charge.findUniqueOrThrow({ where: { id: charge } });
  assert.equal(voidedCharge.status, 'VOID');
  assert.ok(voidedCharge.voidedAt && voidedCharge.voidReason);
});
