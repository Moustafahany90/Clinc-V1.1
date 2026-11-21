# Production Readiness — Phase 9.2 Independent Final Review

**Date:** 2026-11-21  
**Review type:** Independent read-only review / PR readiness gate  
**Branch under review:** `fix/phase9-remediation`  
**HEAD:** `98c39f968a8e5b10e23b63a08e59c18131a9e2e1`  
**Local Phase 9 tip:** `fe7b56367cfd5b6a7b82c17471367f866c93af59` (`feature/phase9-performance`)  
**Local `main` / local `origin/main`:** `e55119fd8067316ebc4af23d93c468f399a7efc6`  
**Prior report:** `docs/PRODUCTION_READINESS_PHASE9_1.md`  
**GitHub Actions:** **NOT RUN**  
**Phase C status:** **LOCAL HISTORY VERIFIED — REMOTE BASE NOT VERIFIED**  
**Executive verdict:** **BLOCKED**

---

## 1. Executive verdict

**BLOCKED — do not open the PR yet.**

The local remediation history is intact and verified: the branch is `fix/phase9-remediation`, the worktree was clean before this report was created, `git diff --check` was clean, and exactly eight remediation commits sit on top of the local Phase 9 tip `fe7b563`. The core Phase 9.1 fixes are present in source and the strongest evidence artifacts support the main claims: 190/190 backend tests in two time zones, 50/50 clean walk-in races, 20 RPS soak and 100 RPS stress SLO passes, proxy-chain anti-spoofing in the TLS topology, and the four-index migration.

However, PR readiness is blocked for two independent reasons:

1. **Verification gate — remote base unavailable.** No fetch was permitted, so the real remote `origin/main` and PR base cannot be verified. The local `refs/remotes/origin/main` is only a stored tracking ref, not live remote state. Phase C therefore remains **LOCAL HISTORY VERIFIED — REMOTE BASE NOT VERIFIED**.
2. **Open code and deployment risks.** The independent review found one High queue-position defect and several Medium issues: non-domain-separated advisory-lock keys, queue writers that do not share the walk-in serialization, no post-fix 40P01/P2028 coverage, migration rollback/deployment safety gaps, PDF shutdown exposure, proxy spoof-safety proven only in the TLS topology, unverified rate-limit capacity, and resource-overlay sizing that has not been validated on the target host.

This verdict is not a rejection of the remediation work. It is a conservative readiness decision: the branch should not be promoted until the owner supplies remote verification, resolves or explicitly accepts the findings below, and attaches the missing independent CI/evidence results.

---

## 2. Scope, method, and safety confirmation

### 2.1 Method

This review used:

- Direct inspection of the eight commit diffs and current source at HEAD.
- Read-only Git ancestry and ref comparison.
- Inspection of Phase 9.1 evidence artifacts in `C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/out/`.
- Source review of queue, PDF, database migration/schema, auth/rate-limit, proxy, CI, and Compose files.

This review **did not** rerun test suites, rebuild containers, run performance harnesses, access any database or production system, or use real patient data.

### 2.2 Safety constraints observed

No deploy, production access, real patient data, push, fetch, PR, merge, rebase, cherry-pick, reset, clean, branch/tag/container/volume deletion, `git add -A`, or application-code change was performed. No remote or Git-write operation was performed. The only file created by this review is this report.

### 2.3 Worktree state before reporting

| Check | Result |
|---|---|
| `git status --short --branch` | `## fix/phase9-remediation` |
| `git diff --check` | no output |
| HEAD | `98c39f968a8e5b10e23b63a08e59c18131a9e2e1` |
| Worktree before report creation | clean |

---

## 3. Eight-commit table

All eight remediation commits remain present, in order, on top of `fe7b563`.

