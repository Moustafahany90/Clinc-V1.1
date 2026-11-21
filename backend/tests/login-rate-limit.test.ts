import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Phase 9.1 login limiter regression.
 *
 * Before the fix, the only login throttle was 10 requests / 15 min per IP.
 * Behind a clinic's shared NAT that let one user's failed attempts lock out
 * every other user. The fix keeps a generous per-IP ceiling and adds a
 * per-account (normalised email) limiter.
 *
 * Synthetic IPs from TEST-NET-2/3 only. Destructive: refuses to run unless the
 * database name ends in `_test`.
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

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');

const PASSWORD = 'P91-Strong-Pass!';
const SHARED_IP = '198.51.100.77';
const ACCOUNT_A = 'p91.login.a@clinic.test';
const ACCOUNT_B = 'p91.login.b@clinic.test';

let server: Server;
let baseUrl = '';

async function api(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    ip?: string;
  } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function login(email: string, password: string, ip?: string) {
  return api('/auth/login', {
    method: 'POST',
    ip,
    body: { email, password },
  });
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
        email: 'p91.login.admin@clinic.test',
        password: PASSWORD,
      },
      clinic: {
        name: 'P91 Login Test Clinic',
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

  for (const [firstName, email] of [
    ['AccountA', ACCOUNT_A],
    ['AccountB', ACCOUNT_B],
  ]) {
    const created = await api('/users', {
      method: 'POST',
      token: setup.body.accessToken,
      body: {
        firstName,
        lastName: 'Login',
        email,
        role: 'DOCTOR',
        password: PASSWORD,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

test('failed logins for one account do not lock out another account behind the same IP', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failed = await login(ACCOUNT_A, 'definitely-wrong', SHARED_IP);
    // Existing per-account lockout starts after 8 failures; both rejections
    // still count toward the shared-IP limiter.
    assert.ok(
      failed.status === 401 || failed.status === 403,
      `attempt ${attempt + 1}: ${JSON.stringify(failed.body)}`,
    );
  }

  const otherUser = await login(ACCOUNT_B, PASSWORD, SHARED_IP);
  assert.equal(
    otherUser.status,
    200,
    `a second account behind the shared IP must still be able to log in: ${JSON.stringify(otherUser.body)}`,
  );
  assert.ok(otherUser.body.accessToken, 'the second account must receive a session');
});

test('repeated attempts against one email are limited even from different IPs', async () => {
  const target = 'P91.Target.Attack@Clinic.TEST';
  const normalized = target.trim().toLowerCase();
  let blocked = false;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await login(target, 'wrong-password', `198.51.100.${100 + attempt}`);
    if (attempt < 10) {
      assert.equal(result.status, 401, `attempt ${attempt + 1}: ${JSON.stringify(result.body)}`);
    } else if (result.status === 429) {
      blocked = true;
      assert.equal(result.body.error.code, 'RATE_LIMITED');
    }
  }

  assert.equal(blocked, true, `the per-account limiter must block ${normalized} after 10 attempts`);
});
