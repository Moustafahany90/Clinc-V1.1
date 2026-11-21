/**
 * Phase 9.1 out-of-process load generator.
 *
 * Spawned by p91-soak.mjs. Runs in a separate OS process from the API so the
 * measured server event loop and RSS are not contaminated by the generator.
 */

import { performance } from 'node:perf_hooks';

const baseUrl = process.env.P91_BASE_URL;
const token = process.env.P91_TOKEN;
const label = process.env.P91_LABEL ?? 'phase';
const durationMs = Number(process.env.P91_DURATION_MS ?? 20_000);
const targetRps = Number(process.env.P91_RPS ?? 20);
const paths = (process.env.P91_PATHS ?? '/patients').split(',').filter(Boolean);

if (!baseUrl || !token) {
  process.stderr.write('[p91-load-client] P91_BASE_URL and P91_TOKEN are required\n');
  process.exit(1);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 100) / 100;
}

const latencies = [];
const statusCounts = {};
let requestIndex = 0;
let errors = 0;
const started = performance.now();
const tickMs = 100;
const perTick = Math.max(1, Math.round((targetRps * tickMs) / 1000));

async function request(path) {
  const requestStart = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        // Distinct synthetic clients per request so the per-IP API limiter
        // does not mask application capacity during the stress phase.
        'x-forwarded-for': `198.51.100.${1 + (requestIndex % 200)}`,
      },
    });
    await response.arrayBuffer();
    latencies.push(performance.now() - requestStart);
    const key = String(response.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    if (response.status >= 500) errors += 1;
  } catch (error) {
    latencies.push(performance.now() - requestStart);
    errors += 1;
    const key = `NETWORK:${error?.name ?? 'Error'}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
}

while (performance.now() - started < durationMs) {
  const tickStart = performance.now();
  const batch = [];
  for (let i = 0; i < perTick; i += 1) {
    const path = paths[requestIndex % paths.length];
    requestIndex += 1;
    batch.push(request(path));
  }
  await Promise.all(batch);
  const remaining = tickMs - (performance.now() - tickStart);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

const elapsedMs = performance.now() - started;
const result = {
  label,
  targetRps,
  durationMs: Math.round(elapsedMs),
  completedRequests: latencies.length,
  actualRps: Math.round((latencies.length / elapsedMs) * 100_000) / 100,
  statusCounts,
  errors,
  errorRate: Math.round((errors / Math.max(1, latencies.length)) * 10_000) / 10_000,
  latencyMs: {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Math.round(Math.max(0, ...latencies) * 100) / 100,
  },
  paths,
};
process.stdout.write(`__P91_RESULT__${JSON.stringify(result)}\n`);