| # | Commit | Subject | Reviewed change | Result |
|---:|---|---|---|---|
| 1 | `1dc3762e4de5cc8cff2117602a8c8530720f7003` | `fix(queue): map wrapped 23P01 exclusion violations to 409` | Extends `backend/src/middleware/error.ts` to classify plain, nested/structured, and Prisma text-wrapped SQLSTATE `23P01` as `409 APPOINTMENT_CONFLICT`. | Implemented; unit coverage inspected. Low residual: structured path does not check constraint name. |
| 2 | `601e8bee14c44e25c698174d54799fbedca8ed4f` | `fix(pdf): bound Chromium renders and close browser on shutdown` | Adds PDF timeout, semaphore, bounded queue, context cleanup, diagnostics, and shutdown hook. | Implemented; test fidelity and shutdown-timer placement gaps remain. |
| 3 | `68d23e5df34db6eb1e2d83681c1fd00bfc98cec8` | `fix(auth): add per-account login limiter and relax shared-IP ceiling` | Adds 100/IP per 15 min plus normalized-email 10/account per 15 min limiter; raises IP ceiling from 10. | Implemented and wired correctly; capacity, durability, and success-reset gaps remain. |
| 4 | `d2661be97fb29274e0a0c309ae913051e90cd668` | `perf(db): add four read-path indexes from Phase 9 EXPLAIN` | Adds migration `20261121220000_phase91_performance_indexes` with four indexes. | Migration and schema inspected; rollback/deployment proof is only reported, not independently rerun. |
| 5 | `219d5fa2eef819ab74077d4fa6f0f25752205f10` | `chore(compose): add optional resource-limit overlay` | Adds opt-in `docker-compose.limits.yml`; base compose unchanged. | Safe-by-default design verified; production sizing and Caddy cap gaps remain. |
| 6 | `a8dff0433c179717a22f8d5569d85eb6126cb147` | `fix(queue): serialize per-doctor walk-ins to avoid 40P01 deadlock` | Adds transaction-scoped `pg_advisory_xact_lock(hashtext(doctor.id::text))` to walk-in creation. | Lock placement is correct inside `$transaction`; position calculation, key design, and writer coverage gaps remain. |
| 7 | `abd1a480a02f60cda80387ebf8efd9f97c8049d1` | `test(perf): add Phase 9.1 synthetic measurement harnesses` | Adds `tests/perf/p91-*` harnesses for concurrency, soak, load client, and comparison. | Synthetic/safety guards inspected; hardcoded paths, fail-soft comparison, and cleanup gaps remain. |
| 8 | `98c39f968a8e5b10e23b63a08e59c18131a9e2e1` | `docs: add Phase 9.1 remediation and measurement report` | Adds `docs/PRODUCTION_READINESS_PHASE9_1.md`. | Report claims reviewed; several checks remain reported-only or unavailable. |

---

## 4. Queue lock review

### 4.1 Verified positives

- `backend/src/modules/queue/routes.ts:279-337` performs walk-in creation inside `prisma.$transaction`.
- The advisory lock at `backend/src/modules/queue/routes.ts:286` is acquired through the transaction client `tx`, so it is transaction-scoped and released on commit or rollback.
- Appointment, status history, queue entry, and billing writes occur under that lock.
- `backend/src/middleware/error.ts:15-85,142-153` handles top-level, structured nested, and text-wrapped `23P01`.
- Error-classification tests cover wrapped, nested, and `P2028`-wrapped `23P01`, plus negative cases.
- `p91-concurrency-debug.json` contains pre-fix `40P01` and 5 s Prisma transaction-expiry evidence.
- `p91-concurrency.json` contains 50 iterations × 6 attempts with `successfulIterations: 50`, `totalServerErrors: 0`, and 300 total requests. The expected per-iteration pattern is one `201` plus five `409`s.
- The harness uses synthetic data and guards the target database name.

### 4.2 Critical review findings

