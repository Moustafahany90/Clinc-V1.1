import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Phase 7 operational-log redaction tests.
 *
 * These are in-process only. They do not start Docker, do not touch a database
 * and do not send any external request. Synthetic markers stand in for PHI and
 * secrets so we can prove they never reach stdout.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://p7:p7@127.0.0.1:5432/p7_test';
process.env.JWT_ACCESS_SECRET = 'p7-phase7-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'p7-phase7-refresh-secret-fedcba9876543210';
process.env.LOG_LEVEL = 'info';

const { log, safeRoute, hashIdentifier } = await import('../src/lib/logger.js');

function captureStdout(fn: () => void): string[] {
  const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const original = stdout.write;
  const chunks: string[] = [];
  stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stdout.write;
  try {
    fn();
  } finally {
    stdout.write = original;
  }
  return chunks.join('').split('\n').filter(Boolean);
}

const PHI_NAME = 'P7-PHI-NAME-JaneDoe';
const PHI_PHONE = 'P7-PHI-PHONE-12025550123';
const EMAIL = 'patient.p7@example.test';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwN3Rlc3QifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const API_KEY = 'sk_live_p7abcd1234efgh';
const PASSWORD = 'p7PlaintextPassword123';

test('phase7 structured logs redact embedded PHI and secrets and drop sensitive keys', () => {
  const lines = captureStdout(() => {
    log('info', 'phase7.test', {
      message: `login ${PHI_NAME} ${PHI_PHONE} ${EMAIL} token=${JWT} apiKey=${API_KEY} password=${PASSWORD}`,
      // All of the following keys are outside the safe allowlist and must be dropped.
      patientName: PHI_NAME,
      phone: PHI_PHONE,
      email: EMAIL,
      token: JWT,
      apiKey: API_KEY,
      password: PASSWORD,
      body: { note: PHI_NAME },
      query: { phone: PHI_PHONE },
      headers: { authorization: `Bearer ${JWT}` },
    });
  });

  assert.equal(lines.length, 1);
  const raw = lines[0]!;
  for (const secret of [
    PHI_NAME,
    PHI_PHONE,
    EMAIL,
    JWT,
    API_KEY,
    PASSWORD,
    '12025550123',
    'patient.p7',
  ]) {
    assert.ok(!raw.includes(secret), `leaked ${secret} in ${raw}`);
  }
  assert.ok(raw.includes('[REDACTED_MARKER]'));
  assert.ok(raw.includes('[REDACTED_EMAIL]'));
  assert.ok(raw.includes('[REDACTED_JWT]'));
  assert.ok(raw.includes('[REDACTED_SECRET]'));
  assert.ok(raw.includes('password=[REDACTED]'));

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.event, 'phase7.test');
  assert.equal(parsed.level, 'info');
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(parsed.service, 'ultrasound-clinic-api');
  assert.ok(!('patientName' in parsed));
  assert.ok(!('phone' in parsed));
  assert.ok(!('email' in parsed));
  assert.ok(!('token' in parsed));
  assert.ok(!('apiKey' in parsed));
  assert.ok(!('password' in parsed));
  assert.ok(!('body' in parsed));
  assert.ok(!('query' in parsed));
  assert.ok(!('headers' in parsed));
});

test('phase7 safeRoute uses the route template and never exposes raw paths or query strings', () => {
  const route = safeRoute({
    baseUrl: '/api/v1',
    route: { path: '/patients/:id' },
    path: `/patients/${PHI_NAME}?note=${PHI_PHONE}`,
  } as never);

  assert.equal(route, '/api/v1/patients/:id');
  assert.ok(!route.includes(PHI_NAME));
  assert.ok(!route.includes(PHI_PHONE));
  assert.ok(!route.includes('?'));

  const uuidRoute = safeRoute({
    baseUrl: '/api/v1',
    route: { path: '/reports/3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
    path: '/reports/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  } as never);
  assert.equal(uuidRoute, '/api/v1/reports/:id');
  assert.ok(!uuidRoute.includes('3f2504e0'));

  assert.equal(
    safeRoute({ baseUrl: '/api/v1', route: undefined, path: `/unknown/${PHI_NAME}` } as never),
    'unmatched',
  );
});

test('phase7 hashIdentifier emits only a deterministic pseudonym', () => {
  const rawId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const first = hashIdentifier(rawId);
  const second = hashIdentifier(rawId);

  assert.equal(first, second);
  assert.match(first!, /^h_[0-9a-f]{12}$/);
  assert.ok(!first!.includes(rawId));
  assert.ok(!first!.includes('3f2504e0'));
  assert.equal(hashIdentifier(null), null);
  assert.equal(hashIdentifier(''), null);
});

test('phase7 Prisma client does not enable query or parameter logging', () => {
  const source = readFileSync(new URL('../src/lib/prisma.ts', import.meta.url), 'utf8');
  assert.match(source, /log:\s*\[\]/);
  assert.doesNotMatch(source, /log:\s*\[[^\]]*['"]query['"]/);
  assert.doesNotMatch(source, /Prisma\.logLevels/);
});
