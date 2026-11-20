# Phase 8.1 — Repository Stabilization & Security Hardening

**Project:** Ultrasound Clinic Management System (`Clinc-V1.1`)
**Document type:** Repository-only stabilization report
**Branch / HEAD:** `feature/clinic-quick-actions` @ `0d79b7d98962b204806e3e2cf2caf1ac381f1026`
**Date:** 2026-11-20
**Final status:** **PARTIAL**
**Deployment decision:** **NO-GO — unchanged.** This phase did not and does not authorize Phase 8.2, deployment, release, or any host-side operation.

> Scope boundary: all work in this phase was confined to the local repository. No deployment, Ubuntu/SSH access, Docker daemon change, container build/start/stop, production database access, local database migration, production `.env` read, secret rotation, commit, push, tag, or release was performed.

---

## A. Executive summary

| Area | Phase 8.1 result | Evidence |
|---|---|---|
| Existing work preservation | **Preserved.** Original 13 modified tracked files and 11 untracked entries remain; new Phase 8.1 files are additive only. | Repository-verified |
| `backup.patch` | Tracked and unchanged. Git blob `e31aa83e68fd94a76efcfcdad156521c286e6ce6`; SHA-256 `4D7440E2813B7A51BE3B3439439071DFCD638EBDDB7F02C0E4893FB1E7690769`. | Repository-verified |
| Legacy dump | `backups/db-20261113T134414Z.dump` unchanged; SHA-256 `70A4B4D0366AF79C5FF5C273A5927F6B89F2D826A5AAD0D2351067F472574BDF`. | Repository-verified |
| B1 Quick Actions timing | Diagnosed as a **test-fixture defect**, not a production time/DST defect. Test-only fallback seeded; deterministic timing tests added. | Repository-verified |
| Secret scan | Redaction-first scanner added. Working tree: 2 exact known fixtures allowlisted, 0 actionable. One historical `.env*` candidate remains ACTIONABLE / owner-triage-only. | Repository-verified |
| Backend dependency audit | 4 high advisories, all in the Prisma 6.x advisory cluster. No critical/moderate/low. No in-range patch; Prisma 7 is a breaking upgrade and was not attempted. | Repository-verified |
| Root/frontend dependency audit | 0 vulnerabilities. | Repository-verified |
| Docker hardening | Static review only. Removed vulnerable transitive `effect` from backend runtime image. No image CVE scan performed; no CVE claims made. | Repository-verified |
| CI | Added self-contained workflow with least-privilege permissions, pinned first-party actions, secret scan, typecheck/build/unit tests, synthetic-Postgres backend tests, and documented audit exception handling. Workflow not executed here. | Repository-verified |
| Full backend DB suite | **Not run locally.** Requires a disposable `_test` PostgreSQL database; DB access and migrations were forbidden in this phase. CI now defines that run for a future approved CI execution. | Not verified |
| Deployment readiness | Still **NO-GO**. B2, B3, B5 (image CVE), and B7–B9 remain. | Assessment |

**Why PARTIAL and not COMPLETE:** the repository-only stabilization work was completed where permitted, but the release blockers that require owner decisions, commits/tags, host access, real secret triage/rotation, or image CVE scanning remain open or partially resolved. No deployment gate was passed.

---

## B. Scope, constraints, and preservation

### B.1 Permitted and forbidden work

Permitted and performed:

- read-only repository inspection;
- test-only fixture changes for B1;
- new deterministic tests;
- new local/CI secret scanner;
- new CI workflow and audit classifier;
- low-risk Dockerfile hardening;
- local typecheck, build, frontend tests, deterministic backend timing tests, secret scan, audit classification, and YAML syntax parse;
- documentation.

Explicitly not performed:

- `reset`, `clean`, `checkout`, `restore`, `stash`, `rebase`, `commit`, `push`, `tag`, staging, or history rewriting;
- deployment, Ubuntu host access, SSH, firewall/TLS/DNS changes;
- Docker daemon changes or image build/run/scan;
- production database access, local database migration, or DB content reads;
- production `.env` reads, secret disclosure, or secret rotation;
- release publication or Phase 8.2 work.

