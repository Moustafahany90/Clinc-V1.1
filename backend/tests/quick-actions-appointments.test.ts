import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clinicDateString, clinicLocalToUtc } from '../src/lib/time.js';

/**
 * Integration tests for the Phase 1 Quick Actions (Actions 1-5).
 *
 * Availability must be produced by the same engine that serves
 * `GET /appointments/agenda`; these tests compare the two directly.
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
let alphaId = '';
let betaId = '';
let laterId = '';
let closedId = '';
let alphaToken = '';
let betaToken = '';
let limitedToken = '';
let noAccessToken = '';
let patientOneId = '';
let patientTwoId = '';
let longServiceId = '';
let alphaTodayAppointmentId = '';
let betaTodayAppointmentId = '';

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

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoWeekday(dateOnly: string): number {
  const day = new Date(`${dateOnly}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Independent (non-`lib/time`) expectation: Saturday on/before `dateOnly`. */
function expectedSaturday(dateOnly: string): string {
  const offset = (isoWeekday(dateOnly) - 6 + 7) % 7;
  return addDays(dateOnly, -offset);
}

/** A weekday (ISO 1..7) at least one week in the future, as YYYY-MM-DD. */
function futureWeekday(isoDay: number, weeksAhead = 1): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  const current = date.getUTCDay() || 7;
  let delta = (isoDay - current + 7) % 7;
  delta += weeksAhead * 7;
  if (delta < 7) delta += 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function workingHoursPayload() {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: true,
    openMinute: 480,
    closeMinute: 1320,
    breakStartMinute: null,
    breakEndMinute: null,
  }));
}

function availabilityPayload(isWorking: boolean) {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isWorking,
    openMinute: 480,
    closeMinute: 1320,
  }));
}

