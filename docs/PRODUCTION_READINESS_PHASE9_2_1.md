# Production Readiness — Phase 9.2.1 Queue Race / Shutdown Final Remediation

**Date:** 2026-11-21
**Review type:** Implementation + local verification report for Phase 9.2.1 only
**Branch:** `fix/phase9-remediation`
**HEAD before Phase 9.2.1 edits:** `98c39f968a8e5b10e23b63a08e59c18131a9e2e1`
**Local Phase 9 tip:** `fe7b56367cfd5b6a7b82c17471367f866c93af59` (`feature/phase9-performance`)
**Local `main` / local `origin/main`:** `e55119fd8067316ebc4af23d93c468f399a7efc6`
**Prior review input:** `docs/PRODUCTION_READINESS_PHASE9_2.md` (pre-existing, untracked; left untouched and unstaged)
**GitHub Actions:** **NOT RUN**
**Remote base:** **NOT VERIFIED** (no fetch/push/PR authorized)
**Local verdict:** **LOCAL WORK COMPLETE AND GREEN — PR REMAINS GATED ON REMOTE BASE VERIFICATION + CI**

---

## 1. Executive verdict

**Phase 9.2.1 is complete locally.** The queue-position race is closed by moving position counting and allocation inside the transaction-scoped critical section. Queue advisory locks now use PostgreSQL's separate two-integer key namespace, disjoint from every existing one-argument `hashtext(...)` lock. Reschedule writes that move a queue row to a different doctor or clinic date now reallocate its position under the same queue lock. Shutdown arms its forced-exit deadline before any cleanup await and uses `Promise.allSettled` so one failing cleanup task cannot prevent the other.

All executed validation passed:

- Backend: **202/202** in `TZ=UTC` and **202/202** in `TZ=Africa/Cairo` (190 pre-existing + 12 new).
- Targeted new/regression set: **35/35**.
- Web: **42/42**. Secret-scan regression: **10/10**.
- Phase 9 concurrency harness: **7/7**, including the corrected walk-in expectation.
- Phase 9.2.1 harness: **50/50 iterations, 500/500 requests**, zero duplicates, zero 5xx, zero deadlocks, zero transaction expiries.
- Controlled probes observed **40P01**, **P2028**, clean rollback, and lock release.
- Root typecheck and production build passed; `git diff --check` clean.

This report does **not** declare the PR ready. The same two gates from the Phase 9.2 review remain: the remote Phase 9 base was not verified, and GitHub Actions was not run. The isolated p72 nginx shell harness was attempted but is blocked by this host's Docker/WSL path interop; the two p72 tests that live in the backend suite pass.

---

## 2. Scope, method, and safety confirmation

**In scope (Phase 9.2.1 only):**
1. Close the walk-in queue-position race.
2. Separate queue advisory locks from all other advisory-lock domains.
3. Align every queue writer with the allocation contract.
4. Harden graceful-shutdown deadline ordering.
5. Add concurrency, lock-identity, shutdown, and queue-writer tests plus a repeatable harness.
6. Correct the stale Phase 9 concurrency expectation.
7. Produce this report.

**Explicitly out of scope:** Phase 9.3, deployment, container restart, production access, real patient data, remote ref changes, PR creation, report/financial/WhatsApp feature changes, PDF rendering changes, auth/rate-limit policy changes, Docker default changes.

**Safety controls actually used:**

- All destructive tests ran only against a newly created disposable PostgreSQL container `p921-queue-pg` (ID `daacbda8ecfb`), network `p921-net` (ID `2b5b8e6ccd7b`), bound to `127.0.0.1:55433`.
- Databases: `p921_test` (migrated, used by the Jest/node:test suites) and `clinic_p9_test` (migrated and seeded by `p9-seed.mjs`, used by the performance harnesses). Application user: `p921_app`.
- `prisma migrate deploy` succeeded on both databases. The Phase 9 seed produced 30,000 `QueueEntry`, 60,000 `Charge`, and the rest of the documented synthetic dataset.
- No `ultrasound-clinic-*` container, network, database, or volume was started, stopped, modified, or deleted. Before and after cleanup all four production-named containers (`ultrasound-clinic-evolution-1`, `-backend-1`, `-web-1`, `-db-1`) were `Up (healthy)`.
- The isolated container and network were removed at the end; port `55433` is free and no `p921-*` resource remains. Evidence: `C:\Users\Moustafa\AppData\Local\Temp\opencode\p921\cleanup-verification.txt`.
- No production secrets were read or written. All test JWT secrets and passwords were synthetic and supplied only through the local environment.

