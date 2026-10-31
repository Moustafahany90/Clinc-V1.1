import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { ensureStorage } from '../src/modules/files/routes.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Phase 5 release-hardening integration tests:
 *  - server-side mustChangePassword gate
 *  - access-token invalidation through User.tokenVersion
 *  - privileged schedule / visit overrides
 *  - finalized-record immutability and amendment versioning
 *  - database-aware health endpoint
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
let rootUrl = '';
let baseUrl = '';
let adminToken = '';
let doctorToken = '';
let receptionToken = '';
let doctorId = '';
let doctorPermissions: string[] = [];
let patientId = '';

interface ApiResult {
  status: number;
  body: any;
  setCookie: string[];
}

async function api(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    cookie?: string;
    root?: boolean;
  } = {},
): Promise<ApiResult> {
  const response = await fetch(`${options.root ? rootUrl : baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.getSetCookie(),
  };
}

async function login(email: string, password: string) {
  const result = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const cookie = result.setCookie.find((value) => value.startsWith('uc_refresh='));
  assert.ok(cookie, 'refresh cookie missing');
  return { token: result.body.accessToken as string, cookie: cookie.split(';')[0] };
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

function hoursPayload() {
  return Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    isOpen: ![4, 5].includes(index + 1),
    openMinute: 780,
    closeMinute: 1260,
    breakStartMinute: null,
    breakEndMinute: null,
  }));
}

async function createVisit(token: string): Promise<string> {
  const created = await api('/visits', {
    method: 'POST',
    token,
    body: {
      patientId,
      chiefComplaint: 'Synthetic test complaint',
      examinationType: 'Test ultrasound',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.visit.id;
}

async function createDraftReport(token: string, visitId: string): Promise<string> {
  const created = await api('/reports', {
    method: 'POST',
    token,
    body: { visitId, content: { findings: 'Synthetic finding' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.report.id;
}

before(async () => {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length > 0) {
    const list = tables.map((row) => `"${row.tablename.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  }

  await ensureStorage();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  rootUrl = `http://127.0.0.1:${port}`;
  baseUrl = `${rootUrl}/api/v1`;

  const setup = await api('/setup', {
    method: 'POST',
    body: {
      admin: {
        firstName: 'Security',
        lastName: 'Admin',
        email: 'security.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Security Test Clinic',
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
      firstName: 'Security',
      lastName: 'Doctor',
      email: 'security.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorId = doctor.body.user.id;
  doctorPermissions = doctor.body.user.permissions;
  doctorToken = (await login('security.doctor@clinic.test', 'Str0ng!Passw0rd')).token;

  const reception = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Security',
      lastName: 'Reception',
      email: 'security.reception@clinic.test',
      role: 'RECEPTIONIST',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(reception.status, 201, JSON.stringify(reception.body));
  receptionToken = (await login('security.reception@clinic.test', 'Str0ng!Passw0rd')).token;

  const temp = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Security',
      lastName: 'Temp',
      email: 'security.temp@clinic.test',
      role: 'RECEPTIONIST',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(temp.status, 201, JSON.stringify(temp.body));
  await prisma.user.update({
    where: { id: temp.body.user.id },
    data: { mustChangePassword: true },
  });

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Synthetic',
      lastName: 'Security Patient',
      phone: '01000000003',
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

test('health is database-aware and reports audit write failures', async () => {
  const health = await api('/healthz', { root: true });
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.database, 'reachable');
  assert.equal(typeof health.body.audit.writeFailures, 'number');
});

test('mustChangePassword is enforced by the API, not only the SPA', async () => {
  const temp = await login('security.temp@clinic.test', 'Str0ng!Passw0rd');
  assert.equal(temp.token.length > 20, true);

  const blocked = await api('/patients', { token: temp.token });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

  const me = await api('/auth/me', { token: temp.token });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.mustChangePassword, true);

  const refreshed = await api('/auth/refresh', {
    method: 'POST',
    cookie: temp.cookie,
    body: {},
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.user.mustChangePassword, true);

  const changed = await api('/auth/change-password', {
    method: 'POST',
    token: temp.token,
    body: {
      currentPassword: 'Str0ng!Passw0rd',
      newPassword: 'N3w!SecurityPassw0rd',
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const newToken = changed.body.accessToken as string;

  const oldTokenAfterChange = await api('/patients', { token: temp.token });
  assert.equal(oldTokenAfterChange.status, 401, JSON.stringify(oldTokenAfterChange.body));

  const newTokenWorks = await api('/patients', { token: newToken });
  assert.equal(newTokenWorks.status, 200, JSON.stringify(newTokenWorks.body));

  const relogin = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'security.temp@clinic.test',
      password: 'N3w!SecurityPassw0rd',
    },
  });
  assert.equal(relogin.status, 200, JSON.stringify(relogin.body));
  assert.equal(relogin.body.user.mustChangePassword, false);
});

test('schedule overrides require an explicit permission and are audited', async () => {
  const monday = futureWeekday(1);
  const payload = {
    patientId,
    doctorId,
    date: monday,
    startMinute: 765,
    durationMinutes: 15,
  };

  const receptionistAttempt = await api('/appointments', {
    method: 'POST',
    token: receptionToken,
    body: { ...payload, overrideReason: 'Receptionist should not be able to do this' },
  });
  assert.equal(receptionistAttempt.status, 403, JSON.stringify(receptionistAttempt.body));

  const missingReason = await api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: payload,
  });
  assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));
  assert.equal(missingReason.body.error.details.requiresOverride, true);

  const approved = await api('/appointments', {
    method: 'POST',
    token: adminToken,
    body: { ...payload, overrideReason: 'Patient arrived before opening' },
  });
  assert.equal(approved.status, 201, JSON.stringify(approved.body));
  assert.equal(approved.body.appointment.isManualOverride, true);
  assert.equal(approved.body.appointment.overrideReason, 'Patient arrived before opening');

  const audit = await prisma.auditLog.findFirst({
    where: {
      action: 'appointment.created',
      entityId: approved.body.appointment.id,
    },
  });
  assert.ok(audit);
  assert.equal((audit?.metadata as any)?.manualOverride, true);
  assert.equal((audit?.metadata as any)?.overrideReason, 'Patient arrived before opening');
});

test('appointment completion override requires the override permission and a reason', async () => {
  const monday = futureWeekday(1);
  const created = await api('/appointments', {
    method: 'POST',
    token: receptionToken,
    body: {
      patientId,
      doctorId,
      date: monday,
      startMinute: 900,
      durationMinutes: 15,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const appointmentId = created.body.appointment.id;

  for (const status of ['CONFIRMED', 'ARRIVED', 'WAITING', 'IN_EXAM', 'REPORT_REVIEW']) {
    const moved = await api(`/appointments/${appointmentId}/status`, {
      method: 'POST',
      token: adminToken,
      body: { status },
    });
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.body)}`);
  }

  const denied = await api(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token: receptionToken,
    body: { status: 'DONE', overrideReason: 'Receptionist tries to bypass clinical completion' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const missingReason = await api(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token: adminToken,
    body: { status: 'DONE' },
  });
  assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));
  assert.equal(missingReason.body.error.details.requiresOverride, true);

  const completed = await api(`/appointments/${appointmentId}/status`, {
    method: 'POST',
    token: adminToken,
    body: {
      status: 'DONE',
      overrideReason: 'Patient records completed manually at the front desk',
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.appointment.status, 'DONE');
});

test('visit completion cannot bypass finalization without the override permission', async () => {
  const visitId = await createVisit(doctorToken);

  const denied = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { status: 'COMPLETED' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const grant = await api(`/users/${doctorId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { permissions: [...doctorPermissions, 'VISITS_OVERRIDE'] },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.ok(grant.body.user.permissions.includes('VISITS_OVERRIDE'));

  const missingReason = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { status: 'COMPLETED' },
  });
  assert.equal(missingReason.status, 400, JSON.stringify(missingReason.body));
  assert.equal(missingReason.body.error.details.requiresOverride, true);

  const completed = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: {
      status: 'COMPLETED',
      overrideReason: 'Report dictated after the patient left',
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.visit.status, 'COMPLETED');

  const measurement = await api(`/visits/${visitId}/measurements`, {
    method: 'POST',
    token: doctorToken,
    body: { label: 'CRL', value: '12', unit: 'mm' },
  });
  assert.equal(measurement.status, 403, JSON.stringify(measurement.body));

  const metadataEdit = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { chiefComplaint: 'Changed after completion' },
  });
  assert.equal(metadataEdit.status, 403, JSON.stringify(metadataEdit.body));
});

