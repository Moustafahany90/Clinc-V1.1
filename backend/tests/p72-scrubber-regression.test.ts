import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Phase 7.2 scrubber precision regression.
 *
 * In-process only: no Docker, database or external request. The same synthetic
 * identifiers pass through the real logger twice (field level and final JSON
 * level), proving UUIDs survive while every supported phone format is redacted.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://p72:p72@127.0.0.1:5432/p72_test';
process.env.JWT_ACCESS_SECRET = 'p72-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET = 'p72-refresh-secret-fedcba9876543210';
process.env.LOG_LEVEL = 'info';

const { log } = await import('../src/lib/logger.js');

function captureStdout(fn: () => void): string {
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
  return chunks.join('');
}

const UUID_LOWER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_UPPER = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
const UUID_ALL_DIGITS = '12345678-1234-1234-1234-123456789012';
const UUID_V4 = '9b2e4f7c-3a1d-4e6b-8f20-7c5d9a1b3e42';

const PHONE_FORMATS = [
  '+209876543210',
  '00209876543210',
  '09876543210',
  '+20 987 654 3210',
  '010-9876-5432',
  '(010) 9876 5432',
  '010 9876 5432',
  '+20 (100) 987-6543',
];
const PHONE_DIGITS = ['209876543210', '00209876543210', '09876543210', '01098765432'];

test('p72 logger preserves UUIDs and redacts all supported Egyptian phone formats', () => {
  const raw = captureStdout(() => {
    log('info', 'p72.scrubber.regression', {
      message: [
        `lower=${UUID_LOWER}`,
        `upper=${UUID_UPPER}`,
        `all_digits=${UUID_ALL_DIGITS}`,
        `v4=${UUID_V4}`,
        ...PHONE_FORMATS.map((phone, i) => `phone${i + 1}=${phone}`),
        `adjacent=${UUID_ALL_DIGITS}+209876543210`,
      ].join(' | '),
      requestId: UUID_LOWER,
      userId: UUID_UPPER,
    });
  }).trim();

  for (const uuid of [UUID_LOWER, UUID_UPPER, UUID_ALL_DIGITS, UUID_V4]) {
    assert.ok(raw.includes(uuid), `UUID was over-redacted: ${uuid}\n${raw}`);
  }
  for (const digits of PHONE_DIGITS) {
    assert.ok(!raw.includes(digits), `raw phone digits leaked: ${digits}\n${raw}`);
  }
  assert.equal((raw.match(/\[REDACTED_PHONE\]/g) ?? []).length, PHONE_FORMATS.length + 1);

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.event, 'p72.scrubber.regression');
  assert.equal(parsed.requestId, UUID_LOWER);
  assert.equal(parsed.userId, UUID_UPPER);
});

test('p72 logger keeps mixed diagnostic UUIDs readable without revealing adjacent phone numbers', () => {
  const raw = captureStdout(() => {
    log('warn', 'p72.scrubber.mixed', {
      message: `request ${UUID_V4} retried after +20 987 654 3210; patient id ${UUID_ALL_DIGITS}`,
    });
  }).trim();

  assert.ok(raw.includes(UUID_V4));
  assert.ok(raw.includes(UUID_ALL_DIGITS));
  assert.ok(!raw.includes('209876543210'));
  assert.ok(raw.includes('[REDACTED_PHONE]'));
});
