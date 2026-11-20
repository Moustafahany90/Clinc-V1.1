import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase M — database integrity constraints.
 *
 * Proves two things:
 *   1. raw Prisma writes that violate a new CHECK are rejected with the exact
 *      constraint name (and the pre-existing money CHECKs still fire);
 *   2. legitimate API workflows, including the documented minute boundaries,
 *      still succeed — including setup validation before the CHECK is reached.
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
let adminId = '';

const ids = {
  patient: '',
  service: '',
  paymentMethod: '',
  category: '',
  appointment: '',
  queueEntry: '',
  charge: '',
  payment: '',
  refund: '',
  allocation: '',
  expense: '',
  visit: '',
  report: '',
  reportVersion: '',
  reportDelivery: '',
  updateRequest: '',
  file: '',
  sequence: '',
  availability: '',
  exception: '',
};

const newConstraintNames = [
  'Charge_status_allowed',
  'Charge_void_fields_consistent',
  'Expense_status_allowed',
  'Expense_void_fields_consistent',
  'ReportUpdateRequest_status_allowed',
  'ReportUpdateRequest_resolved_fields_consistent',
  'FileAsset_kind_allowed',
  'Service_price_nonnegative',
  'Service_duration_positive',
  'ClinicSettings_appointment_minutes_positive',
  'ClinicSettings_slot_interval_positive',
  'FileAsset_size_positive',
  'Appointment_duration_positive',
  'Appointment_end_after_start',
  'Report_version_positive',
  'ReportVersion_version_positive',
  'ReportDelivery_version_positive',
  'ReportDelivery_attempts_positive',
  'QueueEntry_position_positive',
  'QueueEntry_timestamp_order',
  'User_failed_login_count_nonnegative',
  'User_token_version_nonnegative',
  'Sequence_value_nonnegative',
  'PaymentMethod_sort_order_nonnegative',
  'WorkingHours_day_of_week_range',
  'WorkingHours_open_minute_range',
  'WorkingHours_close_minute_range',
  'WorkingHours_break_start_range',
  'WorkingHours_break_end_range',
  'WorkingHours_open_before_close',
  'WorkingHours_break_order_and_window',
  'DoctorAvailability_day_of_week_range',
  'DoctorAvailability_open_minute_range',
  'DoctorAvailability_close_minute_range',
  'DoctorAvailability_open_before_close',
  'ScheduleException_open_minute_range',
  'ScheduleException_close_minute_range',
  'ScheduleException_open_before_close',
];

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

async function rejectsWithConstraint(
  run: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      message.includes(constraint),
      `expected rejection naming "${constraint}", got: ${message}`,
    );
    return true;
  });
}

