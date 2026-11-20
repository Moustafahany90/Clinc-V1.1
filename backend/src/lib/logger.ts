import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * Minimal structured logger for operational logs.
 *
 * Rules enforced here:
 *  - one JSON object per line on stdout, UTC timestamp first;
 *  - no raw request/response bodies, headers, query strings or stack traces;
 *  - keys that can carry PHI/secrets are dropped by default (default-deny);
 *  - a final text scrub catches markers that still slip through free-text fields.
 *
 * The application audit log (`AuditLog` / `GET /api/v1/audit`) is a separate,
 * access-controlled record. Operational logs must never become a shadow copy
 * of it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const configured = (env.LOG_LEVEL ?? 'info') as LogLevel;
const effectiveConfigured: LogLevel =
  env.isProduction && configured === 'debug' ? 'info' : configured;

/** Keys that may be copied into an operational log line. Everything else is dropped. */
const SAFE_KEYS = new Set([
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'userId',
  'role',
  'event',
  'message',
  'action',
  'entityType',
  'entityIdHash',
  'error',
  'errorCode',
  'errorName',
  'at',
  'signal',
  'port',
  'environment',
  'timezone',
  'code',
  'reason',
  'result',
  'enabled',
  'configured',
  'mimeType',
  'sizeBytes',
  'recipientLast4',
  'provider',
  'versionNumber',
  'count',
  'check',
  'severity',
]);

/** Belt-and-braces: even a safe key is discarded if its name looks sensitive. */
const SENSITIVE_KEY =
  /(pass|pwd|secret|token|cookie|authoriz|credential|api[_-]?key|apikey|phone|mobile|telephone|patient|name|report|content|body|html|payload|query|header|jwt|session|key)/i;

const SCRUBBERS: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\b(?:sk_live|sk_test|AKIA|ghp_|gho_|xoxb-|xoxp-)[A-Za-z0-9_-]{6,}/g, '[REDACTED_SECRET]'],
  [/\bP7-(?:PHI|SECRET)-[A-Za-z0-9_-]+\b/g, '[REDACTED_MARKER]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]'],
  [
    // Do not re-scrub values that a previous scrubber already replaced.
    /(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^,;\s}\[]+/gi,
    '$1=[REDACTED]',
  ],
];

function scrubText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SCRUBBERS) {
    out = out.replace(pattern, replacement);
  }
  // Phone-like runs: only redact when the run really contains >= 9 digits,
  // so UTC timestamps such as 2026-11-20 are left intact.
  out = out.replace(/\+?[0-9][0-9().\s-]{6,}[0-9]/g, (match) => {
    const digits = match.replace(/\D/g, '').length;
    return digits >= 9 ? '[REDACTED_PHONE]' : match;
  });
  return out;
}

function primitive(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return scrubText(value.slice(0, 512));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 1) return '[REDACTED_NESTED]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => primitive(item, depth + 1));
  }
  if (typeof value === 'object') return sanitise(value as Record<string, unknown>, depth + 1);
  return '[REDACTED_UNKNOWN]';
}

function sanitise(details: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue;
    if (!SAFE_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    out[key] = primitive(value, depth);
  }
  return out;
}

/** Pseudonymous identifier for correlation; never the raw patient/entity UUID. */
export function hashIdentifier(id: string | null | undefined): string | null {
  if (!id) return null;
  return `h_${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
}

/** Route template only. Raw paths can contain identifiers; query strings are never logged. */
export function safeRoute(req: Pick<Request, 'baseUrl' | 'route' | 'path'>): string {
  const route = req.route?.path;
  if (!route) return 'unmatched';
  const pattern = `${req.baseUrl || ''}${typeof route === 'string' ? route : 'unmatched'}`;
  return scrubText(
    pattern.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    ),
  );
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_VALUE[level] < LEVEL_VALUE[effectiveConfigured]) return;
  if (env.isProduction && level === 'debug') return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    service: 'ultrasound-clinic-api',
    ...sanitise(fields),
  };
  let encoded: string;
  try {
    encoded = JSON.stringify(line);
  } catch {
    encoded = JSON.stringify({ ts: line.ts, level, event, error: 'log_serialisation_failed' });
  }
  process.stdout.write(`${scrubText(encoded).slice(0, 8192)}\n`);
}

export const logger = { log, safeRoute, hashIdentifier };
