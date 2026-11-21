/**
 * Phase 9.2.1 queue concurrency harness. Synthetic P921- data only.
 *
 * Run from backend/ against the isolated disposable test database:
 *   node --import tsx tests/perf/p921-queue-concurrency.mjs
 *
 * Environment:
 *   P921_ITERATIONS         1..500 (default 50)
 *   P921_ATTEMPTS           2..50 (default 10)
 *   P921_OUT                evidence JSON path
 *
 * Refuses to run unless DATABASE_URL targets clinic_p9_test. Does not truncate
 * and never touches clinic/production resources. The walk-in route derives
 * startAt from the server clock, so a synthetic no-argument Date clock is used
 * to give every concurrent request its own non-overlapping 10-minute slot.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

process.env.APP_TIMEZONE = 'UTC';

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
assert.match(databaseName, /_test$/, 'P921 requires a *_test database');
assert.equal(databaseName, 'clinic_p9_test', 'P921 requires isolated clinic_p9_test');

const ITERATIONS = Number(process.env.P921_ITERATIONS ?? 50);
const ATTEMPTS = Number(process.env.P921_ATTEMPTS ?? 10);
assert.ok(ITERATIONS > 0 && ITERATIONS <= 500, 'P921_ITERATIONS must be 1..500');
assert.ok(ATTEMPTS > 1 && ATTEMPTS <= 50, 'P921_ATTEMPTS must be 2..50');

const { createApp } = await import('../../src/app.js');
const { prisma } = await import('../../src/lib/prisma.js');
const { clinicDateString, dateOnlyToDb } = await import('../../src/lib/time.js');
const { acquireQueueAllocationLock, queueLockIdentity } = await import(
  '../../src/lib/queueLock.js'
);

const RUN = `P921-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'P9-Synthetic-Pass!';
const ADMIN_EMAIL = 'p9.admin@clinic.test';
const SLOT_MS = 10 * 60_000;
const BASE_EPOCH = Date.parse('2031-05-01T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;

const RealDate = globalThis.Date;
const clock = { baseEpoch: BASE_EPOCH, tick: 0, fixed: false };
class HarnessDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      const offset = clock.fixed ? 0 : clock.tick * SLOT_MS;
      super(clock.baseEpoch + offset);
      clock.tick += 1;
      return;
    }
    super(...args);
  }
  static now() {
    return RealDate.now();
  }
}
globalThis.Date = HarnessDate;

const evidence = {
  tool: 'p921-queue-concurrency',
  run: RUN,
  database: databaseName,
  iterations: ITERATIONS,
  attemptsPerIteration: ATTEMPTS,
  slotMinutes: SLOT_MS / 60_000,
  startedAt: new RealDate().toISOString(),
  iterationsData: [],
  overlappingScenario: null,
  transactionFaultInjection: null,
};

let server;
let baseUrl = '';
let adminToken = '';
let adminUserId = '';
let serviceId = null;
let sequence = 0;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function stats(values) {
  return {
    count: values.length,
    minMs: Math.round(Math.min(...values) * 100) / 100,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: Math.round(Math.max(...values) * 100) / 100,
    meanMs: Math.round((values.reduce((a, b, c) => a + b + c, 0) / values.length) * 100) / 100,
  };
}

function nextXff(label) {
  return `198.51.100.${20 + (sequence++ % 200)}`;
}

async function api(path, { method = 'GET', token, body, xff } = {}) {
  const started = performance.now();
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
  return {
    status: response.status,
    body: parsed,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function errorCode(attempt) {
  return attempt.body?.error?.code ?? null;
}

function errorDetail(attempt) {
  return typeof attempt.body?.error?.detail === 'string' ? attempt.body.error.detail : '';
}

function classify(attempts) {
  const counts = {};
  for (const attempt of attempts) {
    const key = `${attempt.status}:${errorCode(attempt) ?? 'NONE'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function countMatches(attempts, pattern) {
  return attempts.filter((attempt) => pattern.test(errorDetail(attempt))).length;
}

function uuid(index, salt) {
  const hash = (start, length) =>
    createHash('md5').update(`${RUN}-${salt}-${index}`).digest('hex').slice(start, start + length);
  return `${hash(0, 8)}-${hash(8, 4)}-4${hash(12, 3)}-a${hash(16, 3)}-${hash(18, 12)}`;
}

async function createPatient(index) {
  const result = await api('/patients', {
    method: 'POST',
    token: adminToken,
    xff: nextXff('patient'),
    body: {
      firstName: 'P921Patient',
      lastName: `Race${index}`,
      phone: `012${String(30_000_000 + index).padStart(8, '0')}`,
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.patient.id;
}

async function createDoctor(index) {
  const result = await api('/users', {
    method: 'POST',
    token: adminToken,
    xff: nextXff('doctor'),
    body: {
      firstName: 'P921Doctor',
      lastName: `Race${index}`,
      email: `${RUN}-doctor-${index}@clinic.test`.toLowerCase(),
      role: 'DOCTOR',
      password: PASSWORD,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.user.id;
}

/** Seed two committed queue entries with known positions 1 and 2. */
async function seedInitialQueue(patientId, doctorId, queueDate) {
  for (let index = 0; index < 2; index += 1) {
    const startAt = new RealDate(BASE_EPOCH - (2 - index) * 60 * 60_000);
    const appointment = await prisma.appointment.create({
      data: {
        id: uuid(index, `seed-appointment-${patientId}-${doctorId}`),
        patientId,
        doctorId,
        serviceId,
        startAt,
        endAt: new RealDate(startAt.getTime() + 5 * 60_000),
        durationMinutes: 5,
        status: 'ARRIVED',
        isManualOverride: true,
        overrideReason: 'P921 seed',
        createdById: adminUserId,
      },
    });
    await prisma.appointmentStatusHistory.create({
      data: {
        appointmentId: appointment.id,
        fromStatus: null,
        toStatus: 'ARRIVED',
        changedById: adminUserId,
        reason: 'P921 seed',
      },
    });
    await prisma.queueEntry.create({
      data: {
        appointmentId: appointment.id,
        patientId,
        doctorId,
        queueDate,
        status: 'WAITING',
        arrivedAt: startAt,
        position: index + 1,
        createdById: adminUserId,
      },
    });
  }
}