function workingHours(openMinute: number, closeMinute: number, reversedDay = 0) {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: true,
    openMinute: index + 1 === reversedDay ? closeMinute : openMinute,
    closeMinute: index + 1 === reversedDay ? openMinute : closeMinute,
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
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('setup validates working hours before any row reaches the DB CHECK', async () => {
  const admin = {
    firstName: 'Constraint',
    lastName: 'Admin',
    email: 'constraint.admin@clinic.test',
    password: 'Str0ng!Passw0rd',
  };
  const clinic = {
    name: 'Constraint Test Clinic',
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    defaultAppointmentMinutes: 15,
  };

  const invalid = await api('/setup', {
    method: 'POST',
    body: { admin, clinic, workingHours: workingHours(780, 1260, 1) },
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.match(invalid.body.error.message, /before closing/i);
  assert.equal(await prisma.user.count(), 0, 'failed setup must not leave partial rows');

  const valid = await api('/setup', {
    method: 'POST',
    body: { admin, clinic, workingHours: workingHours(780, 1260) },
  });
  assert.equal(valid.status, 201, JSON.stringify(valid.body));
  adminToken = valid.body.accessToken;
  adminId = valid.body.user.id;
});

test('valid fixture rows can be created under the new constraints', async () => {
  const patient = await prisma.patient.create({
    data: { patientNumber: 'P-DBCON-000001', firstName: 'Db', lastName: 'Constraint' },
  });
  ids.patient = patient.id;

  const service = await prisma.service.create({
    data: { name: 'DBCON free service', durationMinutes: 15, priceMinor: 0 },
  });
  ids.service = service.id;

  const paymentMethod = await prisma.paymentMethod.create({
    data: { key: 'DBCON', label: 'DB Constraint Method', sortOrder: 0 },
  });
  ids.paymentMethod = paymentMethod.id;

  const category = await prisma.expenseCategory.create({ data: { name: 'DBCON category' } });
  ids.category = category.id;

  const appointment = await prisma.appointment.create({
    data: {
      patientId: ids.patient,
      doctorId: adminId,
      startAt: new Date('2026-12-01T10:00:00.000Z'),
      endAt: new Date('2026-12-01T10:15:00.000Z'),
      durationMinutes: 15,
    },
  });
  ids.appointment = appointment.id;

  const queueEntry = await prisma.queueEntry.create({
    data: {
      appointmentId: ids.appointment,
      patientId: ids.patient,
      doctorId: adminId,
      queueDate: new Date('2026-12-01T00:00:00.000Z'),
      position: 1,
    },
  });
  ids.queueEntry = queueEntry.id;

  const charge = await prisma.charge.create({
    data: { patientId: ids.patient, description: 'DBCON charge', amountMinor: 1000 },
  });
  ids.charge = charge.id;

  const payment = await prisma.payment.create({
    data: {
      patientId: ids.patient,
      methodKey: 'DBCON',
      amountMinor: 1000,
      receivedById: adminId,
    },
  });
  ids.payment = payment.id;

  const refund = await prisma.refund.create({
    data: {
      paymentId: ids.payment,
      patientId: ids.patient,
      amountMinor: 100,
      reason: 'DBCON refund',
      refundedById: adminId,
    },
  });
  ids.refund = refund.id;

  const allocation = await prisma.paymentAllocation.create({
    data: { paymentId: ids.payment, chargeId: ids.charge, amountMinor: 100 },
  });
  ids.allocation = allocation.id;

  const expense = await prisma.expense.create({
    data: {
      expenseDate: new Date('2026-12-01T00:00:00.000Z'),
      amountMinor: 500,
      categoryId: ids.category,
      description: 'DBCON expense',
      recordedById: adminId,
    },
  });
  ids.expense = expense.id;

  const visit = await prisma.visit.create({ data: { patientId: ids.patient, doctorId: adminId } });
  ids.visit = visit.id;

  const report = await prisma.report.create({
    data: { visitId: ids.visit, doctorId: adminId, currentContent: {} },
  });
  ids.report = report.id;

  const reportVersion = await prisma.reportVersion.create({
    data: { reportId: ids.report, versionNumber: 1, content: {}, authorId: adminId },
  });
  ids.reportVersion = reportVersion.id;

  const reportDelivery = await prisma.reportDelivery.create({
    data: {
      reportId: ids.report,
      patientId: ids.patient,
      sentById: adminId,
      versionNumber: 1,
      recipientLast4: '1234',
      attempts: 1,
    },
  });
  ids.reportDelivery = reportDelivery.id;

  const updateRequest = await prisma.reportUpdateRequest.create({
    data: { reportId: ids.report, doctorId: adminId, message: 'DBCON request' },
  });
  ids.updateRequest = updateRequest.id;

  const file = await prisma.fileAsset.create({
    data: {
      patientId: ids.patient,
      uploadedById: adminId,
      originalName: 'dbcon.txt',
      storedName: 'dbcon-stored.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
    },
  });
  ids.file = file.id;

  const sequence = await prisma.sequence.create({ data: { name: 'dbcon-sequence', value: 1 } });
  ids.sequence = sequence.name;

  const availability = await prisma.doctorAvailability.create({
    data: { doctorId: adminId, dayOfWeek: 1, openMinute: 780, closeMinute: 1260 },
  });
  ids.availability = availability.id;

  const exception = await prisma.scheduleException.create({
    data: { date: new Date('2026-12-25T00:00:00.000Z'), isClosed: true },
  });
  ids.exception = exception.id;
});

test('all 38 new CHECKs exist in the catalog and are validated', async () => {
  const rows = await prisma.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND contype = 'c'
      AND conname = ANY(${newConstraintNames}::text[])
  `;
  assert.equal(rows.length, newConstraintNames.length);
  assert.ok(rows.every((row) => row.convalidated), 'every new CHECK must be validated');

  const totals = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND contype = 'c'
  `;
  assert.equal(
    Number(totals[0]?.count),
    43,
    '38 new checks + 5 pre-existing money checks',
  );
});

test('string status and void-field combinations are rejected by name', async () => {
  await rejectsWithConstraint(
    () => prisma.charge.update({ where: { id: ids.charge }, data: { status: 'UNKNOWN' } }),
    'Charge_status_allowed',
  );
  await rejectsWithConstraint(
    () =>
      prisma.charge.update({
        where: { id: ids.charge },
        data: { status: 'VOID', voidReason: 'no timestamp' },
      }),
    'Charge_void_fields_consistent',
  );
  await rejectsWithConstraint(
    () => prisma.expense.update({ where: { id: ids.expense }, data: { status: 'UNKNOWN' } }),
    'Expense_status_allowed',
  );
  await rejectsWithConstraint(
    () => prisma.expense.update({ where: { id: ids.expense }, data: { status: 'VOID' } }),
    'Expense_void_fields_consistent',
  );
  await rejectsWithConstraint(
    () =>
      prisma.reportUpdateRequest.update({
        where: { id: ids.updateRequest },
        data: { status: 'CLOSED' },
      }),
    'ReportUpdateRequest_status_allowed',
  );
  await rejectsWithConstraint(
    () =>
      prisma.reportUpdateRequest.update({
        where: { id: ids.updateRequest },
        data: { resolvedAt: new Date() },
      }),
    'ReportUpdateRequest_resolved_fields_consistent',
  );
  await rejectsWithConstraint(
    () => prisma.fileAsset.update({ where: { id: ids.file }, data: { kind: 'REPORT' } }),
    'FileAsset_kind_allowed',
  );
});

test('numeric and ordering checks reject invalid writes by name', async () => {
  await rejectsWithConstraint(
    () => prisma.service.update({ where: { id: ids.service }, data: { priceMinor: -1 } }),
    'Service_price_nonnegative',
  );
  await rejectsWithConstraint(
    () => prisma.service.update({ where: { id: ids.service }, data: { durationMinutes: 0 } }),
    'Service_duration_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.clinicSettings.update({ where: { id: 1 }, data: { defaultAppointmentMinutes: 0 } }),
    'ClinicSettings_appointment_minutes_positive',
  );
  await rejectsWithConstraint(
    () => prisma.clinicSettings.update({ where: { id: 1 }, data: { slotIntervalMinutes: -1 } }),
    'ClinicSettings_slot_interval_positive',
  );
  await rejectsWithConstraint(
    () => prisma.fileAsset.update({ where: { id: ids.file }, data: { sizeBytes: 0 } }),
    'FileAsset_size_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.appointment.update({ where: { id: ids.appointment }, data: { durationMinutes: 0 } }),
    'Appointment_duration_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.appointment.update({
        where: { id: ids.appointment },
        data: { endAt: new Date('2026-12-01T10:00:00.000Z') },
      }),
    'Appointment_end_after_start',
  );
  await rejectsWithConstraint(
    () => prisma.report.update({ where: { id: ids.report }, data: { versionNumber: 0 } }),
    'Report_version_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.reportVersion.update({
        where: { id: ids.reportVersion },
        data: { versionNumber: 0 },
      }),
    'ReportVersion_version_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.reportDelivery.update({
        where: { id: ids.reportDelivery },
        data: { versionNumber: 0 },
      }),
    'ReportDelivery_version_positive',
  );
  await rejectsWithConstraint(
    () => prisma.reportDelivery.update({ where: { id: ids.reportDelivery }, data: { attempts: 0 } }),
    'ReportDelivery_attempts_positive',
  );
  await rejectsWithConstraint(
    () => prisma.queueEntry.update({ where: { id: ids.queueEntry }, data: { position: 0 } }),
    'QueueEntry_position_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.queueEntry.update({
        where: { id: ids.queueEntry },
        data: {
          arrivedAt: new Date('2026-12-01T10:00:00.000Z'),
          calledAt: new Date('2026-12-01T09:00:00.000Z'),
        },
      }),
    'QueueEntry_timestamp_order',
  );
  await rejectsWithConstraint(
    () =>
      prisma.user.update({ where: { id: adminId }, data: { failedLoginCount: -1 } }),
    'User_failed_login_count_nonnegative',
  );
  await rejectsWithConstraint(
    () => prisma.user.update({ where: { id: adminId }, data: { tokenVersion: -1 } }),
    'User_token_version_nonnegative',
  );
  await rejectsWithConstraint(
    () => prisma.sequence.update({ where: { name: ids.sequence }, data: { value: -1 } }),
    'Sequence_value_nonnegative',
  );
  await rejectsWithConstraint(
    () =>
      prisma.paymentMethod.update({ where: { id: ids.paymentMethod }, data: { sortOrder: -1 } }),
    'PaymentMethod_sort_order_nonnegative',
  );
});

