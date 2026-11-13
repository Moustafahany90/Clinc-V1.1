import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordServiceRevenue } from '../src/modules/payments/billing.js';

/**
 * Integration tests for automatic service revenue at registration.
 *
 * Destructive: refuses to run unless the database name ends in `_test`.
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
let otherDoctorId = '';
let patientId = '';
let consultationServiceId = '';
let freeServiceId = '';
let historyServiceId = '';
let walkInServiceId = '';
let firstWalkInAppointmentId = '';
let secondWalkInAppointmentId = '';

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

const bookingDate = futureWeekday(1);

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

async function createService(
  name: string,
  priceMinor: number,
  durationMinutes = 15,
): Promise<string> {
  const created = await api('/settings/services', {
    method: 'POST',
    token: adminToken,
    body: { name, priceMinor, durationMinutes },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.service.id;
}

async function book(
  startMinute: number,
  serviceId: string | null,
  payment?: Record<string, unknown>,
): Promise<ApiResult> {
  return api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: {
      patientId,
      doctorId,
      ...(serviceId ? { serviceId } : {}),
      date: bookingDate,
      startMinute,
      durationMinutes: 15,
      ...(payment ? { payment } : {}),
    },
  });
}

async function chargesForPatient(): Promise<any[]> {
  const result = await api(`/payments/charges/list?patientId=${patientId}&pageSize=100`, {
    token: adminToken,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.charges;
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
        firstName: 'Revenue',
        lastName: 'Admin',
        email: 'revenue.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Revenue Test Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: openHours(),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;

  for (const method of [
    { key: 'CASH', label: 'Cash', requiresReference: false, isActive: true, sortOrder: 1 },
    { key: 'CARD', label: 'Card', requiresReference: true, isActive: true, sortOrder: 2 },
    { key: 'OLD', label: 'Retired method', requiresReference: false, isActive: false, sortOrder: 3 },
  ]) {
    await prisma.paymentMethod.upsert({
      where: { key: method.key },
      create: method,
      update: method,
    });
  }

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Revenue',
      lastName: 'Doctor',
      email: 'revenue.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorId = doctor.body.user.id;

  const otherDoctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Other',
      lastName: 'Doctor',
      email: 'other.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(otherDoctor.status, 201, JSON.stringify(otherDoctor.body));
  otherDoctorId = otherDoctor.body.user.id;

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Revenue',
      lastName: 'Patient',
      phone: '01000000003',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  patientId = patient.body.patient.id;

  consultationServiceId = await createService('Consultation', 25_000);
  freeServiceId = await createService('Free follow-up', 0);
  historyServiceId = await createService('Price history scan', 30_000);
  walkInServiceId = await createService('Walk-in scan', 15_000);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('service revenue is recorded automatically at registration', async (t) => {
  let pendingAppointmentId = '';
  let pendingChargeId = '';

  await t.test('pending booking creates an open charge and no payment', async () => {
    const booked = await book(480, consultationServiceId, { status: 'PENDING' });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.ok(booked.body.charge, 'charge should be returned');
    assert.equal(booked.body.charge.amountMinor, 25_000);
    assert.equal(booked.body.charge.description, 'Consultation');
    assert.equal(booked.body.charge.status, 'OPEN');
    assert.equal(booked.body.payment, null);

    pendingAppointmentId = booked.body.appointment.id;
    pendingChargeId = booked.body.charge.id;

    const charges = await chargesForPatient();
    const charge = charges.find((row) => row.id === pendingChargeId);
    assert.ok(charge);
    assert.equal(charge.amountMinor, 25_000);
    assert.equal(charge.allocatedMinor, 0);
    assert.equal(charge.balanceMinor, 25_000);
    assert.equal(charge.status, 'OPEN');

    const payments = await api(`/payments?patientId=${patientId}&pageSize=100`, {
      token: adminToken,
    });
    assert.equal(payments.status, 200, JSON.stringify(payments.body));
    assert.equal(payments.body.payments.length, 0);
  });

  await t.test('a deposit creates a payment and allocation and leaves a balance', async () => {
    const booked = await book(510, consultationServiceId, {
      status: 'DEPOSIT',
      amountMinor: 10_000,
      methodKey: 'CASH',
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.charge.status, 'OPEN');
    assert.equal(booked.body.payment.amountMinor, 10_000);
    assert.equal(booked.body.payment.methodKey, 'CASH');
    assert.equal(booked.body.payment.allocations.length, 1);
    assert.equal(booked.body.payment.allocations[0].chargeId, booked.body.charge.id);
    assert.equal(booked.body.payment.allocations[0].amountMinor, 10_000);

    const charges = await chargesForPatient();
    const charge = charges.find((row) => row.id === booked.body.charge.id);
    assert.ok(charge);
    assert.equal(charge.allocatedMinor, 10_000);
    assert.equal(charge.balanceMinor, 15_000);
    assert.equal(charge.status, 'OPEN');
  });

  await t.test('a fully paid booking settles the charge', async () => {
    const booked = await book(540, consultationServiceId, {
      status: 'PAID',
      methodKey: 'CARD',
      reference: 'CARD-REF-1',
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.charge.amountMinor, 25_000);
    assert.equal(booked.body.charge.status, 'SETTLED');
    assert.equal(booked.body.payment.amountMinor, 25_000);
    assert.equal(booked.body.payment.allocations[0].amountMinor, 25_000);

    const charges = await chargesForPatient();
    const charge = charges.find((row) => row.id === booked.body.charge.id);
    assert.ok(charge);
    assert.equal(charge.balanceMinor, 0);
    assert.equal(charge.status, 'SETTLED');
  });

  await t.test('invalid deposit amounts and methods are rejected without booking', async () => {
    const before = await prisma.appointment.count();

    const zero = await book(570, consultationServiceId, {
      status: 'DEPOSIT',
      amountMinor: 0,
      methodKey: 'CASH',
    });
    assert.equal(zero.status, 400, JSON.stringify(zero.body));

    const tooMuch = await book(570, consultationServiceId, {
      status: 'DEPOSIT',
      amountMinor: 30_000,
      methodKey: 'CASH',
    });
    assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.body));

    const inactive = await book(570, consultationServiceId, {
      status: 'DEPOSIT',
      amountMinor: 1_000,
      methodKey: 'OLD',
    });
    assert.equal(inactive.status, 400, JSON.stringify(inactive.body));

    const missingReference = await book(570, consultationServiceId, {
      status: 'DEPOSIT',
      amountMinor: 1_000,
      methodKey: 'CARD',
    });
    assert.equal(missingReference.status, 400, JSON.stringify(missingReference.body));

    const after = await prisma.appointment.count();
    assert.equal(after, before, 'failed payments must roll the appointment back');
  });

  await t.test('a zero-priced service is not charged automatically', async () => {
    const booked = await book(600, freeServiceId, {
      status: 'PAID',
      methodKey: 'CASH',
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.charge, null);
    assert.equal(booked.body.payment, null);

    const stored = await prisma.charge.findUnique({
      where: { appointmentId: booked.body.appointment.id },
    });
    assert.equal(stored, null);
  });

  await t.test('editing an appointment never duplicates its charge', async () => {
    const patched = await api(`/appointments/${pendingAppointmentId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { notes: 'Updated reception notes' },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const count = await prisma.charge.count({ where: { appointmentId: pendingAppointmentId } });
    assert.equal(count, 1);
  });

  await t.test('changing service or doctor after billing is blocked', async () => {
    const serviceChange = await api(`/appointments/${pendingAppointmentId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { serviceId: freeServiceId },
    });
    assert.equal(serviceChange.status, 409, JSON.stringify(serviceChange.body));

    const doctorChange = await api(`/appointments/${pendingAppointmentId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { doctorId: otherDoctorId },
    });
    assert.equal(doctorChange.status, 409, JSON.stringify(doctorChange.body));

    const unchanged = await prisma.appointment.findUnique({
      where: { id: pendingAppointmentId },
      select: { serviceId: true, doctorId: true },
    });
    assert.equal(unchanged?.serviceId, consultationServiceId);
    assert.equal(unchanged?.doctorId, doctorId);
  });

  await t.test('charge and payment creation is idempotent on retry', async () => {
    const booked = await book(630, consultationServiceId);
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const appointmentId = booked.body.appointment.id;

    const input = {
      patientId,
      appointmentId,
      service: { id: consultationServiceId, name: 'Consultation', priceMinor: 25_000 },
      createdById: (
        await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' }, select: { id: true } })
      ).id,
      payment: { status: 'PAID' as const, methodKey: 'CASH' },
    };

    const first = await prisma.$transaction((tx) => recordServiceRevenue(tx, input));
    const second = await prisma.$transaction((tx) => recordServiceRevenue(tx, input));

    assert.equal(first.charge?.id, second.charge?.id);
    assert.equal(first.payment?.id, second.payment?.id);
    assert.equal(await prisma.charge.count({ where: { appointmentId } }), 1);
    assert.equal(
      await prisma.payment.count({ where: { idempotencyKey: `booking:${appointmentId}` } }),
      1,
    );
    assert.equal(
      await prisma.paymentAllocation.count({ where: { chargeId: first.charge!.id } }),
      1,
    );
  });

  await t.test('historical charges keep their original price snapshot', async () => {
    const booked = await book(660, historyServiceId);
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.charge.amountMinor, 30_000);

    const updated = await api(`/settings/services/${historyServiceId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { priceMinor: 50_000 },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const historical = await prisma.charge.findUnique({
      where: { appointmentId: booked.body.appointment.id },
    });
    assert.equal(historical?.amountMinor, 30_000);

    const later = await book(690, historyServiceId);
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal(later.body.charge.amountMinor, 50_000);
  });

  await t.test('walk-in registration records revenue with the same rules', async () => {
    const walkIn = await api('/queue/walk-in', {
      method: 'POST',
      token: adminToken,
      body: {
        patientId,
        doctorId,
        serviceId: walkInServiceId,
        payment: { status: 'DEPOSIT', amountMinor: 5_000, methodKey: 'CASH' },
      },
    });
    assert.equal(walkIn.status, 201, JSON.stringify(walkIn.body));
    firstWalkInAppointmentId = walkIn.body.appointment.id;
    assert.equal(walkIn.body.charge.amountMinor, 15_000);
    assert.equal(walkIn.body.charge.status, 'OPEN');
    assert.equal(walkIn.body.payment.amountMinor, 5_000);
    assert.equal(walkIn.body.payment.allocations[0].chargeId, walkIn.body.charge.id);

    const stored = await prisma.charge.findUnique({
      where: { appointmentId: walkIn.body.appointment.id },
      include: { appointment: { select: { doctorId: true, status: true } } },
    });
    assert.equal(stored?.amountMinor, 15_000);
    assert.equal(stored?.appointment.doctorId, doctorId);
    assert.equal(stored?.appointment.status, 'ARRIVED');

    const pendingWalkIn = await api('/queue/walk-in', {
      method: 'POST',
      token: adminToken,
      body: { patientId, doctorId: otherDoctorId, serviceId: walkInServiceId },
    });
    assert.equal(pendingWalkIn.status, 201, JSON.stringify(pendingWalkIn.body));
    secondWalkInAppointmentId = pendingWalkIn.body.appointment.id;
    assert.equal(pendingWalkIn.body.charge.status, 'OPEN');
    assert.equal(pendingWalkIn.body.payment, null);
  });

  await t.test('a later payment allocates to a pending charge and settles it', async () => {
    const booked = await book(720, consultationServiceId);
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    const chargeId = booked.body.charge.id;

    const payment = await api('/payments', {
      method: 'POST',
      token: adminToken,
      body: {
        patientId,
        amountMinor: 25_000,
        methodKey: 'CASH',
        allocations: [{ chargeId, amountMinor: 25_000 }],
      },
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    assert.equal(payment.body.payment.allocations[0].chargeId, chargeId);
    assert.equal(payment.body.payment.allocations[0].amountMinor, 25_000);

    const charge = await prisma.charge.findUnique({ where: { id: chargeId } });
    assert.equal(charge?.status, 'SETTLED');

    const ledger = await api(`/patients/${patientId}/ledger`, { token: adminToken });
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    const row = ledger.body.charges.find((item: any) => item.id === chargeId);
    assert.equal(row?.balanceMinor, 0);
    assert.equal(row?.allocatedMinor, 25_000);
  });

  await t.test('every automatic charge is attributed to the appointment doctor', async () => {
    const first = await prisma.charge.findUnique({
      where: { appointmentId: firstWalkInAppointmentId },
      include: { appointment: { select: { doctorId: true } } },
    });
    assert.equal(first?.appointment?.doctorId, doctorId);

    const second = await prisma.charge.findUnique({
      where: { appointmentId: secondWalkInAppointmentId },
      include: { appointment: { select: { doctorId: true } } },
    });
    assert.equal(second?.appointment?.doctorId, otherDoctorId);

    const charges = await prisma.charge.findMany({
      where: { patientId, appointmentId: { not: null } },
      select: { id: true, appointment: { select: { doctorId: true } } },
    });
    assert.ok(charges.length > 0);
    for (const charge of charges) {
      assert.ok(
        charge.appointment?.doctorId === doctorId ||
          charge.appointment?.doctorId === otherDoctorId,
        'each charge must resolve to the appointment doctor',
      );
    }
  });
});