---

## 3. Git history and ref integrity

**Source-verified and re-checked at the end of this work:**

- Branch is `fix/phase9-remediation`.
- HEAD at the start of Phase 9.2.1 was `98c39f968a8e5b10e23b63a08e59c18131a9e2e1`.
- All eight prior remediation commits are ancestors of HEAD (each `git merge-base --is-ancestor` returned 0): `1dc3762`, `601e8be`, `68d23e5`, `d2661be`, `219d5fa`, `a8dff04`, `abd1a48`, `98c39f9`.
- Local Phase 9 tip `fe7b56367cfd5b6a7b82c17471367f866c93af59` verified with `git rev-parse 'fe7b563^{commit}'`.
- Local `main` and local `origin/main` both remain `e55119fd8067316ebc4af23d93c468f399a7efc6`.
- No fetch, pull, push, merge, rebase, cherry-pick, reset, branch, or PR operation was performed.
- No `git add -A`, stash, or clean was used. Only explicitly listed Phase 9.2.1 paths were staged.
- The pre-existing untracked `docs/PRODUCTION_READINESS_PHASE9_2.md` was not staged, modified, or deleted.

---

## 4. Queue-position race: root cause and fix

**Source-verified.**

Root cause (Phase 9.2 finding Q-1): `POST /api/v1/queue/walk-in` counted `existingToday` **before** opening the transaction and **before** taking the per-doctor advisory lock, then wrote `position: existingToday + 1` inside the transaction. Two concurrent non-overlapping walk-ins could read the same count and persist the same position; no database constraint rejected it.

Fix in `backend/src/modules/queue/routes.ts`:

- The clinic-local day is captured once (`queueDateOnly`, `queueDate`) so identity, stored date, and lock key cannot disagree across midnight.
- `acquireQueueAllocationLock(tx, doctor.id, queueDateOnly)` is called at the top of the transaction.
- `allocateQueuePosition(tx, doctor.id, queueDate)` is called **inside the same locked critical section**, immediately after the lock.
- `position` is now the allocated value; the stale pre-transaction count is gone.

**Test-executed/passed:** `queue-lock.test.ts` asserts allocation uses the transaction client and `count({ where: { queueDate, doctorId, ... } })`; the 50-iteration harness asserts strictly sequential positions after two seeded rows in every iteration.

---

## 5. Advisory-lock namespace and ordering

**Source-verified + test-executed.**

New `backend/src/lib/queueLock.ts`:

- Uses `pg_advisory_xact_lock(int, int)`, PostgreSQL's **two-integer** advisory key space.
- `QUEUE_LOCK_DOMAIN_KEY = 1_363_955_523` (ASCII `"QLOC"` packed as a signed 32-bit int).
- Entity key: `hashtext("v1|YYYY-MM-DD|doctorId")` via PostgreSQL's built-in function on the `tx` client.
- Version prefix `v1` permits future, explicit key-format migration.

PostgreSQL's documentation states the one-`bigint` and two-`int` advisory key spaces **do not overlap** (verified against the PostgreSQL 16 system-administration functions documentation). All five pre-existing locks use the one-bigint space (`pg_advisory_xact_lock(hashtext(...))` or a fixed integer): doctor calendar (`appointments/service.ts:48`), patient ledger (`payments/routes.ts:24`), report-per-visit (`reports/routes.ts:645`), setup (`setup/routes.ts:18,127`), and the old queue walk-in lock (`queue/routes.ts`, now replaced).

**Lock order:** calendar lock → queue allocation lock → row writes. Reschedule takes the target doctor's calendar lock first, then the queue lock only when the logical queue changes. Walk-in takes only the queue lock. There is no path that takes the queue lock and then a calendar lock, so no reverse-order cycle exists.