test('pre-existing money positivity CHECKs still fire', async () => {
  await rejectsWithConstraint(
    () => prisma.charge.update({ where: { id: ids.charge }, data: { amountMinor: 0 } }),
    'Charge_amount_positive',
  );
  await rejectsWithConstraint(
    () => prisma.payment.update({ where: { id: ids.payment }, data: { amountMinor: 0 } }),
    'Payment_amount_positive',
  );
  await rejectsWithConstraint(
    () => prisma.refund.update({ where: { id: ids.refund }, data: { amountMinor: 0 } }),
    'Refund_amount_positive',
  );
  await rejectsWithConstraint(
    () => prisma.expense.update({ where: { id: ids.expense }, data: { amountMinor: 0 } }),
    'Expense_amount_positive',
  );
  await rejectsWithConstraint(
    () =>
      prisma.paymentAllocation.update({
        where: { id: ids.allocation },
        data: { amountMinor: 0 },
      }),
    'PaymentAllocation_amount_positive',
  );
});

test('time-window checks reject invalid values and allow documented boundaries', async () => {
  await rejectsWithConstraint(
    () => prisma.workingHours.update({ where: { dayOfWeek: 1 }, data: { dayOfWeek: 8 } }),
    'WorkingHours_day_of_week_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { openMinute: -1, closeMinute: 1260 },
      }),
    'WorkingHours_open_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { openMinute: 780, closeMinute: 1441 },
      }),
    'WorkingHours_close_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { breakStartMinute: -1, breakEndMinute: null },
      }),
    'WorkingHours_break_start_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { closeMinute: 1440, breakStartMinute: 1200, breakEndMinute: 1441 },
      }),
    'WorkingHours_break_end_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { openMinute: 1200, closeMinute: 600 },
      }),
    'WorkingHours_open_before_close',
  );
  await rejectsWithConstraint(
    () =>
      prisma.workingHours.update({
        where: { dayOfWeek: 1 },
        data: { breakStartMinute: 500, breakEndMinute: 900 },
      }),
    'WorkingHours_break_order_and_window',
  );

  await rejectsWithConstraint(
    () =>
      prisma.doctorAvailability.update({
        where: { id: ids.availability },
        data: { dayOfWeek: 8 },
      }),
    'DoctorAvailability_day_of_week_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.doctorAvailability.update({
        where: { id: ids.availability },
        data: { openMinute: -1, closeMinute: 1260 },
      }),
    'DoctorAvailability_open_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.doctorAvailability.update({
        where: { id: ids.availability },
        data: { openMinute: 780, closeMinute: 1441 },
      }),
    'DoctorAvailability_close_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.doctorAvailability.update({
        where: { id: ids.availability },
        data: { openMinute: 1200, closeMinute: 600 },
      }),
    'DoctorAvailability_open_before_close',
  );

  await rejectsWithConstraint(
    () =>
      prisma.scheduleException.update({
        where: { id: ids.exception },
        data: { openMinute: 1440, closeMinute: null },
      }),
    'ScheduleException_open_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.scheduleException.update({
        where: { id: ids.exception },
        data: { openMinute: null, closeMinute: 1441 },
      }),
    'ScheduleException_close_minute_range',
  );
  await rejectsWithConstraint(
    () =>
      prisma.scheduleException.update({
        where: { id: ids.exception },
        data: { openMinute: 900, closeMinute: 900 },
      }),
    'ScheduleException_open_before_close',
  );

  const boundary = await prisma.workingHours.update({
    where: { dayOfWeek: 1 },
    data: { openMinute: 1439, closeMinute: 1440, breakStartMinute: null, breakEndMinute: null },
  });
  assert.equal(boundary.openMinute, 1439);
  assert.equal(boundary.closeMinute, 1440);
  await prisma.workingHours.update({
    where: { dayOfWeek: 1 },
    data: { openMinute: 780, closeMinute: 1260 },
  });
});

test('valid API workflows still succeed', async () => {
  const hours = workingHours(780, 1260);
  const savedHours = await api('/settings/working-hours', {
    method: 'PUT',
    token: adminToken,
    body: { workingHours: hours },
  });
  assert.equal(savedHours.status, 200, JSON.stringify(savedHours.body));

  const service = await api('/settings/services', {
    method: 'POST',
    token: adminToken,
    body: { name: 'DBCON API free service', durationMinutes: 15, priceMinor: 0 },
  });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  assert.equal(service.body.service.priceMinor, 0, 'free services must remain legal');

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Api',
      lastName: 'Constraint',
      phone: '+10005550001',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));

  const charge = await api('/payments/charges', {
    method: 'POST',
    token: adminToken,
    body: { patientId: patient.body.patient.id, description: 'DBCON API charge', amountMinor: 1000 },
  });
  assert.equal(charge.status, 201, JSON.stringify(charge.body));

  const listed = await api('/settings/services', { token: adminToken });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.services.some((row: any) => row.priceMinor === 0));
});
