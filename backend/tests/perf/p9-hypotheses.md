# Phase 9 pre-measurement hypotheses

Recorded before any Phase 9 EXPLAIN, endpoint latency, load, concurrency, PDF/Chromium,
rate-limit, or container-limit measurement. Sources are the static audit of the repository at
`e55119fd8067316ebc4af23d93c468f399a7efc6` plus the seeded synthetic dataset only. Nothing
below is treated as measured fact until a Phase 9 harness produces evidence.

Synthetic dataset context: `clinic_p9_test`, deterministic seed `9112026`, 20,000 patients,
60,000 appointments, 30,000 queue entries, 20,000 expenses, 60,000 charges, 60,000 payments,
48,000 allocations, 5,400 refunds, 30,000 visits, 60,000 measurements, 30,000 reports,
60,000 report versions, 100,000 file assets, and 200,000 audit-log rows.

| Rank | Hypothesis | Static evidence | Measurement that will confirm/refute |
| --- | --- | --- | --- |
| H1 | Financial reads (ledger, dashboard, export) are unbounded and not point-in-time; latency and buffer reads will grow with the synthetic history, and concurrent writes may change totals mid-read. | Financial modules/routes use broad Prisma `findMany`/aggregate paths without explicit transaction snapshots or date bounds. | EXPLAIN on ledger/aggregate shapes; p50/p95/p99 and returned row/byte counts; invariant checks before/after concurrent write load. |
| H2 | Advisory-lock hot paths plus default isolation and no Prisma transaction timeout will produce queuing, `P2028`, and tail-latency spikes under contention; invariants may remain clean while losing requests error. | `payments/routes.ts` uses `pg_advisory_xact_lock(hashtext(doctorId))`, `pg_advisory_xact_lock(hashtext(patientId))`, `pg_advisory_xact_lock(hashtext('report-visit:'+visit.id))`, setup lock constant `918273645`; no explicit isolation/maxWait/timeout/P2028 handling. Phase 3 already recorded clean invariants with loser-side `P2028`. | Concurrent payment/refund/void/appointment/queue/report scenarios with error classification and SQL invariant checks. |
| H3 | PDF generation is a shared-resource bottleneck: one Chromium instance, context-per-render, no render timeout, no concurrency semaphore, no abort handling, and no production `browser.close()`. | `backend/src/lib/htmlPdf.ts`. | Concurrent PDF renders with duration/resource sampling, cancellation/abort probe, and Chromium process/memory observation. |
| H4 | Rate limiters keyed only on `req.ip` will throttle many staff behind one NAT and may trust a spoofable XFF path if Caddy is bypassed. | `backend/src/middleware/rateLimit.ts`: api 600/min, login 10/15min, refresh 120/15min, passwordSetup 20/hour, setup 10/hour, upload 60/10min, reportDelivery 20/10min; `TRUST_PROXY=1`; Caddy -> nginx -> Express topology. | Controlled synthetic-IP/XFF requests against a local test server; status 429 and `Retry-After` checks. |
| H5 | Query plans will degrade for `contains`/`mode: 'insensitive'` searches, whole-table position aggregates, and unbounded agenda/queue/export reads; several missing indexes will show sequential scans or large sorts. | Static index/query inventory: no indexed `contains` support; no standalone `Refund.refundedAt`, `Refund.paymentId`, `[reportId, createdAt]`, `[reportId, updatedAt]`, `[visitId, createdAt]`, `[visitId, measuredAt]`; no `Report.updatedAt`; weekly revenue performs roughly 40 Prisma reads. | `EXPLAIN (ANALYZE, BUFFERS)` before indexes; optional proposed indexes only in `clinic_p9_drill`, then dropped; endpoint percentile and scan/row comparisons. |
| H6 | TOCTOU pre-checks will surface as raw `P2002` or 404/409 races instead of deterministic conflicts under concurrency. | Appointment/queue transition pre-reads; queue walk-in pre-count without unique position; payment/expense/direct-charge idempotency pre-checks; report delete race; file finalized-record race. | Concurrent duplicate-create/transition scenarios with exact error-code capture and final SQL state. |
| H7 | All-time position calculations and large exports will allocate disproportionate memory/CPU and produce oversized responses. | Static route inspection of finance/position/export paths; no server-side pagination caps on some unbounded reads. | EXPLAIN row/buffer counts, response byte sizes, RSS sampling during load. |
| H8 | Container/runtime settings lack memory/CPU limits, so load can exhaust the host or be killed unpredictably; Node heap has no explicit production cap. | `docker-compose.yml` and CI/release docs show no deploy resource limits; no `NODE_OPTIONS=--max-old-space-size` in runtime config. | Disposable `p9*` container memory-limit drill only; observe RSS/OOM behavior and report, never modify production compose. |
| H9 | Setup advisory lock constant is global rather than tenant-scoped, creating avoidable cross-clinic blocking. | Constant `918273645` in setup path. | Contention probe instrumentation/report only; no production code change. |

## Decision rules

- A hypothesis is "confirmed" only by harness output saved under the Phase 9 evidence directory.
- Severity will be assigned by measured impact (error rate, tail latency, resource use, invariant damage),
  not by static severity alone.
- Any verified defect will be reported to the owner without an application/schema/Compose/CI fix.
- Proposed indexes, if tested, will exist only transiently in `clinic_p9_drill` and will be dropped after measurement.
- All generated data, users, emails, markers, and resources are synthetic and `P9-`-prefixed.
