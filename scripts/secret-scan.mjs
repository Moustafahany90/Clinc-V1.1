#!/usr/bin/env node
/**
 * Redaction-first credential scan for CI and local use.
 *
 * Scans tracked files and project untracked files (never ignored files such as
 * .env) for high-confidence provider-prefixed credentials and private-key
 * headers. It prints only a safe identifier: the first four characters, the
 * candidate length and a truncated SHA-256 fingerprint. Full matches are
 * never logged, written to disk, or copied into reports.
 *
 * Supported text encodings: UTF-8, UTF-8 BOM, UTF-16LE/BE with or without BOM,
 * and NUL-containing text that otherwise decodes cleanly. Files whose bytes
 * cannot be safely decoded are reported as actionable `undecodable-text`
 * findings, so a scanner error can never be mistaken for a clean scan. Files
 * with a known binary extension are explicitly counted as skipped; their bytes
 * are not decoded.
 *
 * Known fixtures are suppressed only by an exact rule/file/fingerprint
 * allowlist. Marker words such as "test" or "example" never suppress a finding.
 *
 * Usage:
 *   node scripts/secret-scan.mjs            # working tree
 *   node scripts/secret-scan.mjs --history  # also scan all reachable commits
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RULES = [
  { name: 'stripe-live-key', re: /sk_live_[A-Za-z0-9]{16,}/g },
  { name: 'stripe-test-key', re: /sk_test_[A-Za-z0-9]{16,}/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{20,}/g },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { name: 'telegram-bot-token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
];

/**
 * Exact known fixture identities: rule | file | redacted fingerprint.
 * Marker words alone are deliberately not an allowlist signal.
 */
export const FIXTURE_ALLOWLIST = new Set([
  'stripe-live-key|backend/tests/p72-http-422.test.ts|sk_l…(len=26) sha256:034abe1ab554',
  'stripe-live-key|backend/tests/phase7-route-redaction.test.ts|sk_l…(len=27) sha256:899f43f0bb06',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.dump', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm',
]);

// Env-like files are the deliberate historical scope. This keeps the original
// --history intent while decoding blobs through the same hardened path.
const ENV_PATH = /(^|\/)\.env(?:$|\.)/;

export class TextDecodeError extends Error {
  constructor(name, reason) {
    super(`${name}: ${reason}`);
    this.name = 'TextDecodeError';
  }
}

export function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 });
}

function countNul(buffer, start, step) {
  let count = 0;
  for (let i = start; i < buffer.length; i += step) {
    if (buffer[i] === 0) count += 1;
  }
  return count;
}

/**
 * Decode supported text bytes into one canonical representation.
 * Returns { text, encoding, hadNul, kind }. Throws TextDecodeError on anything
 * that cannot be safely decoded.
 */
export function decodeBytes(buffer, name) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length === 0) {
    return { text: '', encoding: 'empty', hadNul: false, kind: 'text' };
  }

  let encoding = 'utf8';
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf8-bom';
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf16le-bom';
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf16be-bom';
    offset = 2;
  } else {
    const nulEven = countNul(bytes, 0, 2);
    const nulOdd = countNul(bytes, 1, 2);
    if (nulOdd > 0 || nulEven > 0) {
      // UTF-16LE puts NUL at odd byte offsets for ASCII text; UTF-16BE at even.
      if (nulOdd >= 2 && nulOdd > nulEven * 4) encoding = 'utf16le';
      else if (nulEven >= 2 && nulEven > nulOdd * 4) encoding = 'utf16be';
      else encoding = 'utf8-nul';
    }
  }

  const decoderName = encoding.startsWith('utf16le')
    ? 'utf-16le'
    : encoding.startsWith('utf16be')
      ? 'utf-16be'
      : 'utf-8';
  let text;
  try {
    text = new TextDecoder(decoderName, { fatal: true }).decode(bytes.subarray(offset));
  } catch (error) {
    throw new TextDecodeError(name, `cannot decode as ${encoding}: ${error.message}`);
  }

  const hadNul = text.includes('\0');
  if (hadNul) text = text.replace(/\0/g, '');
  text = text.replace(/^\uFEFF/, '');
  return { text, encoding, hadNul, kind: 'text' };
}