| ID | Severity | Finding | Evidence/status |
|---|---|---|---|
| Q-1 | **High** | Queue position is computed before the lock and before the transaction. `existingToday` is counted at `backend/src/modules/queue/routes.ts:274-277`, while the lock is acquired at `:286` and `position: existingToday + 1` is written at `:311-321`. Two concurrent, **non-overlapping** walk-ins for the same doctor can both read `N` and both persist `N+1`. `QueueEntry` has no unique constraint on `(queueDate, doctorId, position)` in `backend/prisma/schema.prisma:380-403`. | **Verified by code inspection.** Not observed by the supplied harness because it uses near-simultaneous overlapping 15-minute slots, where losers fail earlier on `23P01`. |
| Q-2 | Medium | Lock identity is 32-bit and not domain-separated. `hashtext(doctor.id::text)` shares the advisory-key namespace with patient-ledger, report, setup, and doctor-calendar locks. Collisions would over-serialize unrelated work and may contribute to `P2028`. | **Verified static gap.** DB-level key equivalence/collision probe unavailable. |
| Q-3 | Medium | Not all queue-writing paths share the serialization. Status transitions and appointment-status-driven queue upserts/reschedule updates do not take the same queue/doctor lock. | **Verified by code inspection.** No failure shown by the p91 harness. |
| Q-4 | Medium | 40P01/P2028 have no independent post-fix coverage. There is no injection test, retry policy, or explicit `$transaction` `maxWait`/`timeout` on the walk-in path. `P2028` test coverage is only as an outer wrapper around nested `23P01`. | **Verified gap.** Pre-fix evidence exists; post-fix absence is not proof under other contention shapes. |
| Q-5 | Medium | Stale Phase 9 regression test remains: `backend/tests/perf/p9-concurrency.test.mjs:473-474` still expects all six walk-ins to succeed with no duplicate positions, contradicting the fixed `1×201 + 5×409` behavior. It is excluded from `npm test` by `backend/package.json:20`. | **Verified.** |
| Q-6 | Low | The p91 harness does not assert the `409 APPOINTMENT_CONFLICT` classification; it asserts success count, absence of 5xx, entry count, and duplicate positions. | **Verified.** Evidence JSON does show 250×409. |
| Q-7 | Low | Structured `23P01` detection maps any nested `code === '23P01'` to `APPOINTMENT_CONFLICT` without checking the constraint name. Only one exclusion constraint currently exists, so impact is limited. | **Verified.** |
| Q-8 | Low / Informational | Cleanup is documented but not evidenced. The harness closes server/Prisma but does not delete created rows. | Cleanup policy **verified as documented**; execution **unavailable**. |

### 4.3 Queue conclusion

The `23P01` and repeated-race fix is well evidenced, and the advisory lock is correctly transaction-scoped. The serialization is nevertheless incomplete: queue position is calculated outside the protected critical section, the key namespace is shared with unrelated locks, and only one of several queue-writing paths takes the lock. Q-1 must be resolved or formally accepted before PR.

---

## 5. PDF cancellation and cleanup review

### 5.1 Implemented controls

- `backend/src/lib/htmlPdf.ts`:
  - `renderHtmlToPdf()` acquires a bounded semaphore slot.
  - Excess work beyond `PDF_MAX_QUEUE_SIZE` fails fast with `PDF_RENDER_BUSY`.
  - `renderPageWithTimeout()` calls `page.close({ runBeforeUnload: false })` on timeout, rather than relying only on `Promise.race`.
  - Every render closes its `BrowserContext` in `finally`; cleanup errors are logged and do not mask render errors.
  - `htmlPdfDiagnostics()` exposes read-only counters.
- `backend/src/config/env.ts` and `.env.example` add PDF timeout/concurrency/queue settings.
- `backend/src/index.ts:33` calls `closeHtmlPdfBrowser()` during graceful shutdown.

### 5.2 Findings

| ID | Severity | Finding | Evidence/status |
|---|---|---|---|
| P-1 | Medium | The forced-exit timer in `backend/src/index.ts:33-35` is armed only after `closeHtmlPdfBrowser()` and `prisma.$disconnect()` awaits. A hung browser close or Prisma disconnect can block shutdown before the 5 s escape hatch exists. | **Verified by code inspection.** |
| P-2 | Low | The timeout test uses a fake page; it proves `page.close()` is called, not that a real Chromium operation is cancelled. | **Verified test-fidelity gap.** |
| P-3 | Low | `backend/tests/pdf-resource-controls.test.ts:10-11` overrides render concurrency to `2`, while the documented production default is `4`; production-default saturation is not covered. | **Verified coverage gap.** |
| P-4 | Low | A narrow shutdown/relaunch race remains in `backend/src/lib/htmlPdf.ts:38-55` when disconnected-browser detection clears `browserPromise` during close. | **Verified static gap.** |
| P-5 | Low | `.env.example` documents `PDF_RENDER_TIMEOUT_MS=30000`, while the Phase 9.1 report describes an allowed range of `1,000–300,000`; env validation minimum is `1`. | **Verified documentation mismatch.** |