**Test-executed/passed:** `queue-lock.test.ts` asserts deterministic identity, exact bound values, the two-`int` SQL shape, absence of `bigint`, and—against the disposable database—`pg_locks.classid = QLOC`, matching `objid`, and `objsubid = 2` (two-int space), then zero granted locks after commit. Legacy locks are source-verified as one-bigint/`objsubid = 1`; that specific `pg_locks` assertion was not added.

---

## 6. Queue writer alignment

**Source-verified + test-executed.**

A full writer audit covered every `QueueEntry` and appointment write path:

| Writer | Position behavior | Lock/transaction after Phase 9.2.1 |
|---|---|---|
| `POST /queue/walk-in` | Allocates position inside queue lock | Queue lock + transaction |
| `PATCH /appointments/:id` (reschedule) | Reallocates when `doctorId` or `queueDate` changes and current position is non-NULL; NULL stays NULL | Calendar lock → queue lock → transaction |
| `POST /appointments/:id/status` → `syncQueueForStatus` | ARRIVED upsert creates row with `position = NULL`; never updates position on existing rows | Transaction; no position allocation by design |
| `PATCH /queue/:id/status` | Never writes position, doctor, or date | Transaction; guarded to today's queue |
| Queue reads / dashboard / quick actions | Read-only | N/A |

No code path deletes a queue entry; SKIPPED retains the row. There are exactly three `queueDate` writers (walk-in create, ARRIVED upsert create, reschedule) and all use clinic-local day at `00:00Z`.

**Test-executed/passed:** `queue-writer-consistency.test.ts` verifies (a) reschedule into another doctor's queue produces positions `[1,2]` with no duplicates, (b) a today-dated queue status transition preserves position and updates status, and (c) `BOOKED → CONFIRMED → ARRIVED` creates a queue row with `position = NULL`, the correct doctor, and the correct clinic date.

---

## 7. Graceful shutdown hardening

**Source-verified + test-executed.**

New `backend/src/lib/gracefulShutdown.ts`, wired from `backend/src/index.ts` for `SIGTERM` and `SIGINT`:

- The forced-exit deadline (default 5,000 ms) is armed **before** any cleanup is awaited.
- The timer is `unref`'d so a fast successful shutdown is not held open.
- Browser close and database disconnect run concurrently via `Promise.allSettled`; one failure cannot skip the other.
- The timer is cancelled **only** after every task succeeds. On failure it stays armed as the bounded exit path.
- Handler is idempotent; repeated signals do not re-arm or duplicate cleanup.

**Test-executed/passed:** `graceful-shutdown.test.ts` (5 tests) covers ordering (`timer.arm`/`timer.unref` before `browser.start`/`database.start`), browser failure, database failure, a hanging browser close bounded by the armed deadline, and SIGTERM+SIGINT idempotence.

---

## 8. Database constraint decision

**Source-verified; decision recorded.**

No uniqueness constraint was added on `(queueDate, doctorId, position)`. Rationale:

- `QueueEntry.position` is `Int?`; ARRIVED-sync rows legitimately hold `NULL`, and PostgreSQL unique indexes permit repeated `NULL`.
- Historical production data could legitimately contain duplicates (reschedule previously moved rows without reallocation, deletes/cascades could free positions). Without production access this cannot be proven absent, so a `@@unique` migration would risk failing validation.
- The deterministic Phase 9 seed intentionally cycles positions modulo 40 across 30,000 rows, producing duplicates by construction.
- Serialization plus tests now prevent **new** duplicate allocations in the fixed writers; a future constraint requires a separate data-audit migration.

Schema/migrations confirm only `appointmentId` is unique on `QueueEntry`; DB CHECKs require `position IS NULL OR position > 0` and timestamp ordering, and the only exclusion constraint is `appointment_no_doctor_overlap`. No migration creates a queue-position uniqueness or exclusion constraint.

---

## 9. Evidence classification legend

| Classification | Meaning |
|---|---|
| **Source-verified** | Behavior confirmed by reading the current code/schema/migrations in this worktree. |
| **Test-executed/passed** | Command was actually run here and produced a passing TAP/Vitest/harness result. |
| **Reported-only** | Value or claim inherited from the prior Phase 9.2 review and not re-executed here. |
| **Not tested** | No execution attempted because it is outside this phase or lacked prerequisites. |
| **Blocked** | Execution attempted but prevented by the environment; partial results are stated explicitly. |

