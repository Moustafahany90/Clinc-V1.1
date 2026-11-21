/**
 * Phase 9.1 expanded concurrency harness. All records are synthetic P91- data.
 *
 * Run from backend/ against the seeded disposable test database:
 *   node --import tsx tests/perf/p91-concurrency.mjs
 *
 * Refuses to run unless DATABASE_URL points at clinic_p9_test. Does not
 * truncate; it creates only new P91-prefixed rows through the real API.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { clinicDateString, dateOnlyToDb } from '../../src/lib/time.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
assert.match(databaseName, /_test$/, 'P91 concurrency requires a *_test database');
assert.equal(databaseName, 'clinic_p9_test', 'P91 concurrency requires clinic_p9_test');

const ITERATIONS = Number(process.env.P91_ITERATIONS ?? 50);
const ATTEMPTS = Number(process.env.P91_ATTEMPTS ?? 6);
assert.ok(ITERATIONS > 0 && ITERATIONS <= 500, 'P91_ITERATIONS must be 1..500');
assert.ok(ATTEMPTS > 1 && ATTEMPTS <= 50, 'P91_ATTEMPTS must be 2..50');

const RUN = `P91-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'P9-Synthetic-Pass!';
const ADMIN_EMAIL = 'p9.admin@clinic.test';

function uuid(prefix, i) {
  const h = (start, length) =>
    createHash('md5').update(`${prefix}-${i}`).digest('hex').slice(start, start + length);
  return `${h(0, 8)}-${h(8, 4)}-4${h(12, 3)}-a${h(16, 3)}-${h(18, 12)}`;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

function stats(values) {
  return {
    count: values.length,
    minMs: Math.round(Math.min(...values) * 100) / 100,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: Math.round(Math.max(...values) * 100) / 100,
    meanMs: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
  };
}

async function dbConnections() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = current_database()`,
  );
  return Number(rows[0]?.connections ?? 0);
}

const out = {
  tool: 'p91-concurrency',
  database: databaseName,
  seed: 9112026,
  run: RUN,
  iterations: ITERATIONS,
  attemptsPerIteration: ATTEMPTS,
  startedAt: new Date().toISOString(),
  iterationsData: [],
};

let server;
let baseUrl = '';
let adminToken = '';
let sequence = 0;

function nextXff(label) {
  return `198.51.100.${20 + (sequence++ % 200)}`;
}

async function api(path, { method = 'GET', token, body, xff } = {}) {
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
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return {
    status: response.status,
    body: parsed,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

async function createPatient(label, index) {
  const n = index + 1;
  const result = await api('/patients', {
    method: 'POST',
    token: adminToken,
    xff: nextXff(label),
    body: {
      firstName: 'P91Race',
      lastName: `${label}${n}`,
      phone: `012${String(20_000_000 + n).padStart(8, '0')}`,
      gender: 'FEMALE',
      acknowledgeDuplicates: true,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.patient.id;
}

async function createDoctor(label, index) {
  const email = `${RUN}-${label}-${index}@clinic.test`.toLowerCase();
  const result = await api('/users', {
    method: 'POST',
    token: adminToken,
    xff: nextXff(label),
    body: {
      firstName: 'P91Doctor',
      lastName: `${label}${index}`,
      email,
      role: 'DOCTOR',
      password: PASSWORD,
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.user.id;
}

async function main() {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await api('/auth/login', {
    method: 'POST',
    xff: nextXff('login'),
    body: { email: ADMIN_EMAIL, password: 'P9-Synthetic-Pass!' },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminToken = login.body.accessToken;

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const rssSamples = [];
  const rssTimer = setInterval(() => {
    rssSamples.push(process.memoryUsage().rss);
  }, 25);
  const cpuStart = process.cpuUsage();
  const connectionsStart = await dbConnections();
  const allWalkInLatencies = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const [patientId, doctorId] = await Promise.all([
      createPatient('patient', index),
      createDoctor('doctor', index),
    ]);

    const attempts = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, attemptIndex) =>
        api('/queue/walk-in', {
          method: 'POST',
          token: adminToken,
          xff: nextXff(`walkin-${attemptIndex}`),
          body: { patientId, doctorId, payment: { status: 'PENDING' } },
        }),
      ),
    );

    const classifications = {};
    for (const attempt of attempts) {
      const code = attempt.body?.error?.code ?? (attempt.status >= 500 ? 'HTTP_5XX' : 'NONE');
      const key = `${attempt.status}:${code}`;
      classifications[key] = (classifications[key] ?? 0) + 1;
      allWalkInLatencies.push(attempt.latencyMs);
    }
    const failureDetails = attempts
      .filter((attempt) => attempt.status >= 500)
      .map((attempt) => ({
        status: attempt.status,
        detail: attempt.body?.error?.detail ?? null,
      }));

    const entries = await prisma.queueEntry.findMany({
      where: {
        patientId,
        doctorId,
        queueDate: dateOnlyToDb(clinicDateString()),
      },
      select: { id: true, position: true },
    });
    const positions = entries.map((entry) => entry.position);
    const duplicatePositions = positions.filter(
      (position, i) => positions.indexOf(position) !== i,
    );

    const iteration = {
      index: index + 1,
      successes: attempts.filter((attempt) => attempt.status === 201).length,
      serverErrors: attempts.filter((attempt) => attempt.status >= 500).length,
      classifications,
      ...(failureDetails.length > 0 ? { failureDetails } : {}),
      queueEntries: entries.length,
      positions,
      duplicatePositions,
      latencies: stats(attempts.map((attempt) => attempt.latencyMs)),
    };
    out.iterationsData.push(iteration);

    assert.equal(iteration.successes, 1, `iteration ${index + 1}: ${JSON.stringify(classifications)}`);
    assert.equal(iteration.serverErrors, 0, `iteration ${index + 1} produced a 5xx`);
    assert.equal(iteration.queueEntries, 1, `iteration ${index + 1} created multiple queue entries`);
    assert.deepEqual(iteration.duplicatePositions, [], `iteration ${index + 1} duplicated a position`);

    if ((index + 1) % 10 === 0) {
      process.stdout.write(`[p91-concurrency] ${index + 1}/${ITERATIONS} iterations passed\n`);
    }
  }

  clearInterval(rssTimer);
  loopDelay.disable();
  const cpuEnd = process.cpuUsage(cpuStart);
  const connectionsEnd = await dbConnections();

  out.finishedAt = new Date().toISOString();
  out.summary = {
    allWalkInLatencies: stats(allWalkInLatencies),
    successfulIterations: out.iterationsData.filter((item) => item.successes === 1).length,
    totalServerErrors: out.iterationsData.reduce((sum, item) => sum + item.serverErrors, 0),
    totalRequests: allWalkInLatencies.length,
    processRssBytes: {
      start: rssSamples[0] ?? process.memoryUsage().rss,
      max: Math.max(...rssSamples, process.memoryUsage().rss),
      end: process.memoryUsage().rss,
    },
    processCpuMs: {
      user: Math.round(cpuEnd.user / 1000) / 1000,
      system: Math.round(cpuEnd.system / 1000) / 1000,
    },
    eventLoopDelayMs: {
      p50: Math.round((loopDelay.percentile(50) / 1e6) * 100) / 100,
      p95: Math.round((loopDelay.percentile(95) / 1e6) * 100) / 100,
      p99: Math.round((loopDelay.percentile(99) / 1e6) * 100) / 100,
      max: Math.round((loopDelay.max / 1e6) * 100) / 100,
    },
    dbConnections: { start: connectionsStart, end: connectionsEnd },
  };

  const target =
    process.env.P91_OUT ??
    'C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out/p91-concurrency.json';
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stdout.write(`[p91-concurrency] WROTE ${target}\n`);
}

main()
  .catch((error) => {
    out.failedAt = new Date().toISOString();
    out.error = String(error?.stack ?? error);
    const target =
      process.env.P91_OUT ??
      'C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out/p91-concurrency.json';
    writeFileSync(target, JSON.stringify(out, null, 2));
    process.stderr.write(`[p91-concurrency] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await prisma.$disconnect();
  });
