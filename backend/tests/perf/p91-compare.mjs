/**
 * Phase 9.1 evidence comparison. Reads the synthetic evidence JSON files
 * produced by the Phase 9 and Phase 9.1 harnesses and writes one corrected
 * comparison document. Read-only with respect to all databases and services.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out';
const P9_ROOT = 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out';

function read(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const concurrencyBefore = read(`${P9_ROOT}/concurrency.json`);
const concurrencyAfter = read(`${ROOT}/p91-concurrency.json`);
const explain = read(`${ROOT}/explain-comparison.json`);
const soak = read(`${ROOT}/p91-soak.json`);
const proxy = read(`${ROOT}/proxy-chain-verification.json`);
const pdfBefore = read(`${ROOT}/pdf-before-controls.json`);

function walkIn(scenario) {
  if (!scenario) return null;
  return {
    statuses: scenario.classifications ?? null,
    successes: scenario.successes ?? null,
    serverErrors: Object.entries(scenario.classifications ?? {}).reduce(
      (sum, [key, count]) => sum + (key.startsWith('5') ? count : 0),
      0,
    ),
    queueEntries: scenario.queueEntries ?? null,
    positions: scenario.positions ?? null,
  };
}

const beforeWalkIn = walkIn(
  concurrencyBefore?.scenarios?.find((scenario) => scenario.name === 'queue_walkin_position'),
);
const afterWalkIn = concurrencyAfter
  ? {
      successes: concurrencyAfter.summary.successfulIterations,
      serverErrors: concurrencyAfter.summary.totalServerErrors,
      requests: concurrencyAfter.summary.totalRequests,
      iterations: concurrencyAfter.iterations,
      latencies: concurrencyAfter.summary.allWalkInLatencies,
      allIterationsClean: concurrencyAfter.iterationsData.every(
        (item) =>
          item.successes === 1 &&
          item.serverErrors === 0 &&
          item.queueEntries === 1 &&
          item.duplicatePositions.length === 0,
      ),
    }
  : null;

const report = {
  tool: 'p91-compare',
  generatedAt: new Date().toISOString(),
  scope: 'Corrected Phase 9 -> Phase 9.1 comparison, synthetic p91 resources only',
  hostCaveat:
    'Local measurement host is AMD Ryzen 5 5600G / 6 physical cores / ~29.9 GB RAM; owner-stated production host is Xeon E3-1225 v5 / 16 GB. Absolute latency values are not directly comparable to production.',
  comparison: [
    {
      topic: 'Queue walk-in classification',
      phase9: beforeWalkIn,
      phase91: afterWalkIn,
      finding:
        beforeWalkIn?.serverErrors === 5 && afterWalkIn?.allIterationsClean === true
          ? 'FIXED: 5 HTTP 500 responses became deterministic 409 APPOINTMENT_CONFLICT across 50 repeated races with no 5xx.'
          : 'Evidence incomplete; see individual harness outputs.',
    },
    {
      topic: 'Persistent indexes',
      phase9: 'Six transient P9_* trial indexes in clinic_p9_drill, dropped after measurement; no persistent index added.',
      phase91:
        'Four persistent indexes applied by migration 20261121220000_phase91_performance_indexes; migrate diff clean; rollback verified in clinic_p91_drill.',
      evidence: explain,
      finding:
        'finance_monthly_refunds plan changed from Seq Scan to Index Scan; patient_ledger_payments gained 1.27 ms improvement; other gains are partly warm-cache effects and are reported as such.',
    },
    {
      topic: 'Proxy / rate-limit key',
      phase9: 'Risk reported: shared NAT could collapse keys and XFF could be spoofed if a proxy were bypassed.',
      phase91: proxy?.conclusions ?? null,
      finding:
        proxy?.conclusions?.spoofable === false &&
        proxy?.conclusions?.distinctClientsGetDistinctKeys === true
          ? 'CORRECTED: real Caddy -> nginx -> Express chain overwrites forwarding headers; TRUST_PROXY=1 and 2 both ignore client-supplied XFF. No proxy configuration change was necessary.'
          : 'Proxy evidence incomplete.',
    },
    {
      topic: 'Login limiter',
      phase9: '10 attempts / 15 min per IP; a shared IP could lock out every user.',
      phase91:
        'Per-IP ceiling raised to 100 and a per-account normalised-email limiter (10/15 min) added. Pre-change test showed second account behind shared IP receiving HTTP 429; post-change test passes.',
      finding: 'FIXED with a limited application change; no proxy trust boundary changed.',
    },
    {
      topic: 'PDF / Chromium',
      phase9: {
        parallelRenders: 10,
        succeeded: pdfBefore?.succeeded ?? null,
        elapsedMs: pdfBefore?.elapsedMs ?? null,
        note: 'No timeout, semaphore, bounded queue or production shutdown.',
      },
      phase91:
        '30 s render timeout, cap 2 concurrent renders, bounded queue 4, page closed on timeout, contexts closed in finally, browser closed during graceful shutdown.',
      finding:
        'Mitigated. Annual financial statement size/streaming remains a documented, owner-deferred item.',
    },
    {
      topic: 'Container / Node limits',
      phase9: 'No CPU or memory limits in docker-compose.yml; no Node heap cap.',
      phase91:
        'Optional docker-compose.limits.yml adds per-service memory/CPU/pids ceilings and NODE_OPTIONS=--max-old-space-size=1536 for backend; all three Compose configurations validate.',
      finding: 'Mitigated as an opt-in overlay; production adoption is an owner decision.',
    },
    {
      topic: 'Latency / resource SLOs',
      phase9:
        'Mixed load p95 2,291.42 ms, p99 2,402.39 ms, event-loop drift p95 4,981.14 ms, DB connections 13, Node RSS growth ~406 MB.',
      phase91:
        soak?.phases?.map((phase) => ({
          phase: phase.label,
          targetRps: phase.targetRps,
          latency: phase.client.latencyMs,
          errorRate: phase.client.errorRate,
          eventLoopP99: phase.serverMetrics.eventLoopDelayMs.p99,
          rssGrowthBytes: phase.serverMetrics.rssGrowthBytes,
          maxDbConnections: phase.serverMetrics.dbConnections.max,
          allSlosPass: phase.allSlosPass,
        })) ?? null,
      finding:
        'New figures use a different host and smaller response mix; see the Phase 9.1 report for the SLO table and caveats.',
    },
  ],
  stillOpen: [
    'Annual financial statement response size and streaming (owner deferred).',
    'Prisma 7 migration (owner deferred).',
    'Unbounded patient ledger and all-time finance aggregates need query redesign, not indexes alone.',
  ],
};

const target = `${ROOT}/p91-corrected-comparison.json`;
writeFileSync(target, JSON.stringify(report, null, 2));
process.stdout.write(`[p91-compare] WROTE ${target}\n`);
