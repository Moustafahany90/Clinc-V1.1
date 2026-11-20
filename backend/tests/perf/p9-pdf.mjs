/**
 * Phase 9 PDF/Chromium concurrency and resource harness.
 *
 * Run from backend/:
 *   node --import tsx tests/perf/p9-pdf.mjs
 *
 * This exercises the production renderHtmlToPdf() path with synthetic P9-
 * HTML only. It makes no database, API, WhatsApp, Telegram, or network calls.
 * The shared Chromium instance is closed by this short-lived process at exit.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { closeHtmlPdfBrowser, renderHtmlToPdf } from '../../src/lib/htmlPdf.js';

const execFileAsync = promisify(execFile);

const outPath =
  process.env.P9_OUT ?? 'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/pdf.json';
const htmlRows = Number(process.env.P9_PDF_ROWS ?? 250);
const concurrency = Number(process.env.P9_PDF_CONCURRENCY ?? 6);
assert.ok(Number.isInteger(htmlRows) && htmlRows > 0, 'P9_PDF_ROWS must be a positive integer');
assert.ok(
  Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 16,
  'P9_PDF_CONCURRENCY must be 1..16',
);

const out = {
  tool: 'p9-pdf',
  seed: 9112026,
  startedAt: new Date().toISOString(),
  htmlRows,
  concurrency,
  sequential: [],
  concurrent: [],
  chromium: {
    processCountMin: 0,
    processCountMax: 0,
    rssStartBytes: 0,
    rssPeakBytes: 0,
    observedPids: [],
  },
  nodeRss: {},
  abortProbe: {},
};

function syntheticHtml(rowCount) {
  const rows = Array.from(
    { length: rowCount },
    (_, i) =>
      `<tr><td>P9-PAT-${String(i + 1).padStart(5, '0')}</td>` +
      `<td>P9-Synthetic-Patient-${i + 1}</td><td>2022-06-${String((i % 28) + 1).padStart(2, '0')}</td>` +
      `<td>P9-Synthetic-Observation-${i + 1}</td></tr>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 12mm; }
    body { font-family: Arial, sans-serif; font-size: 9px; color: #111; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #999; padding: 2px 3px; text-align: left; }
    th { background: #eee; }
  </style></head><body><h1>P9-Synthetic Report</h1>
  <table><thead><tr><th>ID</th><th>Name</th><th>Date</th><th>Observation</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

async function sampleChromium() {
  // Get-Process is much cheaper than Get-CimInstance. Sampling is asynchronous
  // so the PowerShell probe does not inflate the measured render latency.
  const script = [
    "$procs = Get-Process -Name chrome,chrome-headless-shell -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' }",
    "foreach ($p in $procs) { '{0},{1}' -f $p.Id, $p.WorkingSet64 }",
  ].join('\n');
  let stdout = '';
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return { count: 0, rssBytes: 0, pids: [] };
  }
  const pids = [];
  let rssBytes = 0;
  for (const line of stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const [pid, bytes] = line.split(',');
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid)) continue;
    pids.push(numericPid);
    rssBytes += Number(bytes ?? 0);
  }
  return { count: pids.length, rssBytes, pids };
}

const sampleIntervalMs = 250;
const pidsSeen = new Set();
let sampling = false;
let samplerInFlight = Promise.resolve();
let rssPeakBytes = 0;
let nodeRssPeakBytes = process.memoryUsage().rss;
let processCountMin = Number.POSITIVE_INFINITY;
let processCountMax = 0;
let eventLoopExpected = performance.now();
const eventLoopDriftMs = [];

function recordSample(sample) {
  nodeRssPeakBytes = Math.max(nodeRssPeakBytes, process.memoryUsage().rss);
  for (const pid of sample.pids) pidsSeen.add(pid);
  rssPeakBytes = Math.max(rssPeakBytes, sample.rssBytes);
  if (sample.count > 0) {
    processCountMin = Math.min(processCountMin, sample.count);
    processCountMax = Math.max(processCountMax, sample.count);
  }
}

const sampler = setInterval(() => {
  if (!sampling) return;
  const now = performance.now();
  eventLoopDriftMs.push(Math.max(0, now - eventLoopExpected - sampleIntervalMs));
  eventLoopExpected += sampleIntervalMs;
  samplerInFlight = sampleChromium().then(recordSample).catch(() => undefined);
}, sampleIntervalMs);

async function timedRender(html) {
  const started = performance.now();
  const pdf = await renderHtmlToPdf(html, 'Letter');
  return { ms: performance.now() - started, bytes: pdf.length };
}

function summarize(samples) {
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const bytes = samples.map((s) => s.bytes).sort((a, b) => a - b);
  return {
    count: samples.length,
    p50Ms: Number(percentile(times, 0.5)?.toFixed(2) ?? 0),
    p95Ms: Number(percentile(times, 0.95)?.toFixed(2) ?? 0),
    p99Ms: Number(percentile(times, 0.99)?.toFixed(2) ?? 0),
    maxMs: Number((times.at(-1) ?? 0).toFixed(2)),
    wallMs: Number(Math.max(...times).toFixed(2)),
    p50Bytes: percentile(bytes, 0.5) ?? 0,
    maxBytes: bytes.at(-1) ?? 0,
  };
}

async function main() {
  const html = syntheticHtml(htmlRows);
  const nodeRssStart = process.memoryUsage().rss;
  sampling = true;
  const baseline = await sampleChromium();
  out.chromium.rssStartBytes = baseline.rssBytes;
  recordSample(baseline);

  await timedRender(html); // warm the shared browser and verify local Chromium exists

  for (let i = 0; i < 3; i += 1) out.sequential.push(await timedRender(html));
  const parallelStart = performance.now();
  const parallel = await Promise.all(
    Array.from({ length: concurrency }, () => timedRender(html)),
  );
  const parallelWallMs = performance.now() - parallelStart;
  out.concurrent = parallel;
  out.parallelWallMs = Number(parallelWallMs.toFixed(2));

  // The production renderer has no AbortSignal parameter. A harness-side timeout
  // therefore cannot cancel an in-flight render; record whether it kept running.
  const abortStarted = performance.now();
  const renderPromise = timedRender(syntheticHtml(Math.max(htmlRows, 1500)));
  let timedOut = false;
  let completed = false;
  renderPromise.then(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  timedOut = !completed;
  const abortResult = await renderPromise;
  out.abortProbe = {
    harnessTimeoutMs: 100,
    timedOutBeforeRendererFinished: timedOut,
    rendererContinuedToCompletion: true,
    completionMs: Number((performance.now() - abortStarted).toFixed(2)),
    completedBytes: abortResult.bytes,
    productionRendererAcceptsAbortSignal: false,
  };

  sampling = false;
  clearInterval(sampler);
  await samplerInFlight;
  const finalSample = await sampleChromium();
  recordSample(finalSample);

  out.sequentialSummary = summarize(out.sequential);
  out.concurrentSummary = summarize(out.concurrent);
  out.parallelWallMs = Number(parallelWallMs.toFixed(2));
  out.speedupVsSequentialSum = Number(
    (
      out.sequential.reduce((sum, s) => sum + s.ms, 0) / Math.max(parallelWallMs, 1)
    ).toFixed(2),
  );
  out.chromium.processCountMin = Number.isFinite(processCountMin)
    ? processCountMin
    : finalSample.count;
  out.chromium.processCountMax = Math.max(processCountMax, finalSample.count);
  out.chromium.rssPeakBytes = rssPeakBytes;
  out.chromium.observedPids = [...pidsSeen].sort((a, b) => a - b);
  out.nodeRss = {
    startBytes: nodeRssStart,
    peakBytes: Math.max(nodeRssStart, nodeRssPeakBytes, process.memoryUsage().rss),
    endBytes: process.memoryUsage().rss,
  };
  out.eventLoopDriftP95Ms = Number(
    percentile(eventLoopDriftMs.sort((a, b) => a - b), 0.95)?.toFixed(2) ?? 0,
  );
  out.eventLoopDriftMaxMs = Number(Math.max(0, ...eventLoopDriftMs).toFixed(2));
  out.finishedAt = new Date().toISOString();

  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.stdout.write(
    `[p9-pdf] seq p50=${out.sequentialSummary.p50Ms}ms p95=${out.sequentialSummary.p95Ms}ms ` +
      `parallel wall=${out.parallelWallMs}ms chromeRssPeak=${rssPeakBytes} ` +
      `chromeProcs=${out.chromium.processCountMax}\n`,
  );
  process.stdout.write(`[p9-pdf] WROTE ${outPath}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p9-pdf] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(sampler);
    await closeHtmlPdfBrowser().catch(() => undefined);
  });
