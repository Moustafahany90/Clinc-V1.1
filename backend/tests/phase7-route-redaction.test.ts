import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Prisma } from '@prisma/client';

/**
 * Phase 7.1 route-level PHI/secret redaction proof.
 *
 * Exercises real HTTP routes on an in-process Express app against an isolated
 * database whose name ends in `_test`. Synthetic PHI/secret markers are sent in
 * request bodies, query strings, headers, filenames and thrown errors. The
 * backend's stdout/stderr are teed into a buffer for the whole run, then every
 * marker is asserted absent from the captured operational log lines.
 *
 * No external service is contacted: WhatsApp delivery is disabled and the
 * Evolution provider is not called.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://p7:p7@127.0.0.1:5432/p7_route_test';
process.env.JWT_ACCESS_SECRET = 'p71-route-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'p71-route-refresh-secret-fedcba9876543210';
process.env.LOG_LEVEL = 'info';
process.env.EVOLUTION_API_ENABLED = 'false';
process.env.APP_ORIGIN = 'http://127.0.0.1:5173';

const databaseName = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
if (!/_test$/.test(databaseName)) {
  throw new Error(
    'Refusing to run route redaction tests: DATABASE_URL must point at a database ending in "_test".',
  );
}

// Tee (do not swallow) the process streams so node:test output still works.
const captured: string[] = [];
const originalStdout = process.stdout.write.bind(process.stdout);
const originalStderr = process.stderr.write.bind(process.stderr);
function tee(chunk: unknown): boolean {
  captured.push(String(chunk));
  return true;
}
(process.stdout as unknown as { write: (c: unknown) => boolean }).write = ((chunk: unknown) => {
  tee(chunk);
  return originalStdout(chunk as never);
}) as typeof process.stdout.write;
(process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((chunk: unknown) => {
  tee(chunk);
  return originalStderr(chunk as never);
}) as typeof process.stderr.write;

const { createApp } = await import('../src/app.js');
const { ensureStorage } = await import('../src/modules/files/routes.js');
const { prisma } = await import('../src/lib/prisma.js');

const PHI_NAME = 'P7-PHI-NAME-JaneDoe';
const PHI_PHONE = 'P7-PHI-PHONE-12025550123';
const EMAIL = 'patient.p7route@example.test';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwN3JvdXRldGVzdCJ9.ZmFrZVNpZ25hdHVyZUZvclJvdXRlVGVzdA';
const API_KEY = 'sk_live_p7routeabc123def456';
const PASSWORD = 'P7-PASSWORD-FakePass123';
const MARKERS = [PHI_NAME, PHI_PHONE, EMAIL, JWT, API_KEY, PASSWORD];

const statuses = new Map<string, number>();

function record(label: string, status: number): void {
  statuses.set(label, status);
}

let server: Server;
let baseUrl = '';
let rootUrl = '';

async function api(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    formData?: FormData;
    root?: boolean;
  } = {},
) {
  const response = await fetch(`${options.root ? rootUrl : baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined && !options.formData
        ? {}
        : options.formData
          ? {}
          : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.formData
      ? options.formData
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

test('route-level operational logs never contain injected PHI, JWT, API key, email or password', async () => {
  let adminToken = '';
  let doctorToken = '';
  let patientId = '';
  let reportId = '';

  try {
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
    rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseUrl = `${rootUrl}/api/v1`;

    const setup = await api('/setup', {
      method: 'POST',
      body: {
        admin: {
          firstName: 'Route',
          lastName: 'Admin',
          email: 'route.admin@p7test.local',
          password: 'Str0ng!Passw0rd',
        },
        clinic: {
          name: 'Route Redaction Clinic',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          defaultAppointmentMinutes: 15,
        },
        workingHours: Array.from({ length: 7 }, (_, i) => ({
          dayOfWeek: i + 1,
          isOpen: true,
          openMinute: 480,
          closeMinute: 1200,
          breakStartMinute: null,
          breakEndMinute: null,
        })),
      },
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body).slice(0, 400));
    adminToken = (setup.body as any).accessToken;

    const doctor = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: 'Route',
        lastName: 'Doctor',
        email: 'route.doctor@p7test.local',
        role: 'DOCTOR',
        password: 'Str0ng!Passw0rd',
      },
    });
    assert.equal(doctor.status, 201, JSON.stringify(doctor.body).slice(0, 400));

    const loginFailed = await api('/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    record('login_failure_401', loginFailed.status);

    const loginOk = await api('/auth/login', {
      method: 'POST',
      body: { email: 'route.doctor@p7test.local', password: 'Str0ng!Passw0rd' },
    });
    assert.equal(loginOk.status, 200, JSON.stringify(loginOk.body).slice(0, 300));
    doctorToken = (loginOk.body as any).accessToken;

    record('unauthenticated_401', (await api('/patients')).status);
    record(
      'fake_jwt_401',
      (
        await api('/patients', {
          headers: { authorization: `Bearer ${JWT}`, 'x-api-key': API_KEY },
        })
      ).status,
    );

    // Query strings and headers carrying markers must not reach the logger.
    record(
      'patients_search_with_query_markers_200',
      (
        await api(`/patients?q=${encodeURIComponent(PHI_NAME)}&apikey=${encodeURIComponent(API_KEY)}`, {
          token: adminToken,
        })
      ).status,
    );

    const created = await api('/patients', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: PHI_NAME,
        lastName: PHI_PHONE,
        phone: '01055559991',
        gender: 'FEMALE',
        notes: `${EMAIL} ${API_KEY}`,
        acknowledgeDuplicates: true,
      },
    });
    record('patient_create_201', created.status);
    patientId = (created.body as any)?.patient?.id ?? '';
    assert.ok(patientId, JSON.stringify(created.body).slice(0, 300));

    if (patientId) {
      record(
        'patient_update_200',
        (
          await api(`/patients/${patientId}`, {
            method: 'PATCH',
            token: adminToken,
            body: { address: `${PHI_NAME}, ${PHI_PHONE}` },
          })
        ).status,
      );
      record(
        'patient_search_200',
        (await api(`/patients?search=${encodeURIComponent(PHI_NAME)}`, { token: adminToken })).status,
      );
    }

    // Service error containing PHI: only the error name/route may be logged.
    // Patch findFirst, which GET /patients/:id awaits directly. A delegate used
    // inside prisma.$transaction([...]) would produce a promise rejected before
    // the transaction attaches a handler -> an unhandledRejection under node:test.
    const patientDelegate = prisma.patient as unknown as Record<string, unknown>;
    const originalFindFirst = patientDelegate.findFirst;
    patientDelegate.findFirst = async () => {
      throw new Error(`service failed for ${PHI_NAME} ${API_KEY}`);
    };
    try {
      record(
        'service_error_500',
        (
          await api(`/patients/${patientId}?marker=${encodeURIComponent(PHI_NAME)}`, {
            token: adminToken,
          })
        ).status,
      );
    } finally {
      patientDelegate.findFirst = originalFindFirst;
    }

    // Prisma error carrying a marker in its message. PATCH /patients/:id awaits
    // findUnique directly, so patch that delegate. meta.target is a neutral
    // column name: the PHI lives in the thrown message, which error.ts never
    // logs on the P2002 branch.
    const originalFindUnique = patientDelegate.findUnique;
    patientDelegate.findUnique = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        `unique violation for ${PHI_NAME} ${API_KEY}`,
        { code: 'P2002', clientVersion: '6.18.0', meta: { target: ['phone'] } },
      );
    };
    try {
      record(
        'prisma_error_409',
        (
          await api(`/patients/${patientId}`, {
            method: 'PATCH',
            token: adminToken,
            body: { address: `${PHI_NAME}, ${PHI_PHONE}` },
          })
        ).status,
      );
    } finally {
      patientDelegate.findUnique = originalFindUnique;
    }

    const visit = await api('/visits', {
      method: 'POST',
      token: doctorToken,
      body: {
        patientId,
        chiefComplaint: `${PHI_NAME} with ${PHI_PHONE}`,
        examinationType: 'Route redaction synthetic scan',
      },
    });
    record('visit_create_201', visit.status);
    const visitId = (visit.body as any)?.visit?.id ?? '';

    if (visitId) {
      // File upload with a marker inside the file and in the query string.
      // Do this before finalizing the report: finalization completes the visit,
      // after which the files route correctly forbids new attachments.
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([`%PDF-1.4\n% ${PHI_NAME} ${EMAIL} ${API_KEY}`], { type: 'application/pdf' }),
        `${PHI_NAME}.pdf`,
      );
      formData.append('visitId', visitId);
      record(
        'file_upload',
        (
          await api(`/files?label=${encodeURIComponent(PHI_NAME)}`, {
            method: 'POST',
            token: doctorToken,
            formData,
          })
        ).status,
      );

      const report = await api('/reports', {
        method: 'POST',
        token: doctorToken,
        body: {
          visitId,
          templateId: null,
          content: { findings: `${PHI_NAME} ${EMAIL}`, impression: API_KEY },
        },
      });
      record('report_create_201', report.status);
      reportId = (report.body as any)?.report?.id ?? '';
      if (reportId) {
        record('report_finalize_200', (await api(`/reports/${reportId}/finalize`, { method: 'POST', token: doctorToken })).status);
        record('report_print_data_200', (await api(`/reports/${reportId}/print-data?note=${encodeURIComponent(PHI_NAME)}`, { token: doctorToken })).status);
        record(
          'whatsapp_disabled_provider',
          (
            await api(`/reports/${reportId}/whatsapp`, {
              method: 'POST',
              token: doctorToken,
              body: { phone: PHI_PHONE, note: API_KEY },
            })
          ).status,
        );
      }
    }

    record(
      'payment_201',
      (
        await api('/payments', {
          method: 'POST',
          token: adminToken,
          body: {
            patientId,
            amountMinor: 12500,
            methodKey: 'CASH',
            reference: '',
            notes: `${PHI_NAME} ${API_KEY}`,
            idempotencyKey: 'p71-route-redaction-payment-1',
          },
        })
      ).status,
    );

    record('validation_400', (await api('/patients', { method: 'POST', token: adminToken, body: { firstName: PHI_NAME } })).status);
    record('not_found_404', (await api(`/no-such-route?q=${encodeURIComponent(PHI_NAME)}`)).status);

    const reception = await api('/users', {
      method: 'POST',
      token: adminToken,
      body: {
        firstName: 'Route',
        lastName: 'Reception',
        email: 'route.reception@p7test.local',
        role: 'RECEPTIONIST',
        password: 'Str0ng!Passw0rd',
      },
    });
    if (reception.status === 201) {
      const receptionLogin = await api('/auth/login', {
        method: 'POST',
        body: { email: 'route.reception@p7test.local', password: 'Str0ng!Passw0rd' },
      });
      const receptionToken = (receptionLogin.body as any)?.accessToken ?? '';
      record(
        'forbidden_403',
        (
          await api(reportId ? `/reports/${reportId}/print-data` : '/reports', {
            token: receptionToken,
          })
        ).status,
      );
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
      originalStdout as typeof process.stdout.write;
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write =
      originalStderr as typeof process.stderr.write;
  }

  const logs = captured.join('');
  for (const marker of MARKERS) {
    assert.ok(!logs.includes(marker), `operational log leaked marker ${marker}`);
  }
  assert.ok(!logs.includes(`${PHI_NAME}=`), 'operational log leaked a marked query value');
  assert.ok(logs.includes('"event":"http.request"'), 'expected structured request logs');

  // Report the observed status coverage in the test output for audit evidence.
  originalStdout(
    `Phase 7.1 route statuses: ${[...statuses.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}\n`,
  );
  assert.equal(statuses.get('login_failure_401'), 401);
  assert.equal(statuses.get('unauthenticated_401'), 401);
  assert.equal(statuses.get('fake_jwt_401'), 401);
  assert.equal(statuses.get('service_error_500'), 500);
  assert.equal(statuses.get('prisma_error_409'), 409);
  assert.equal(statuses.get('validation_400'), 400);
  assert.equal(statuses.get('not_found_404'), 404);
  assert.equal(statuses.get('forbidden_403'), 403);
});
