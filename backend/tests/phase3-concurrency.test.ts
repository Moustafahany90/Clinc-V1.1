import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clinicLocalToUtc } from '../src/lib/time.js';

/**
 * Phase 3 production-readiness audit: concurrency invariants.
 *
 * Every scenario here fires real concurrent HTTP requests at the application
 * and then checks the persisted ledger/calendar state. The assertions encode
 * invariants that must hold no matter how requests interleave.
 *
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
let doctorToken = '';
let doctorId = '';
let patientId = '';

interface ApiResult {
  status: number;
  body: any;
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
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, password: string): Promise<string> {
  const result = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.accessToken as string;
}

function futureWeekday(isoDay: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const current = date.getUTCDay() || 7;
  let delta = (isoDay - current + 7) % 7;
  if (delta < 7) delta += 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function createPatient(label: string): Promise<string> {
  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Race',
      lastName: label,
      phone: `011${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  return patient.body.patient.id as string;
}

async function createCharge(patient: string, amountMinor: number): Promise<string> {
  const charge = await api('/payments/charges', {
    method: 'POST',
    token: adminToken,
    body: { patientId: patient, description: 'Phase 3 race charge', amountMinor },
  });
  assert.equal(charge.status, 201, JSON.stringify(charge.body));
  return charge.body.charge.id as string;
}

async function createPayment(patient: string, amountMinor: number): Promise<string> {
  const payment = await api('/payments', {
    method: 'POST',
    token: adminToken,
    body: { patientId: patient, amountMinor, methodKey: 'CASH' },
  });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  return payment.body.payment.id as string;
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
        lastName: 'Admin',
        email: 'phase3.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Phase 3 Concurrency Clinic',
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

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Race',
      lastName: 'Doctor',
      email: 'phase3.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorId = doctor.body.user.id;
  doctorToken = await login('phase3.doctor@clinic.test', 'Str0ng!Passw0rd');

  patientId = await createPatient('Concurrency');
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('concurrent refunds never exceed the payment amount', async () => {
  const patient = await createPatient('Refund');
  const paymentId = await createPayment(patient, 10_000);

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api(`/payments/${paymentId}/refund`, {
        method: 'POST',
        token: adminToken,
        body: { amountMinor: 10_000, reason: 'Concurrent full refund attempt' },
      }),
    ),
  );

  const created = attempts.filter((result) => result.status === 201);
  const rejected = attempts.filter((result) => result.status !== 201);
  const persisted = await prisma.refund.aggregate({
    where: { paymentId },
    _sum: { amountMinor: true },
    _count: true,
  });

  assert.equal(
    created.length,
    1,
    `expected exactly one refund to win, got ${created.length} successes and ${rejected.length} rejections`,
  );
  assert.equal(persisted._sum.amountMinor, 10_000);
  assert.equal(persisted._count, 1);
});

test('concurrent report creation creates exactly one report per visit', async () => {
  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: {
      patientId,
      chiefComplaint: 'Concurrent report creation',
      examinationType: 'Synthetic ultrasound',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  const visitId = visit.body.visit.id as string;

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/reports', {
        method: 'POST',
        token: doctorToken,
        body: {
          visitId,
          content: { findings: 'Concurrent write', impression: 'Concurrent impression' },
        },
      }),
    ),
  );

  const created = attempts.filter((result) => result.status === 201);
  const persisted = await prisma.report.count({ where: { visitId } });

  assert.equal(
    created.length,
    1,
    `expected exactly one report creation to win, got statuses ${attempts
      .map((result) => result.status)
      .join(',')}`,
  );
  assert.equal(persisted, 1);
});

test('concurrent allocation to one charge never exceeds the charge amount', async () => {
  const patient = await createPatient('Allocation');
  const chargeId = await createCharge(patient, 10_000);

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      api('/payments', {
        method: 'POST',
        token: adminToken,
        body: {
          patientId: patient,
          amountMinor: 10_000,
          methodKey: 'CASH',
          allocations: [{ chargeId, amountMinor: 10_000 }],
        },
      }),
    ),
  );

  const allocation = await prisma.paymentAllocation.aggregate({
    where: { chargeId },
    _sum: { amountMinor: true },
    _count: true,
  });
  const charge = await prisma.charge.findUnique({ where: { id: chargeId } });

  assert.equal(attempts.filter((result) => result.status === 201).length, 1);
  assert.equal(allocation._sum.amountMinor, 10_000);
  assert.equal(allocation._count, 1);
  assert.equal(charge?.status, 'SETTLED');
});

test('voiding a charge cannot race an allocation onto it', async () => {
  const violations: string[] = [];

  for (let round = 0; round < 6; round += 1) {
    const patient = await createPatient(`VoidRace${round}`);
    const chargeId = await createCharge(patient, 5_000);

    const [payment, voided] = await Promise.all([
      api('/payments', {
        method: 'POST',
        token: adminToken,
        body: {
          patientId: patient,
          amountMinor: 5_000,
          methodKey: 'CASH',
          allocations: [{ chargeId, amountMinor: 5_000 }],
        },
      }),
      api(`/payments/charges/${chargeId}/void`, {
        method: 'POST',
        token: adminToken,
        body: { reason: 'Concurrent void race probe' },
      }),
    ]);

    const charge = await prisma.charge.findUnique({
      where: { id: chargeId },
      include: { allocations: true },
    });
    assert.ok(charge);

    const allocationTotal = charge.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
    const voidWon = voided.status === 200;
    const paymentWon = payment.status === 201;

    if (voidWon && charge.allocations.length > 0) {
      violations.push(
        `round ${round}: charge VOID (void=${voided.status}, payment=${payment.status}) kept ${allocationTotal} of allocations`,
      );
    }
    if (voidWon && paymentWon) {
      violations.push(`round ${round}: both void and allocation succeeded`);
    }
    if (charge.status === 'VOID' && allocationTotal > 0) {
      violations.push(`round ${round}: persisted VOID charge has allocations`);
    }
    if (charge.status !== 'VOID' && !paymentWon && voided.status === 200) {
      violations.push(`round ${round}: void reported success but charge is ${charge.status}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('concurrent booking of one slot creates exactly one appointment', async () => {
  const date = futureWeekday(1);
  const attempts = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      api('/appointments', {
        method: 'POST',
        token: adminToken,
        body: {
          patientId,
          doctorId,
          date,
          startMinute: 600,
          durationMinutes: 15,
          notes: `race ${index}`,
        },
      }),
    ),
  );

  const persisted = await prisma.appointment.count({
    where: {
      doctorId,
      startAt: clinicLocalToUtc(date, 600),
      status: { not: 'CANCELLED' },
    },
  });
  assert.equal(attempts.filter((result) => result.status === 201).length, 1);
  assert.equal(persisted, 1);
});
