import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { buildDaySlots, resolveSchedule } from '../src/modules/appointments/service.js';
import { clinicLocalToUtc } from '../src/lib/time.js';

/**
 * Characterisation tests for the existing availability engine.
 *
 * These lock the behaviour of `resolveSchedule`, `buildDaySlots` and
 * `GET /appointments/agenda` before the quick-actions work extracts shared
 * helpers from `appointments/service.ts`. They must pass unchanged both before
 * and after that refactor.
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

/** A weekday (ISO 1..7) at least one week in the future, as YYYY-MM-DD. */
function futureWeekday(isoDay: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const current = date.getUTCDay() || 7;
  let delta = (isoDay - current + 7) % 7;
  if (delta < 7) delta += 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hoursPayload(overrides: {
  closedDays?: number[];
  openMinute?: number;
  closeMinute?: number;
  breakStartMinute?: number | null;
  breakEndMinute?: number | null;
}) {
  const closed = new Set(overrides.closedDays ?? [4, 5]);
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: !closed.has(index + 1),
    openMinute: overrides.openMinute ?? 780,
    closeMinute: overrides.closeMinute ?? 1260,
    breakStartMinute: overrides.breakStartMinute ?? null,
    breakEndMinute: overrides.breakEndMinute ?? null,
  }));
}