test('finalized reports and their attachments are immutable; amendments add a version', async () => {
  const visitId = await createVisit(doctorToken);
  const reportId = await createDraftReport(doctorToken, visitId);

  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.report.status, 'FINALIZED');

  const finalizeAgain = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalizeAgain.status, 409, JSON.stringify(finalizeAgain.body));

  const edit = await api(`/reports/${reportId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { content: { findings: 'Attempted overwrite' } },
  });
  assert.equal(edit.status, 403, JSON.stringify(edit.body));

  const measurement = await api(`/visits/${visitId}/measurements`, {
    method: 'POST',
    token: doctorToken,
    body: { label: 'CRL', value: '13', unit: 'mm' },
  });
  assert.equal(measurement.status, 403, JSON.stringify(measurement.body));

  const visitEdit = await api(`/visits/${visitId}`, {
    method: 'PATCH',
    token: doctorToken,
    body: { chiefComplaint: 'Attempted overwrite' },
  });
  assert.equal(visitEdit.status, 403, JSON.stringify(visitEdit.body));

  const form = new FormData();
  form.append('reportId', reportId);
  form.append(
    'file',
    new Blob([Buffer.from('%PDF-1.4\nsynthetic test file\n%%EOF\n')], {
      type: 'application/pdf',
    }),
    'synthetic.pdf',
  );
  const upload = await fetch(`${baseUrl}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${doctorToken}` },
    body: form,
  });
  assert.equal(upload.status, 403, await upload.text());

  const amended = await api(`/reports/${reportId}/amend`, {
    method: 'POST',
    token: doctorToken,
    body: {
      content: { findings: 'Corrected finding' },
      reason: 'Corrected a transcription error',
    },
  });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  assert.equal(amended.body.report.versionNumber, 2);

  const versions = await api(`/reports/${reportId}/versions`, { token: doctorToken });
  assert.equal(versions.status, 200, JSON.stringify(versions.body));
  assert.equal(versions.body.versions.length, 2);
  assert.equal(versions.body.versions.find((v: any) => v.versionNumber === 1).isFinal, true);

  const secondAmend = await api(`/reports/${reportId}/amend`, {
    method: 'POST',
    token: doctorToken,
    body: {
      content: { findings: 'Second correction' },
      reason: 'Second correction with audit trail',
    },
  });
  assert.equal(secondAmend.status, 200, JSON.stringify(secondAmend.body));
  assert.equal(secondAmend.body.report.versionNumber, 3);
});

test('logout blacklists the access token and revokes the refresh session', async () => {
  const session = await login('security.reception@clinic.test', 'Str0ng!Passw0rd');

  const logout = await api('/auth/logout', {
    method: 'POST',
    token: session.token,
    cookie: session.cookie,
  });
  assert.equal(logout.status, 204, JSON.stringify(logout.body));

  const oldAccess = await api('/patients', { token: session.token });
  assert.equal(oldAccess.status, 401, JSON.stringify(oldAccess.body));

  const refresh = await api('/auth/refresh', {
    method: 'POST',
    cookie: session.cookie,
    body: {},
  });
  assert.equal(refresh.status, 401, JSON.stringify(refresh.body));
});

test('concurrent amendments allow exactly one version and reject the lost race', async () => {
  const visitId = await createVisit(doctorToken);
  const reportId = await createDraftReport(doctorToken, visitId);
  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));

  const amend = (finding: string, reason: string) =>
    api(`/reports/${reportId}/amend`, {
      method: 'POST',
      token: doctorToken,
      body: { content: { findings: finding }, reason },
    });

  const results = await Promise.all([
    amend('Concurrent correction A', 'Concurrent amendment A'),
    amend('Concurrent correction B', 'Concurrent amendment B'),
  ]);
  const statuses = results.map((result) => result.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((r) => r.body)));

  const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
  assert.equal(report.versionNumber, 2);
  const versions = await prisma.reportVersion.count({ where: { reportId } });
  assert.equal(versions, 2);
});

test('archiving and restoring an account invalidates old access tokens', async () => {
  const created = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Security',
      lastName: 'Removable',
      email: 'security.removable@clinic.test',
      role: 'RECEPTIONIST',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.user.id;
  const session = await login('security.removable@clinic.test', 'Str0ng!Passw0rd');

  const removed = await api(`/users/${id}`, { method: 'DELETE', token: adminToken });
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  const whileInactive = await api('/patients', { token: session.token });
  assert.equal(whileInactive.status, 401, JSON.stringify(whileInactive.body));

  const restored = await api(`/users/${id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { isActive: true },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));

  const afterRestore = await api('/patients', { token: session.token });
  assert.equal(afterRestore.status, 401, JSON.stringify(afterRestore.body));

  const fresh = await login('security.removable@clinic.test', 'Str0ng!Passw0rd');
  const freshWorks = await api('/patients', { token: fresh.token });
  assert.equal(freshWorks.status, 200, JSON.stringify(freshWorks.body));
});
