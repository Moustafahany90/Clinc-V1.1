import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Integration tests for clinic opening hours and per-doctor availability.
 *
 * These tests exercise the real HTTP routes against a disposable PostgreSQL
 * database. They are destructive by design, so they refuse to run unless the
 * configured database name ends in `_test`.
 *
 *   DATABASE_URL=postgresql://.../clinic_test npm test
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
let doctorToken = '';
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

function availabilityPayload(openMinute: number, closeMinute: number, working = true) {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isWorking: working,
    openMinute,
    closeMinute,
  }));
}

before(async () => {
  // Truncate everything except Prisma's migration bookkeeping table.
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
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('clinic hours, doctor availability and booking boundaries', async (t) => {
  const monday = futureWeekday(1);
  const thursday = addDays(monday, 3);

  await t.test('working hours persist exactly as saved', async () => {
    const payload = hoursPayload({
      closedDays: [4, 5],
      openMinute: 780,
      closeMinute: 1260,
    });
    const saved = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: payload },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const loaded = await api('/settings/working-hours', { token: adminToken });
    assert.equal(loaded.status, 200);
    const byDay = new Map<number, any>(
      loaded.body.workingHours.map((row: any) => [row.dayOfWeek, row]),
    );
    for (const day of payload) {
      const stored = byDay.get(day.dayOfWeek);
      assert.ok(stored, `day ${day.dayOfWeek} missing`);
      assert.equal(stored.isOpen, day.isOpen);
      assert.equal(stored.openMinute, day.openMinute);
      assert.equal(stored.closeMinute, day.closeMinute);
      assert.equal(stored.breakStartMinute, day.isOpen ? day.breakStartMinute : null);
      assert.equal(stored.breakEndMinute, day.isOpen ? day.breakEndMinute : null);
    }
  });

  await t.test('invalid opening hours are rejected by the server', async () => {
    const sixDays = hoursPayload({}).slice(0, 6);
    const missingDay = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: sixDays },
    });
    assert.equal(missingDay.status, 400);

    const reversed = hoursPayload({ openMinute: 1020, closeMinute: 540 });
    const reversedResult = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: reversed },
    });
    assert.equal(reversedResult.status, 400);
    assert.match(reversedResult.body.error.message, /before closing/i);

    const badBreak = hoursPayload({ breakStartMinute: 700, breakEndMinute: 840 });
    const badBreakResult = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: badBreak },
    });
    assert.equal(badBreakResult.status, 400);
    assert.match(badBreakResult.body.error.message, /break/i);
  });

  await t.test('a doctor account can be created and cannot manage schedules', async () => {
    const created = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: 'Sara',
        lastName: 'Test',
        email: 'sara.test@clinic.test',
        role: 'DOCTOR',
        password: 'Str0ng!Passw0rd',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    doctorId = created.body.user.id;

    const login = await api('/auth/login', {
      method: 'POST',
      body: { email: 'sara.test@clinic.test', password: 'Str0ng!Passw0rd' },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    doctorToken = login.body.accessToken;

    const forbiddenView = await api(`/settings/doctors/${doctorId}/availability`, {
      token: doctorToken,
    });
    assert.equal(forbiddenView.status, 403);

    const forbiddenSave = await api(`/settings/doctors/${doctorId}/availability`, {
      method: 'PUT',
      token: doctorToken,
      body: { availability: availabilityPayload(540, 1020) },
    });
    assert.equal(forbiddenSave.status, 403);
  });

  await t.test('doctor availability narrows but never extends clinic hours', async () => {
    const saved = await api(`/settings/doctors/${doctorId}/availability`, {
      method: 'PUT',
      token: adminToken,
      body: { availability: availabilityPayload(540, 1020) },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));
    assert.equal(agenda.body.openingHours.isOpen, true);
    assert.equal(agenda.body.openingHours.openMinute, 780);
    assert.equal(agenda.body.openingHours.closeMinute, 1020);
    assert.equal(agenda.body.slots[0].minute, 780);
    assert.equal(agenda.body.slots.length, 16);
  });

  await t.test('clinic closure wins over doctor availability', async () => {
    const agenda = await api(`/appointments/agenda?date=${thursday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));
    assert.equal(agenda.body.openingHours.isOpen, false);
    assert.equal(agenda.body.slots.length, 0);
    assert.match(agenda.body.openingHours.reason, /closed/i);
  });

  await t.test('a per-doctor exception can open a closed day', async () => {
    const exception = await api('/settings/exceptions', {
      method: 'POST',
      token: adminToken,
      body: {
        date: thursday,
        doctorId,
        isClosed: false,
        openMinute: 1020,
        closeMinute: 1140,
        reason: 'Extra evening shift',
      },
    });
    assert.equal(exception.status, 201, JSON.stringify(exception.body));

    const agenda = await api(`/appointments/agenda?date=${thursday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.body.openingHours.isOpen, true);
    assert.equal(agenda.body.openingHours.source, 'exception');
    assert.equal(agenda.body.openingHours.openMinute, 1020);
    assert.equal(agenda.body.openingHours.closeMinute, 1140);
    assert.ok(agenda.body.slots.length > 0);

    const removed = await api(`/settings/exceptions/${exception.body.exception.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(removed.status, 204);
  });

  await t.test('a clinic break is clipped to the doctor hours', async () => {
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
    assert.equal(narrowed.status, 200);

    const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.body.openingHours.openMinute, 810);
    assert.equal(agenda.body.openingHours.breakStartMinute, 810);
    assert.equal(agenda.body.openingHours.breakEndMinute, 840);
    assert.equal(agenda.body.slots[0].minute, 840);

    const cleared = await api('/settings/working-hours', {
      method: 'PUT',
      token: adminToken,
      body: { workingHours: hoursPayload({ closedDays: [4, 5] }) },
    });
    assert.equal(cleared.status, 200);
  });

  await t.test('deleting overrides restores the clinic schedule', async () => {
    const reset = await api(`/settings/doctors/${doctorId}/availability`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(reset.status, 204);

    const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    assert.equal(agenda.body.openingHours.source, 'clinic');
    assert.equal(agenda.body.openingHours.openMinute, 780);
    assert.equal(agenda.body.openingHours.closeMinute, 1260);
    assert.equal(agenda.body.slots.length, 32);
  });

  await t.test('the configured clinic timezone controls slot instants', async () => {
    const before = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    const cairoStart = before.body.slots[0].start as string;

    const changed = await api('/settings', {
      method: 'PATCH',
      token: adminToken,
      body: { timezone: 'Asia/Riyadh' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const after = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
      token: adminToken,
    });
    const riyadhStart = after.body.slots[0].start as string;
    assert.equal(new Date(riyadhStart).getTime() - new Date(cairoStart).getTime(), -60 * 60_000);

    const restored = await api('/settings', {
      method: 'PATCH',
      token: adminToken,
      body: { timezone: 'Africa/Cairo' },
    });
    assert.equal(restored.status, 200);
  });

  await t.test('bookings outside clinic hours need an explicit override', async () => {
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

    const beforeOpening = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 765, durationMinutes: 15 },
    });
    assert.equal(beforeOpening.status, 400);
    assert.equal(beforeOpening.body.error.details?.requiresOverride, true);

    const override = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: {
        patientId,
        doctorId,
        date: monday,
        startMinute: 765,
        durationMinutes: 15,
        overrideReason: 'Patient could only arrive early',
      },
    });
    assert.equal(override.status, 201, JSON.stringify(override.body));
    assert.equal(override.body.appointment.isManualOverride, true);
    assert.equal(override.body.appointment.overrideReason, 'Patient could only arrive early');

    const atOpening = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 780, durationMinutes: 15 },
    });
    assert.equal(atOpening.status, 201, JSON.stringify(atOpening.body));

    const overlapping = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 780, durationMinutes: 15 },
    });
    assert.equal(overlapping.status, 409);

    const endingAtClose = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 1245, durationMinutes: 15 },
    });
    assert.equal(endingAtClose.status, 201, JSON.stringify(endingAtClose.body));

    const pastClose = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId, date: monday, startMinute: 1250, durationMinutes: 15 },
    });
    assert.equal(pastClose.status, 400);
    assert.equal(pastClose.body.error.details?.requiresOverride, true);
  });
});