### B.2 Working tree preservation

HEAD remained `0d79b7d98962b204806e3e2cf2caf1ac381f1026` throughout.

- Baseline from Phase 8.0: **13 modified tracked + 11 untracked** entries.
- After Phase 8.1, excluding this report: **15 modified tracked + 16 untracked** entries.
- With this report included: **15 modified tracked + 17 untracked** entries.

The two additional tracked modifications are `backend/Dockerfile` and `backend/tests/quick-actions-appointments.test.ts`. New untracked entries are `.github/`, `backend/tests/quick-actions-timing.test.ts`, `scripts/dependency-audit.mjs`, `scripts/secret-scan.mjs`, and this report. Existing Phase 7/8 files were not removed or rewritten.

### B.3 Artifact integrity

| Artifact | Verification | Result |
|---|---|---|
| `backup.patch` | Git blob equals `HEAD:backup.patch` | `e31aa83e68fd94a76efcfcdad156521c286e6ce6` on both sides |
| `backup.patch` | SHA-256 | `4D7440E2813B7A51BE3B3439439071DFCD638EBDDB7F02C0E4893FB1E7690769` |
| `backups/db-20261113T134414Z.dump` | SHA-256 | `70A4B4D0366AF79C5FF5C273A5927F6B89F2D826A5AAD0D2351067F472574BDF` |

Neither artifact was opened for secret/PHI content, regenerated, moved, or modified.

---

## C. B1 — Quick Actions after-hours timing investigation

### C.1 Finding

The failing after-hours Quick Actions test was caused by its fixture, not by the availability/time engine.

- `futureSlot()` can only create an appointment when a future slot exists on the slot grid.
- During after-hours conditions the grid is correctly empty, so no appointment was seeded.
- The test then made an unguarded assertion that an appointment existed.
- The production engine correctly returned an empty grid after hours.
- DST day lengths were normal: 23 h on spring-forward and 25 h on fall-back days.

Classification: **test-fixture defect; no production time or DST defect found.**

### C.2 Changes made

| File | Change |
|---|---|
| `backend/tests/quick-actions-appointments.test.ts` | Added `seedTodayAppointment()` and an after-hours fallback that seeds fixed-time “today” appointments through Prisma when no future slot exists. No production logic changed. |
| `backend/tests/quick-actions-timing.test.ts` | New deterministic tests with injected `now`: after-hours grid is empty, slots are anchored to the injected clock, earlier slots are excluded, occupied slots stay excluded, and DST day boundaries stay local. |

### C.3 Validation

```text
node --test --import tsx tests/quick-actions-timing.test.ts
# 4 tests, 4 pass, 0 fail
```

The database-backed integration suite was not run locally because Phase 8.1 forbids DB access/migrations. The new fixture is designed so the CI synthetic-PostgreSQL job can exercise it without wall-clock dependence.

---

## D. Secret scan and triage

### D.1 New control

`scripts/secret-scan.mjs` is a redaction-first scanner for local and CI use.

- Scans tracked files and project untracked files; ignores ignored files such as `.env`.
- Skips binary/archive extensions.
- Detects provider-prefixed credentials and private-key headers.
- Prints only a truncated prefix, candidate length, and truncated SHA-256 fingerprint.
- Suppresses only two exact known fixtures, identified by rule + file + redacted fingerprint. Marker words such as `test`, `example`, or `change-me` never suppress a finding.
- `--history` scans all reachable commits for `.env*` paths with PCRE-compatible rules; history findings are never allowlisted. CI uses the working-tree mode only.

No full candidate value is logged, written to disk, or copied into this report.

### D.2 Current working tree

```text
secret-scan: 2 candidate(s) found (0 actionable, 2 allowlisted fixtures; values redacted)
```

Both are the exact known `sk_live_` fixtures in their expected backend test files. No actionable candidate was found.

### D.3 Historical candidate

A reachable-history scan of `.env*` paths found one historical 40-character `sk_live_`-shaped value in `.env.example`:

- redacted fingerprint: `sk_l…len=40…sha256=47e7959a1b54…`;
- introduced in `ebcd2a42d063d8204399d25f948ec9ef4d12b87e`;
- removed in `df35a9941b92b6e98c3995afa0b00b337fa7d8d6`;
- not present on branch/HEAD;
- reachable through 6 commit IDs in non-branch `refs/agents/7214664e-4551-4e20-80e2-6c826bb01a92/checkpoints/turn/{1,2,3,4}` objects;
- history mode reports all 6 as **ACTIONABLE**, never allowlisted.

Classification: **POTENTIALLY REAL / INCONCLUSIVE**, requiring owner-controlled validation and, if necessary, rotation. No value was disclosed and no rotation was attempted. This remains part of B6.

### D.4 Classification correction and synthetic tests

The original broad marker rule could incorrectly suppress a real credential whose random body happened to contain `test`, `example`, `fake`, etc. That was a false-negative risk. The correction replaces marker-based suppression with the exact rule + file + fingerprint allowlist above.

Synthetic-only verification results:

| Case | Result |
|---|---|
| Exact known fixture at its expected path | allowlisted |
| Same fingerprint copied to a different path | ACTIONABLE |
| Live-prefixed synthetic key with `test` embedded in its body | ACTIONABLE |
| Test-prefixed synthetic key with `example` embedded in its body | ACTIONABLE |
| Benign short string containing `sk_live_` but below the match length | not matched |

Impact: ambiguous values are no longer downgraded to “synthetic”; only the two exact known fixtures are ignored in working-tree mode, and history findings are always actionable.

---

## E. Dependency security review

### E.1 Package manager and lockfiles

- npm with lockfileVersion 3 at root, `backend/`, and `web/`.
- Root audit: **0 vulnerabilities**.
- Frontend audit: **0 vulnerabilities**.
- Backend audit: **4 high**, no critical/moderate/low.
- `npm ls` reports a missing `concurrently` edge for the `file:..` link; this is an npm artifact of linked local package devDependencies, not resolved-version drift. Root itself is clean.

### E.2 Backend advisories

| Package | Severity | Role | Remediation |
|---|---|---|---|
| `prisma` 6.18.0 | High | Direct devDependency / optional peer pulled into prod tree | Prisma 7.10.1 — breaking major |
| `@prisma/config` 6.18.0 | High | Transitive via Prisma CLI | Prisma 7.10.1 |
| `deepmerge-ts` 7.1.5 | High | Transitive via `@prisma/config` | Prisma 7.10.1 |
| `effect` 3.18.4 | High | Transitive via Prisma CLI | Prisma 7.10.1 |

No 6.x patch version is available. The Prisma 7 migration requires generator, import, driver-adapter, config, and script changes; it was intentionally not attempted in Phase 8.1.

`@prisma/client` itself was not flagged. `playwright` is runtime-relevant for HTML-to-PDF rendering and was not flagged.

### E.3 Hardening and CI handling

- `backend/Dockerfile` already removed the Prisma CLI path and `deepmerge-ts` from the runtime image.
- Phase 8.1 additionally removes `node_modules/effect`; no runtime source imports it.
- New `scripts/dependency-audit.mjs` accepts only the exact documented four-high Prisma cluster and emits a warning annotation; any changed package set, severity, or count fails CI.
- No dependency upgrades or lockfile rewrites were performed.

### E.4 Why all four advisories appear in both audit modes

- `@prisma/client@6.18.0` declares `prisma: "*"` as an optional peer (`backend/package-lock.json` lines 528–535). npm therefore installs the `devOptional` Prisma CLI chain even under `--omit=dev`.
- `prisma` 6.18.0 depends on `@prisma/config` 6.18.0, which pins `deepmerge-ts` 7.1.5 and `effect` 3.18.4 (`backend/package-lock.json` lines 541–552).
- Local verification: full audit and `npm audit --omit=dev` both return exactly `total=4`, `high=4`, with the same package set `@prisma/config`, `deepmerge-ts`, `effect`, `prisma`. Both exit 1; both are accepted by the classifier only as the documented exception.
- `scripts/dependency-audit.mjs` classifies the exact package set, total, and severity mix; a changed set, count, or severity fails closed. It is therefore consistent with the documented four-high cluster, not silently accepting a different set.
- Removing `effect` from the runtime image reduces runtime surface only. It does **not** clear any audit advisory and does not resolve the Prisma 6.x cluster; remediation remains the Prisma 7 major upgrade.