Every later section uses these labels. No result in this report is labelled passed unless its command was executed in this session.

---

## 10. Test matrix

All commands ran from `backend/` against the isolated `p921_test` database unless noted.

| Evidence | Classification | Result | Artifact |
|---|---|---|---|
| `node --test ... queue-lock, graceful-shutdown, queue-writer-consistency, error-classification, pdf-resource-controls, pdf-timeout` | Test-executed/passed | 35/35 | `targeted-tests.txt` |
| `npm test` with `TZ=UTC` | Test-executed/passed | 202/202 | `final-utc-isolated.txt` |
| `npm test` with `TZ=Africa/Cairo` | Test-executed/passed | 202/202 | `final-cairo-isolated.txt` |
| `npm --prefix web run test:run` | Test-executed/passed | 42/42 (7 files) | `web-tests.txt` |
| `node --test scripts/secret-scan-regression.test.mjs` | Test-executed/passed | 10/10 | `secret-scan.txt` |
| `npm run typecheck` (root) | Test-executed/passed | exit 0 | `final-typecheck.txt` |
| `npm run build` (root) | Test-executed/passed | exit 0 | `final-build.txt` |
| `git diff --check` | Test-executed/passed | exit 0 (benign LF→CRLF notice on `p9-concurrency.test.mjs`) | console |
| Baseline `npm test` before edits, UTC / Cairo | Test-executed/passed | 190/190 each | `baseline-utc-isolated.txt`, `baseline-cairo-isolated.txt` |

The 12 added tests are 4 lock tests, 5 shutdown tests, and 3 queue-writer tests; 190 → 202 matches exactly.

---

## 11. Phase 9.2.1 concurrency harness

**Test-executed/passed.**

Command (from `backend/`, isolated `clinic_p9_test`, `APP_TIMEZONE=UTC`):

```
node --import tsx tests/perf/p921-queue-concurrency.mjs
```

Harness design: 50 iterations × 10 concurrent walk-ins. Each iteration creates a fresh synthetic patient and doctor through the real API, seeds two committed queue rows at positions 1 and 2, then fires 10 walk-ins concurrently. A synthetic no-argument `Date` clock assigns each request a non-overlapping 10-minute slot, so all 10 are legitimate concurrent **non-overlapping** writes rather than expected conflict victims.

Result (`p921-concurrency.json`, `p921-harness.txt`):

- 50/50 iterations, **500 requests, 500×201**, 0 unexpected 4xx, 0 5xx.
- Duplicate positions: **0**; every iteration's positions were exactly `[1..12]`.
- Deadlock mentions: **0**; transaction-expiry mentions: **0**.
- Per-request latency: min 42.30 ms, **p50 123.77 ms**, **p95 198.04 ms**, **p99 251.79 ms**, max 451.32 ms, mean 373.66 ms; total elapsed 16,915 ms.
- Status-history and charge invariants held for every created walk-in (seed rows are deliberately unbilled).

The harness refuses to run unless `DATABASE_URL` targets exactly `clinic_p9_test`, and it never truncates or touches clinic/production resources.

---

## 12. Controlled probes and regression harnesses

**Test-executed/passed except where labelled otherwise.**

From the same evidence file:

- **Overlapping-slot probe (E2):** 1×201 + 5×409 `APPOINTMENT_CONFLICT`. The 23P01 response contract is preserved.
- **40P01 probe (E3):** two sessions acquire distinct advisory locks in opposite order; exactly one victim, with SQLSTATE `40P01` present in the Prisma `P2010` error. This is a controlled probe only; the concurrency workload itself produced **zero** deadlocks.
- **P2028 probe (E3):** an intentionally expired 1 ms interactive transaction produced Prisma `P2028`; no automatic retry was added.
- **Rollback probe:** a synthetic appointment written under the queue lock and then rolled back left **0** marker rows and **0** granted queue locks.

Phase 9 regression harness (updated stale expectation, `p9-concurrency.test.mjs`):

```
node --test --test-concurrency=1 --import tsx tests/perf/p9-concurrency.test.mjs
```

**Test-executed/passed:** 7/7. The walk-in test now asserts `1×201`, `5×409 APPOINTMENT_CONFLICT`, one queue entry, and no duplicate positions; the previous "all six succeed" expectation was stale relative to the 23P01 fix.