async function createDoctor(firstName: string, email: string) {
  const created = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName,
      lastName: 'Doctor',
      email,
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await api('/auth/login', {
    method: 'POST',
    body: { email, password: 'Str0ng!Passw0rd' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { id: created.body.user.id as string, token: login.body.accessToken as string };
}

async function createUser(
  email: string,
  role: 'RECEPTIONIST' | 'ADMIN',
  permissions?: string[],
) {
  const created = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Quick',
      lastName: 'Actions',
      email,
      role,
      password: 'Str0ng!Passw0rd',
      ...(permissions ? { permissions } : {}),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await api('/auth/login', {
    method: 'POST',
    body: { email, password: 'Str0ng!Passw0rd' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.accessToken as string;
}

/** Slots the agenda calls available, ignoring the ~1 s boundary race. */
function stableAvailableAgendaStarts(body: any, cutoff: number): string[] {
  return body.slots
    .filter((slot: any) => slot.available && Date.parse(slot.start) > cutoff)
    .map((slot: any) => slot.start)
    .sort();
}

function futureSlot(body: any): any | null {
  return (
    body.slots.find(
      (slot: any) => slot.available && Date.parse(slot.start) > Date.now() + 30_000,
    ) ?? null
  );
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
        name: 'Quick Actions Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: workingHoursPayload(),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;

  const settings = await api('/settings', {
    method: 'PATCH',
    token: adminToken,
    body: { slotIntervalMinutes: 15 },
  });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));

  const alpha = await createDoctor('Alpha', 'alpha.quick@clinic.test');
  alphaId = alpha.id;
  alphaToken = alpha.token;
  const beta = await createDoctor('Beta', 'beta.quick@clinic.test');
  betaId = beta.id;
  betaToken = beta.token;
  const later = await createDoctor('Later', 'later.quick@clinic.test');
  laterId = later.id;
  const closed = await createDoctor('Closed', 'closed.quick@clinic.test');
  closedId = closed.id;

  const closedAvailability = await api(`/settings/doctors/${closedId}/availability`, {
    method: 'PUT',
    token: adminToken,
    body: { availability: availabilityPayload(false) },
  });
  assert.equal(closedAvailability.status, 200, JSON.stringify(closedAvailability.body));

  limitedToken = await createUser('limited.quick@clinic.test', 'RECEPTIONIST', [
    'APPOINTMENTS_READ',
  ]);
  noAccessToken = await createUser('none.quick@clinic.test', 'RECEPTIONIST', []);

  const patientOne = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Mona',
      lastName: 'One',
      phone: '01000000101',
      gender: 'FEMALE',
    },
  });
  assert.equal(patientOne.status, 201, JSON.stringify(patientOne.body));
  patientOneId = patientOne.body.patient.id;

  const patientTwo = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Hassan',
      lastName: 'Two',
      phone: '01000000102',
      gender: 'MALE',
    },
  });
  assert.equal(patientTwo.status, 201, JSON.stringify(patientTwo.body));
  patientTwoId = patientTwo.body.patient.id;

  const service = await api('/settings/services', {
    method: 'POST',
    token: adminToken,
    body: { name: 'Extended scan', durationMinutes: 30, priceMinor: 50000 },
  });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  longServiceId = service.body.service.id;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('quick actions: appointment and statistics actions 1-13', async (t) => {
  const today = clinicDateString();

  await t.test('Action 1 groups today by doctor and matches the agenda grid', async () => {
    const all = await api('/quick-actions/availability/today', { token: adminToken });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.date, today);
    assert.equal(all.body.timezone, 'Africa/Cairo');
    assert.equal(all.body.durationMinutes, 15);
    assert.equal(all.body.slotIntervalMinutes, 15);
    assert.ok(Array.isArray(all.body.doctors));
    assert.equal(all.body.doctors.length, 4);
    assert.equal(
      all.body.totalAvailable,
      all.body.doctors.reduce((sum: number, row: any) => sum + row.availableCount, 0),
    );
    for (const row of all.body.doctors) {
      assert.equal(typeof row.doctor.id, 'string');
      assert.ok(row.slots.every((slot: any) => slot.available === true));
      assert.equal(row.availableCount, row.slots.length);
      if (row.slots.length > 0) {
        assert.deepEqual(Object.keys(row.slots[0]).sort(), ['available', 'end', 'minute', 'start']);
      }
    }

    const agenda = await api(`/appointments/agenda?date=${today}&doctorId=${alphaId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));

    const cutoff = Date.now() + 30_000;
    const quick = await api(
      `/quick-actions/availability/today?doctorId=${alphaId}`,
      { token: adminToken },
    );
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    assert.equal(quick.body.doctors.length, 1);
    assert.equal(quick.body.doctorId, alphaId);

    const expected = stableAvailableAgendaStarts(agenda.body, cutoff);
    const actual = quick.body.doctors[0].slots
      .filter((slot: any) => Date.parse(slot.start) > cutoff)
      .map((slot: any) => slot.start)
      .sort();
    assert.deepEqual(actual, expected);
  });

  await t.test('Action 1 excludes occupied slots and closed doctors', async () => {
    const agenda = await api(`/appointments/agenda?date=${today}&doctorId=${alphaId}`, {
      token: adminToken,
    });
    const slot = futureSlot(agenda.body);
    if (slot) {
      const booked = await api('/appointments', {
        method: 'POST',
        token: adminToken,
        body: {
          patientId: patientOneId,
          doctorId: alphaId,
          date: today,
          startMinute: slot.minute,
          durationMinutes: 15,
        },
      });
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      alphaTodayAppointmentId = booked.body.appointment.id;
    }

    const quick = await api(
      `/quick-actions/availability/today?doctorId=${alphaId}`,
      { token: adminToken },
    );
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    if (slot) {
      assert.ok(
        !quick.body.doctors[0].slots.some((entry: any) => entry.start === slot.start),
        'the booked slot must not be offered',
      );
      const refreshed = await api(`/appointments/agenda?date=${today}&doctorId=${alphaId}`, {
        token: adminToken,
      });
      const occupied = refreshed.body.slots.find((entry: any) => entry.start === slot.start);
      assert.equal(occupied.available, false);
      assert.equal(occupied.conflictWith, alphaTodayAppointmentId);
    }

    const closed = await api(
      `/quick-actions/availability/today?doctorId=${closedId}`,
      { token: adminToken },
    );
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.doctors.length, 1);
    const row = closed.body.doctors[0];
    assert.equal(row.isOpen, false);
    assert.equal(row.openingHours.source, 'doctor');
    assert.match(row.openingHours.reason, /not working/i);
    assert.deepEqual(row.slots, []);
    assert.equal(row.availableCount, 0);
    assert.equal(closed.body.totalAvailable, 0);
  });

  await t.test('Action 2 lists today with status, limits and doctor isolation', async () => {
    // A second doctor's appointment keeps isolation checks meaningful.
    const betaAgenda = await api(`/appointments/agenda?date=${today}&doctorId=${betaId}`, {
      token: adminToken,
    });
    const betaSlot = futureSlot(betaAgenda.body);
    if (betaSlot) {
      const booked = await api('/appointments', {
        method: 'POST',
        token: adminToken,
        body: {
          patientId: patientTwoId,
          doctorId: betaId,
          date: today,
          startMinute: betaSlot.minute,
          durationMinutes: 15,
        },
      });
      assert.equal(booked.status, 201, JSON.stringify(booked.body));
      betaTodayAppointmentId = booked.body.appointment.id;
    }

    const admin = await api('/quick-actions/appointments/today', { token: adminToken });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.date, today);
    assert.equal(admin.body.canViewPatientNames, true);
    assert.ok(Array.isArray(admin.body.appointments));
    assert.equal(admin.body.limit, 50);
    assert.equal(admin.body.hasMore, admin.body.total > 50);
    assert.equal(admin.body.appointments.length, Math.min(admin.body.total, 50));

    if (alphaTodayAppointmentId) {
      const alpha = await api(
        `/quick-actions/appointments/today?doctorId=${alphaId}`,
        { token: adminToken },
      );
      assert.equal(alpha.status, 200, JSON.stringify(alpha.body));
      const entry = alpha.body.appointments.find(
        (row: any) => row.id === alphaTodayAppointmentId,
      );
      assert.ok(entry, 'the alpha appointment should be listed');
      assert.equal(entry.doctor.id, alphaId);
      assert.equal(entry.patient.id, patientOneId);
      assert.equal(entry.patient.firstName, 'Mona');
      assert.equal(entry.status, 'BOOKED');
      assert.ok(
        !alpha.body.appointments.some((row: any) => row.id === betaTodayAppointmentId),
        'another doctor appointment leaked into the list',
      );

      const doctorView = await api(
        `/quick-actions/appointments/today?doctorId=${betaId}`,
        { token: alphaToken },
      );
      assert.equal(doctorView.status, 200, JSON.stringify(doctorView.body));
      assert.equal(doctorView.body.doctorId, alphaId);
      assert.ok(
        doctorView.body.appointments.every((row: any) => row.doctor.id === alphaId),
        'a doctor must only see their own appointments',
      );

      const cancelledOnly = await api(
        `/quick-actions/appointments/today?status=CANCELLED&doctorId=${alphaId}`,
        { token: adminToken },
      );
      assert.equal(cancelledOnly.status, 200, JSON.stringify(cancelledOnly.body));
      assert.ok(cancelledOnly.body.appointments.every((row: any) => row.status === 'CANCELLED'));

      const limited = await api(
        '/quick-actions/appointments/today?limit=1',
        { token: alphaToken },
      );
      assert.equal(limited.status, 200, JSON.stringify(limited.body));
      assert.equal(limited.body.limit, 1);
      assert.equal(limited.body.appointments.length, 1);
    }
  });

  await t.test('cancelled appointments stop blocking availability but stay in the day list', async () => {
    if (!betaTodayAppointmentId) return;

    const cancelled = await api(`/appointments/${betaTodayAppointmentId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'CANCELLED', reason: 'quick actions test' },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const list = await api(`/quick-actions/appointments/today?doctorId=${betaId}`, {
      token: adminToken,
    });
    const entry = list.body.appointments.find((row: any) => row.id === betaTodayAppointmentId);
    assert.ok(entry);
    assert.equal(entry.status, 'CANCELLED');

    const agenda = await api(`/appointments/agenda?date=${today}&doctorId=${betaId}`, {
      token: adminToken,
    });
    const matching = agenda.body.slots.find(
      (slot: any) => slot.start === entry.startAt,
    );
    if (matching) assert.equal(matching.available, true, 'cancelled slot must be free again');
  });

  await t.test('Action 3 groups the current Saturday week and matches each agenda day', async () => {
    const weekStart = addDays(today, 21);
    const week = await api(
      `/quick-actions/availability/week?weekStart=${weekStart}&doctorId=${alphaId}`,
      { token: adminToken },
    );
    assert.equal(week.status, 200, JSON.stringify(week.body));

    const saturday = expectedSaturday(weekStart);
    assert.equal(week.body.weekStart, saturday);
    assert.equal(week.body.weekEnd, addDays(saturday, 6));
    assert.equal(week.body.days.length, 7);
    assert.deepEqual(
      week.body.days.map((day: any) => day.date),
      Array.from({ length: 7 }, (_, index) => addDays(saturday, index)),
    );
    assert.ok(
      week.body.days.every((day: any) => isoWeekday(day.date) >= 1 && isoWeekday(day.date) <= 7),
    );

    for (const day of week.body.days) {
      assert.equal(day.doctors.length, 1);
      const agenda = await api(
        `/appointments/agenda?date=${day.date}&doctorId=${alphaId}`,
        { token: adminToken },
      );
      assert.equal(agenda.status, 200, JSON.stringify(agenda.body));
      const expected = agenda.body.slots
        .filter((slot: any) => slot.available)
        .map((slot: any) => slot.start)
        .sort();
      const actual = day.slots.map((slot: any) => slot.start).sort();
      assert.deepEqual(actual, expected, `availability differs on ${day.date}`);
      assert.ok(day.slots.every((slot: any) => slot.doctor.id === alphaId));
    }

    assert.deepEqual(
      week.body.availableDays,
      week.body.days.filter((day: any) => day.totalAvailable > 0).map((day: any) => day.date),
    );
  });

  await t.test('Action 3 normalises the week to Saturday and survives DST transitions', async () => {
    const spring = await api(
      '/quick-actions/availability/week?weekStart=2027-04-26&doctorId=&serviceId=',
      { token: adminToken },
    );
    assert.equal(spring.status, 200, JSON.stringify(spring.body));
    assert.equal(spring.body.weekStart, '2027-04-24');
    assert.equal(spring.body.weekEnd, '2027-04-30');
    assert.deepEqual(
      spring.body.days.map((day: any) => day.date),
      [
        '2027-04-24',
        '2027-04-25',
        '2027-04-26',
        '2027-04-27',
        '2027-04-28',
        '2027-04-29',
        '2027-04-30',
      ],
    );

    const beforeDst = spring.body.days.find((day: any) => day.date === '2027-04-29');
    const afterDst = spring.body.days.find((day: any) => day.date === '2027-04-30');
    assert.ok(beforeDst.slots.length > 0 && afterDst.slots.length > 0);
    assert.equal(
      Date.parse(afterDst.slots[0].start) - Date.parse(beforeDst.slots[0].start),
      23 * 60 * 60 * 1000,
      'spring-forward day is 23 hours long',
    );

    const autumn = await api(
      '/quick-actions/availability/week?weekStart=2027-10-25&doctorId=',
      { token: adminToken },
    );
    assert.equal(autumn.status, 200, JSON.stringify(autumn.body));
    assert.equal(autumn.body.weekStart, '2027-10-23');
    assert.equal(autumn.body.weekEnd, '2027-10-29');
    const beforeFall = autumn.body.days.find((day: any) => day.date === '2027-10-28');
    const afterFall = autumn.body.days.find((day: any) => day.date === '2027-10-29');
    assert.ok(beforeFall.slots.length > 0 && afterFall.slots.length > 0);
    assert.equal(
      Date.parse(afterFall.slots[0].start) - Date.parse(beforeFall.slots[0].start),
      25 * 60 * 60 * 1000,
      'fall-back day is 25 hours long',
    );
  });

  await t.test('Action 3 reports an explicitly empty week for a closed doctor', async () => {
    const week = await api(
      `/quick-actions/availability/week?weekStart=${addDays(today, 21)}&doctorId=${closedId}`,
      { token: adminToken },
    );
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.equal(week.body.totalAvailable, 0);
    assert.deepEqual(week.body.availableDays, []);
    assert.equal(week.body.days.length, 7);
    for (const day of week.body.days) {
      assert.equal(day.totalAvailable, 0);
      assert.deepEqual(day.slots, []);
      assert.equal(day.doctors[0].isOpen, false);
    }
  });

  await t.test('Action 4 returns a dated doctor schedule with appointments and slots', async () => {
    const from = futureWeekday(1, 4);
    const to = addDays(from, 2);
    const agenda = await api(`/appointments/agenda?date=${from}&doctorId=${alphaId}`, {
      token: adminToken,
    });
    assert.equal(agenda.status, 200, JSON.stringify(agenda.body));
    const slot = agenda.body.slots.find((entry: any) => entry.available);
    assert.ok(slot, 'expected a free slot on the target date');

    const booked = await api('/appointments', {
      method: 'POST',
      token: adminToken,
      body: {
        patientId: patientOneId,
        doctorId: alphaId,
        date: from,
        startMinute: slot.minute,
        durationMinutes: 15,
      },
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const futureAppointmentId = booked.body.appointment.id;

    const schedule = await api(
      `/quick-actions/doctor-schedule?doctorId=${alphaId}&date=${from}&to=${to}`,
      { token: adminToken },
    );
    assert.equal(schedule.status, 200, JSON.stringify(schedule.body));
    assert.equal(schedule.body.doctor.id, alphaId);
    assert.equal(schedule.body.from, from);
    assert.equal(schedule.body.to, to);
    assert.equal(schedule.body.canViewPatientNames, true);
    assert.equal(schedule.body.days.length, 3);
    assert.equal(schedule.body.totalAppointments, 1);
    assert.equal(schedule.body.truncated, false);

    const firstDay = schedule.body.days[0];
    assert.equal(firstDay.date, from);
    assert.equal(firstDay.appointments.length, 1);
    assert.equal(firstDay.appointments[0].id, futureAppointmentId);
    assert.ok(
      !firstDay.slots.some((entry: any) => entry.start === slot.start),
      'the booked slot must be excluded from the schedule availability',
    );
    assert.equal(
      firstDay.availableCount,
      agenda.body.slots.filter(
        (entry: any) => entry.available && entry.start !== slot.start,
      ).length,
    );

    const otherDoctor = await api(
      `/quick-actions/doctor-schedule?doctorId=${betaId}&date=${from}&to=${from}`,
      { token: adminToken },
    );
    assert.equal(otherDoctor.status, 200, JSON.stringify(otherDoctor.body));
    assert.equal(otherDoctor.body.doctor.id, betaId);
    assert.equal(otherDoctor.body.totalAppointments, 0);

    const doctorForced = await api(
      `/quick-actions/doctor-schedule?doctorId=${betaId}&date=${from}`,
      { token: alphaToken },
    );
    assert.equal(doctorForced.status, 200, JSON.stringify(doctorForced.body));
    assert.equal(doctorForced.body.doctor.id, alphaId);
    assert.equal(doctorForced.body.totalAppointments, 1);

    const reversed = await api(
      `/quick-actions/doctor-schedule?doctorId=${alphaId}&date=${to}&to=${from}`,
      { token: adminToken },
    );
    assert.equal(reversed.status, 400);

    const tooLong = await api(
      `/quick-actions/doctor-schedule?doctorId=${alphaId}&date=${from}&to=${addDays(from, 31)}`,
      { token: adminToken },
    );
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error.message, /31 days/);

    const badDate = await api(
      `/quick-actions/doctor-schedule?doctorId=${alphaId}&date=2026-02-30`,
      { token: adminToken },
    );
    assert.equal(badDate.status, 400);

    const missingDoctor = await api(
      `/quick-actions/doctor-schedule?date=${from}`,
      { token: adminToken },
    );
    assert.equal(missingDoctor.status, 400);
  });

  await t.test('Action 5 finds the earliest slot and enforces the 60-day horizon', async () => {
    const todayException = await api('/settings/exceptions', {
      method: 'POST',
      token: adminToken,
      body: { date: today, doctorId: laterId, isClosed: true, reason: 'Closed today' },
    });
    assert.equal(todayException.status, 201, JSON.stringify(todayException.body));
    const tomorrow = addDays(today, 1);
    const tomorrowException = await api('/settings/exceptions', {
      method: 'POST',
      token: adminToken,
      body: { date: tomorrow, doctorId: laterId, isClosed: true, reason: 'Closed tomorrow' },
    });
    assert.equal(tomorrowException.status, 201, JSON.stringify(tomorrowException.body));

    const next = await api(
      `/quick-actions/next-available?doctorId=${laterId}`,
      { token: adminToken },
    );
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.horizonDays, 60);
    assert.equal(next.body.found, true);
    assert.ok(next.body.result, 'expected an availability result');
    assert.equal(next.body.result.date, addDays(today, 2));
    assert.equal(next.body.result.doctor.id, laterId);
    assert.equal(next.body.result.slot.minute, 480);
    assert.equal(
      next.body.result.startAt,
      clinicLocalToUtc(addDays(today, 2), 480).toISOString(),
    );
    assert.equal(next.body.message, null);

    const closed = await api(
      `/quick-actions/next-available?doctorId=${closedId}`,
      { token: adminToken },
    );
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.found, false);
    assert.equal(closed.body.result, null);
    assert.match(closed.body.message, /No availability in the next 60 days/);

    const withService = await api(
      `/quick-actions/next-available?doctorId=${alphaId}&serviceId=${longServiceId}`,
      { token: adminToken },
    );
    assert.equal(withService.status, 200, JSON.stringify(withService.body));
    assert.equal(withService.body.found, true);
    assert.equal(withService.body.durationMinutes, 30);
    assert.equal(
      (Date.parse(withService.body.result.slot.end) -
        Date.parse(withService.body.result.slot.start)) /
        60_000,
      30,
    );

    const doctorScoped = await api(
      `/quick-actions/next-available?doctorId=${laterId}`,
      { token: alphaToken },
    );
    assert.equal(doctorScoped.status, 200, JSON.stringify(doctorScoped.body));
    assert.equal(doctorScoped.body.doctorId, alphaId);
    if (doctorScoped.body.found) {
      assert.equal(doctorScoped.body.result.doctor.id, alphaId);
    }

    const badDoctor = await api('/quick-actions/next-available?doctorId=not-a-uuid', {
      token: adminToken,
    });
    assert.equal(badDoctor.status, 400);
    const badService = await api('/quick-actions/next-available?serviceId=nope', {
      token: adminToken,
    });
    assert.equal(badService.status, 400);
  });

  await t.test('patient names are gated by PATIENTS_READ, not by the endpoint', async () => {
    const restricted = await api('/quick-actions/appointments/today', {
      token: limitedToken,
    });
    assert.equal(restricted.status, 200, JSON.stringify(restricted.body));
    assert.equal(restricted.body.canViewPatientNames, false);
    assert.ok(restricted.body.appointments.length > 0);
    assert.ok(restricted.body.appointments.every((row: any) => row.patient === null));

    const canUseAvailability = await api(
      `/quick-actions/availability/today?doctorId=${alphaId}`,
      { token: limitedToken },
    );
    assert.equal(canUseAvailability.status, 200, JSON.stringify(canUseAvailability.body));

    const denied = await api('/quick-actions/appointments/today', { token: noAccessToken });
    assert.equal(denied.status, 403);

    const endpoints = [
      `/quick-actions/availability/today?doctorId=${alphaId}`,
      `/quick-actions/appointments/today`,
      `/quick-actions/availability/week?doctorId=${alphaId}`,
      `/quick-actions/doctor-schedule?doctorId=${alphaId}&date=${today}`,
      `/quick-actions/next-available?doctorId=${alphaId}`,
    ];
    for (const path of endpoints) {
      const noAccess = await api(path, { token: noAccessToken });
      assert.equal(noAccess.status, 403, path);
      const anonymous = await api(path);
      assert.equal(anonymous.status, 401, path);
    }
  });

  await t.test('doctor filters and identifiers are validated', async () => {
    const badDoctor = await api(
      '/quick-actions/availability/today?doctorId=not-a-uuid',
      { token: adminToken },
    );
    assert.equal(badDoctor.status, 400);

    const unknownDoctor = await api(
      '/quick-actions/availability/today?doctorId=00000000-0000-4000-8000-000000000000',
      { token: adminToken },
    );
    assert.equal(unknownDoctor.status, 400);
    assert.match(unknownDoctor.body.error.message, /active doctor/i);

    const badWeek = await api(
      '/quick-actions/availability/week?weekStart=2026-02-30',
      { token: adminToken },
    );
    assert.equal(badWeek.status, 400);

    const badLimit = await api(
      '/quick-actions/appointments/today?limit=201',
      { token: adminToken },
    );
    assert.equal(badLimit.status, 400);

    const badStatus = await api(
      '/quick-actions/appointments/today?status=SOMETHING',
      { token: adminToken },
    );
    assert.equal(badStatus.status, 400);

    const badService = await api(
      '/quick-actions/availability/today?serviceId=00000000-0000-4000-8000-000000000000',
      { token: adminToken },
    );
    assert.equal(badService.status, 400);
    assert.match(badService.body.error.message, /active service/i);
  });

  await t.test('a doctor only ever gets their own availability', async () => {
    const quick = await api(
      `/quick-actions/availability/today?doctorId=${betaId}`,
      { token: alphaToken },
    );
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    assert.equal(quick.body.doctorId, alphaId);
    assert.equal(quick.body.doctors.length, 1);
    assert.equal(quick.body.doctors[0].doctor.id, alphaId);

    const week = await api(
      `/quick-actions/availability/week?weekStart=${addDays(today, 21)}&doctorId=${betaId}`,
      { token: alphaToken },
    );
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.equal(week.body.doctorId, alphaId);
    assert.ok(week.body.days.every((day: any) => day.slots.every(
      (slot: any) => slot.doctor.id === alphaId,
    )));
  });

  await t.test('Actions 10-13 expose the statistics summaries', async () => {
    const dailyList = await api('/quick-actions/appointments/today', { token: adminToken });
    assert.equal(dailyList.status, 200, JSON.stringify(dailyList.body));

    const todaySummary = await api('/quick-actions/appointments/today-summary', {
      token: adminToken,
    });
    assert.equal(todaySummary.status, 200, JSON.stringify(todaySummary.body));
    assert.equal(todaySummary.body.date, today);
    assert.equal(todaySummary.body.timezone, 'Africa/Cairo');
    assert.equal(todaySummary.body.total, dailyList.body.total);
    assert.equal(
      Object.values(todaySummary.body.byStatus).reduce(
        (sum: number, count: any) => sum + count,
        0,
      ),
      todaySummary.body.total,
    );

    const queue = await api('/quick-actions/queue/status', { token: adminToken });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.equal(queue.body.date, today);
    for (const key of ['waiting', 'called', 'inExam', 'skipped', 'done']) {
      assert.equal(typeof queue.body[key], 'number', key);
      assert.ok(queue.body[key] >= 0, key);
    }

    const served = await api('/quick-actions/patients/today-summary', {
      token: adminToken,
    });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.body.date, today);
    const distinctPatients = new Set(
      dailyList.body.appointments
        .map((row: any) => row.patient?.id)
        .filter((id: unknown): id is string => typeof id === 'string'),
    );
    assert.equal(served.body.total, distinctPatients.size);

    const weekly = await api('/quick-actions/appointments/week-summary', {
      token: adminToken,
    });
    assert.equal(weekly.status, 200, JSON.stringify(weekly.body));
    const weekStart = expectedSaturday(today);
    assert.equal(weekly.body.weekStart, weekStart);
    assert.equal(weekly.body.weekEnd, addDays(weekStart, 6));
    assert.ok(weekly.body.total >= todaySummary.body.total);
    assert.equal(
      Object.values(weekly.body.byStatus).reduce(
        (sum: number, count: any) => sum + count,
        0,
      ),
      weekly.body.total,
    );

    const appointmentPaths = [
      '/quick-actions/appointments/today-summary',
      '/quick-actions/appointments/week-summary',
    ];
    for (const path of appointmentPaths) {
      assert.equal((await api(path, { token: limitedToken })).status, 200, path);
      assert.equal((await api(path, { token: noAccessToken })).status, 403, path);
      assert.equal((await api(path)).status, 401, path);
    }

    const protectedPaths = [
      '/quick-actions/queue/status',
      '/quick-actions/patients/today-summary',
    ];
    for (const path of protectedPaths) {
      assert.equal((await api(path, { token: limitedToken })).status, 403, path);
      assert.equal((await api(path, { token: noAccessToken })).status, 403, path);
      assert.equal((await api(path)).status, 401, path);
    }
  });
});