---

## F. Docker and container configuration review

**Method:** static review only. No Docker daemon operation, image build, container start/stop, registry pull, or vulnerability scanner execution was performed. Docker CLI `29.9.3` is available locally; neither `trivy` nor `grype` is installed. Therefore **no CVE claims are made** and the B5 image-CVE portion remains unverified.

### F.1 Findings carried forward

| Finding | Severity | Status |
|---|---|---|
| `docker-compose.monitoring.yml` mounts `/var/run/docker.sock:ro` into `clinic-monitor` | High if enabled | Conditional. Read-only still grants broad host/API visibility. Do not enable the `monitoring` profile until owner approval and a safer design are recorded. |
| Flat `clinic_net` for all services | Medium | Carried forward from Phase 8.0; unchanged. |
| No CPU/memory limits and no documented vCPU/RAM minimum | Medium | Carried forward; unchanged. |
| No `env_file:`/`secrets:` directives; secrets supplied through Compose environment | Medium | Carried forward; unchanged. |
| `backend/Dockerfile` runtime uses non-root `node` and installs Playwright Chromium | Positive | Unchanged, plus removal of transitive `effect`. |
| `web/Dockerfile` uses nginx runtime | Informational | Unchanged. |

### F.2 Not performed

- no image CVE scan for backend/web/monitoring images;
- no daemon or Compose state changes;
- no Windows Docker Desktop container inspection or modification;
- no Ubuntu target inspection.

### F.3 Runtime impact of removing `effect`

- `backend/src` contains no imports of `effect`, `deepmerge-ts`, or the Prisma CLI package; it imports `PrismaClient` and types from `@prisma/client` only.
- The generated `.prisma` client contains no `effect` or `deepmerge-ts` references in local static inspection.
- The runtime image copies the generated client from the build stage and does not need the Prisma CLI chain; the `migrate` service remains in the build stage.
- Local typecheck, build, and tests passed after the Dockerfile change, but no image was built or run. Image CVE status remains **NOT VERIFIED**.

---

## G. CI implementation

### G.1 Workflow

Added `.github/workflows/ci.yml` with:

- `permissions: contents: read`;
- workflow-level concurrency cancellation;
- pinned first-party actions by commit SHA:
  - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`;
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0`;
- Node `22.14.0`;
- deterministic `npm ci` from all three committed lockfiles;
- no third-party secret-scanning action and no uploaded secrets.

### G.2 Jobs

| Job | Checks |
|---|---|
| `static` | secret scan; root and frontend audits; backend/frontend typecheck; backend/frontend build; frontend tests (7 files / 42 tests locally). |
| `backend-tests` | synthetic PostgreSQL 16.4 service with database name ending `_test`; synthetic env values; Prisma client generation; `prisma migrate deploy`; full backend test suite. |
| `dependency-audit` | backend `npm audit --omit=dev --json`; classification by `scripts/dependency-audit.mjs`; known exception warning or hard failure on change. |

### G.3 Boundaries

The workflow defines future CI behavior only. It was **not executed on GitHub during this phase**, no branch protection was changed, and no CI run, artifact, tag, or release was created. The workflow contains only synthetic environment values.

### G.4 Static review result