### 5.3 PDF conclusion

The main resource controls are present and the delivery-failure behavior is covered. The primary readiness item is P-1: the shutdown safety timer should be armed before potentially hung awaits.

---

## 6. Migration and index review

### 6.1 Verified migration content

`backend/prisma/migrations/20261121220000_phase91_performance_indexes/migration.sql` adds exactly four indexes:

```sql
CREATE INDEX "Refund_refundedAt_idx" ON "Refund"("refundedAt");
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Measurement_visitId_measuredAt_idx" ON "Measurement"("visitId", "measuredAt");
CREATE INDEX "FileAsset_patientId_createdAt_idx" ON "FileAsset"("patientId", "createdAt");
```

`backend/prisma/schema.prisma` contains matching index annotations. No duplicate `ReportVersion` index was found. The index names and order match the measured EXPLAIN plans reported in Phase 9.1.

### 6.2 Evidence status

| Claim | Classification |
|---|---|
| Migration SQL and schema annotations | **Artifact/source verified** |
| Temp rollback SQL file with four `DROP INDEX` statements | **Artifact inspected** at `C:/Users/Moustafa/AppData/Local/Temp/opencode/p91/rollback-indexes.sql` |
| `prisma migrate diff --exit-code` clean | **Reported-only** |
| 45 CHECK constraints intact after migration | **Reported-only** |
| Rollback `4 → 0 → 4` | **Reported-only** |
| Production-like populated-table migration timing/locking | **Unavailable** |

### 6.3 Findings

| ID | Severity | Finding | Evidence/status |
|---|---|---|---|
| D-1 | Medium | No committed rollback script or runbook exists for `20261121220000_phase91_performance_indexes`; the rollback SQL is only in a temp evidence directory. | **Verified.** |
| D-2 | Medium | Plain `CREATE INDEX` can block writes on populated tables. The Phase 9.1 report relies on an empty-table assumption that is not independently validated here. | **Verified migration shape; runtime risk conditional.** |
| D-3 | Low | `explain-comparison.json` shows genuine plan changes for two finance queries, but several improvements are warm-cache effects and should not be attributed to indexes. | **Reported/artifact reviewed with caveat.** |

### 6.4 Migration conclusion

The migration itself is minimal and matches the schema. Before PR, the owner should provide a committed rollback/runbook and either validate the migration on a production-like populated staging database or explicitly document a maintenance/empty-table deployment window.

---

## 7. Rate-limit and proxy review

### 7.1 Verified implementation

- `backend/src/middleware/rateLimit.ts:30` sets `loginLimiter` to 100 requests / 15 min per IP.
- `backend/src/middleware/rateLimit.ts:39-50` sets `loginAccountLimiter` to 10 requests / 15 min, keyed by `trim().toLowerCase()` of `req.body.email`, with fallback `no-email:${req.ip ?? 'unknown'}`.
- `backend/src/modules/auth/routes.ts:82-86` wires both limiters to `/login`.
- `backend/src/modules/auth/routes.ts:127-130` resets DB `failedLoginCount` and `lockedUntil` and updates `lastLoginAt` on successful login.
- No proxy files were changed by commits `68d23e5` or `219d5fa`; `TRUST_PROXY` remains `1`.
- `proxy-chain-verification.json` reports `spoofable: false`, `distinctClientsGetDistinctKeys: true`, and `configurationChanged: false` for the real `Caddy → nginx → Express` chain.

### 7.2 Findings

