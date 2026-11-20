import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Phase 3 production-readiness audit: WhatsApp delivery gaps not covered by
 * the existing delivery suite.
 *
 * All provider traffic is mocked in-process; no real WhatsApp message is sent.
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
const { prisma } = await import('../src/lib/prisma.js');
const {
  sendWhatsAppDocument,
  getEvolutionStatus,
  WhatsAppError,
  EVOLUTION_MAX_ATTEMPTS,
} = await import('../src/lib/whatsapp.js');

let server: Server;
let baseUrl = '';
let adminToken = '';
let doctorToken = '';
let patientId = '';
let reportId = '';

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

/** Mocked provider that records send requests and can delay them. */
function mockProvider(delayMs = 0) {
  const originalFetch = globalThis.fetch;
  const sends: Array<{ number: string; fileName: string; media: string; requestId: number }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://evolution-mock.test:8080/')) {
      if (url.includes('/message/sendMedia/')) {
        const body = JSON.parse(String(init?.body));
        sends.push({ number: body.number, fileName: body.fileName, media: body.media, requestId: sends.length });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return new Response(
          JSON.stringify({ key: { id: `synthetic-msg-${sends.length}` }, status: 'PENDING' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return {
    sends,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
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
        firstName: 'Phase3',
        lastName: 'WhatsApp Admin',
        email: 'phase3.whatsapp.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Phase 3 WhatsApp Clinic',
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
  adminToken = setup.body.accessToken;

  const doctor = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Phase3',
      lastName: 'Doctor',
      email: 'phase3.whatsapp.doctor@clinic.test',
      role: 'DOCTOR',
      password: 'Str0ng!Passw0rd',
    },
  });
  assert.equal(doctor.status, 201, JSON.stringify(doctor.body));
  doctorToken = await login('phase3.whatsapp.doctor@clinic.test', 'Str0ng!Passw0rd');

  const patient = await api('/patients', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Synthetic',
      lastName: 'WhatsApp Recipient',
      phone: '01012345678',
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(patient.status, 201, JSON.stringify(patient.body));
  patientId = patient.body.patient.id;

  const visit = await api('/visits', {
    method: 'POST',
    token: doctorToken,
    body: { patientId, chiefComplaint: 'Phase 3 WhatsApp audit', examinationType: 'Ultrasound' },
  });
  assert.equal(visit.status, 201, JSON.stringify(visit.body));

  const report = await api('/reports', {
    method: 'POST',
    token: doctorToken,
    body: {
      visitId: visit.body.visit.id,
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
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

function syntheticSendInput() {
  return {
    to: '201012345678',
    filename: 'report.pdf',
    pdf: Buffer.from('%PDF-1.4\n'),
    caption: 'Synthetic',
  };
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

test('generic network failures map to WHATSAPP_NETWORK_ERROR without leaking the recipient', async () => {
  let calls = 0;
  const offlineFetch = (async () => {
    calls += 1;
    throw new TypeError('fetch failed: ENETUNREACH');
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(syntheticSendInput(), offlineFetch),
    (error: unknown) =>
      error instanceof WhatsAppError &&
      error.code === 'WHATSAPP_NETWORK_ERROR' &&
      !error.message.includes('201012345678'),
  );
  assert.equal(calls, EVOLUTION_MAX_ATTEMPTS, 'retries must be bounded');
});

test('a transient connection failure is retried and a later success is used', async () => {
  let calls = 0;
  const flakyFetch = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed: ECONNREFUSED');
    return new Response(JSON.stringify({ key: { id: 'synthetic-retry-msg' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const sent = await sendWhatsAppDocument(syntheticSendInput(), flakyFetch);
  assert.equal(sent.messageId, 'synthetic-retry-msg');
  assert.equal(calls, 2);
});

test('a timed-out document send is never replayed (no duplicate delivery risk)', async () => {
  let calls = 0;
  const timeoutFetch = (async () => {
    calls += 1;
    throw namedError('TimeoutError', 'The operation was aborted');
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(syntheticSendInput(), timeoutFetch),
    (error: unknown) =>
      error instanceof WhatsAppError && error.code === 'WHATSAPP_TIMEOUT',
  );
  assert.equal(calls, 1, 'non-idempotent sends must not be replayed after a timeout');
});

test('an idempotent status read is retried on timeout', async () => {
  let calls = 0;
  const flakyFetch = (async () => {
    calls += 1;
    if (calls === 1) throw namedError('TimeoutError', 'The operation was aborted');
    return new Response(JSON.stringify({ instance: { state: 'open' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const status = await getEvolutionStatus(flakyFetch);
  assert.equal(status.state, 'open');
  assert.equal(calls, 2);
});

test('concurrent first sends claim one delivery and make exactly one provider call', async () => {
  const provider = mockProvider(80);
  try {
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(`/reports/${reportId}/whatsapp`, {
          method: 'POST',
          token: doctorToken,
          body: { consent: true },
        }),
      ),
    );
    const succeeded = attempts.filter((result) => result.status === 200);
    const conflicts = attempts.filter((result) => result.status === 409);

    assert.equal(succeeded.length, 1, `statuses: ${attempts.map((result) => result.status).join(',')}`);
    assert.equal(conflicts.length, 3);
    assert.equal(provider.sends.length, 1);
    assert.equal(provider.sends[0].media.startsWith('data:application/pdf;base64,'), true);

    const deliveries = await prisma.reportDelivery.findMany({
      where: { reportId, channel: 'WHATSAPP' },
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, 'SENT');
    assert.equal(deliveries[0].versionNumber, 1);
    assert.equal(deliveries[0].attempts, 1);
  } finally {
    provider.restore();
  }
});

test('an amendment creates a separate versioned delivery without reusing version 1', async () => {
  const amended = await api(`/reports/${reportId}/amend`, {
    method: 'POST',
    token: doctorToken,
    body: {
      content: { findings: 'Synthetic corrected finding.', impression: 'Synthetic impression.' },
      reason: 'Phase 3 version association probe',
    },
  });
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  assert.equal(amended.body.report.versionNumber, 2);

  const provider = mockProvider();
  try {
    const sent = await api(`/reports/${reportId}/whatsapp`, {
      method: 'POST',
      token: doctorToken,
      body: { consent: true },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.delivery.versionNumber, 2);
    assert.equal(provider.sends.length, 1);
    assert.match(provider.sends[0].fileName, /-v2\.pdf$/);
  } finally {
    provider.restore();
  }

  const deliveries = await prisma.reportDelivery.findMany({
    where: { reportId, channel: 'WHATSAPP' },
    orderBy: { versionNumber: 'asc' },
  });
  assert.deepEqual(
    deliveries.map((delivery) => delivery.versionNumber),
    [1, 2],
  );
  assert.equal(deliveries[0].providerMessageId, 'synthetic-msg-1');
  assert.match(deliveries[1].providerMessageId ?? '', /^synthetic-msg-/);

  const versions = await prisma.reportVersion.findMany({
    where: { reportId },
    orderBy: { versionNumber: 'asc' },
  });
  assert.deepEqual(
    versions.map((version) => [version.versionNumber, version.isFinal, version.reason]),
    [
      [1, true, null],
      [2, true, 'Phase 3 version association probe'],
    ],
  );
});
