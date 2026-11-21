# Production Readiness — Phase 9.1 Remediation and Measurements

**Date:** 2026-11-21
**Branch:** `fix/phase9-remediation` (created from `fe7b56367cfd5b6a7b82c17471367f866c93af59`; no fetch)
**Base report:** `docs/PRODUCTION_READINESS_PHASE9.md`
**Scope:** Owner-approved remediation of the Phase 9 findings plus the missing concurrency, soak/stress and corrected-comparison measurements. Synthetic `p91*` resources only.

---

## 1. Executive summary

| Item | Phase 9 finding | Phase 9.1 result |
|---|---|---|
| Queue walk-in 500 | 1×201, **5×500 `INTERNAL`** (wrapped `23P01`) | **Fixed.** 50 repeated 6-way races: **50×201 + 250×409**, **0×5xx**, one queue entry per race, no duplicate positions |
| Concurrent-walk-in deadlock | Not previously exercised repeatedly | **New finding, fixed.** Repeated races exposed PostgreSQL `40P01` GiST deadlocks and 5 s Prisma transaction expiry (`P2028`); a transaction-scoped per-doctor advisory lock removes them |
| PDF / Chromium | 10 parallel renders, no timeout/cap/queue/shutdown | **Mitigated.** 30 s timeout, cap 2, queue 4, bounded contexts, page closed on timeout, browser closed on shutdown; 6/6 tests pass |
| Query plans | Six transient trial indexes, none persistent | **Four persistent indexes** added by migration; `migrate diff` clean; 45 CHECK constraints intact; rollback verified |
| Proxy / rate limit | XFF spoof risk; shared-IP login lockout | **Corrected.** Real Caddy→nginx→Express verified spoof-safe; no proxy change needed. Shared-IP lockout fixed with 100/IP + 10/account login limits |
| Container limits | No CPU/memory ceilings; no Node heap cap | **Optional overlay** added; all three Compose configurations validate |
| Latency / soak SLOs | Mixed-load p95 2,291 ms, p99 2,402 ms, event-loop p95 4,981 ms | New out-of-process soak and stress phases pass all SLOs (see §8) |

**Decision gate:** All owner-approved items are implemented and verified. Owner-deferred items (annual statement streaming, Prisma 7) remain open and were not touched. No production access, deployment, push, PR, GitHub Actions run, or change to `main` occurred.

---

## 2. Safety and scope confirmation

- Every database used ends in `_test` or `_drill`: `clinic_p9_test`, `clinic_p91_drill`, `clinic_p91_shadow_test`, `clinic_p91_login_test`.
- Containers/networks/volumes were named `p91-*`; existing `ultrasound-clinic-*` resources were never started, stopped or modified.
- All records are synthetic (`P9-`/`P91-` prefixes, TEST-NET IPs, synthetic JWT/WhatsApp/ACME values). No real patient data, WhatsApp, Telegram or ACME credentials were used.
- No `git push`, PR, branch deletion, rebase, reset, clean, force operation, `git add -A`, or commit on `main`.
- No PowerShell `>`/`>>` redirection; evidence written with `Tee-Object`/`Set-Content`/Node `writeFileSync`.
- All edited/created files were checked for NUL bytes and UTF-8 BOM: **all false**.
- **GitHub Actions status: NOT RUN.** CI-equivalent checks were executed locally (§9) only.

---

## 3. Changes delivered

| Commit | Change |
|---|---|
| `1dc3762` | Map wrapped `23P01` exclusion violations to `409 APPOINTMENT_CONFLICT` |
| `601e8be` | Bound Chromium renders (timeout/cap/queue/cleanup) and close browser on shutdown |
| `68d23e5` | Raise login IP ceiling to 100 and add per-account normalised-email limiter (10/15 min) |
| `d2661be` | Four persistent read-path indexes + migration |
| `219d5fa` | Optional `docker-compose.limits.yml` overlay |
| `a8dff04` | Serialize per-doctor walk-ins with a transaction-scoped advisory lock (`40P01` fix) |
| `abd1a48` | Four Phase 9.1 synthetic measurement harnesses |

Proxy verification produced evidence only; no proxy file was changed. `p7-check-containers.sh` was not modified or used.

---

## 4. Queue walk-in: verified fix and newly found deadlock

### 4.1 Original defect (Phase 9)

Six simultaneous walk-ins produced `1×201 + 5×500 INTERNAL`. PostgreSQL `23P01` exclusion violations were wrapped by Prisma and missed by `errorHandler`. `1dc3762` extended the existing 3-path overlap detector (plain driver error, structured nested cause, Prisma text wrapper), yielding `1×201 + 5×409` with one persisted queue entry.

### 4.2 Newly found deadlock under repeated races