Phase 7.2 in-suite tests (`p72-http-422.test.ts`, `p72-scrubber-regression.test.ts`) are included in the 202/202 backend runs and **passed**.

**Blocked:** `scripts/p72-nginx-privacy-test.sh`. Attempted three ways (WSL bash + `docker.exe`, Git Bash + `docker`, Git Bash + a `wslpath -w` shim backed by `cygpath`). The refusal scenario passed once (`502` with redacted logs), but the upstream-500 scenario could not start its nginx container reliably because this host's Docker Desktop WSL integration and Git Bash bind-mount path conversion do not cooperate. No `p72-*` resources remain. Evidence: `p72-nginx-privacy.txt`.

**Not tested:** `scripts/p72-phase7-regression.sh` requires `python3`, which is not installed on this host. No attempt was made to install it.

---

## 13. Test additions and residual coverage gaps

**Test-executed/passed additions:** `backend/tests/queue-lock.test.ts`, `backend/tests/graceful-shutdown.test.ts`, `backend/tests/queue-writer-consistency.test.ts`, `backend/tests/perf/p921-queue-concurrency.mjs`, and the corrected assertion in `backend/tests/perf/p9-concurrency.test.mjs`.

**Reported-only / not-tested residual items inherited from the Phase 9.2 review and not changed here:**

- PDF resource tests still use a reduced cap of 2 and fake pages; production-default saturation was not re-measured (reported-only).
- `p91-concurrency.mjs` does not assert the explicit `409` code and does not clean up its `P91-` rows (reported-only; the new p921 harness does both).
- The Phase 9.2 documentation mismatch about PDF defaults was not corrected in this phase (reported-only).
- Long-duration soak/stress (`p91-soak.mjs`) and out-of-process load probes were **not tested**.

None of these are introduced by Phase 9.2.1.

---

## 14. Regression and non-functional verification

**Test-executed/passed:**

- Root `npm run typecheck` passed for both backend and web after all source changes.
- Root `npm run build` passed (backend `tsc` + web Vite production build; web built in 3.82s).
- Secret-scan regression 10/10 passed.
- `git diff --check` returned 0. The only notice was Git's informational warning that LF will be replaced by CRLF in `backend/tests/perf/p9-concurrency.test.mjs` on a future touch; no whitespace errors were reported.

**Preserved by source review and by the executed suites:**

- `23P01` → `409 APPOINTMENT_CONFLICT` response body and message, including nested/P2028-wrapped cases (18 error-classification tests).
- Billing behavior: every walk-in still produces exactly one `Charge` with `PENDING` payment in the harness; no report/financial/WhatsApp code changed.
- Business rules: appointment transition table, doctor scoping, same-clinic-day reschedule checks, schedule/override rules unchanged.
- PDF rendering controls and auth/rate-limit policies unchanged; their existing tests pass.
- Docker defaults and Compose files unchanged.

---

## 15. Findings and residual risks

| ID | Severity | Status | Note |
|---|---|---|---|
| Q-1 walk-in position race | High | **Fixed, test-executed** | Allocation inside lock+transaction; 50×10 harness clean. |
| Q-2 shared 32-bit advisory namespace | Medium | **Fixed, test-executed** | Two-int `QLOC` domain; `pg_locks objsubid=2`. |
| Q-3 reschedule carries position into new queue | Medium | **Fixed, test-executed** | Reallocation under queue lock when doctor/date changes. |
| Q-5 stale Phase 9 concurrency expectation | Low | **Fixed, test-executed** | 7/7 harness pass. |
| P-1 shutdown timer armed too late | Medium | **Fixed, test-executed** | Deadline armed before awaits; allSettled cleanup. |
| No queue-position DB constraint | Accepted | **Source-verified decision** | See §8; audit migration required if ever added. |
| Remote base not verified | Gate | **Blocked by authorization** | No fetch/ls-remote performed. |
| GitHub Actions not run | Gate | **Not tested** | Must run before PR merge. |
| p72 nginx shell harness | Low | **Blocked by environment** | See §12; partial refusal scenario passed. |
| p72 phase7 shell harness | Low | **Not tested** | `python3` unavailable. |

No new high-severity finding was introduced by the Phase 9.2.1 changes.

---

## 16. Owner actions before PR

