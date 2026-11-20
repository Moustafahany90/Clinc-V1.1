import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { clinicLocalToUtc } from '../src/lib/time.js';
import { renderReportPdf } from '../src/lib/reportPdf.js';
import { closeHtmlPdfBrowser } from '../src/lib/htmlPdf.js';
import { buildInitialContent, validateDefinition } from '../src/lib/report-blocks/blocks.validate.js';
import { templateDefinitionSchema } from '../src/lib/report-blocks/blocks.schema.js';
import type { TemplateDefinition } from '../src/lib/report-blocks/blocks.types.js';

/**
 * Phase 3 production-readiness audit: patient → appointment → visit → report
 * → finalization → amendment → rendering/print.
 *
 * Synthetic patients only. Destructive: refuses to run unless the database
 * name ends in `_test`.
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
  headers: Headers;
  text: string;
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
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers, text };
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

function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function hoursPayload(closedDays: number[] = [4, 5]) {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: !closedDays.includes(index + 1),
    openMinute: 540,
    closeMinute: 1260,
    breakStartMinute: null,
    breakEndMinute: null,
  }));
}

const blockDefinition = {
  schemaVersion: 1 as const,
  baseSize: 11,
  blocks: [
    {
      type: 'infoTable',
      rows: [
        { label: 'Name', source: 'patient.name' },
        { label: 'Date', source: 'visit.date' },
        { label: 'LMP', key: 'lmp', placeholder: 'dd/mm/yyyy' },
      ],
    },
    { type: 'title', text: 'PHASE 3 SYNTHETIC SCAN' },
    {
      type: 'text',
      template: 'First twin: {{firstTwin}}',
      fields: { firstTwin: { default: 'Synthetic first twin.' } },
    },
    {
      type: 'text',
      template: 'Second twin: {{secondTwin}}',
      fields: { secondTwin: { default: 'Synthetic second twin.' } },
    },
    {
      type: 'section',
      title: 'Free comments',
      children: [
        {
          type: 'freeList',
          key: 'comments',
          default: ['Synthetic first comment', 'Synthetic second comment'],
        },
      ],
    },
    { type: 'signature' },
  ],
};

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
        lastName: 'Clinical Admin',
        email: 'phase3.clinical.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Phase 3 Clinical Clinic',
        phone: '+20 100 000 0000',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: hoursPayload(),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Clinical',
      lastName: 'Doctor',
      email: 'phase3.clinical.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorId = doctor.body.user.id;
  doctorToken = await login('phase3.clinical.doctor@clinic.test', 'Str0ng!Passw0rd');

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Synthetic',
      lastName: 'Clinical Patient',
      phone: '01055550001',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  patientId = patient.body.patient.id;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await closeHtmlPdfBrowser();
  await prisma.$disconnect();
});

test('patient management detects duplicates and keeps an auditable identity record', async () => {
  const duplicate = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Duplicate',
      lastName: 'Probe',
      phone: '010 5555 0001',
      gender: 'FEMALE',
    },
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.error.details?.canOverride, true);
  assert.ok(Array.isArray(duplicate.body.error.details?.matches));

  const acknowledged = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Duplicate',
      lastName: 'Probe',
      phone: '010 5555 0001',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(acknowledged.status, 201, JSON.stringify(acknowledged.body));
  // The displayed phone keeps the operator's formatting; the normalized digits
  // are stored separately and are what duplicate detection compares.
  assert.equal(acknowledged.body.patient.phone, '010 5555 0001');
  const stored = await prisma.patient.findUniqueOrThrow({
    where: { id: acknowledged.body.patient.id },
    select: { phoneNormalized: true },
  });
  assert.equal(stored.phoneNormalized, '01055550001');

  const updated = await api(`/patients/${patientId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { address: 'Synthetic audit address', notes: 'Phase 3 synthetic only' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.patient.address, 'Synthetic audit address');

  const fetched = await api(`/patients/${patientId}`, { token: adminToken });
  assert.equal(fetched.status, 200);
  assert.ok(fetched.body.patient.patientNumber);
  const ledger = await api(`/patients/${patientId}/ledger`, { token: adminToken });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.summary.chargesMinor, 0);
});

test('appointment transitions, availability rules and billing-once protect the calendar', async () => {
  const monday = futureWeekday(1);
  const closedDay = addDays(monday, 3);

  const service = await api('/settings/services', {
    method: 'POST',
    token: adminToken,
    body: { name: 'Phase 3 audit scan', priceMinor: 12_500, durationMinutes: 20 },
  });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  const serviceId = service.body.service.id as string;

  const closed = await api('/settings/exceptions', {
    method: 'POST',
    token: adminToken,
    body: { date: closedDay, isClosed: true, reason: 'Synthetic public holiday' },
  });
  assert.equal(closed.status, 201, JSON.stringify(closed.body));
  const rejected = await api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: { patientId, doctorId, serviceId, date: closedDay, startMinute: 600 },
  });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  const reopened = await api(`/settings/exceptions/${closed.body.exception.id}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(reopened.status, 204);

  const booked = await api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: {
      patientId,
      doctorId,
      serviceId,
      date: monday,
      startMinute: 600,
      durationMinutes: 20,
      notes: 'Phase 3 synthetic booking',
      payment: { status: 'DEPOSIT', amountMinor: 5_000, methodKey: 'CASH' },
    },
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const appointmentId = booked.body.appointment.id as string;
  assert.equal(booked.body.appointment.status, 'BOOKED');
  assert.equal(new Date(booked.body.appointment.startAt).getTime(), clinicLocalToUtc(monday, 600).getTime());
  assert.equal(booked.body.charge.amountMinor, 12_500);
  assert.equal(booked.body.payment.amountMinor, 5_000);

  const duplicateSlot = await api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: { patientId, doctorId, date: monday, startMinute: 605, durationMinutes: 15 },
  });
  assert.equal(duplicateSlot.status, 409, JSON.stringify(duplicateSlot.body));

  const agenda = await api(`/appointments/agenda?date=${monday}&doctorId=${doctorId}`, {
    token: adminToken,
  });
  assert.equal(agenda.status, 200);
  assert.equal(agenda.body.slots.find((slot: any) => slot.minute === 600).available, false);

  const invalidJump = await api(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token: adminToken,
    body: { status: 'DONE' },
  });
  assert.equal(invalidJump.status, 400, JSON.stringify(invalidJump.body));

  for (const status of ['CONFIRMED', 'ARRIVED', 'WAITING', 'IN_EXAM', 'REPORT_REVIEW']) {
    const transition = await api(`/appointments/${appointmentId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status },
    });
    assert.equal(transition.status, 200, `${status}: ${JSON.stringify(transition.body)}`);
  }
  const history = await prisma.appointmentStatusHistory.findMany({
    where: { appointmentId },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    history.map((row) => row.toStatus),
    ['BOOKED', 'CONFIRMED', 'ARRIVED', 'WAITING', 'IN_EXAM', 'REPORT_REVIEW'],
  );

  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: {
      patientId,
      appointmentId,
      chiefComplaint: 'Synthetic phase 3 indication',
      examinationType: 'Synthetic ultrasound',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  assert.equal(visit.body.visit.status, 'DRAFT');
  const visitId = visit.body.visit.id as string;

  const duplicateVisit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: { patientId, appointmentId },
  });
  assert.equal(duplicateVisit.status, 400, JSON.stringify(duplicateVisit.body));

  const measurement = await api(`/visits/${visitId}/measurements`, {
    method: 'POST',
    token: doctorToken,
    body: { label: 'CRL', value: '63', unit: 'mm' },
  });
  assert.equal(measurement.status, 201, JSON.stringify(measurement.body));

  const report = await api('/reports', {
    method: 'POST',
    token: doctorToken,
    body: {
      visitId,
      templateId: null,
      content: { findings: 'Synthetic draft finding', impression: 'Synthetic draft impression' },
    },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const reportId = report.body.report.id as string;
  assert.equal(report.body.report.status, 'DRAFT');
  assert.equal((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).status, 'IN_REVIEW');

  const edited = await api(`/reports/${reportId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { content: { findings: 'Synthetic finalized finding', impression: 'Synthetic impression' } },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.report.status, 'FINALIZED');
  assert.equal((await prisma.visit.findUniqueOrThrow({ where: { id: visitId } })).status, 'COMPLETED');

  const done = await api(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token: adminToken,
    body: { status: 'DONE' },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const lockedVisit = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { chiefComplaint: 'Attempted edit after completion' },
  });
  assert.equal(lockedVisit.status, 403);
  const lockedMeasurement = await api(`/visits/${visitId}/measurements`, {
    method: 'POST',
    token: doctorToken,
    body: { label: 'Illegal', value: '1' },
  });
  assert.equal(lockedMeasurement.status, 403);
  const lockedReport = await api(`/reports/${reportId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { content: { findings: 'Attempted overwrite' } },
  });
  assert.equal(lockedReport.status, 403);
  const lockedDelete = await api(`/reports/${reportId}`, {
    method: 'DELETE',
    token: doctorToken,
  });
  assert.equal(lockedDelete.status, 403);
  const secondFinalize = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(secondFinalize.status, 409);

  const chargeCount = await prisma.charge.count({ where: { appointmentId } });
  const paymentCount = await prisma.payment.count({
    where: { idempotencyKey: `booking:${appointmentId}` },
  });
  assert.equal(chargeCount, 1, 'appointment must be billed exactly once');
  assert.equal(paymentCount, 1);

  const amended = await api(`/reports/${reportId}/amend`, {
    method: 'POST',
    token: doctorToken,
    body: {
      content: { findings: 'Synthetic corrected finding', impression: 'Synthetic impression' },
      reason: 'Phase 3 correction audit',
    },
  });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  assert.equal(amended.body.report.versionNumber, 2);
  const versions = await prisma.reportVersion.findMany({
    where: { reportId },
    orderBy: { versionNumber: 'asc' },
  });
  assert.deepEqual(
    versions.map((version) => version.versionNumber),
    [1, 2],
  );
  assert.deepEqual((versions[0].content as any).findings, 'Synthetic finalized finding');
  assert.deepEqual((versions[1].content as any).findings, 'Synthetic corrected finding');
  assert.equal(versions[1].reason, 'Phase 3 correction audit');

  const printData = await api(`/reports/${reportId}/print-data`, { token: doctorToken });
  assert.equal(printData.status, 200);
  const storedPatient = await api(`/patients/${patientId}`, { token: adminToken });
  assert.equal(storedPatient.status, 200);
  assert.equal(printData.body.patient.patientNumber, storedPatient.body.patient.patientNumber);
  assert.equal(printData.body.examination.doctor, 'Clinical Doctor');
  assert.equal(printData.body.examination.measurements.length, 1);
  assert.equal(printData.body.report.versionNumber, 2);
  assert.equal((printData.body.report.content as any).findings, 'Synthetic corrected finding');

  const audits = await prisma.auditLog.findMany({
    where: { entityId: { in: [visitId, reportId, appointmentId] } },
  });
  for (const action of ['visit.created', 'report.created', 'report.finalized', 'report.amended']) {
    assert.ok(audits.some((audit) => audit.action === action), `missing ${action} audit entry`);
  }
});

test('block templates validate field shapes, render one safe HTML pipeline and US Letter PDFs', async () => {
  const parsed = templateDefinitionSchema.safeParse(blockDefinition);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues.slice(0, 3)));
  const definition = parsed.data as TemplateDefinition;
  const validation = validateDefinition(definition);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const content = buildInitialContent(validation.fields);
  assert.equal(typeof content.firstTwin, 'string');
  assert.equal(typeof content.secondTwin, 'string');
  assert.ok(Array.isArray(content.comments));
  assert.ok(content.comments.every((item: unknown) => typeof item === 'string'));

  const invalid = await api('/reports/templates/validate', {
    method: 'POST',
    token: adminToken,
    body: {
      definition: {
        schemaVersion: 1,
        blocks: [
          { type: 'text', template: '{{twin}}' },
          { type: 'text', template: '{{twin}}' },
        ],
      },
    },
  });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
  assert.equal(invalid.body.ok, false);
  assert.ok(invalid.body.errors.some((message: string) => /already used|appears twice/.test(message)));

  const preview = await api('/reports/templates/preview', {
    method: 'POST',
    token: adminToken,
    body: { definition: blockDefinition },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 500));
  assert.ok(preview.body.html.includes('@page{size:Letter'));
  assert.ok(!/<script/i.test(preview.body.html));
  assert.ok(!/allow-scripts/.test(preview.body.html));
  assert.ok(preview.body.html.includes('First twin'));
  assert.ok(preview.body.html.includes('Second twin'));

  const template = await api('/reports/templates', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Phase 3 block audit template',
      description: 'Synthetic twin-field block definition',
      layout: { printLayout: 'blocks', definition: blockDefinition },
      isActive: true,
    },
  });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  const templateId = template.body.template.id as string;

  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: { patientId, chiefComplaint: 'Synthetic block audit', examinationType: 'Synthetic scan' },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));
  const report = await api('/reports', {
    method: 'POST',
    token: doctorToken,
    body: {
      visitId: visit.body.visit.id,
      templateId,
      content: { firstTwin: 'Client value must be ignored', comments: ['malicious'] },
    },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const reportId = report.body.report.id as string;
  assert.equal(report.body.report.templateVersion, template.body.template.updatedAt);
  assert.deepEqual((report.body.report.currentContent as any).firstTwin, 'Synthetic first twin.');
  assert.deepEqual((report.body.report.currentContent as any).comments, [
    'Synthetic first comment',
    'Synthetic second comment',
  ]);

  const injected = await api(`/reports/${reportId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: {
      content: {
        firstTwin: '<script>alert(1)</script><img src=x onerror=alert(2)>',
        secondTwin: 'Synthetic second twin.',
        comments: ['<b>synthetic</b>'],
      },
    },
  });
  assert.equal(injected.status, 200, JSON.stringify(injected.body));

  const printHtml = await api(`/reports/${reportId}/document?mode=print`, { token: doctorToken });
  assert.equal(printHtml.status, 200);
  assert.match(printHtml.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(printHtml.headers.get('cache-control'), 'no-store');
  assert.ok(printHtml.body.includes('@page{size:Letter'));
  assert.ok(!/<script/i.test(printHtml.body));
  assert.ok(!printHtml.body.includes('<img src=x'));
  assert.ok(printHtml.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/contenteditable/.test(printHtml.body.replace(/<style>[\s\S]*?<\/style>/, '')));

  const editHtml = await api(`/reports/${reportId}/document?mode=edit`, { token: doctorToken });
  assert.equal(editHtml.status, 200);
  assert.ok(/contenteditable/.test(editHtml.body));
  assert.ok(editHtml.body.includes('data-key="firstTwin"'));

  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));

  const printData = await api(`/reports/${reportId}/print-data`, { token: doctorToken });
  assert.equal(printData.status, 200);
  const input = {
    clinic: {
      name: printData.body.clinic.name,
      phone: printData.body.clinic.phone,
      email: printData.body.clinic.email,
      address: printData.body.clinic.address,
      timezone: printData.body.clinic.timezone,
    },
    report: {
      id: printData.body.report.id,
      status: printData.body.report.status,
      versionNumber: printData.body.report.versionNumber,
      finalizedAt: new Date(printData.body.report.finalizedAt),
      lastAmendedAt: null,
      content: printData.body.report.content,
      templateName: printData.body.report.templateName,
      templateVersion: printData.body.report.templateVersion,
      templateFields: printData.body.report.templateFields ?? [],
      templateLayout: printData.body.report.templateLayout,
    },
    patient: {
      ...printData.body.patient,
      dateOfBirth: printData.body.patient.dateOfBirth
        ? new Date(printData.body.patient.dateOfBirth)
        : null,
    },
    examination: {
      visitDate: new Date(printData.body.examination.visitDate),
      doctor: printData.body.examination.doctor,
      examinationType: printData.body.examination.examinationType,
      chiefComplaint: printData.body.examination.chiefComplaint,
    },
    measurements: printData.body.examination.measurements.map((measurement: any) => ({
      label: measurement.label,
      value: measurement.value,
      unit: measurement.unit,
      measuredAt: new Date(measurement.measuredAt),
    })),
  };

  const pdf = await renderReportPdf(input as any);
  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(pdf.length > 1_000, `PDF too small: ${pdf.length} bytes`);
  assert.match(pdf.toString('latin1'), /\/MediaBox\s*\[\s*0\s+0\s+612\s+792\s*\]/, 'PDF must use US Letter');
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length, 1);

  const longReport = await renderReportPdf({
    ...input,
    report: {
      ...input.report,
      content: {
        ...input.report.content,
        firstTwin: 'Long synthetic finding that must wrap across lines. '.repeat(300),
      },
    },
  } as any);
  assert.equal(longReport.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(
    (longReport.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 2,
    'a long report must paginate instead of clipping content',
  );
});