function availabilityPayload(openMinute: number, closeMinute: number) {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isWorking: true,
    openMinute,
    closeMinute,
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
        firstName: 'Test',
        lastName: 'Admin',
        email: 'admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Test Ultrasound Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: hoursPayload({ closedDays: [4, 5] }),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Sara',
      lastName: 'Test',
      email: 'sara.characterization@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorId = doctor.body.user.id;

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Test',
      lastName: 'Patient',
      phone: '01000000001',
      gender: 'FEMALE',
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  patientId = patient.body.patient.id;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('availability engine characterisation', async (t) => {
  const monday = futureWeekday(1);
  const thursday = addDays(monday, 3);

  await t.test('resolveSchedule returns the clinic window by default', async () => {
    const window = await resolveSchedule(doctorId, monday);
    assert.deepEqual(window, {
      isOpen: true,
      openMinute: 780,
      closeMinute: 1260,
      breakStartMinute: null,
      breakEndMinute: null,
      source: 'clinic',
    });
  });

  await t.test('buildDaySlots enumerates the full grid', async () => {
    const built = await buildDaySlots(doctorId, monday, 15, 15);
    assert.equal(built.window.source, 'clinic');
    assert.equal(built.slots.length, 32);
    assert.equal(built.slots[0].minute, 780);
    assert.equal(built.slots[0].start, clinicLocalToUtc(monday, 780).toISOString());
    assert.equal(built.slots[31].minute, 1245);
    assert.ok(built.slots.every((slot) => slot.available));
    assert.ok(built.slots.every((slot) => !('conflictWith' in slot)));
  });

  await t.test('agenda response shape and defaults are stable', async () => {
    const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));
    assert.deepEqual(Object.keys(agenda.body).sort(), [
      'appointments',
      'date',
      'doctorId',
      'durationMinutes',
      'openingHours',
      'slotIntervalMinutes',
      'slots',
    ]);
    assert.equal(agenda.body.date, monday);
    assert.equal(agenda.body.doctorId, doctorId);
    assert.equal(agenda.body.durationMinutes, 15);
    assert.equal(agenda.body.slotIntervalMinutes, 15);
    assert.equal(agenda.body.slots.length, 32);
    assert.deepEqual(agenda.body.appointments, []);
    assert.deepEqual(agenda.body.openingHours, {
      isOpen: true,
      openMinute: 780,
      closeMinute: 1260,
      breakStartMinute: null,
      breakEndMinute: null,
      source: 'clinic',
    });
    assert.deepEqual(Object.keys(agenda.body.slots[0]).sort(), ['available', 'end', 'minute', 'start']);
  });

  await t.test('active appointments occupy their slot; cancelled ones do not', async () => {
    const booked = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 780, durationMinutes: 15 },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const bookedId = booked.body.appointment.id;

    const cancelled = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 840, durationMinutes: 15 },
    });
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    const cancelledId = cancelled.body.appointment.id;

    const cancelledStatus = await api(`/appointments/${cancelledId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'CANCELLED', reason: 'characterisation' },
    });
    assert.equal(cancelledStatus.status, 200, JSON.stringify(cancelledStatus.body));

    const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));

    const byMinute = new Map<number, any>(agenda.body.slots.map((slot: any) => [slot.minute, slot]));
    assert.equal(byMinute.get(780).available, false);
    assert.equal(byMinute.get(780).conflictWith, bookedId);
    assert.equal(byMinute.get(795).available, true);
    assert.equal(byMinute.get(840).available, true);

    // The agenda only lists appointments that still occupy the calendar.
    assert.equal(agenda.body.appointments.length, 1);
    assert.deepEqual(
      agenda.body.appointments.map((row: any) => row.status),
      ['BOOKED'],
    );
  });

  await t.test('service duration changes the slot grid', async () => {
    const built = await buildDaySlots(doctorId, monday, 30, 15);
    assert.equal(built.slots.length, 31);
    assert.equal(built.slots[0].minute, 780);
    assert.equal(built.slots[30].minute, 1230);
    for (const slot of built.slots) {
      assert.equal(
        new Date(slot.end).getTime() - new Date(slot.start).getTime(),
        30 * 60_000,
      );
    }
  });

  await t.test('doctor availability narrows the clinic window', async () => {
    const saved = await api(`/settings/doctors/${doctorId}/availability`, {
      method: 'PUT',
      token: adminToken,
      body: { availability: availabilityPayload(540, 1020) },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const window = await resolveSchedule(doctorId, monday);
    assert.equal(window.isOpen, true);
    assert.equal(window.openMinute, 780);
    assert.equal(window.closeMinute, 1020);
    assert.equal(window.source, 'doctor');

    const built = await buildDaySlots(doctorId, monday, 15, 15);
    assert.equal(built.slots.length, 16);
    assert.equal(built.slots[0].minute, 780);
    assert.equal(built.slots[15].minute, 1005);
  });

  await t.test('a clinic closure wins over doctor availability', async () => {
    const closed = await api('/settings/exceptions', {
      method: 'POST',
      token: adminToken,
      body: { date: thursday, isClosed: true, reason: 'Public holiday' },
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));

    const window = await resolveSchedule(doctorId, thursday);
    assert.equal(window.isOpen, false);
    assert.equal(window.source, 'exception');
    assert.equal(window.reason, 'Public holiday');

    const built = await buildDaySlots(doctorId, thursday, 15, 15);
    assert.deepEqual(built.slots, []);

    const removed = await api(`/settings/exceptions/${closed.body.exception.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(removed.status, 204);
  });

  await t.test('a doctor exception opens an otherwise closed day', async () => {
    const exception = await api('/settings/exceptions', {
      method: 'POST',
      token: adminToken,
      body: {
        date: thursday,
        doctorId,
        isClosed: false,
        openMinute: 1020,
        closeMinute: 1140,
        reason: 'Extra shift',
      },
    });
    assert.equal(exception.status, 201, JSON.stringify(exception.body));

    const window = await resolveSchedule(doctorId, thursday);
    assert.deepEqual(window, {
      isOpen: true,
      openMinute: 1020,
      closeMinute: 1140,
      breakStartMinute: null,
      breakEndMinute: null,
      source: 'exception',
    });

    const built = await buildDaySlots(doctorId, thursday, 15, 15);
    assert.equal(built.slots.length, 8);
    assert.equal(built.slots[0].minute, 1020);
    assert.equal(built.slots[7].minute, 1125);

    const removed = await api(`/settings/exceptions/${exception.body.exception.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(removed.status, 204);
  });

  await t.test('a clinic break is clipped to the doctor window', async () => {
    const withBreak = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: {
        workingHours: hoursPayload({
          closedDays: [4, 5],
          breakStartMinute: 780,
          breakEndMinute: 840,
        }),
      },
    });
    assert.equal(withBreak.status, 200, JSON.stringify(withBreak.body));

    const narrowed = await api(`/settings/doctors/${doctorId}/availability`, {
      method: 'PUT',
      token: adminToken,
      body: { availability: availabilityPayload(810, 1020) },
    });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));

    const window = await resolveSchedule(doctorId, monday);
    assert.deepEqual(window, {
      isOpen: true,
      openMinute: 810,
      closeMinute: 1020,
      breakStartMinute: 810,
      breakEndMinute: 840,
      source: 'doctor',
    });

    const built = await buildDaySlots(doctorId, monday, 15, 15);
    assert.equal(built.slots[0].minute, 840);
    assert.equal(built.slots.length, 12);

    const cleared = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: hoursPayload({ closedDays: [4, 5] }) },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  });
});