| ID | Severity | Finding | Evidence/status |
|---|---|---|---|
| R-1 | Medium | Spoof-safety is proven only for the TLS topology. In base compose without Caddy, `web/nginx.conf:121-126` forwards client-supplied `X-Forwarded-For` unchanged, and `backend/src/app.ts:18` trusts `TRUST_PROXY=1`. A directly reachable nginx could allow client control of `req.ip`, bypassing IP-keyed limiters. | **Source verified; base topology probe unavailable.** |
| R-2 | Medium | The 10× shared-IP ceiling relaxation has no production capacity validation. Failed logins perform scrypt work; 100 attempts/IP/15 min can consume meaningful CPU under the proposed 1.5-vCPU backend quota. | **Config verified; capacity unavailable.** |
| R-3 | Medium | Pre-existing account-lockout/DoS and account-enumeration behavior remains: locked accounts return 403 before password verification while unknown accounts return 401; 8 failures lock an account for 15 min. | **Verified source behavior; not introduced by Phase 9.1.** |
| R-4 | Low | Successful login does not reset the in-memory limiter bucket; only the DB failure counter resets. | **Verified source; library default reported.** |
| R-5 | Low | Limiter state is process-local with no shared store. Current Compose has one backend service, so this is not currently exploitable, but counters reset on restart and would not be global across replicas. | **Reported/verified configuration.** |
| R-6 | Low | Login tests do not assert DB counter reset on success, malformed-email fallback key, or that varied XFF values produce distinct `req.ip`. | **Verified coverage gap.** |

### 7.3 Rate-limit/proxy conclusion

The per-account limiter is correctly normalized and wired, and the TLS topology evidence is strong. The owner must ensure production always uses the Caddy-fronted topology or correct the trust-header policy for any directly exposed nginx deployment, and should validate the 100/IP ceiling against target-host capacity.

---

## 8. Resource overlay review

### 8.1 Verified design

- `docker-compose.limits.yml` is a separate overlay; base `docker-compose.yml` is unchanged, so the default deployment is unaffected.
- Declared hard memory ceilings total approximately **9.25 GB**.
- Backend Node heap is capped with `NODE_OPTIONS=--max-old-space-size=1536` inside a `3g` backend memory limit.
- Caddy is intentionally omitted from the overlay because it is defined in `docker-compose.tls.yml`; declaring it in the base overlay would create an inert service in base-only deployments.
- Phase 9.1 reports all three Compose configurations validate with exit 0.

### 8.2 Findings

| ID | Severity | Finding | Evidence/status |
|---|---|---|---|
| O-1 | Medium | CPU quotas oversubscribe the stated production host: steady state 2.0 db + 1.5 backend + 0.25 web + 1.0 evolution = 4.75 vCPU on a 4-core Xeon E3-1225 v5; 5.75 during migrate. Caddy is uncapped and there are no priority weights. | **Verified config arithmetic; host spec reported.** |
| O-2 | Medium | Overlay sizes are not derived from production-host telemetry. Available resource evidence is idle/synthetic load on a Ryzen 5 5600G host with 29.9 GB RAM. | **Config verified; sizing unavailable.** |
| O-3 | Medium | Caddy, the public front door, has no CPU/memory/PID cap, so a spike or fault can starve throttled services. | **Verified.** |
| O-4 | Low–Medium | Chromium allocates outside the Node heap but inside the backend `3g` cgroup. No combined PDF + large-statement + near-heap-cap test was run. | **Reported; combined-load evidence unavailable.** |
| O-5 | Low–Medium | The `4g` DB limit includes OS page cache; DB working-set behavior under the cap with the full synthetic dataset was not measured. | **Unavailable.** |
| O-6 | Low | PID limits appear adequate, but no validation with the overlay applied was provided. | **Reported.** |

### 8.3 Resource overlay conclusion

The opt-in design is safe by default. Production adoption should be conditional on target-host validation, revised CPU allocation or priority rules, and an explicit decision about capping Caddy.

---

## 9. Evidence matrix

Legend: **Artifact-inspected** = file content read directly during this review. **Reported-only** = claimed in Phase 9.1 or adjacent artifacts but not independently rerun. **Unavailable** = no accessible evidence or outside read-only scope.