The 50-iteration harness initially failed at iteration 2–3 with all six attempts returning `500 INTERNAL` after 1–5 s. Full error details (saved in `p91-concurrency-debug.json`) showed:

```text
PostgresError { code: "40P01", message: "deadlock detected",
  detail: "Process 4348 waits for ShareLock on transaction 1446; blocked by process 4340..." }
Transaction API error: Transaction already closed ... timeout for this transaction was 5000 ms ...
```

The appointment exclusion constraint is:

```sql
EXCLUDE USING gist ("doctorId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&)
WHERE status IN ('BOOKED','CONFIRMED','ARRIVED','WAITING','IN_EXAM','REPORT_REVIEW')
```

Concurrent inserts for the same doctor can deadlock while their GiST share locks intersect. `40P01` was not classified by `errorHandler`, so clients saw 500; waiting transactions also hit Prisma's 5 s interactive-transaction timeout (`P2028`).

### 4.3 Fix

`a8dff04` adds a transaction-scoped advisory lock at the start of the walk-in transaction:

```ts
await tx.$queryRaw`SELECT 1 AS locked
  FROM (SELECT pg_advisory_xact_lock(hashtext(${doctor.id}::text))) AS advisor`;
```

The lock is released on commit/rollback, serialises only inserts for the same doctor, and makes the race deterministic: one insert wins, the rest fail with `23P01` and are mapped to `409 APPOINTMENT_CONFLICT`. No global error-mapping change was made. The subquery cast avoids Prisma's inability to deserialize PostgreSQL's `void` type.

### 4.4 Result

| Run | Result | Evidence |
|---|---|---|
| Before any fix | `1×201 + 5×500` | `docs/PRODUCTION_READINESS_PHASE9.md` §4 |
| After `23P01` fix, single race | `1×201 + 5×409` | `concurrency-after-queue-fix.json` |
| Repeated races, before advisory lock | deadlock at iteration 2–3, `0` successes, `6` 5xx | `p91-concurrency-debug.json` |
| 6 iterations, after advisory lock | `6/6` clean | `p91-concurrency-after-lock.json` |
| **50 iterations, final** | **50/50 clean, 0 5xx** | `p91-concurrency.json` |

---

## 5. PDF / Chromium controls

`601e8be` added `PDF_RENDER_TIMEOUT_MS` (default 30,000; 1,000–300,000), `PDF_MAX_CONCURRENT_RENDERS` (2; 1–16) and `PDF_MAX_QUEUE_SIZE` (4; 0–64) to `env.ts` and `.env.example`.

- `renderHtmlToPdf` acquires a bounded semaphore slot; excess renders fail fast with `PDF_RENDER_BUSY`.
- `renderPageWithTimeout` closes the page on timeout so the in-flight Chromium operation is cancelled (not just abandoned by `Promise.race`).
- Every render closes its `BrowserContext` in `finally`; a cleanup failure is logged and never masks the render error.
- `closeHtmlPdfBrowser()` is called from the graceful shutdown path in `index.ts`, so short-lived processes exit.
- `htmlPdfDiagnostics()` exposes read-only counters for tests.

Tests: `pdf-timeout.test.ts`, `pdf-resource-controls.test.ts`, `pdf-delivery-failure.test.ts` — **6/6 pass**. The delivery-failure test confirms a renderer failure marks the WhatsApp delivery `FAILED`, never `PENDING`.

---

## 6. Indexes

Migration `20261121220000_phase91_performance_indexes` adds exactly four indexes:

```sql
CREATE INDEX "Refund_refundedAt_idx" ON "Refund"("refundedAt");
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Measurement_visitId_measuredAt_idx" ON "Measurement"("visitId", "measuredAt");
CREATE INDEX "FileAsset_patientId_createdAt_idx" ON "FileAsset"("patientId", "createdAt");
```

Validation (all on synthetic DBs):
- `prisma migrate diff --exit-code`: **No difference detected** (exit 0).
- Applied to `clinic_p9_test` and `clinic_p91_login_test`.
- `clinic_p9_test`: all 4 indexes present; **45** CHECK constraints intact; 9 migrations applied.
- Transactional rollback in `clinic_p9_test`: drop → `0` indexes; `ROLLBACK` → `4` restored. The disposable `clinic_p91_drill` remains intentionally post-rollback (verified separately).

EXPLAIN `(ANALYZE, BUFFERS)` before/after on the reseeded 20k-patient dataset (`explain-comparison.json`):