async function readQueueState(patientId, doctorId, queueDate) {
  const [entries, appointments, histories, charges] = await Promise.all([
    prisma.queueEntry.findMany({
      where: { patientId, doctorId, queueDate },
      select: { id: true, appointmentId: true, position: true, status: true },
      orderBy: { position: 'asc' },
    }),
    prisma.appointment.findMany({
      where: { patientId, doctorId },
      select: { id: true, overrideReason: true, status: true },
    }),
    prisma.appointmentStatusHistory.findMany({
      where: { appointment: { patientId, doctorId } },
      select: { appointmentId: true, toStatus: true },
    }),
    prisma.charge.findMany({
      where: { appointment: { patientId, doctorId } },
      select: { id: true, appointmentId: true },
    }),
  ]);
  return { entries, appointments, histories, charges };
}

async function runIteration(index) {
  clock.baseEpoch = BASE_EPOCH + index * DAY_MS;
  clock.tick = 0;
  clock.fixed = false;

  const [patientId, doctorId] = await Promise.all([
    createPatient(index),
    createDoctor(index),
  ]);
  const dateOnly = clinicDateString(new RealDate(clock.baseEpoch));
  const queueDate = dateOnlyToDb(dateOnly);
  const ticksBefore = clock.tick;
  await seedInitialQueue(patientId, doctorId, queueDate);

  const attempts = await Promise.all(
    Array.from({ length: ATTEMPTS }, (_, attemptIndex) =>
      api('/queue/walk-in', {
        method: 'POST',
        token: adminToken,
        xff: nextXff(`walkin-${attemptIndex}`),
        body: {
          patientId,
          doctorId,
          ...(serviceId ? { serviceId } : {}),
          payment: { status: 'PENDING' },
        },
      }),
    ),
  );

  const ticksAfter = clock.tick;
  const state = await readQueueState(patientId, doctorId, queueDate);
  const positions = state.entries.map((entry) => entry.position);
  const duplicatePositions = positions.filter(
    (position, positionIndex) => positions.indexOf(position) !== positionIndex,
  );
  const successful = attempts.filter((attempt) => attempt.status === 201);
  const createdAppointmentIds = successful.map((attempt) => attempt.body?.appointment?.id);
  const classifications = classify(attempts);
  const deadlocks = countMatches(attempts, /40P01/);
  const transactionExpiries = countMatches(attempts, /P2028|Transaction API error|transaction.*timeout/i);
  const serverErrors = attempts.filter((attempt) => attempt.status >= 500);
  const unexpected4xx = attempts.filter(
    (attempt) => attempt.status >= 400 && attempt.status < 500 && attempt.status !== 409,
  );

  const outcome = {
    iteration: index + 1,
    doctorId,
    patientId,
    queueDate: dateOnly,
    clockTicksDuringAttempts: ticksAfter - ticksBefore,
    classifications,
    successes: successful.length,
    expectedConflicts: 0,
    unexpected4xx: unexpected4xx.length,
    serverErrors: serverErrors.length,
    deadlocks,
    transactionExpiries,
    positions,
    duplicatePositions,
    queueEntries: state.entries.length,
    appointments: state.appointments.length,
    statusHistories: state.histories.length,
    charges: state.charges.length,
    latenciesMs: attempts.map((attempt) => attempt.latencyMs),
  };

  // Verify all successful entries are distinct and sequential after the seeded 1,2.
  const expected = Array.from({ length: 2 + ATTEMPTS }, (_, i) => i + 1);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    expected,
    `iteration ${index + 1}: non-sequential or duplicate positions`,
  );
  assert.equal(successful.length, ATTEMPTS, JSON.stringify(classifications));
  assert.deepEqual(duplicatePositions, []);
  assert.equal(outcome.serverErrors, 0, JSON.stringify(serverErrors.map((s) => s.body)));
  assert.equal(outcome.unexpected4xx, 0);
  assert.equal(outcome.deadlocks, 0);
  assert.equal(outcome.transactionExpiries, 0);
  assert.equal(state.appointments.length, 2 + ATTEMPTS, `iteration ${index + 1}: appointments`);
  assert.equal(state.histories.length, 2 + ATTEMPTS, `iteration ${index + 1}: status histories`);
  // The two pre-seeded queue rows are deliberately unbilled; only the walk-ins
  // under test create charges.
  assert.equal(state.charges.length, serviceId ? ATTEMPTS : 0, `iteration ${index + 1}: charges`);
  for (const appointmentId of createdAppointmentIds) {
    assert.ok(
      state.histories.some((history) => history.appointmentId === appointmentId),
      'missing status history for a created appointment',
    );
    if (serviceId) {
      assert.equal(
        state.charges.filter((charge) => charge.appointmentId === appointmentId).length,
        1,
        'expected exactly one charge per billed walk-in',
      );
    }
  }

  return outcome;
}