1. Verify the remote Phase 9 base with the owner's authorized workflow (this session was not permitted to fetch or inspect remote refs). Local `main`/`origin/main` are confirmed at `e55119f`.
2. Run GitHub Actions and confirm the full matrix, especially Playwright availability for PDF tests.
3. Decide whether to keep `docs/PRODUCTION_READINESS_PHASE9_2.md` as a separate untracked review artifact or add it in its own change. It was deliberately not staged here.
4. In an environment with working Docker bind mounts (or WSL integration), run `scripts/p72-nginx-privacy-test.sh`; install `python3` to run `scripts/p72-phase7-regression.sh` if those gates are required.
5. On rollout, monitor for advisory-lock wait on the `QLOC` two-int key and confirm queue positions remain sequential after a mixed walk-in/reschedule burst.

No database migration, config change, or service restart is required by Phase 9.2.1 itself.

---

## 17. Reproduction commands and evidence artifacts

All artifacts are under `C:\Users\Moustafa\AppData\Local\Temp\opencode\p921\`.

```
# Isolated DB lifecycle (already completed and cleaned up)
docker network create p921-net
docker run -d --rm --name p921-queue-pg --network p921-net \
  -p 127.0.0.1:55433:5432 \
  -e POSTGRES_DB=p921_test -e POSTGRES_USER=p921_app \
  -e POSTGRES_PASSWORD=p921synthetic postgres:16-alpine
DATABASE_URL=postgresql://p921_app:p921synthetic@127.0.0.1:55433/p921_test?schema=public \
  npx prisma migrate deploy

# Backend (from backend/)
DATABASE_URL=...p921_test npm test                       # TZ=UTC and TZ=Africa/Cairo
node --test --test-concurrency=1 --import tsx \
  tests/queue-lock.test.ts tests/graceful-shutdown.test.ts \
  tests/queue-writer-consistency.test.ts tests/error-classification.test.ts \
  tests/pdf-resource-controls.test.ts tests/pdf-timeout.test.ts

# Phase 9.2.1 harness (from backend/, clinic_p9_test)
DATABASE_URL=...clinic_p9_test node --import tsx tests/perf/p921-queue-concurrency.mjs

# Phase 9 regression (from backend/, clinic_p9_test)
DATABASE_URL=...clinic_p9_test node --test --test-concurrency=1 --import tsx \
  tests/perf/p9-concurrency.test.mjs

# Root
npm run typecheck
npm run build
node --test scripts/secret-scan-regression.test.mjs
git diff --check
```

Key artifacts: `baseline-utc-isolated.txt`, `baseline-cairo-isolated.txt`, `migrate-deploy.txt`, `migrate-p9.txt`, `seed-p9.txt`, `targeted-tests.txt`, `p921-harness.txt`, `p921-concurrency.json`, `p9-harness.txt`, `p9-concurrency.json`, `final-utc-isolated.txt`, `final-cairo-isolated.txt`, `web-tests.txt`, `secret-scan.txt`, `final-typecheck.txt`, `final-build.txt`, `p72-nginx-privacy.txt`, `cleanup-verification.txt`.

---

## 18. Final determination

**Phase 9.2.1: LOCAL COMPLETE — ALL EXECUTED CHECKS PASSED.**

Delivered and verified locally:

- Queue-position allocation serialized inside a domain-separated, transaction-scoped advisory lock.
- All position-writing and queue-moving paths aligned; reschedule reallocates under the same lock.
- Shutdown deadline armed before cleanup, unref'd, `Promise.allSettled` cleanup, cancelled only on full success.
- 12 new tests plus one corrected regression expectation; 202/202 backend in both timezones, 42/42 web, 35/35 targeted, 7/7 Phase 9 harness, 50/50 Phase 9.2.1 harness, 10/10 secret scan.
- 23P01 contract, billing, business rules, PDF behavior, auth/rate-limit, and Docker defaults unchanged.
- Isolated test infrastructure fully removed; no clinic/production resource touched.

**PR verdict remains BLOCKED** until the remote Phase 9 base is verified and GitHub Actions passes, consistent with the Phase 9.2 review. The p72 nginx shell harness is an additional environment-blocked item that the owner should run elsewhere; it does not invalidate the locally executed evidence above.
