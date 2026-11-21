/**
 * Phase 9.1 out-of-process soak/stress harness. All records are synthetic.
 *
 * Run from backend/ against the seeded disposable test database:
 *   node --import tsx tests/perf/p91-soak.mjs
 *
 * The API runs in this process; the load generator runs in a separate OS
 * process (p91-load-client.mjs). Server-side RSS, CPU, event-loop lag and DB
 * connection counts are sampled only in the API process.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Match the verified production proxy topology (Caddy -> nginx -> Express)
// before importing the app, so per-request synthetic XFF IPs are honoured and
// the per-IP API limiter does not mask application capacity.
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../../src/app.js');
const { prisma } = await import('../../src/lib/prisma.js');

const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
assert.match(databaseName, /_test$/, 'P91 soak requires a *_test database');
assert.equal(databaseName, 'clinic_p9_test', 'P91 soak requires clinic_p9_test');

const PHASES = [
  {
    label: 'soak',
    durationMs: Number(process.env.P91_SOAK_MS ?? 20_000),
    rps: Number(process.env.P91_SOAK_RPS ?? 20),
  },
  {
    label: 'stress',
    durationMs: Number(process.env.P91_STRESS_MS ?? 10_000),
    rps: Number(process.env.P91_STRESS_RPS ?? 100),
  },
];
const PATHS = process.env.P91_PATHS ?? '/patients,/queue,/financial-reports/daily';

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

async function dbConnections() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = current_database()`,
  );
  return Number(rows[0]?.connections ?? 0);
}

function runLoadClient(baseUrl, token, phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/perf/p91-load-client.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        P91_BASE_URL: baseUrl,
        P91_TOKEN: token,
        P91_LABEL: phase.label,
        P91_DURATION_MS: String(phase.durationMs),
        P91_RPS: String(phase.rps),
        P91_PATHS: PATHS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const marker = '__P91_RESULT__';
      const index = stdout.indexOf(marker);
      if (code !== 0 || index < 0) {
        reject(new Error(`load client failed (code ${code}): ${stderr || stdout}`));
        return;
      }
      const line = stdout.slice(index + marker.length).split('\n')[0];
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid load client result: ${line}: ${error}`));
      }
    });
  });
}

function slo(label, actual, comparison, target) {
  const pass = comparison === '<=' ? actual <= target : actual >= target;
  return { slo: label, actual, comparison, target, pass };
}

const out = {
  tool: 'p91-soak',
  database: databaseName,
  seed: 9112026,
  startedAt: new Date().toISOString(),
  loadGeneratorProcess: 'separate OS process (child_process.spawn)',
  paths: PATHS.split(','),
  phases: [],
};

let server;

async function main() {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'p9.admin@clinic.test', password: 'P9-Synthetic-Pass!' }),
  });
  const loginBody = await login.text();
  assert.equal(login.status, 200, loginBody);
  const token = JSON.parse(loginBody).accessToken;

  for (const phase of PHASES) {
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const rssSamples = [];
    const connectionSamples = [];
    const rssTimer = setInterval(() => {
      rssSamples.push(process.memoryUsage().rss);
    }, 50);
    const connectionTimer = setInterval(() => {
      dbConnections()
        .then((value) => connectionSamples.push(value))
        .catch(() => undefined);
    }, 500);
    const cpuStart = process.cpuUsage();
    const connectionsStart = await dbConnections();
    const started = performance.now();

    const client = await runLoadClient(baseUrl, token, phase);

    const elapsedMs = performance.now() - started;
    clearInterval(rssTimer);
    clearInterval(connectionTimer);
    loopDelay.disable();
    const cpuEnd = process.cpuUsage(cpuStart);
    const connectionsEnd = await dbConnections();

    const serverMetrics = {
      wallMs: Math.round(elapsedMs),
      rssBytes: {
        start: rssSamples[0] ?? process.memoryUsage().rss,
        max: Math.max(...rssSamples, process.memoryUsage().rss),
        end: process.memoryUsage().rss,
      },
      rssGrowthBytes:
        (rssSamples.at(-1) ?? process.memoryUsage().rss) - (rssSamples[0] ?? 0),
      cpuMs: {
        user: Math.round(cpuEnd.user / 1000) / 1000,
        system: Math.round(cpuEnd.system / 1000) / 1000,
      },
      eventLoopDelayMs: {
        p50: Math.round((loopDelay.percentile(50) / 1e6) * 100) / 100,
        p95: Math.round((loopDelay.percentile(95) / 1e6) * 100) / 100,
        p99: Math.round((loopDelay.percentile(99) / 1e6) * 100) / 100,
        max: Math.round((loopDelay.max / 1e6) * 100) / 100,
      },
      dbConnections: {
        start: connectionsStart,
        end: connectionsEnd,
        max: Math.max(connectionsStart, connectionsEnd, ...connectionSamples),
      },
    };

    const isSoak = phase.label === 'soak';
    const slos = [
      slo('p95 latency', client.latencyMs.p95, '<=', isSoak ? 500 : 1500),
      slo('p99 latency', client.latencyMs.p99, '<=', isSoak ? 1000 : 3000),
      slo('error rate', client.errorRate, '<=', 0.01),
      slo('server 5xx', client.statusCounts['500'] ?? 0, '<=', 0),
      slo('event-loop p99 (ms)', serverMetrics.eventLoopDelayMs.p99, '<=', isSoak ? 100 : 300),
      slo('RSS growth (bytes)', serverMetrics.rssGrowthBytes, '<=', 150 * 1024 * 1024),
      slo('max DB connections', serverMetrics.dbConnections.max, '<=', 20),
    ];

    out.phases.push({
      label: phase.label,
      targetRps: phase.rps,
      targetDurationMs: phase.durationMs,
      client,
      serverMetrics,
      slos,
      allSlosPass: slos.every((item) => item.pass),
    });
    process.stdout.write(
      `[p91-soak] ${phase.label}: ${client.completedRequests} requests, ` +
        `p95=${client.latencyMs.p95}ms, p99=${client.latencyMs.p99}ms, ` +
        `errors=${client.errors}, SLO=${slos.every((item) => item.pass) ? 'PASS' : 'FAIL'}\n`,
    );
  }

  out.finishedAt = new Date().toISOString();
  const target =
    process.env.P91_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out/p91-soak.json';
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stdout.write(`[p91-soak] WROTE ${target}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p91-soak] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await prisma.$disconnect();
  });