async function runOverlappingScenario() {
  clock.fixed = true;
  clock.tick = 0;
  const [patientId, doctorId] = await Promise.all([createPatient(90_000), createDoctor(90_000)]);
  const attempts = await Promise.all(
    Array.from({ length: 6 }, (_, attemptIndex) =>
      api('/queue/walk-in', {
        method: 'POST',
        token: adminToken,
        xff: nextXff(`overlap-${attemptIndex}`),
        body: { patientId, doctorId, payment: { status: 'PENDING' } },
      }),
    ),
  );
  clock.fixed = false;
  const classifications = classify(attempts);
  const outcome = {
    classifications,
    successes: attempts.filter((attempt) => attempt.status === 201).length,
    conflicts: attempts.filter(
      (attempt) => attempt.status === 409 && errorCode(attempt) === 'APPOINTMENT_CONFLICT',
    ).length,
  };
  assert.deepEqual(classifications, { '201:NONE': 1, '409:APPOINTMENT_CONFLICT': 5 });
  return outcome;
}

function errorMentions(err, needle) {
  return JSON.stringify({
    code: err?.code,
    meta: err?.meta,
    message: err?.message,
    cause: err?.cause?.message,
  }).includes(needle);
}

async function runTransactionFaultInjection(doctorId, queueDate) {
  const result = { deadlock40P01: null, p2028: null, rollback: null, lockReleased: null };

  // Controlled 40P01: two sessions acquire two distinct advisory locks in
  // opposite order. This exercises SQLSTATE handling without touching clinic data.
  const keyA = 991_000_001;
  const keyB = 991_000_002;
  const hold = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const first = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyA}::bigint)`;
    await hold(150);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyB}::bigint)`;
  });
  const second = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyB}::bigint)`;
    await hold(150);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${keyA}::bigint)`;
  });
  const deadlockOutcomes = await Promise.allSettled([first, second]);
  const deadlockErrors = deadlockOutcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
  result.deadlock40P01 = {
    rejectedCount: deadlockErrors.length,
    sqlstateObserved: deadlockErrors.some((err) => errorMentions(err, '40P01')),
    codes: deadlockErrors.map((err) => err?.code ?? null),
  };
  assert.equal(deadlockErrors.length, 1, 'expected exactly one deadlock victim');
  assert.equal(result.deadlock40P01.sqlstateObserved, true);

  // Controlled P2028 probe. Zero-maxWait is used so the failure is deterministic
  // when a lock is held by another session.
  try {
    await prisma.$transaction(async (tx) => {
      await acquireQueueAllocationLock(tx, doctorId, clinicDateString(queueDate));
      await prisma.$executeRaw`SELECT 1`;
    }, { maxWait: 1, timeout: 1 });
    result.p2028 = { observed: false, note: 'probe completed without expiry' };
  } catch (err) {
    result.p2028 = {
      observed: errorMentions(err, 'P2028'),
      code: err?.code ?? null,
      message: err?.message ?? null,
    };
  }

  // Rollback: a synthetic appointment written under the queue lock must not
  // survive a thrown error, and the transaction-scoped lock must be released.
  const marker = 'P921-ROLLBACK-MARKER';
  const patientId = (await prisma.patient.findFirst({ where: { firstName: 'P921Patient' } }))?.id;
  assert.ok(patientId, 'P921 patient required for rollback probe');
  const identity = queueLockIdentity(doctorId, clinicDateString(queueDate)).identity;
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await acquireQueueAllocationLock(tx, doctorId, clinicDateString(queueDate));
      await tx.appointment.create({
        data: {
          patientId,
          doctorId,
          startAt: new RealDate(clock.baseEpoch),
          endAt: new RealDate(clock.baseEpoch + 5 * 60_000),
          durationMinutes: 5,
          status: 'ARRIVED',
          isManualOverride: true,
          overrideReason: marker,
          createdById: adminUserId,
        },
      });
      throw new Error('P921 synthetic rollback');
    }),
    /P921 synthetic rollback/,
  );
  const leftovers = await prisma.appointment.count({ where: { overrideReason: marker } });
  const heldLocks = await prisma.$queryRaw`
    SELECT count(*)::int AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND granted
      AND classid = (SELECT ${queueLockIdentity(doctorId, clinicDateString(queueDate)).domainKey}::int)
      AND objid = (SELECT hashtext(${identity})::int)
      AND objsubid = 2
  `;
  result.rollback = { markerRowsAfterRollback: leftovers };
  result.lockReleased = { heldLocksAfterRollback: Number(heldLocks[0]?.count ?? -1) };
  assert.equal(leftovers, 0, 'rollback left a partial appointment behind');
  assert.equal(Number(heldLocks[0]?.count ?? -1), 0, 'queue lock was not released after rollback');
  return result;
}

