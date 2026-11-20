import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Phase 7.2 HTTP 422 monitoring/redaction proof.
 *
 * No production route currently returns 422: the helper exists but is unused.
 * This test therefore exercises the supported error middleware through a real
 * in-process route by injecting unprocessable() from a directly awaited Prisma
 * delegate. It invents no endpoint and changes no application behaviour.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://p72:p72@127.0.0.1:5432/p72_422_test';
process.env.JWT_ACCESS_SECRET = 'p72-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'p72-refresh-secret-fedcba9876543210';
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
    'Refusing to run HTTP 422 tests: DATABASE_URL must point at a database ending in "_test".',
  );
}

const captured: string[] = [];
const originalStdout = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => {
  captured.push(String(chunk));
  return originalStdout(chunk as never);
}) as typeof process.stdout.write;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { unprocessable } = await import('../src/lib/errors.js');

const PHI_NAME = 'P72-PHI-NAME-JaneDoe';
const PHI_PHONE = 'P72-PHONE-9876543210';
const EMAIL = 'patient.p72422@example.test';
const API_KEY = 'sk_live_p72422abc123def456';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwNzI0MjIifQ.ZmFrZVNpZ25hdHVyZUZvclA3MjQyMg';
const COOKIE = 'session=P72-COOKIE-SECRET';
const MARKERS = [PHI_NAME, PHI_PHONE, EMAIL, API_KEY, JWT, COOKIE, 'P72-QUERY-MARKER'];

let server: Server | undefined;

test('p72 HTTP 422 uses the unchanged error contract and leaks no request data', async () => {
  let adminToken = '';
  try {
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
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    const setup = await fetch(`${baseUrl}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        admin: {
          firstName: 'P72',
          lastName: 'Admin',
          email: 'p72422.admin@example.test',
          password: 'Str0ng!Passw0rd',
        },
        clinic: {
          name: 'P72 422 Clinic',
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
      }),
    });
    const setupText = await setup.text();
    assert.equal(setup.status, 201, setupText.slice(0, 300));
    adminToken = ((JSON.parse(setupText) as any).accessToken ?? '') as string;
    assert.ok(adminToken);

    const patientDelegate = prisma.patient as unknown as Record<string, unknown>;
    const originalFindUnique = patientDelegate.findUnique;
    patientDelegate.findUnique = async () => {
      throw unprocessable('synthetic unprocessable response', { field: 'phone' });
    };

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/patients/00000000-0000-4000-8000-000000000000?marker=P72-QUERY-MARKER`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken}`,
            cookie: COOKIE,
            'x-api-key': API_KEY,
          },
          body: JSON.stringify({
            phone: PHI_PHONE,
            address: PHI_NAME,
            notes: `${EMAIL} ${JWT}`,
          }),
        },
      );
    } finally {
      patientDelegate.findUnique = originalFindUnique;
    }

    assert.equal(response.status, 422);
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    assert.equal(body.error?.code, 'UNPROCESSABLE');
    assert.equal(body.error?.message, 'synthetic unprocessable response');
    assert.deepEqual(body.error?.details, { field: 'phone' });
    for (const marker of MARKERS) {
      assert.ok(!JSON.stringify(body).includes(marker), `422 response leaked ${marker}`);
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write =
      originalStdout as typeof process.stdout.write;
  }

  const logs = captured.join('');
  for (const marker of MARKERS) {
    assert.ok(!logs.includes(marker), `operational log leaked ${marker}`);
  }
  assert.ok(!logs.includes('"event":"request.failed"'), 'AppError must not create a 500-style log');

  const requestLines = logs
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const status422 = requestLines.find(
    (line) => line.event === 'http.request' && line.status === 422,
  );
  assert.ok(status422, 'expected a structured http.request line for HTTP 422');
  // Error unwinding can leave Express with only the nested router's route
  // template; either form is safe because neither contains the raw UUID.
  assert.ok(
    ['/api/v1/patients/:id', '/:id'].includes(String(status422!.route)),
    `unexpected route template: ${String(status422!.route)}`,
  );
  assert.ok(!String(status422!.route).includes('00000000-0000'));

  originalStdout(
    `Phase 7.2 HTTP 422 evidence: status=422 code=UNPROCESSABLE route=${String(status422!.route)} sensitive_markers_in_logs=0\n`,
  );
});