| Query | Before | After | Interpretation |
|---|---:|---:|---|
| `finance_position_charges` | 16.16 ms, 2,444 read buffers | 10.30 ms, 0 read | Mostly warm-cache benefit; plan still seq scan |
| `finance_position_payments` | 14.72 ms, 1,962 read | 7.89 ms, 0 read | Mostly warm-cache benefit |
| `finance_monthly_refunds` | 0.54 ms, seq scan | **0.20 ms, index scan** | Genuine plan change from `Refund_refundedAt_idx` |
| `patient_ledger_payments` | 1.47 ms, 1 seq scan, 27 read | **0.20 ms, 0 seq scan, 6 read** | Genuine improvement from `Refund_paymentId_idx` |
| `finance_monthly_payments` | 1.96 ms | 1.68 ms | Small; existing index |

All-time finance aggregates and case-insensitive duplicate lookups remain unindexed by design; they need application-level query changes (owner-deferred / out of scope). Warm-cache effects are reported as such, not attributed to indexes.

---

## 7. Proxy and rate limiting

### 7.1 Proxy chain (evidence only, no change)

`proxy-chain-verification.json` confirms with the real `p91-caddy-1 → p91-web-1 → p91-backend-1` chain:
- Clients `172.24.0.11` and `172.24.0.12` produced distinct `req.ip` values and distinct rate-limit keys.
- Client-supplied `X-Forwarded-For: 203.0.113.9` was ignored at both `TRUST_PROXY=1` and `TRUST_PROXY=2`.
- Conclusion: `spoofable: false`, `distinctClientsGetDistinctKeys: true`. **No proxy configuration change was necessary.**

### 7.2 Login limiter

`loginLimiter` raised from 10 to **100 per IP / 15 min**; new `loginAccountLimiter` keys on the trimmed, lowercased `email` (10 / 15 min), falling back to IP for malformed bodies. Wired into `/auth/login` in `auth/routes.ts`.

- Pre-change (`login-limiter-before.txt`): 10 failed attempts for account A from shared IP `198.51.100.77` caused account B's valid login from the same IP to return **429**.
- Post-change (`login-limiter-after.txt`): account B logs in **200**; repeated attempts against one email from different IPs are blocked by the per-account limiter.
- `login-rate-limit.test.ts`: **2/2 pass**.

---

## 8. Containers, limits and measurements

### 8.1 Resource overlay

`docker-compose.limits.yml` sets: db 4g/2 CPU, migrate 1g, backend 3g/1.5 CPU with `NODE_OPTIONS=--max-old-space-size=1536`, web 256m, evolution 1g. Caddy is intentionally omitted because it is defined only in `docker-compose.tls.yml`; declaring it here would create an inert service in base-only deployments. All three configurations validate with exit 0:

```text
docker-compose.yml                                   -> 0
docker-compose.yml + docker-compose.limits.yml       -> 0
docker-compose.yml + docker-compose.tls.yml + limits -> 0
```

Idle `p91-*` container baseline: `container-resource-baseline.json`. Host caveat: local AMD Ryzen 5 5600G, 6 physical / 12 logical cores, 29,925,617,664 bytes RAM; owner-stated production host is Xeon E3-1225 v5 / 16 GB. Absolute latencies are not directly comparable to production.

### 8.2 50-iteration concurrency (`p91-concurrency.json`)

```text
iterations: 50   attempts: 6 each   requests: 300
successes: 50    server errors: 0   all clean: true
latency ms: p50 35.04 | p95 46.04 | p99 98.09 | max 111.79 | mean 36.91
event-loop delay ms: p50 11.33 | p95 17.79 | p99 24.49 | max 26.49
process RSS: 280.5 MB start -> 317.1 MB max -> 302.4 MB end
DB connections: 1 -> 9
```

### 8.3 Out-of-process soak / stress (`p91-soak.json`)

The API ran in one OS process; the load generator ran in a separate child process (`p91-load-client.mjs`) with distinct synthetic XFF IPs and `TRUST_PROXY=1`, matching the verified production topology. Paths: `/patients`, `/queue`, `/financial-reports/daily`.

| SLO | Soak (20 RPS / 20 s) | Target | Stress (100 RPS / 10 s) | Target | Pass |
|---|---:|---:|---:|---:|---|
| Requests / actual RPS | 380 / 18.94 | — | 940 / 93.37 | — | — |
| Status | 380×200 | — | 940×200 | — | — |
| p50 latency | 29.70 ms | — | 58.68 ms | — | — |
| p95 latency | 43.77 ms | ≤ 500 ms | 78.38 ms | ≤ 1,500 ms | ✅ |
| p99 latency | 58.50 ms | ≤ 1,000 ms | 89.49 ms | ≤ 3,000 ms | ✅ |
| Error rate | 0 | ≤ 1% | 0 | ≤ 1% | ✅ |
| Server 5xx | 0 | 0 | 0 | 0 | ✅ |
| Event-loop p99 | 22.59 ms | ≤ 100 ms | 24.31 ms | ≤ 300 ms | ✅ |
| RSS growth | −88.4 MB | ≤ 150 MB | +8.0 MB | ≤ 150 MB | ✅ |
| Max DB connections | 10 | ≤ 20 | 13 | ≤ 20 | ✅ |