| Area | Claim | Classification | Notes |
|---|---|---|---|
| Backend suite | 190/190 pass with `TZ=UTC` | **Artifact-inspected** | `backend-suite-utc.txt` read; not rerun. |
| Backend suite | 190/190 pass with `TZ=Africa/Cairo` | **Artifact-inspected** | `backend-suite-cairo.txt` read; not rerun. |
| PDF tests | 6/6 pass | **Reported-only / partly artifact-supported** | PDF test names appear in backend suite logs; no independent rerun. |
| Queue single race | `1×201 + 5×409` | **Artifact-inspected** | `concurrency-after-queue-fix.json` read. |
| Queue repeated race | 50/50 clean, 0 5xx, 300 requests | **Artifact-inspected** | `p91-concurrency.json` parsed across all iterations. |
| Pre-fix deadlock | `40P01` and Prisma 5 s expiry | **Artifact-inspected** | `p91-concurrency-debug.json` read. |
| Soak | 20 RPS SLO pass | **Artifact-inspected** | `p91-soak.json` read; not rerun. |
| Stress | 100 RPS SLO pass | **Artifact-inspected** | `p91-soak.json` read; not rerun. |
| Corrected comparison | Phase 9 → 9.1 deltas | **Artifact-inspected with caveat** | `p91-corrected-comparison.json` and hardcoded-path/fail-soft tooling inspected. |
| Proxy chain | Spoof-safe in TLS topology | **Artifact-inspected / topology-limited** | `proxy-chain-verification.json` read; base topology unavailable. |
| Login limiter before/after | Shared-IP lockout reproduced then fixed | **Artifact-supported / pass count reported** | `login-limiter-before.txt` and `login-limiter-after.txt` read; 2/2 pass not rerun. |
| Index migration | Four indexes added | **Artifact/source verified** | Migration SQL and schema read. |
| Migration diff | Clean `prisma migrate diff` | **Reported-only** | No independent run artifact inspected. |
| Rollback | `4 → 0 → 4` | **Reported-only** | Temp rollback SQL inspected; execution not rerun. |
| Secret scan | 0 actionable, 2 allowlisted fixtures | **Reported-only** | No independent run. |
| Secret-scan regression | 10/10 pass | **Reported-only / source count verified** | 10 cases counted in source; not rerun. |
| Dependency audit | Exit 0 with accepted Prisma 6.x advisory cluster | **Artifact-inspected / wrapper** | Audit input JSON and wrapper code inspected; exit/warning reported-only. |
| p72 regression | PASS with documented counters | **Reported-only** | No independent run. |
| Compose validation | Three configurations exit 0 | **Reported-only** | Not rerun. |
| GitHub Actions | Required workflow checks | **Unavailable / NOT RUN** | No run URL or logs. |
| Live remote base | Current remote `origin/main`, PR base ancestry | **Unavailable** | Fetch prohibited; local tracking ref only. |
| Production host | CPU/RAM/working-set validation | **Unavailable** | No production access. |
| Cleanup | Disposable p91 resources deleted | **Unavailable** | Documented targets only; no execution record inspected. |

---

## 10. Git ancestry and ref comparison

| Check | Result | Interpretation |
|---|---|---|
| Current branch | `fix/phase9-remediation` | Required branch preserved. |
| HEAD | `98c39f968a8e5b10e23b63a08e59c18131a9e2e1` | Phase 9.1 report commit is HEAD. |
| Local Phase 9 tip | `fe7b56367cfd5b6a7b82c17471367f866c93af59` | Direct parent of the first remediation commit. |
| Local `main` | `e55119fd8067316ebc4af23d93c468f399a7efc6` | Stored local branch state. |
| Local `origin/main` | `e55119fd8067316ebc4af23d93c468f399a7efc6` | Stored tracking ref; **not live remote state**. |
| `merge-base(HEAD, main)` | `e55119fd8067316ebc4af23d93c468f399a7efc6` | Local merge base is current local `main`. |
| `merge-base(HEAD, origin/main)` | `e55119fd8067316ebc4af23d93c468f399a7efc6` | Local tracking merge base matches local `main`. |
| `merge-base(HEAD, feature/phase9-performance)` | `fe7b56367cfd5b6a7b82c17471367f866c93af59` | Remediation branch is based on the Phase 9 tip. |
| `git rev-list --count fe7b563..HEAD` | `8` | Exactly eight remediation commits. |
| `git rev-list --count main..HEAD` | `10` | Phase 9 plus eight remediation commits ahead of local `main`. |
| `fe7b563` ancestor of local `main` | **No** | Phase 9 tip has not been merged into local `main`. |
| `git merge-base --is-ancestor 1dc3762 HEAD` | exit `0` | First remediation commit is in HEAD history. |
| `git merge-base --is-ancestor a8dff04 HEAD` | exit `0` | Advisory-lock commit is in HEAD history. |
| Worktree before report | clean | No unexpected tracked or untracked changes. |

