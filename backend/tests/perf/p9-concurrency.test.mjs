/**
 * Phase 9 concurrency harness. All records are synthetic P9- data.
 *
 * Run from backend/ against the seeded disposable test database:
 *   node --test --test-concurrency=1 --import tsx tests/perf/p9-concurrency.test.mjs
 *
 * Refuses to run unless DATABASE_URL points at a *_test database. Does not
 * truncate; it creates only new P9-prefixed rows through the real API.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { clinicDateString, dateOnlyToDb } from '../../src/lib/time.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
assert.match(databaseName, /_test$/, 'P9 concurrency tests require a *_test database');
assert.equal(databaseName, 'clinic_p9_test', 'P9 concurrency tests require clinic_p9_test');

function uuid(prefix, i) {
  const h = (start, length) =>
    createHash('md5').update(`${prefix}-${i}`).digest('hex').slice(start, start + length);
  return `${h(0, 8)}-${h(8, 4)}-4${h(12, 3)}-a${h(16, 3)}-${h(18, 12)}`;
}

const P9 = {
  adminEmail: 'p9.admin@clinic.test',
  doctor1Email: 'p9.doctor1@clinic.test',
  password: 'P9-Synthetic-Pass!',
  doctorId: uuid('user', 2),
  run: `P9-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
};

let server;
let baseUrl = '';
let adminToken = '';
let doctorToken = '';
let sequence = 0;
const results = {
  tool: 'p9-concurrency',
  database: databaseName,
  seed: 9112026,
  run: P9.run,
  startedAt: new Date().toISOString(),
  scenarios: [],
};

function nextXff(label) {
  return `203.0.113.${20 + (sequence++ % 200)}`;
}

function classify(attempts) {
  const counts = {};
  for (const attempt of attempts) {
    const code = attempt.body?.error?.code ?? (attempt.status >= 500 ? 'HTTP_5XX' : 'NONE');
    const key = `${attempt.status}:${code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function errorDetails(attempts) {
  return attempts
    .filter((attempt) => attempt.status >= 500)
    .map((attempt) => ({
      status: attempt.status,
      code: attempt.body?.error?.code ?? null,
      detail: attempt.body?.error?.detail ?? null,
    }));
}

async function api(path, { method = 'GET', token, body, xff } = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function login(email, xff) {
  const result = await api('/auth/login', {
    method: 'POST',
    xff,
    body: { email, password: P9.password },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.accessToken;
}

async function createPatient(label) {
  const n = sequence++;
  const result = await api('/patients', {
    method: 'POST',
    token: adminToken,
    xff: nextXff(label),
    body: {
      firstName: 'P9Race',
      lastName: `${label}${n}`,
      phone: `011${String(30_000_000 + n).padStart(8, '0')}`,
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.patient.id;
}

async function createDoctor(label) {
  const n = sequence++;
  const email = `${P9.run}-${label}-${n}@clinic.test`.toLowerCase();
  const result = await api('/users', {
    method: 'POST',
    token: adminToken,
    xff: nextXff('doctor'),
    body: {
      firstName: 'P9Doctor',
      lastName: `${label}${n}`,
      email,
      role: 'DOCTOR',
      password: P9.password,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.user.id;
}

async function createCharge(patientId, amountMinor) {
  const result = await api('/payments/charges', {
    method: 'POST',
    token: adminToken,
    xff: nextXff('charge'),
    body: {
      patientId,
      description: `${P9.run} race charge`,
      amountMinor,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.charge.id;
}

async function createPayment(patientId, amountMinor) {
  const result = await api('/payments', {
    method: 'POST',
    token: adminToken,
    xff: nextXff('payment'),
    body: { patientId, amountMinor, methodKey: 'CASH' },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.payment.id;
}

function futureWeekday(isoDay) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const current = date.getUTCDay() || 7;
  let delta = (isoDay - current + 7) % 7;
  if (delta < 7) delta += 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function recordScenario(name, detail) {
  results.scenarios.push({ name, ...detail });
}

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login(P9.adminEmail, '198.51.100.10');
  doctorToken = await login(P9.doctor1Email, '198.51.100.11');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  results.finishedAt = new Date().toISOString();
  const target =
    process.env.P9_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/concurrency.json';
  writeFileSync(target, JSON.stringify(results, null, 2));
  process.stdout.write(`[p9-concurrency] WROTE ${target}\n`);
  await prisma.$disconnect();
});

test('concurrent full refunds never exceed the payment amount', async () => {
  const patientId = await createPatient('Refund');
  const paymentId = await createPayment(patientId, 10_000);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api(`/payments/${paymentId}/refund`, {
        method: 'POST',
        token: adminToken,
        xff: nextXff('refund'),
        body: { amountMinor: 10_000, reason: `${P9.run} concurrent full refund` },
      }),
    ),
  );
  const persisted = await prisma.refund.aggregate({
    where: { paymentId },
    _sum: { amountMinor: true },
    _count: true,
  });
  const created = attempts.filter((a) => a.status === 201).length;
  const outcome = {
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    persistedCount: persisted._count,
    persistedMinor: persisted._sum.amountMinor,
  };
  recordScenario('refund_overspend', outcome);
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(persisted._count, 1);
  assert.equal(persisted._sum.amountMinor, 10_000);
});

test('concurrent report creation creates exactly one report per visit', async () => {
  const patientId = await createPatient('Report');
  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    xff: nextXff('visit'),
    body: {
      patientId,
      chiefComplaint: `${P9.run} concurrent report`,
      examinationType: 'P9 ultrasound',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  const visitId = visit.body.visit.id;
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/reports', {
        method: 'POST',
        token: doctorToken,
        xff: nextXff('report'),
        body: {
          visitId,
          content: { findings: `${P9.run} findings`, impression: `${P9.run} impression` },
        },
      }),
    ),
  );
  const persisted = await prisma.report.count({ where: { visitId } });
  const created = attempts.filter((a) => a.status === 201).length;
  const outcome = {
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    persistedCount: persisted,
  };
  recordScenario('report_single_per_visit', outcome);
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(persisted, 1);
});

test('concurrent allocation to one charge never exceeds the charge amount', async () => {
  const patientId = await createPatient('Allocation');
  const chargeId = await createCharge(patientId, 10_000);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/payments', {
        method: 'POST',
        token: adminToken,
        xff: nextXff('allocation'),
        body: {
          patientId,
          amountMinor: 10_000,
          methodKey: 'CASH',
          allocations: [{ chargeId, amountMinor: 10_000 }],
        },
      }),
    ),
  );
  const allocated = await prisma.paymentAllocation.aggregate({
    where: { chargeId },
    _sum: { amountMinor: true },
    _count: true,
  });
  const charge = await prisma.charge.findUnique({ where: { id: chargeId } });
  const created = attempts.filter((a) => a.status === 201).length;
  const outcome = {
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    allocatedMinor: allocated._sum.amountMinor,
    allocationCount: allocated._count,
    chargeStatus: charge?.status,
  };
  recordScenario('charge_allocation_cap', outcome);
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(allocated._sum.amountMinor, 10_000);
  assert.equal(allocated._count, 1);
  assert.equal(charge?.status, 'SETTLED');
});

test('voiding a charge cannot race an allocation onto it', async () => {
  const violations = [];
  const rounds = [];
  for (let round = 0; round < 6; round += 1) {
    const patientId = await createPatient(`Void${round}`);
    const chargeId = await createCharge(patientId, 5_000);
    const [payment, voided] = await Promise.all([
      api('/payments', {
        method: 'POST',
        token: adminToken,
        xff: nextXff('void-pay'),
        body: {
          patientId,
          amountMinor: 5_000,
          methodKey: 'CASH',
          allocations: [{ chargeId, amountMinor: 5_000 }],
        },
      }),
      api(`/payments/charges/${chargeId}/void`, {
        method: 'POST',
        token: adminToken,
        xff: nextXff('void'),
        body: { reason: `${P9.run} concurrent void probe` },
      }),
    ]);
    const charge = await prisma.charge.findUnique({
      where: { id: chargeId },
      include: { allocations: true },
    });
    const allocationTotal = charge.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
    if (voided.status === 200 && allocationTotal > 0) {
      violations.push(`round ${round}: VOID charge kept ${allocationTotal} allocated`);
    }
    if (voided.status === 200 && payment.status === 201) {
      violations.push(`round ${round}: both void and allocation succeeded`);
    }
    rounds.push({
      round,
      payment: `${payment.status}:${payment.body?.error?.code ?? 'NONE'}`,
      void: `${voided.status}:${voided.body?.error?.code ?? 'NONE'}`,
      chargeStatus: charge.status,
      allocationTotal,
    });
  }
  recordScenario('charge_void_vs_allocation', { rounds, violations });
  assert.deepEqual(violations, []);
});

test('concurrent booking of one slot creates exactly one appointment', async () => {
  const patientId = await createPatient('Booking');
  const doctorId = await createDoctor('Booking');
  const date = futureWeekday(1);
  const notes = `${P9.run} slot probe`;
  const attempts = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      api('/appointments', {
        method: 'POST',
        token: adminToken,
        xff: nextXff('booking'),
        body: {
          patientId,
          doctorId,
          date,
          startMinute: 600,
          durationMinutes: 15,
          notes: `${notes}-${index}`,
        },
      }),
    ),
  );
  const persisted = await prisma.appointment.count({ where: { notes: { startsWith: P9.run } } });
  const created = attempts.filter((a) => a.status === 201).length;
  const outcome = {
    date,
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    persistedCount: persisted,
  };
  recordScenario('appointment_slot_uniqueness', outcome);
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(persisted, 1);
});

test('concurrent identical idempotency keys create one payment without raw P2002', async () => {
  const patientId = await createPatient('Idempotency');
  const idempotencyKey = `${P9.run}-IDEM`;
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/payments', {
        method: 'POST',
        token: adminToken,
        xff: nextXff('idem'),
        body: {
          patientId,
          amountMinor: 7_500,
          methodKey: 'CASH',
          idempotencyKey,
        },
      }),
    ),
  );
  const persisted = await prisma.payment.count({ where: { idempotencyKey } });
  const created = attempts.filter((a) => a.status === 201).length;
  const rawUniqueErrors = attempts.filter(
    (a) => a.status >= 500 && String(a.body?.error?.code ?? '').includes('P2002'),
  ).length;
  const outcome = {
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    rawP2002: rawUniqueErrors,
    persistedCount: persisted,
  };
  recordScenario('payment_idempotency_race', outcome);
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(persisted, 1);
  assert.equal(rawUniqueErrors, 0, 'idempotency race surfaced a raw Prisma P2002');
});

test('concurrent walk-ins do not duplicate queue positions', async () => {
  const patientId = await createPatient('WalkIn');
  const doctorId = await createDoctor('WalkIn');
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      api('/queue/walk-in', {
        method: 'POST',
        token: adminToken,
        xff: nextXff('walkin'),
        body: {
          patientId,
          doctorId,
          payment: { status: 'PENDING' },
        },
      }),
    ),
  );
  const entries = await prisma.queueEntry.findMany({
    where: {
      patientId,
      doctorId,
      queueDate: dateOnlyToDb(clinicDateString()),
    },
    select: { id: true, position: true },
  });
  const positions = entries.map((e) => e.position);
  const duplicatePositions = positions.filter((p, i) => positions.indexOf(p) !== i);
  const created = attempts.filter((a) => a.status === 201).length;
  const outcome = {
    successes: created,
    attempts: attempts.length,
    classifications: classify(attempts),
    errorDetails: errorDetails(attempts),
    queueEntries: entries.length,
    positions,
    duplicatePositions,
  };
  recordScenario('queue_walkin_position', outcome);
  // Fixed behavior: the exclusion constraint rejects overlapping slots. The
  // earlier "all six succeed" expectation predates the 23P01 -> 409 mapping.
  assert.equal(created, 1, JSON.stringify(outcome));
  assert.equal(outcome.classifications['201:NONE'], 1, JSON.stringify(outcome));
  assert.equal(outcome.classifications['409:APPOINTMENT_CONFLICT'], 5, JSON.stringify(outcome));
  assert.equal(entries.length, 1, JSON.stringify(outcome));
  assert.deepEqual(duplicatePositions, [], 'concurrent walk-ins duplicated queue positions');
});