A first run from a single IP was capped by the API limiter (733×429 at 100 RPS; `p91-soak-limiter-capped.json`). That evidence is retained: it demonstrates the 600/min/IP `apiLimiter` behaves as configured; the corrected run above isolates application capacity.

### 8.4 Corrected comparison (`p91-corrected-comparison.json`)

`p91-compare.mjs` assembles the Phase 9 → Phase 9.1 deltas across all topics. Key corrections: the queue defect is fixed across 50 races; proxy risk is closed by measurement rather than configuration; the login shared-IP lockout is fixed; the four indexes are persistent and migration-managed; PDF and container risks are mitigated; latency figures use a different host and a smaller response mix and are reported with that caveat.

---

## 9. CI-equivalent validation (local, GitHub Actions NOT RUN)

| Check | Result |
|---|---|
| Backend suite, `TZ=UTC` (`clinic_p91_login_test`) | **190/190 pass** (`backend-suite-utc.txt`) |
| Backend suite, `TZ=Africa/Cairo` | **190/190 pass** (`backend-suite-cairo.txt`) |
| Backend `npm run typecheck` + `npm run build` | exit 0 |
| Web `npm run test:run` | **42/42 pass**, 7 files (`web`) |
| Web `npm run typecheck` | exit 0 |
| `node scripts/secret-scan.mjs` | 0 actionable (2 allowlisted fixtures) |
| `secret-scan-regression.test.mjs` | **10/10 pass** |
| `scripts/dependency-audit.mjs` | exit 0; known Prisma 6.x advisory cluster (4 high) accepted with warning; Prisma 7 deferred by owner |
| `scripts/p72-phase7-regression.sh` | `PASS telegram_success=1 telegram_retry=2 heartbeat_cycle=1 heartbeat_retry=2 rotation_keep=2 redaction_markers=0 secrets_in_output=0` |
| `prisma migrate diff --exit-code` | No difference detected (exit 0) |
| Index / CHECK / rollback verification | 4 indexes, 45 CHECK constraints, rollback 4→0→4 |
| Three Compose configurations | all exit 0 |
| GitHub Actions | **NOT RUN** |

---

## 10. Residual risk and owner-deferred items

1. **Annual financial statement** remains ~3.78 MB with ~508 ms p50 in the Phase 9 baseline. Size reduction/streaming was explicitly deferred by the owner; not changed.
2. **Prisma 7** migration remains deferred; the documented 4-high advisory exception is still accepted by the audit wrapper.
3. **All-time finance aggregates** and case-insensitive patient duplicate lookups still scan large tables; indexes do not fix them. No application query redesign was in scope.
4. **Resource overlay is opt-in.** Production adoption of `docker-compose.limits.yml` is an owner decision. Caddy remains unthrottled when TLS is enabled.
5. **Local host differs from production**; absolute latency numbers in §8 are directional, not production SLAs.
6. `p7-check-containers.sh` was reviewed and found read-only, but was not run because it writes monitor state and may emit alerts; no change was made to it.

---

## 11. Repro commands

```bash
# From backend/ with DATABASE_URL pointing at a synthetic *_test DB:
node --import tsx tests/perf/p91-concurrency.mjs          # set P91_ITERATIONS, P91_OUT
node --import tsx tests/perf/p91-soak.mjs                 # set P91_OUT
node tests/perf/p91-compare.mjs

# Validation:
npm run typecheck && npm run build
TZ=UTC npm test
TZ=Africa/Cairo npm test
node scripts/secret-scan.mjs
node --test scripts/secret-scan-regression.test.mjs
node scripts/dependency-audit.mjs <npm-audit.json>
bash scripts/p72-phase7-regression.sh
npx prisma migrate diff --exit-code \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url '<synthetic _test DB URL>'
docker compose -f docker-compose.yml -f docker-compose.limits.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.tls.yml -f docker-compose.limits.yml config --quiet
```

Evidence files are in `C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out/`.

---

## 12. Cleanup targets (p91 only)

All disposable resources were named `p91*`. Before deletion the exact target list is printed; only the following are removed:

- Containers: `p91-postgres`, `p91-caddy-1`, `p91-web-1`, `p91-backend-1`, `p91-db-1`, `p91-client-a`, `p91-client-b`
- Networks: `p91_proxy_net`, `p91_default` (and any `p91*_default` from the temp Compose project)
- Databases on `p91-postgres`: `clinic_p9_test`, `clinic_p91_drill`, `clinic_p91_shadow_test`, `clinic_p91_login_test`

Existing `ultrasound-clinic-*` containers, networks and volumes are out of scope and were never touched.