export function fingerprint(value) {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${value.slice(0, 4)}…(len=${value.length}) sha256:${digest}`;
}

export function scanText(file, text, findings, allowlist = FIXTURE_ALLOWLIST) {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let match;
      while ((match = rule.re.exec(line)) !== null) {
        const id = fingerprint(match[0]);
        findings.push({
          name: rule.name,
          file,
          line: index + 1,
          location: `${file}:${index + 1}`,
          fingerprint: id,
          allowlisted: allowlist.has(`${rule.name}|${file}|${id}`),
        });
      }
    }
  }
  return findings;
}

export function isEnvPath(path) {
  return ENV_PATH.test(path);
}

function historyFindings() {
  const findings = [];
  const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
  const blobCache = new Map();

  for (const commit of commits) {
    const entries = git(['ls-tree', '-r', '-z', commit]);
    for (const entry of entries.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, hash] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (type !== 'blob' || !isEnvPath(path)) continue;

      let base = blobCache.get(hash);
      if (!base) {
        base = [];
        const bytes = git(['cat-file', 'blob', hash], null);
        try {
          const decoded = decodeBytes(bytes, `blob ${hash}`);
          scanText(path, decoded.text, base, new Set());
        } catch (error) {
          base.push({
            name: 'undecodable-text',
            file: path,
            line: 0,
            location: `blob ${hash}`,
            fingerprint: `no value read (${error.message})`,
            allowlisted: false,
          });
        }
        blobCache.set(hash, base);
      }

      for (const finding of base) {
        findings.push({
          ...finding,
          name: finding.name.includes('(history)') ? finding.name : `${finding.name} (history)`,
          location: `${commit.slice(0, 12)}:${finding.location}`,
          allowlisted: false,
        });
      }
    }
  }
  return findings;
}

export function main(argv = process.argv) {
  const args = new Set(argv.slice(2));
  const history = args.has('--history');
  const findings = [];
  let binarySkipped = 0;

  const files = [
    ...git(['ls-files', '-z']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean);

  for (const file of files) {
    const dot = file.lastIndexOf('.');
    const extension = dot < 0 ? '' : file.slice(dot).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      binarySkipped += 1;
      continue;
    }

    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      try {
        bytes = Buffer.from(git(['show', `:${file}`], null));
      } catch {
        findings.push({
          name: 'unreadable-file',
          file,
          line: 0,
          location: file,
          fingerprint: 'no value read',
          allowlisted: false,
        });
        continue;
      }
    }

    try {
      const decoded = decodeBytes(bytes, file);
      scanText(file, decoded.text, findings);
    } catch (error) {
      findings.push({
        name: 'undecodable-text',
        file,
        line: 0,
        location: file,
        fingerprint: `no value read (${error.message})`,
        allowlisted: false,
      });
    }
  }

  if (history) findings.push(...historyFindings());

  if (binarySkipped > 0) {
    console.log(
      `secret-scan: ${binarySkipped} binary file(s) skipped by explicit extension policy (no text decoded)`,
    );
  }

  if (findings.length === 0) {
    console.log('secret-scan: no high-confidence credential candidates found');
    return;
  }

  const actionable = findings.filter((finding) => !finding.allowlisted);
  const allowlisted = findings.length - actionable.length;
  console.log(
    `secret-scan: ${findings.length} candidate(s) found (${actionable.length} actionable, ${allowlisted} allowlisted fixtures; values redacted)`,
  );
  for (const finding of findings) {
    const label = finding.allowlisted ? 'allowlisted' : 'ACTIONABLE';
    console.log(`  ${label} ${finding.name} ${finding.location} ${finding.fingerprint}`);
  }
  if (actionable.length > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`secret-scan: ERROR ${error?.message ?? error}`);
    process.exitCode = 2;
  }
}
