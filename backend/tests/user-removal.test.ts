import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Integration tests for archiving staff accounts.
 *
 * Removal is a soft delete: the account is deactivated, every session and
 * pending invite is revoked, and the audit trail is retained.
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
let adminId = '';
let secondAdminToken = '';
let secondAdminId = '';
let receptionistId = '';

interface ApiResult {
  status: number;
  body: any;
  setCookie: string[];
}

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown; cookie?: string } = {},
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
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
  return {
    token: result.body.accessToken as string,
    refreshCookie: cookie.split(';')[0],
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
        firstName: 'Removal',
        lastName: 'Admin',
        email: 'removal.admin@clinic.test',
        password: 'Str0ng!Passw0rd',
      },
      clinic: {
        name: 'Removal Test Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
      },
    },
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  adminToken = setup.body.accessToken;
  adminId = setup.body.user.id;

  const second = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Second',
      lastName: 'Admin',
      email: 'removal.second@clinic.test',
      role: 'ADMIN',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  secondAdminId = second.body.user.id;

  const receptionist = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Archived',
      lastName: 'Receptionist',
      email: 'removal.reception@clinic.test',
      role: 'RECEPTIONIST',
      password: 'Str0ng!Passw0rd',
      sendInvite: false,
    },
  });
  assert.equal(receptionist.status, 201, JSON.stringify(receptionist.body));
  receptionistId = receptionist.body.user.id;

  secondAdminToken = (await login('removal.second@clinic.test', 'Str0ng!Passw0rd')).token;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
});

test('an administrator can archive an account and revoke its sessions', async () => {
  const receptionist = await login('removal.reception@clinic.test', 'Str0ng!Passw0rd');

  const forbidden = await api(`/users/${receptionistId}`, {
    method: 'DELETE',
    token: receptionist.token,
  });
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));

  const removed = await api(`/users/${receptionistId}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  // The access token is rejected immediately, even though it has not expired.
  const me = await api('/auth/me', { token: receptionist.token });
  assert.equal(me.status, 401, JSON.stringify(me.body));

  // The refresh token is revoked, so a stolen cookie cannot mint new access.
  const refresh = await api('/auth/refresh', {
    method: 'POST',
    cookie: receptionist.refreshCookie,
  });
  assert.equal(refresh.status, 401, JSON.stringify(refresh.body));

  const signIn = await api('/auth/login', {
    method: 'POST',
    body: { email: 'removal.reception@clinic.test', password: 'Str0ng!Passw0rd' },
  });
  assert.equal(signIn.status, 401, JSON.stringify(signIn.body));

  // The archived account stays visible to administrators for reference.
  const list = await api('/users?pageSize=100', { token: adminToken });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const stored = list.body.users.find((user: any) => user.id === receptionistId);
  assert.ok(stored, 'archived account must remain in the list');
  assert.equal(stored.isActive, false);

  // Removal is idempotent.
  const again = await api(`/users/${receptionistId}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(again.status, 204, JSON.stringify(again.body));

  // Archived accounts cannot be issued a new password link.
  const reset = await api(`/users/${receptionistId}/password-reset`, {
    method: 'POST',
    token: adminToken,
  });
  assert.equal(reset.status, 400, JSON.stringify(reset.body));
});

test('removal is audited with the number of revoked sessions', async () => {
  const audit = await api(
    `/audit?entityType=User&entityId=${receptionistId}&action=user.removed`,
    { token: adminToken },
  );
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.total, 1, JSON.stringify(audit.body));
  const entry = audit.body.entries[0];
  assert.equal(entry.action, 'user.removed');
  assert.equal(entry.entityId, receptionistId);
  assert.equal(entry.metadata.mode, 'archived');
  assert.ok(entry.metadata.revokedRefreshTokens >= 1);
  assert.equal(entry.actorId, adminId);
});

test('removal revokes pending password-setup invitations', async () => {
  const invited = await api('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      firstName: 'Pending',
      lastName: 'Invite',
      email: 'removal.invite@clinic.test',
      role: 'RECEPTIONIST',
      sendInvite: true,
    },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  assert.ok(invited.body.invite?.url, 'expected a one-time invite link when email is disabled');
  const token = new URL(invited.body.invite.url).searchParams.get('token');
  assert.ok(token);

  const before = await api(`/auth/password-setup/${encodeURIComponent(token)}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const removed = await api(`/users/${invited.body.user.id}`, {
    method: 'DELETE',
    token: adminToken,
  });
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  const after = await api(`/auth/password-setup/${encodeURIComponent(token)}`);
  assert.equal(after.status, 400, JSON.stringify(after.body));

  const audit = await api(
    `/audit?entityType=User&entityId=${invited.body.user.id}&action=user.removed`,
    { token: adminToken },
  );
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.total, 1, JSON.stringify(audit.body));
  assert.ok(audit.body.entries[0].metadata.revokedInvites >= 1);
});

test('an administrator cannot remove their own account', async () => {
  const removed = await api(`/users/${adminId}`, {
    method: 'DELETE',
    token: secondAdminToken,
  });
  assert.equal(removed.status, 204, JSON.stringify(removed.body));

  const originalAdmin = await api('/auth/me', { token: adminToken });
  assert.equal(originalAdmin.status, 401, JSON.stringify(originalAdmin.body));

  // The second administrator is now the last active administrator.
  const own = await api(`/users/${secondAdminId}`, {
    method: 'DELETE',
    token: secondAdminToken,
  });
  assert.equal(own.status, 400, JSON.stringify(own.body));
  assert.match(own.body.error?.message ?? JSON.stringify(own.body), /your own account/i);

  const stillThere = await api('/auth/me', { token: secondAdminToken });
  assert.equal(stillThere.status, 200, JSON.stringify(stillThere.body));
});

test('removing an unknown account returns 404', async () => {
  const missing = await api('/users/00000000-0000-4000-8000-000000000000', {
    method: 'DELETE',
    token: secondAdminToken,
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});
