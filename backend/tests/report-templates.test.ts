import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Integration tests for configurable report templates, the default template
 * and per-report template pinning.
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

function templatePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Obstetric ultrasound',
    description: 'Routine obstetric scan',
    fields: [
      { key: 'findings', label: 'Findings', type: 'textarea', required: true },
      { key: 'impression', label: 'Impression', type: 'textarea' },
    ],
    layout: {
      headerNote: 'Clinic copy',
      footerNote: 'Not valid without a signature',
      showMeasurements: true,
      showSignature: true,
    },
    isDefault: false,
    ...overrides,
  };
}

async function createVisit(): Promise<string> {
  const created = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: {
      patientId,
      chiefComplaint: 'Routine follow-up',
      examinationType: 'Obstetric ultrasound',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.visit.id;
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
        firstName: 'Template',
        lastName: 'Admin',
        email: 'templates.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Template Test Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Template',
      lastName: 'Doctor',
      email: 'templates.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'templates.doctor@clinic.test', password: 'Str0ng!Passw0rd' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  doctorToken = login.body.accessToken;

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Synthetic',
      lastName: 'Patient',
      phone: '01000000002',
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
  await prisma.$disconnect();
});

test('report templates are configurable and pinned per report', async (t) => {
  let templateId = '';
  let reportWithTemplate = '';
  let firstVersion = '';

  await t.test('an administrator can create a template', async () => {
    const created = await api('/reports/templates', {
      method: 'POST',
      token: adminToken,
      body: templatePayload(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.template.name, 'Obstetric ultrasound');
    assert.equal(created.body.template.isDefault, false);
    assert.deepEqual(
      created.body.template.fields.map((field: any) => field.key),
      ['findings', 'impression'],
    );
    templateId = created.body.template.id;
  });

  await t.test('invalid field definitions are rejected', async () => {
    const duplicate = await api('/reports/templates', {
      method: 'POST',
      token: adminToken,
      body: templatePayload({
        name: 'Duplicate keys',
        fields: [
          { key: 'same', label: 'One', type: 'text' },
          { key: 'same', label: 'Two', type: 'text' },
        ],
      }),
    });
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body));

    const invalidKey = await api('/reports/templates', {
      method: 'POST',
      token: adminToken,
      body: templatePayload({
        name: 'Bad key',
        fields: [{ key: '1st field', label: 'Bad', type: 'text' }],
      }),
    });
    assert.equal(invalidKey.status, 400, JSON.stringify(invalidKey.body));
  });

  await t.test('non-administrators cannot manage templates', async () => {
    const create = await api('/reports/templates', {
      method: 'POST',
      token: doctorToken,
      body: templatePayload({ name: 'Doctor template' }),
    });
    assert.equal(create.status, 403, JSON.stringify(create.body));

    const patch = await api(`/reports/templates/${templateId}`, {
      method: 'PATCH',
      token: doctorToken,
      body: { name: 'Renamed by doctor' },
    });
    assert.equal(patch.status, 403, JSON.stringify(patch.body));

    const remove = await api(`/reports/templates/${templateId}`, {
      method: 'DELETE',
      token: doctorToken,
    });
    assert.equal(remove.status, 403, JSON.stringify(remove.body));

    // Doctors can still read the active templates they need for new reports.
    const list = await api('/reports/templates', { token: doctorToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.templates.some((template: any) => template.id === templateId));
  });

  await t.test('a report snapshots the template it was created with', async () => {
    const visitId = await createVisit();
    const created = await api('/reports', {
      method: 'POST',
      token: doctorToken,
      body: {
        visitId,
        templateId,
        content: { findings: 'Single live fetus', impression: 'Normal scan' },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    reportWithTemplate = created.body.report.id;
    firstVersion = created.body.report.templateVersion;
    assert.ok(firstVersion, 'templateVersion must be recorded');
    assert.equal(created.body.report.templateSnapshot.name, 'Obstetric ultrasound');

    const print = await api(`/reports/${reportWithTemplate}/print-data`, { token: doctorToken });
    assert.equal(print.status, 200, JSON.stringify(print.body));
    assert.deepEqual(
      print.body.report.templateFields.map((field: any) => field.label),
      ['Findings', 'Impression'],
    );
    assert.equal(print.body.report.templateName, 'Obstetric ultrasound');
    assert.equal(print.body.report.templateVersion, firstVersion);
    assert.equal(print.body.report.templateLayout.footerNote, 'Not valid without a signature');
  });

  await t.test('editing a template leaves existing reports unchanged', async () => {
    const updated = await api(`/reports/templates/${templateId}`, {
      method: 'PATCH',
      token: adminToken,
      body: {
        fields: [
          { key: 'impression', label: 'Renamed impression', type: 'textarea' },
          { key: 'findings', label: 'Findings', type: 'textarea' },
        ],
        layout: { footerNote: 'New footer', showSignature: false },
      },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.notEqual(updated.body.template.updatedAt, undefined);

    const oldPrint = await api(`/reports/${reportWithTemplate}/print-data`, {
      token: doctorToken,
    });
    assert.equal(oldPrint.status, 200);
    assert.deepEqual(
      oldPrint.body.report.templateFields.map((field: any) => field.label),
      ['Findings', 'Impression'],
      'historical report must keep its pinned section order',
    );
    assert.equal(oldPrint.body.report.templateLayout.footerNote, 'Not valid without a signature');

    const visitId = await createVisit();
    const newReport = await api('/reports', {
      method: 'POST',
      token: doctorToken,
      body: { visitId, templateId, content: { impression: 'New wording' } },
    });
    assert.equal(newReport.status, 201, JSON.stringify(newReport.body));
    const newPrint = await api(`/reports/${newReport.body.report.id}/print-data`, {
      token: doctorToken,
    });
    assert.deepEqual(
      newPrint.body.report.templateFields.map((field: any) => field.label),
      ['Renamed impression', 'Findings'],
    );
    assert.notEqual(newPrint.body.report.templateVersion, firstVersion);
  });

  await t.test('only one template can be the default', async () => {
    const second = await api('/reports/templates', {
      method: 'POST',
      token: adminToken,
      body: templatePayload({ name: 'Pelvic ultrasound', isDefault: true }),
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const list = await api('/reports/templates', { token: adminToken });
    const defaults = list.body.templates.filter((template: any) => template.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].name, 'Pelvic ultrasound');

    // Omitting templateId on a new report applies the clinic default.
    const visitId = await createVisit();
    const created = await api('/reports', {
      method: 'POST',
      token: doctorToken,
      body: { visitId, content: { findings: 'Default template used' } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.report.templateId, second.body.template.id);
    assert.equal(created.body.report.templateSnapshot.name, 'Pelvic ultrasound');
  });

  await t.test('an explicit null template keeps the standard fields', async () => {
    const visitId = await createVisit();
    const created = await api('/reports', {
      method: 'POST',
      token: doctorToken,
      body: { visitId, templateId: null, content: { findings: 'Standard fields' } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.report.templateId, null);
    assert.equal(created.body.report.templateSnapshot, null);
  });

  await t.test('archiving hides a template but keeps historical reports printable', async () => {
    const archived = await api(`/reports/templates/${templateId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(archived.status, 204, JSON.stringify(archived.body));

    const doctorList = await api('/reports/templates', { token: doctorToken });
    assert.equal(doctorList.status, 200);
    assert.ok(!doctorList.body.templates.some((template: any) => template.id === templateId));

    const adminList = await api('/reports/templates', { token: adminToken });
    const stored = adminList.body.templates.find((template: any) => template.id === templateId);
    assert.equal(stored.isActive, false);
    assert.equal(stored.isDefault, false);

    const print = await api(`/reports/${reportWithTemplate}/print-data`, { token: doctorToken });
    assert.equal(print.status, 200, JSON.stringify(print.body));
    assert.equal(print.body.report.templateName, 'Obstetric ultrasound');
    assert.deepEqual(
      print.body.report.templateFields.map((field: any) => field.key),
      ['findings', 'impression'],
    );
  });

  await t.test('creating a report with an archived template is rejected', async () => {
    const visitId = await createVisit();
    const created = await api('/reports', {
      method: 'POST',
      token: doctorToken,
      body: { visitId, templateId, content: { findings: 'Should fail' } },
    });
    assert.equal(created.status, 400, JSON.stringify(created.body));
  });
});
