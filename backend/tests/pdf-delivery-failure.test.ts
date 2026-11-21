import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Phase 9.1 delivery-failure regression: a PDF render timeout must leave the
 * WhatsApp delivery row FAILED, never PENDING. An oversized synthetic report
 * forces the timeout; no real WhatsApp request is made because rendering fails
 * first. Destructive: refuses to run unless the database name ends in `_test`.
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
  throw new Error('This test requires a *_test database.');
}

process.env.EVOLUTION_API_ENABLED = 'true';
process.env.EVOLUTION_API_URL = 'http://evolution-mock.test:8080';
process.env.EVOLUTION_API_KEY = 'test-only-evolution-api-key';
process.env.EVOLUTION_INSTANCE_NAME = 'test_clinic';
// A deliberately large synthetic report exceeds this timeout, proving that a
// render timeout follows the existing failed-delivery path.
process.env.PDF_RENDER_TIMEOUT_MS = '1';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');

let server: Server;
let baseUrl = '';
let token = '';
let doctorToken = '';
let templateId = '';
let reportId = '';

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
        firstName: 'P91',
        lastName: 'Admin',
        email: 'p91.pdf.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'P91 Synthetic Clinic',
        phone: '+20 100 000 0000',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
      workingHours: Array.from({ length: 7 }, (_, index) => ({
        dayOfWeek: index + 1,
        isOpen: true,
        openMinute: 540,
        closeMinute: 1260,
        breakStartMinute: null,
        breakEndMinute: null,
      })),
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  token = setup.body.accessToken;

  const doctor = await api('/users', {
    method: 'POST',
    token,
    body: {
      firstName: 'P91',
      lastName: 'Doctor',
      email: 'p91.pdf.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'p91.pdf.doctor@clinic.test', password: 'Str0ng!Passw0rd' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  doctorToken = login.body.accessToken;

  // Only gyn4d/block templates use the Chromium HTML renderer; the default
  // PDFKit path is intentionally unaffected by these controls.
  const template = await api('/reports/templates', {
    method: 'POST',
    token,
    body: {
      name: 'P91 synthetic gyn4d template',
      fields: [{ key: 'findings', label: 'Findings', type: 'textarea' }],
      layout: {
        printLayout: 'gyn4d',
        showMeasurements: false,
        showSignature: false,
        gyn4d: {
          pageTitle: 'P91 synthetic scan',
          scanTitle: 'P91 synthetic gyn4d',
          headerText: 'Synthetic clinic',
          doctorName: 'Dr P91',
          doctorRole: 'Consultant',
          doctorUniversity: 'Synthetic University',
          phone: 'Tel : 100',
          address: '1 Synthetic Street',
        },
      },
    },
  });
  assert.equal(template.status, 201, JSON.stringify(template.body));
  templateId = template.body.template.id;

  const patient = await api('/patients', {
    method: 'POST',
    token,
    body: {
      firstName: 'Synthetic',
      lastName: 'PDF Failure',
      phone: '01012345678',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));

  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: {
      patientId: patient.body.patient.id,
      chiefComplaint: 'Synthetic PDF failure indication',
      examinationType: 'Synthetic ultrasound',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));

  const report = await api('/reports', {
    method: 'POST',
    token: doctorToken,
    body: {
      visitId: visit.body.visit.id,
      templateId,
      content: { findings: 'Synthetic finding.', impression: 'Synthetic impression.' },
    },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  reportId = report.body.report.id;
  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeHtmlPdfBrowser } = await import('../src/lib/htmlPdf.js');
  await closeHtmlPdfBrowser();
  await prisma.$disconnect();
});

test('renderer failure marks the WhatsApp delivery FAILED, never PENDING', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://evolution-mock.test:8080/')) {
      return new Response(
        JSON.stringify({ key: { id: 'p91-should-not-be-sent' }, status: 'PENDING' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  let failed: Awaited<ReturnType<typeof api>>;
  try {
    failed = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.error.code, 'DELIVERY_PREPARATION_FAILED');

  const delivery = await prisma.reportDelivery.findUniqueOrThrow({
    where: {
      reportId_versionNumber_channel: {
        reportId,
        versionNumber: 1,
        channel: 'WHATSAPP',
      },
    },
  });
  assert.equal(delivery.status, 'FAILED');
  assert.equal(delivery.errorCode, 'DELIVERY_PREPARATION_FAILED');
  assert.equal(delivery.sentAt, null);
});
