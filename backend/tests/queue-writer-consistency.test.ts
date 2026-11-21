import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clinicDateString, dateOnlyToDb } from '../src/lib/time.js';

/**
 * Phase 9.2.1 queue-writer regression coverage. Synthetic P921W- data only.
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
  throw new Error('Refusing to run destructive tests: DATABASE_URL must end in "_test".');
}

let server: Server;
let baseUrl = '';
let adminToken = '';
let adminUserId = '';
let doctorA = '';
let doctorB = '';
let patientId = '';

const PASSWORD = 'Str0ng!P921wPass';

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
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

function futureWeekday(isoDay: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const current = date.getUTCDay() || 7;
  let delta = (isoDay - current + 7) % 7;
  if (delta < 7) delta += 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

const targetDate = futureWeekday(2);

function openHours() {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: true,
    openMinute: 480,
    closeMinute: 1320,
    breakStartMinute: null,
    breakEndMinute: null,
  }));
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
        firstName: 'P921W',
        lastName: 'Admin',
        email: 'p921w.admin@clinic.test',
        password: PASSWORD,
      },
      clinic: {
        name: 'P921W Queue Test Clinic',
        timezone: 'UTC',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: openHours(),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;
  const admin = await prisma.user.findUnique({ where: { email: 'p921w.admin@clinic.test' } });
  assert.ok(admin);
  adminUserId = admin.id;

  for (const [label, index] of [
    ['A', 1],
    ['B', 2],
  ] as const) {
    const created = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: 'P921WDoctor',
        lastName: label,
        email: `p921w.doctor${index}@clinic.test`,
        role: 'DOCTOR',
        password: PASSWORD,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    if (label === 'A') doctorA = created.body.user.id;
    else doctorB = created.body.user.id;
  }

  const createdPatient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'P921WPatient',
      lastName: 'Queue',
      phone: '01000000921',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(createdPatient.status, 201, JSON.stringify(createdPatient.body));
  patientId = createdPatient.body.patient.id;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

test('reschedule into another doctor queue reallocates position under the queue lock', async () => {
  const walkIn = await api('/queue/walk-in', {
    method: 'POST',
    token: adminToken,
    body: { patientId, doctorId: doctorA, payment: { status: 'PENDING' } },
  });
  assert.equal(walkIn.status, 201, JSON.stringify(walkIn.body));
  const movedAppointmentId = walkIn.body.appointment.id;
  const movedQueueEntryId = walkIn.body.entry.id;

  // Known target state: one committed entry at position 1 on targetDate.
  const targetQueueDate = dateOnlyToDb(targetDate);
  const existingAppointment = await prisma.appointment.create({
    data: {
      patientId,
      doctorId: doctorB,
      startAt: new Date(`${targetDate}T09:00:00.000Z`),
      endAt: new Date(`${targetDate}T09:15:00.000Z`),
      durationMinutes: 15,
      status: 'ARRIVED',
      isManualOverride: true,
      overrideReason: 'P921W target seed',
      createdById: adminUserId,
    },
  });
  await prisma.queueEntry.create({
    data: {
      appointmentId: existingAppointment.id,
      patientId,
      doctorId: doctorB,
      queueDate: targetQueueDate,
      status: 'WAITING',
      arrivedAt: new Date(`${targetDate}T09:00:00.000Z`),
      position: 1,
      createdById: adminUserId,
    },
  });

  const rescheduled = await api(`/appointments/${movedAppointmentId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { doctorId: doctorB, date: targetDate, startMinute: 600, durationMinutes: 15 },
  });
  assert.equal(rescheduled.status, 200, JSON.stringify(rescheduled.body));

  const targetEntries = await prisma.queueEntry.findMany({
    where: { doctorId: doctorB, queueDate: targetQueueDate },
    select: { id: true, position: true },
    orderBy: { position: 'asc' },
  });
  assert.deepEqual(
    targetEntries.map((entry) => entry.position),
    [1, 2],
  );
  const moved = targetEntries.find((entry) => entry.id === movedQueueEntryId);
  assert.equal(moved?.position, 2);

  const allPositions = await prisma.queueEntry.findMany({
    where: { queueDate: targetQueueDate, doctorId: doctorB },
    select: { position: true },
  });
  const values = allPositions.map((entry) => entry.position);
  assert.equal(new Set(values).size, values.length, 'duplicate target queue positions');
});

test('queue status transitions never change an allocated position', async () => {
  // The status route only accepts today's queue, so create a fresh today-dated
  // entry through the real walk-in path rather than reusing the future-dated
  // reschedule target from the previous test.
  const walkIn = await api('/queue/walk-in', {
    method: 'POST',
    token: adminToken,
    body: { patientId, doctorId: doctorB, payment: { status: 'PENDING' } },
  });
  assert.equal(walkIn.status, 201, JSON.stringify(walkIn.body));
  const entryId = walkIn.body.entry.id as string;
  const before = await prisma.queueEntry.findUnique({ where: { id: entryId } });
  assert.ok(before);
  assert.equal(before.position, 1);

  const called = await api(`/queue/${entryId}/status`, {
    method: 'PATCH',
    token: adminToken,
    body: { status: 'CALLED' },
  });
  assert.equal(called.status, 200, JSON.stringify(called.body));
  assert.equal(called.body.entry.position, 1);

  const reread = await prisma.queueEntry.findUnique({ where: { id: entryId } });
  assert.equal(reread?.position, 1);
  assert.equal(reread?.status, 'CALLED');
});

test('appointment ARRIVED sync creates a queue row without allocating a position', async () => {
  const appointment = await prisma.appointment.create({
    data: {
      patientId,
      doctorId: doctorA,
      startAt: new Date(`${targetDate}T11:00:00.000Z`),
      endAt: new Date(`${targetDate}T11:15:00.000Z`),
      durationMinutes: 15,
      status: 'BOOKED',
      createdById: adminUserId,
    },
  });
  await prisma.appointmentStatusHistory.create({
    data: { appointmentId: appointment.id, fromStatus: null, toStatus: 'BOOKED', changedById: adminUserId },
  });

  // ALLOWED_TRANSITIONS requires BOOKED -> CONFIRMED -> ARRIVED.
  const confirmed = await api(`/appointments/${appointment.id}/status`, {
    method: 'POST',
    token: adminToken,
    body: { status: 'CONFIRMED' },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  const arrived = await api(`/appointments/${appointment.id}/status`, {
    method: 'POST',
    token: adminToken,
    body: { status: 'ARRIVED' },
  });
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));

  const queueEntry = await prisma.queueEntry.findUnique({ where: { appointmentId: appointment.id } });
  assert.ok(queueEntry);
  assert.equal(queueEntry.position, null);
  assert.equal(queueEntry.queueDate.toISOString().slice(0, 10), targetDate);
  assert.equal(queueEntry.doctorId, doctorA);
  assert.equal(clinicDateString(queueEntry.queueDate), targetDate);
});