### Git conclusion

Local history is internally consistent and matches the required shape. No rebase, reset, cherry-pick, merge, or commit loss is visible locally. Remote ancestry remains unverified.

---

## 11. Remote limitation and Phase C status

No fetch, push, or network Git operation was performed. Therefore:

- The real remote `origin/main` tip cannot be confirmed.
- The PR base cannot be confirmed.
- It is unknown whether remote `main` advanced after the stored tracking ref.
- It is unknown whether the remote contains these eight commits or an equivalent history.
- GitHub Actions results are unavailable; GitHub Actions status remains **NOT RUN**.
- Conflict risk against the current remote base cannot be assessed.

**Phase C status:** **LOCAL HISTORY VERIFIED — REMOTE BASE NOT VERIFIED**

This is not `BLOCKED — PHASE 9 HISTORY NOT VERIFIED`: the local Phase 9 history is verified. It is also not `BLOCKED — UNEXPECTED HISTORY OR WORKTREE CHANGES`: no unexpected history or worktree changes were found. The block is specifically the unavailable remote base plus the open findings in this report.

---

## 12. Findings by severity

### Blocker / verification gate

| ID | Finding | Owner action |
|---|---|---|
| G-1 | Live remote base and PR ancestry cannot be verified without fetch. | Provide authorized fetch/remote verification or a trusted remote-base attestation, then re-run Phase C. |
| G-2 | GitHub Actions is **NOT RUN**. | Attach a successful required-check run or accept the documented residual risk in writing before PR. |

### High

| ID | Finding | Owner action |
|---|---|---|
| Q-1 | Queue position is computed outside the advisory lock/transaction; duplicate positions are possible for concurrent non-overlapping walk-ins. | Move the count inside the locked transaction, or add a unique `(queueDate, doctorId, position)` constraint with tested retry/conflict handling, or explicitly accept the risk after review. Add a non-overlapping concurrent walk-in test. |

### Medium

| ID | Finding | Owner action |
|---|---|---|
| Q-2 | Advisory key is 32-bit `hashtext` in a shared namespace. | Use a domain-separated 64-bit/two-int advisory key and document collision behavior. |
| Q-3 | Other queue-writing paths do not share the walk-in serialization. | Align all queue-position writers on the same lock/constraint strategy or prove they cannot race. |
| Q-4 | No post-fix 40P01/P2028 coverage or explicit transaction timeout/retry. | Add injection/long-contention coverage and explicit transaction bounds/retry policy. |
| Q-5 | Stale `p9-concurrency.test.mjs` expectation contradicts fixed behavior. | Update or remove the stale expectation and ensure the harness is not silently inconsistent with current behavior. |
| D-1 | No committed migration rollback/runbook. | Commit rollback SQL and a deployment/rollback runbook. |
| D-2 | Plain `CREATE INDEX` risk on populated tables. | Validate on production-like staging or document an empty-table/maintenance deployment window. |
| P-1 | Forced-exit shutdown timer is armed after hung-await risks. | Arm the 5 s escape timer before browser/Prisma close awaits. |
| R-1 | XFF spoof-safety proven only for TLS topology. | Enforce Caddy-fronted deployment or fix trust-header handling for direct nginx exposure; add a base-topology probe. |
| R-2 | 100/IP login ceiling unvalidated on target host. | Validate under realistic failed-login load on the target host or lower/tune the ceiling. |
| R-3 | Pre-existing lockout DoS/enumeration behavior remains. | Decide whether to remediate or formally accept before PR. |
| O-1 | CPU quotas oversubscribe 4-core production host; Caddy uncapped. | Right-size quotas/priority or document acceptance; decide Caddy cap policy. |
| O-2 | Overlay sizing not based on production telemetry. | Validate on target host before adopting the overlay. |
| O-3 | Caddy is the unthrottled public front door. | Cap Caddy or document why it is exempt. |

