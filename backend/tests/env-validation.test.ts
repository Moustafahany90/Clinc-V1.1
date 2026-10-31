import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * Production configuration must fail closed. These tests load env.ts in a
 * child process so process.exit() is observable without stopping the runner.
 */

function loadEnv(overrides: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "import('./src/config/env.ts')"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://clinic_app:test-only-password@localhost:5432/clinic_test?schema=public',
        APP_ORIGIN: 'https://clinic.example.com',
        COOKIE_SECURE: 'true',
        TRUST_PROXY: '1',
        JWT_ACCESS_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        EMAIL_ENABLED: 'false',
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

test('production refuses HTTP origins, insecure cookies and unsafe proxy settings', () => {
  const result = loadEnv({
    APP_ORIGIN: 'http://clinic.example.com',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: '0',
    JWT_ACCESS_SECRET: 'change-me-'.repeat(6),
    JWT_REFRESH_SECRET: 'change-me-'.repeat(6),
  });

  assert.notEqual(result.status, 0, 'invalid production config must exit non-zero');
  assert.match(result.stderr, /APP_ORIGIN/);
  assert.match(result.stderr, /COOKIE_SECURE/);
  assert.match(result.stderr, /TRUST_PROXY/);
  assert.match(result.stderr, /JWT_ACCESS_SECRET/);
  assert.match(result.stderr, /JWT_REFRESH_SECRET/);
});

test('production refuses a non-HTTPS origin even with secure cookies', () => {
  const result = loadEnv({ APP_ORIGIN: 'http://localhost:8080' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /https:\/\//);
});

test('production refuses an empty public origin', () => {
  const result = loadEnv({ APP_ORIGIN: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /At least one public origin/);
});

test('a valid production configuration loads without exiting', () => {
  const result = loadEnv({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), '');
});
