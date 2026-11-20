import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBytes, fingerprint, scanText } from './secret-scan.mjs';

/**
 * Synthetic-only regression tests for the hardened secret scanner.
 * All credential-shaped values are built at runtime, so no real or literal
 * credential appears in this test file or in the repository scan.
 */

const SCANNER = fileURLToPath(new URL('./secret-scan.mjs', import.meta.url));

function key(prefix, word, length = 24) {
  return `${prefix}${word}${'A'.repeat(length)}`;
}

function utf16be(text) {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'p841-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Synthetic Fixture'], { cwd: dir });
  return dir;
}

function runScanner(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCANNER, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('UTF-8 credentials are detected', () => {
  const value = key('sk_live_', 'UTF8');
  const findings = scanText('utf8.txt', `EVOLUTION_API_KEY=${value}\n`, [], new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'stripe-live-key');
  assert.equal(findings[0].allowlisted, false);
  assert.ok(!findings[0].fingerprint.includes(value));
});

test('UTF-8 BOM is normalised before scanning', () => {
  const value = key('sk_live_', 'BOM');
  const decoded = decodeBytes(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`TOKEN=${value}`, 'utf8')]),
    'bom.txt',
  );
  assert.equal(decoded.encoding, 'utf8-bom');
  assert.equal(decoded.text, `TOKEN=${value}`);
  assert.ok(decoded.text.includes(value));
});

test('UTF-16LE with and without BOM is decoded', () => {
  const value = key('sk_live_', 'LE16');
  const withBom = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`TOKEN=${value}`, 'utf16le'),
  ]);
  assert.equal(decodeBytes(withBom, 'le-bom.txt').text, `TOKEN=${value}`);
  assert.equal(
    decodeBytes(Buffer.from(`TOKEN=${value}`, 'utf16le'), 'le.txt').encoding,
    'utf16le',
  );
});

test('UTF-16BE with BOM is decoded', () => {
  const value = key('sk_live_', 'BE16');
  const bytes = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    utf16be(`TOKEN=${value}`),
  ]);
  const decoded = decodeBytes(bytes, 'be-bom.txt');
  assert.equal(decoded.encoding, 'utf16be-bom');
  assert.equal(decoded.text, `TOKEN=${value}`);
});

test('NUL-containing UTF-16 text is canonicalised and still detected', () => {
  const value = key('sk_live_', 'NUL16');
  const raw = Buffer.from(`TOKEN=${value}`, 'utf16le');
  const split = Math.floor(raw.length / 2 / 2) * 2;
  const withNul = Buffer.concat([raw.subarray(0, split), Buffer.from([0, 0]), raw.subarray(split)]);
  const decoded = decodeBytes(withNul, 'nul.txt');
  assert.equal(decoded.hadNul, true);
  assert.ok(!decoded.text.includes('\0'));
  const findings = scanText('nul.txt', decoded.text, [], new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'stripe-live-key');
});

test('malformed or ambiguous binary input fails closed', () => {
  assert.throws(
    () => decodeBytes(Buffer.from([0xc3, 0x28]), 'malformed.txt'),
    /cannot decode/,
  );
  assert.throws(
    () => decodeBytes(Buffer.from([0x00, 0x01, 0xff, 0x02]), 'ambiguous.bin'),
    /cannot decode/,
  );
});

test('credential-shaped strings containing test or example remain actionable', () => {
  const stripeTest = key('sk_test_', 'example');
  const github = key('ghp_', 'exampletest');
  const findings = scanText('words.ts', `${stripeTest}\n${github}\n`, [], new Set());
  assert.deepEqual(
    findings.map((finding) => finding.name),
    ['stripe-test-key', 'github-token'],
  );
  assert.ok(findings.every((finding) => !finding.allowlisted));
});

test('allowlist is exact: fixture path accepted, same fingerprint elsewhere rejected', () => {
  const value = key('sk_live_', 'Fix');
  const id = fingerprint(value);
  const allowlist = new Set([`stripe-live-key|allowed.ts|${id}`]);

  const allowed = scanText('allowed.ts', value, [], allowlist);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].allowlisted, true);

  const copied = scanText('copied.ts', value, [], allowlist);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].allowlisted, false);
});

test('CLI detects a UTF-16LE backup.patch credential without printing it', () => {
  const dir = initRepo();
  try {
    const value = key('sk_live_', 'Patch16');
    const patch = `diff --git a/.env.example b/.env.example\n+EVOLUTION_API_KEY=${value}\n`;
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(patch, 'utf16le'),
    ]);
    writeFileSync(join(dir, 'backup.patch'), bytes);
    execFileSync('git', ['add', 'backup.patch'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'synthetic utf16 fixture'], { cwd: dir });

    const result = runScanner(dir);
    assert.equal(result.code, 1);
    assert.match(result.output, /ACTIONABLE stripe-live-key backup\.patch/);
    assert.ok(!result.output.includes(value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI --history detects a credential present only in a prior commit', () => {
  const dir = initRepo();
  try {
    const value = key('sk_live_', 'History');
    writeFileSync(join(dir, '.env.example'), `EVOLUTION_API_KEY=${value}\n`);
    execFileSync('git', ['add', '.env.example'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'synthetic history fixture'], { cwd: dir });
    writeFileSync(join(dir, '.env.example'), 'EVOLUTION_API_KEY=\n');

    const current = runScanner(dir);
    assert.equal(current.code, 0);

    const historical = runScanner(dir, ['--history']);
    assert.equal(historical.code, 1);
    assert.match(historical.output, /ACTIONABLE stripe-live-key \(history\)/);
    assert.ok(!historical.output.includes(value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