### Low / informational

| ID | Finding | Owner action |
|---|---|---|
| P-2, P-3, P-4, P-5 | PDF test fidelity, non-production test default, narrow relaunch race, env-range documentation mismatch. | Improve tests/docs; prioritize P-1 first. |
| Q-6, Q-7, Q-8 | Harness does not assert 409 code; structured 23P01 ignores constraint name; cleanup execution unavailable. | Strengthen assertions, constrain classification, and record cleanup. |
| R-4, R-5, R-6 | Limiter bucket not reset on success, process-local state, login test gaps. | Decide whether shared/durable limiter state is required; extend tests. |
| D-3 | Some index latency gains are warm-cache effects. | Keep terminology accurate in any launch notes. |
| O-4, O-5, O-6 | Chromium/heap cgroup contention, DB page-cache working set, and PID limits unvalidated. | Add overlay-applied validation on the target host. |
| Evidence tooling | Comparison harness hardcodes absolute paths and fails soft; several evidence files live outside the repo. | Make evidence paths configurable and archive critical artifacts with the PR. |

---

## 13. Exact owner actions before PR

1. **Remote verification**
   - Authorize or perform the fetch needed to confirm the live remote `origin/main` and PR base.
   - Confirm `merge-base(HEAD, remote-base)` and the eight-commit range against the real remote.
   - Re-run Phase C only after remote state is known.

2. **Resolve or sign off Q-1**
   - Move queue-position calculation into the locked transaction, or add a database uniqueness/retry strategy.
   - Add a concurrent non-overlapping walk-in test that asserts unique positions.

3. **Close queue serialization gaps**
   - Replace the shared 32-bit advisory key with a domain-separated key.
   - Align other queue-position writers with the same serialization strategy.
   - Add post-fix 40P01/P2028 coverage and explicit transaction bounds.
   - Update the stale `p9-concurrency.test.mjs` expectation.

4. **Supply missing verification evidence**
   - Provide a successful GitHub Actions run or explicitly accept **NOT RUN**.
   - Provide run artifacts for `prisma migrate diff`, Compose config validation, secret scan/regression, p72, typecheck/build, and web tests, or state that the Phase 9.1 reports are accepted as-is.
   - Archive critical evidence in a stable location referenced by the PR.

5. **Harden migration deployment**
   - Commit rollback SQL and a runbook.
   - Validate index creation on a populated staging database or document an empty-table/maintenance window.

6. **Harden PDF shutdown and tests**
   - Arm the forced-exit timer before browser/Prisma close awaits.
   - Add a real-Chromium timeout-cancellation test or document the test-fidelity gap.
   - Test with production defaults and correct the `.env.example` range documentation.

7. **Confirm proxy/rate-limit deployment assumptions**
   - Ensure production always uses the Caddy-fronted TLS topology, or correct XFF trust handling for direct nginx exposure.
   - Validate the 100/IP ceiling on target-host capacity.
   - Decide on shared/durable limiter state and the pre-existing account-lockout/enumeration risk.

8. **Validate resource overlay on the target host**
   - Right-size CPU quotas or add priorities.
   - Decide whether Caddy should be capped.
   - Test Chromium + large report + heap cap under the 3 GB backend cgroup.

9. **Re-review**
   - After the above items are resolved or explicitly accepted, re-run the Phase 9.2 readiness check.
   - Only then proceed to PR creation by the owner.

---

## 14. Final determination

- **Executive verdict:** **BLOCKED**
- **Local history:** verified
- **Remote base:** not verified
- **GitHub Actions:** **NOT RUN**
- **Application code changed by this review:** none
- **Only file created:** `docs/PRODUCTION_READINESS_PHASE9_2.md`

The Phase 9.1 remediation is substantially implemented and locally coherent, but it is not yet PR-ready under the stated verification standard.