| Check | Result |
|---|---|
| Permissions | `contents: read` only; no write scopes. |
| Triggers | `push`, `pull_request`, `workflow_dispatch`; no `pull_request_target`, so fork PRs receive a read-only token and no secrets. |
| Environment | All backend env values are synthetic; `NODE_ENV=test`, `COOKIE_SECURE=false`, and `DATABASE_URL` uses `clinic_test`. |
| PostgreSQL service | `postgres:16.4-alpine`, user/password `clinic`, database `clinic_test`, port 5432, `pg_isready` health check. Database name satisfies every `_test` guard in the backend tests. |
| Migrations | `prisma generate` then `prisma migrate deploy` run only in CI against the synthetic service; no local DB migration was performed. |
| Jobs | Three independent jobs; no `needs` graph is required. Each failing command fails its job. The audit command's nonzero exit is intentionally captured and then adjudicated by the classifier, which fails on any changed advisory set. |
| Node/action pinning | Node `22.14.0`; checkout SHA verified against upstream `v4.2.2` tag and setup-node SHA against upstream `v4.4.0` tag. |
| Executed locally | YAML parse, secret scan, audit classifier, typecheck, build, frontend tests, deterministic backend timing tests. |
| Not executed locally | GitHub workflow run, PostgreSQL service startup, `prisma migrate deploy`, full DB-backed backend suite, image CVE scan. GitHub CI **did not pass** in this phase. |

---

## H. Validation and remaining blockers

### H.1 Local validation results

| Check | Result |
|---|---|
| `node scripts/secret-scan.mjs` | Pass; 0 actionable, 2 exact allowlisted fixtures, values redacted; classification tests pass; history mode reports the historical candidate as ACTIONABLE |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run test:run -- --reporter=dot` (`web`) | Pass; 7 files, 42 tests |
| `node --test --import tsx tests/quick-actions-timing.test.ts` (`backend`) | Pass; 4 tests |
| CI workflow YAML parse | Pass; jobs `static`, `backend-tests`, `dependency-audit` |
| Dependency audit classifier against live backend audit | Pass; exact known four-high cluster recognized |
| Preservation hashes | Match recorded baseline |
| Forbidden Git operations | None performed |

### H.2 B1–B9 status update

Summary: **0 RESOLVED; 8 PARTIALLY RESOLVED (B1, B3, B4, B5, B6, B7, B8, B9); 1 OPEN (B2).**

| ID | Phase 8.0 status | Phase 8.1 status | Phase 8.1 change |
|---|---|---|---|
| B1 | PARTIAL | PARTIAL | Fixture defect fixed; deterministic tests added. DB-backed/CI run still pending. |
| B2 | OPEN | OPEN | No commit/tag/release by explicit constraint. |
| B3 | PARTIAL | PARTIAL | No host-side or production backup/restore work performed. |
| B4 | OPEN | PARTIAL | CI workflow added and locally validated; GitHub run and enforcement pending. |
| B5 | OPEN | PARTIAL | Backend audit recorded, Docker statically reviewed, CI classification added; image CVE scan and Prisma remediation still open. |
| B6 | PARTIAL | PARTIAL | Redaction-first scan and `.env*` history triage completed; owner validation/rotation decision still open. |
| B7 | PARTIAL | PARTIAL | No target environment revalidation or decisions made. |
| B8 | PARTIAL | PARTIAL | No deployment, production verification, monitoring activation, or alert exercise. |
| B9 | PARTIAL | PARTIAL | No alert-channel credentials, scheduler installation, or real test. |

### H.3 Blocked or owner-controlled items

1. **B2 release artifact** — commits/tags/releases are explicitly forbidden in Phase 8.1.
2. **B5 image CVE scan** — no approved scanner available locally; no daemon or image operation performed.
3. **B5 Prisma advisories** — four high advisories need a breaking Prisma 7 upgrade in a later, separately validated change.
4. **B6 historical candidate** — ACTIONABLE/inconclusive; requires owner validation and possible rotation.
5. **B3/B7/B8/B9** — all require authorized host/deployment work outside this phase.
6. **Full backend DB suite** — cannot be validated locally under the DB-access restriction; CI definition is ready but unrun.

### H.4 Final decision

**Phase 8.1 status: PARTIAL.**
**Deployment status: NO-GO.**

Repository stabilization improved B1, B4, and B5, and added repeatable local/CI controls. It did not establish production readiness. Existing user work and preservation artifacts are intact, no forbidden Git operation was performed, and no production, database, secret, host, Docker-daemon, or release operation was attempted. Phase 8.2 remains unauthorized.