async function main() {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await api('/auth/login', {
    method: 'POST',
    xff: nextXff('login'),
    body: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.accessToken;
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  assert.ok(admin, 'seeded admin user is required');
  adminUserId = admin.id;
  serviceId = (await prisma.service.findFirst())?.id ?? null;
  evidence.serviceId = serviceId;

  const runStarted = performance.now();
  for (let index = 0; index < ITERATIONS; index += 1) {
    const outcome = await runIteration(index);
    evidence.iterationsData.push(outcome);
    if ((index + 1) % 10 === 0) {
      process.stdout.write(
        `[p921] ${index + 1}/${ITERATIONS} iterations; successes=${evidence.iterationsData.reduce((sum, item) => sum + item.successes, 0)}\n`,
      );
    }
  }

  evidence.overlappingScenario = await runOverlappingScenario();
  const last = evidence.iterationsData.at(-1);
  evidence.transactionFaultInjection = await runTransactionFaultInjection(
    last.doctorId,
    dateOnlyToDb(last.queueDate),
  );

  const allLatencies = evidence.iterationsData.flatMap((item) => item.latenciesMs);
  evidence.summary = {
    totalIterations: ITERATIONS,
    totalRequests: ITERATIONS * ATTEMPTS,
    successfulResponses: evidence.iterationsData.reduce((sum, item) => sum + item.successes, 0),
    expectedConflictResponses: evidence.iterationsData.reduce(
      (sum, item) => sum + (item.classifications['409:APPOINTMENT_CONFLICT'] ?? 0),
      0,
    ),
    unexpected4xx: evidence.iterationsData.reduce((sum, item) => sum + item.unexpected4xx, 0),
    serverErrors: evidence.iterationsData.reduce((sum, item) => sum + item.serverErrors, 0),
    duplicatePositions: evidence.iterationsData.reduce(
      (sum, item) => sum + item.duplicatePositions.length,
      0,
    ),
    deadlocks: evidence.iterationsData.reduce((sum, item) => sum + item.deadlocks, 0),
    transactionExpiries: evidence.iterationsData.reduce(
      (sum, item) => sum + item.transactionExpiries,
      0,
    ),
    latency: stats(allLatencies),
    elapsedMs: Math.round(performance.now() - runStarted),
  };
  evidence.finishedAt = new RealDate().toISOString();
  evidence.verdict = 'PASS';

  const outPath =
    process.env.P921_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p921/p921-concurrency.json';
  writeFileSync(outPath, JSON.stringify(evidence, null, 2));
  process.stdout.write(`[p921] PASS ${JSON.stringify(evidence.summary)}\n`);
  process.stdout.write(`[p921] evidence: ${outPath}\n`);
}

main()
  .catch((err) => {
    evidence.verdict = 'FAIL';
    evidence.failure = {
      name: err?.name ?? 'Error',
      code: err?.code ?? null,
      message: err?.message ?? String(err),
    };
    const outPath =
      process.env.P921_OUT ??
      'C:/Users/Moustafa/AppData/Local/Temp/opencode/p921/p921-concurrency.json';
    writeFileSync(outPath, JSON.stringify(evidence, null, 2));
    process.stderr.write(`[p921] FAIL ${JSON.stringify(evidence.failure)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    globalThis.Date = RealDate;
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });
