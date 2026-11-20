/**
 * Phase 9 endpoint latency, mixed read load, and rate-limit harness.
 *
 * Run from backend/ against the seeded disposable test database:
 *   node --import tsx tests/perf/p9-load.mjs
 *
 * Creates only synthetic P9-prefixed API traffic. Refuses non-*_test databases.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
assert.match(databaseName, /_test$/, 'P9 load tests require a *_test database');
assert.equal(databaseName, 'clinic_p9_test', 'P9 load tests require clinic_p9_test');

function uuid(prefix, i) {
  const h = (start, length) =>
    createHash('md5').update(`${prefix}-${i}`).digest('hex').slice(start, start + length);
  return `${h(0, 8)}-${h(8, 4)}-4${h(12, 3)}-a${h(16, 3)}-${h(18, 12)}`;
}

const patientId = uuid('pat', 1);
const out = {
  tool: 'p9-load',
  database: databaseName,
  seed: 9112026,
  startedAt: new Date().toISOString(),
  endpoints: [],
  load: {},
  rateLimits: {},
};

let server;
let baseUrl = '';
let adminToken = '';

async function request(path, { token, xff, method = 'GET', body } = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    ms: performance.now() - started,
    bytes: Buffer.byteLength(text),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function stats(samples) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const bytes = samples.map((s) => s.bytes).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.status >= 400).length;
  return {
    count: samples.length,
    errors,
    p50Ms: Number(percentile(times, 0.5)?.toFixed(2) ?? 0),
    p95Ms: Number(percentile(times, 0.95)?.toFixed(2) ?? 0),
    p99Ms: Number(percentile(times, 0.99)?.toFixed(2) ?? 0),
    maxMs: Number((times.at(-1) ?? 0).toFixed(2)),
    p50Bytes: percentile(bytes, 0.5) ?? 0,
    p95Bytes: percentile(bytes, 0.95) ?? 0,
    maxBytes: bytes.at(-1) ?? 0,
  };
}

const endpoints = [
  { id: 'patients_search', path: '/patients?search=P9First&page=1&pageSize=20' },
  { id: 'patient_ledger', path: `/patients/${patientId}/ledger` },
  { id: 'finance_position', path: '/financial-reports/position' },
  { id: 'finance_monthly', path: '/financial-reports/monthly?year=2022&month=6' },
  {
    id: 'finance_statement',
    path: '/financial-reports/statement?from=2022-01-01&to=2022-12-31',
  },
];

async function measureEndpoints() {
  for (const [index, endpoint] of endpoints.entries()) {
    const xff = `203.0.113.${50 + index}`;
    await request(endpoint.path, { token: adminToken, xff });
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      samples.push(await request(endpoint.path, { token: adminToken, xff }));
    }
    const summary = { id: endpoint.id, path: endpoint.path, ...stats(samples) };
    out.endpoints.push(summary);
    process.stdout.write(
      `[p9-load] ${endpoint.id}: p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms ` +
        `p99=${summary.p99Ms}ms bytes=${summary.p50Bytes}\n`,
    );
  }
}

async function runMixedLoad() {
  const workerCount = 8;
  const iterations = 15;
  const samples = [];
  const rssSamples = [];
  const dbConnections = [];
  const eventLoopDriftMs = [];
  let expected = performance.now();
  let running = true;

  const sampler = setInterval(() => {
    const now = performance.now();
    eventLoopDriftMs.push(Math.max(0, now - expected - 100));
    expected += 100;
    rssSamples.push(process.memoryUsage().rss);
  }, 100);

  const dbSampler = setInterval(async () => {
    if (!running) return;
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`,
      );
      dbConnections.push(Number(rows[0]?.n ?? 0));
    } catch {
      // Sampling is best-effort; do not perturb the measured workload.
    }
  }, 500);

  const started = performance.now();
  await Promise.all(
    Array.from({ length: workerCount }, async (_, worker) => {
      for (let i = 0; i < iterations; i += 1) {
        const endpoint = endpoints[(worker + i) % endpoints.length];
        samples.push(
          await request(endpoint.path, {
            token: adminToken,
            xff: `203.0.113.${80 + worker}`,
          }),
        );
      }
    }),
  );
  const wallMs = performance.now() - started;
  running = false;
  clearInterval(sampler);
  clearInterval(dbSampler);

  const summary = {
    workers: workerCount,
    iterationsPerWorker: iterations,
    ...stats(samples),
    wallMs: Math.round(wallMs),
    requestsPerSecond: Number(((samples.length / wallMs) * 1000).toFixed(2)),
    rssStartBytes: rssSamples[0] ?? process.memoryUsage().rss,
    rssPeakBytes: Math.max(process.memoryUsage().rss, ...rssSamples),
    rssEndBytes: process.memoryUsage().rss,
    dbConnectionsMax: Math.max(0, ...dbConnections),
    eventLoopDriftP95Ms: Number(percentile(eventLoopDriftMs.sort((a, b) => a - b), 0.95)?.toFixed(2) ?? 0),
    eventLoopDriftMaxMs: Number(Math.max(0, ...eventLoopDriftMs).toFixed(2)),
  };
  out.load = summary;
  process.stdout.write(
    `[p9-load] mixed: rps=${summary.requestsPerSecond} p95=${summary.p95Ms}ms ` +
      `p99=${summary.p99Ms}ms errors=${summary.errors} peakRss=${summary.rssPeakBytes}\n`,
  );
}

async function probeLoginLimiter() {
  const ip = '198.51.100.200';
  const attempts = [];
  for (let i = 0; i < 11; i += 1) {
    attempts.push(
      await request('/auth/login', {
        method: 'POST',
        xff: ip,
        body: { email: 'p9-no-such-user@clinic.test', password: 'P9-wrong-password' },
      }),
    );
  }
  const differentIp = await request('/auth/login', {
    method: 'POST',
    xff: '198.51.100.201',
    body: { email: 'p9-no-such-user@clinic.test', password: 'P9-wrong-password' },
  });
  out.rateLimits.login = {
    sharedIpStatuses: attempts.map((a) => a.status),
    firstHeaders: attempts[0].headers,
    throttledHeaders: attempts.at(-1).headers,
    differentIpStatus: differentIp.status,
  };
  process.stdout.write(
    `[p9-load] login limiter: ${attempts.map((a) => a.status).join(',')} otherIp=${differentIp.status}\n`,
  );
}

async function probeApiLimiter() {
  const ip = '198.51.100.210';
  const samples = [];
  for (let i = 0; i < 603; i += 1) {
    samples.push(await request('/health', { xff: ip }));
  }
  const firstThrottle = samples.findIndex((s) => s.status === 429);
  out.rateLimits.api = {
    requests: samples.length,
    ok: samples.filter((s) => s.status === 200).length,
    throttled: samples.filter((s) => s.status === 429).length,
    firstThrottleRequest: firstThrottle + 1,
    firstHeaders: samples[0].headers,
    throttledHeaders: firstThrottle >= 0 ? samples[firstThrottle].headers : null,
  };
  process.stdout.write(
    `[p9-load] api limiter: first429=${firstThrottle + 1} throttled=${out.rateLimits.api.throttled}\n`,
  );
}

async function main() {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await request('/auth/login', {
    method: 'POST',
    xff: '198.51.100.20',
    body: { email: 'p9.admin@clinic.test', password: 'P9-Synthetic-Pass!' },
  });
  assert.equal(login.status, 200, JSON.stringify(login));
  const loginBody = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.21',
    },
    body: JSON.stringify({ email: 'p9.admin@clinic.test', password: 'P9-Synthetic-Pass!' }),
  }).then((r) => r.json());
  adminToken = loginBody.accessToken;

  await measureEndpoints();
  await runMixedLoad();
  await probeLoginLimiter();
  await probeApiLimiter();

  out.finishedAt = new Date().toISOString();
  const target =
    process.env.P9_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/load.json';
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stdout.write(`[p9-load] WROTE ${target}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p9-load] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  });
