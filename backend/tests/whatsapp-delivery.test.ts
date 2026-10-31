import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Evolution API (WHATSAPP-BAILEYS) Integration & Delivery Tests:
 *  - finalized-only WhatsApp delivery with explicit consent acknowledgement
 *  - doctor isolation and the dedicated REPORTS_SEND capability
 *  - server-side PDF generation and Evolution API sendMedia request shape
 *  - Evolution API connection status and QR code generation
 *  - duplicate/resend handling and sanitised failure persistence
 *  - missing configuration, timeout, and authentication error handling
 *
 * Evolution API is mocked in-process; no real messages are sent.
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

process.env.EVOLUTION_API_ENABLED = 'true';
process.env.EVOLUTION_API_URL = 'http://evolution-mock.test:8080';
process.env.EVOLUTION_API_KEY = 'test-only-evolution-api-key';
process.env.EVOLUTION_INSTANCE_NAME = 'test_clinic';
process.env.EVOLUTION_API_TIMEOUT_MS = '5000';
process.env.EVOLUTION_DEFAULT_COUNTRY_CODE = '20';

const { createApp } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/lib/prisma.js');
const { renderReportPdf } = await import('../src/lib/reportPdf.js');
const {
  sendWhatsAppDocument,
  toWhatsAppRecipient,
  getEvolutionStatus,
  getEvolutionQrCode,
  disconnectEvolution,
  whatsappConfigured,
  WhatsAppError,
} = await import('../src/lib/whatsapp.js');

let server: Server;
let baseUrl = '';
let adminToken = '';
let doctorToken = '';
let doctor2Token = '';
let receptionToken = '';
let patientId = '';
let reportId = '';
let draftReportId = '';

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

async function login(email: string, password: string): Promise<string> {
  const result = await api('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.accessToken as string;
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

async function createReport(token: string, patient: string): Promise<string> {
  const visit = await api('/visits', {
    method: 'POST',
    token,
    body: {
      patientId: patient,
      chiefComplaint: 'Synthetic WhatsApp test indication',
      examinationType: 'Synthetic ultrasound',
    },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));

  const report = await api('/reports', {
    method: 'POST',
    token,
    body: {
      visitId: visit.body.visit.id,
      content: {
        findings: 'Synthetic finding for PDF delivery.',
        impression: 'Synthetic impression.',
      },
    },
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  return report.body.report.id as string;
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
        firstName: 'WhatsApp',
        lastName: 'Admin',
        email: 'whatsapp.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'WhatsApp Test Clinic',
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

  for (const [firstName, email, role] of [
    ['WhatsApp', 'whatsapp.doctor@clinic.test', 'DOCTOR'],
    ['Other', 'whatsapp.other@clinic.test', 'DOCTOR'],
    ['WhatsApp', 'whatsapp.reception@clinic.test', 'RECEPTIONIST'],
  ] as const) {
    const user = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName,
        lastName: 'User',
        email,
        role,
        password: 'Str0ng!Passw0rd',
        sendInvite: false,
      },
    });
    assert.equal(user.status, 201, JSON.stringify(user.body));
  }

  doctorToken = await login('whatsapp.doctor@clinic.test', 'Str0ng!Passw0rd');
  doctor2Token = await login('whatsapp.other@clinic.test', 'Str0ng!Passw0rd');
  receptionToken = await login('whatsapp.reception@clinic.test', 'Str0ng!Passw0rd');

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Synthetic',
      lastName: 'WhatsApp Patient',
      phone: '01012345678',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  patientId = patient.body.patient.id;

  reportId = await createReport(doctorToken, patientId);
  const finalized = await api(`/reports/${reportId}/finalize`, {
    method: 'POST',
    token: doctorToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));

  draftReportId = await createReport(doctorToken, patientId);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('phone conversion normalizes Egyptian local numbers to international format', () => {
  assert.equal(toWhatsAppRecipient('01012345678'), '201012345678');
  assert.equal(toWhatsAppRecipient('+20 101 234 5678'), '201012345678');
  assert.equal(toWhatsAppRecipient('0020 101 234 5678'), '201012345678');
  assert.equal(toWhatsAppRecipient('123'), null);
  assert.equal(toWhatsAppRecipient(''), null);
  assert.equal(toWhatsAppRecipient(null), null);
});

test('missing configuration blocks WhatsApp sending', async () => {
  const origKey = env.EVOLUTION_API_KEY;
  env.EVOLUTION_API_KEY = '';
  try {
    assert.equal(whatsappConfigured(), false);
    await assert.rejects(
      sendWhatsAppDocument({
        to: '201012345678',
        filename: 'report.pdf',
        pdf: Buffer.from('%PDF-1.4\n'),
        caption: 'Report',
      }),
      (err: unknown) =>
        err instanceof WhatsAppError && err.code === 'WHATSAPP_NOT_CONFIGURED',
    );
  } finally {
    env.EVOLUTION_API_KEY = origKey;
  }
});

test('Evolution API authentication failure throws WHATSAPP_AUTH_FAILED', async () => {
  const authFailingFetch = (async () => {
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid apikey' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    getEvolutionStatus(authFailingFetch),
    (err: unknown) =>
      err instanceof WhatsAppError &&
      err.code === 'WHATSAPP_AUTH_FAILED' &&
      err.providerStatus === 401,
  );
});

test('Evolution API timeout produces WHATSAPP_TIMEOUT error without exposing phone number', async () => {
  const failingFetch = (async () => {
    const error = new Error('The operation was aborted');
    error.name = 'TimeoutError';
    throw error;
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(
      {
        to: '201012345678',
        filename: 'synthetic.pdf',
        pdf: Buffer.from('%PDF-1.4\n'),
        caption: 'Synthetic',
      },
      failingFetch,
    ),
    (error: unknown) =>
      error instanceof WhatsAppError &&
      error.code === 'WHATSAPP_TIMEOUT' &&
      !error.message.includes('201012345678'),
  );
});

test('disconnected instance returns WHATSAPP_INSTANCE_DISCONNECTED', async () => {
  const disconnectedFetch = (async () => {
    return new Response(
      JSON.stringify({
        status: 400,
        message: 'Connection is closed. Please connect or scan the QR code first.',
      }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(
      {
        to: '201012345678',
        filename: 'report.pdf',
        pdf: Buffer.from('%PDF-1.4\n'),
        caption: 'Report',
      },
      disconnectedFetch,
    ),
    (err: unknown) =>
      err instanceof WhatsAppError && err.code === 'WHATSAPP_INSTANCE_DISCONNECTED',
  );
});

test('Admin can check WhatsApp connection status via API', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/instance/connectionState/')) {
      return new Response(
        JSON.stringify({
          instance: { instanceName: 'test_clinic', state: 'open' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const res = await api('/settings/whatsapp', {
      method: 'GET',
      token: adminToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.configured, true);
    assert.equal(res.body.state, 'open');
    assert.equal(res.body.instanceName, 'test_clinic');
    // Ensure API key is never exposed
    assert.equal(res.body.apiKey, undefined);
    assert.equal(res.body.key, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Admin can generate WhatsApp QR code via API', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/instance/connectionState/')) {
      return new Response(
        JSON.stringify({
          instance: { instanceName: 'test_clinic', state: 'close' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/instance/connect/')) {
      return new Response(
        JSON.stringify({
          base64: 'data:image/png;base64,syntheticQrBase64',
          code: 'syntheticCode',
          pairingCode: '1234-5678',
          instance: { state: 'connecting' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const res = await api('/settings/whatsapp/connect', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.base64, 'data:image/png;base64,syntheticQrBase64');
    assert.equal(res.body.pairingCode, '1234-5678');
    assert.equal(res.body.state, 'connecting');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Admin can disconnect WhatsApp session via API', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/instance/logout/')) {
      return new Response(
        JSON.stringify({ status: true, response: { message: 'Logged out' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const res = await api('/settings/whatsapp/disconnect', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server-side PDF is a valid PDF document with wrapped report content', async () => {
  const pdf = await renderReportPdf({
    clinic: {
      name: 'WhatsApp Test Clinic',
      phone: '+20 100 000 0000',
      email: 'clinic@example.test',
      address: 'Synthetic address',
      timezone: 'Africa/Cairo',
    },
    report: {
      id: 'synthetic-report-id',
      status: 'FINALIZED',
      versionNumber: 1,
      finalizedAt: new Date('2026-10-30T10:00:00Z'),
      lastAmendedAt: null,
      content: {
        findings: 'A long synthetic finding that should wrap across the PDF width. '.repeat(20),
        impression: 'Synthetic impression.',
      },
      templateName: 'Synthetic template',
      templateVersion: 'v1',
      templateFields: [
        { key: 'findings', label: 'Findings', type: 'textarea' },
        { key: 'impression', label: 'Impression / conclusion', type: 'textarea' },
      ],
      templateLayout: { showMeasurements: true, showSignature: true },
    },
    patient: {
      patientNumber: 'P-0001',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: new Date('1990-01-01T00:00:00Z'),
      gender: 'FEMALE',
    },
    examination: {
      visitDate: new Date('2026-10-30T09:00:00Z'),
      doctor: 'Test Doctor',
      examinationType: 'Synthetic ultrasound',
      chiefComplaint: 'Synthetic indication',
    },
    measurements: [
      { label: 'Synthetic measure', value: '12', unit: 'mm', measuredAt: new Date('2026-10-30T09:05:00Z') },
    ],
  });

  assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(pdf.length > 1_000, `expected PDF output, got ${pdf.length} bytes`);
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.equal(pageCount, 1, 'the footer must not append extra blank pages');
});

test('only a doctor who owns the report may send, drafts are rejected, and consent is required', async () => {
  // Non-doctor (receptionist) rejected
  const reception = await api(`/reports/${reportId}/whatsapp`, {
    method: 'POST',
    token: receptionToken,
    body: { consent: true },
  });
  assert.equal(reception.status, 403, JSON.stringify(reception.body));

  // Different doctor rejected
  const otherDoctor = await api(`/reports/${reportId}/whatsapp`, {
    method: 'POST',
    token: doctor2Token,
    body: { consent: true },
  });
  assert.equal(otherDoctor.status, 403, JSON.stringify(otherDoctor.body));

  // Draft report rejected
  const draft = await api(`/reports/${draftReportId}/whatsapp`, {
    method: 'POST',
    token: doctorToken,
    body: { consent: true },
  });
  assert.equal(draft.status, 409, JSON.stringify(draft.body));

  // Missing explicit consent rejected
  const missingConsent = await api(`/reports/${reportId}/whatsapp`, {
    method: 'POST',
    token: doctorToken,
    body: { consent: false },
  });
  assert.equal(missingConsent.status, 400, JSON.stringify(missingConsent.body));
});

test('sends report PDF through Evolution API and records an auditable delivery', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://evolution-mock.test:8080/')) {
      requests.push({ url, init });
      if (url.includes('/message/sendMedia/')) {
        const payload = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            key: {
              id: 'evolution-msg-98765',
              remoteJid: `${payload.number}@s.whatsapp.net`,
              fromMe: true,
            },
            status: 'PENDING',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const sent = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.delivery.status, 'SENT');
    assert.equal(sent.body.delivery.providerMessageId, 'evolution-msg-98765');
    assert.equal(sent.body.delivery.provider, 'EVOLUTION_BAILEYS');
    assert.equal(sent.body.delivery.recipientLast4, '5678');

    assert.equal(requests.length, 1, 'expected a single sendMedia request to Evolution API');
    const sendReq = requests[0];
    assert.ok(sendReq.url.endsWith('/message/sendMedia/test_clinic'));
    assert.equal(
      new Headers(sendReq.init?.headers).get('apikey'),
      'test-only-evolution-api-key',
    );

    const sendBody = JSON.parse(String(sendReq.init?.body));
    assert.equal(sendBody.number, '201012345678');
    assert.equal(sendBody.mediatype, 'document');
    assert.equal(sendBody.mimetype, 'application/pdf');
    assert.ok(sendBody.media.startsWith('data:application/pdf;base64,'));
    assert.ok(sendBody.fileName.endsWith('.pdf'));

    const delivery = await prisma.reportDelivery.findUniqueOrThrow({
      where: {
        reportId_versionNumber_channel: {
          reportId,
          versionNumber: 1,
          channel: 'WHATSAPP',
        },
      },
    });
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.provider, 'EVOLUTION_BAILEYS');
    assert.equal(delivery.providerMessageId, 'evolution-msg-98765');
    assert.equal(delivery.recipientLast4, '5678');
    assert.equal(delivery.errorMessage, null);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'report.whatsapp_sent', entityId: reportId },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit);
    assert.equal(JSON.stringify(audit.metadata).includes('01012345678'), false);
    assert.equal(JSON.stringify(audit.metadata).includes('201012345678'), false);

    // Duplicate send without resend flag is rejected
    const duplicate = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true },
    });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));

    // Resend with resend=true succeeds and increments attempts
    const resent = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true, resend: true },
    });
    assert.equal(resent.status, 200, JSON.stringify(resent.body));
    assert.equal(resent.body.delivery.status, 'SENT');

    const afterResend = await prisma.reportDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    assert.equal(afterResend.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Evolution API delivery failures are persisted without exposing recipient number', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://evolution-mock.test:8080/')) {
      return new Response(JSON.stringify({ error: 'Internal Server Error', message: 'Evolution media failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const failed = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true, resend: true },
    });
    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, 'WHATSAPP_MESSAGE_FAILED');

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
    assert.equal(delivery.errorCode, 'WHATSAPP_MESSAGE_FAILED');
    assert.equal(delivery.errorMessage?.includes('01012345678') ?? false, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a stuck pending attempt can be recovered after the stale timeout', async () => {
  const delivery = await prisma.reportDelivery.findUniqueOrThrow({
    where: {
      reportId_versionNumber_channel: {
        reportId,
        versionNumber: 1,
        channel: 'WHATSAPP',
      },
    },
  });
  await prisma.reportDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'PENDING',
      attempts: 1,
      providerMessageId: null,
      sentAt: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://evolution-mock.test:8080/')) {
      return new Response(
        JSON.stringify({
          key: { id: 'evolution-recovered-id' },
          status: 'PENDING',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const recovered = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true, resend: true },
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.delivery.status, 'SENT');
    assert.equal(recovered.body.delivery.providerMessageId, 'evolution-recovered-id');

    const afterRecovery = await prisma.reportDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    assert.equal(afterRecovery.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
