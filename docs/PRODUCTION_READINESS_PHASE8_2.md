# Phase 8.2 — Pre-Production Readiness Closure

**Project:** Ultrasound Clinic Management System (`Clinc-V1.1`)
**Document type:** Repository-only investigation and closure report
**Branch / HEAD:** `feature/clinic-quick-actions` @ `0d79b7d98962b204806e3e2cf2caf1ac381f1026`
**Date:** 2026-11-20
**Phase 8.2 status:** **COMPLETED** for the approved documentation/investigation scope
**Next operational phase:** **NO-GO**

> Phase 8.2 did not authorize deployment, host configuration, service activation, credential validation/rotation, database work, container image operations, or a release. Static inspection and local evidence are not treated as proof of production readiness.

---

## 1. Scope and safety boundaries

### 1.1 Approved scope

1. Static review of `.github/workflows/ci.yml` and exact first-run GitHub Actions requirements.
2. Review of the Prisma 6.x advisory cluster and a safe remediation path, without upgrading dependencies.
3. Read-only discovery of offline/static image-scanning options.
4. Continued classification of the historical `.env.example` candidate as **ACTIONABLE / INCONCLUSIVE**.
5. Repository-only reconciliation of backup paths/environment/service-account assumptions and monitoring host-systemd requirements.
6. Creation of this report.

### 1.2 Boundaries observed

No staging, commit, push, tag, reset, clean, checkout, restore, stash, rebase, or Git-history rewrite was performed. No Ubuntu/SSH access, production database access, Docker daemon access, container build/pull/run, deployment, service restart, systemd/timer activation, schedule creation, backup/restore operation, WAL activation, monitoring activation, alert delivery, credential validation, or credential rotation was performed. `.env` values were not read or printed. No clinical report template, patient data, application logic, dependency, or lockfile was modified.

### 1.3 Evidence labels used in this report

- **Repository-verified** — observed directly in the local repository during Phase 8.2 or recorded as repository-verified in Phase 8.0/8.1.
- **Owner-reported / historical** — previously supplied terminal output or owner statements; not independently revalidated in this phase.
- **Not verified** — requires an operation outside this phase's boundaries.

---

## 2. Executive summary

| Area | Phase 8.2 finding | Evidence class |
|---|---|---|
| CI execution readiness | Workflow is statically coherent and safe, but it has not run on GitHub. It remains untracked and requires owner-authorized commit/push/PR plus Actions enablement and first-run approval as applicable. | Repository-verified |
| Dependency security | Backend full and `--omit=dev` audits both report exactly 4 High advisories in `@prisma/config`, `deepmerge-ts`, `effect`, and `prisma`. The fail-closed classifier was not changed. Safe remediation is a separate Prisma 7.10.1-or-later major migration. | Repository-verified |
| Docker image security | No offline/static scanner is installed or vendored. Docker CLI 29.9.3 is present but was not used against a daemon. Image CVE assessment remains **NOT VERIFIED**. | Repository-verified |
| Historical secret finding | Unchanged: **ACTIONABLE / INCONCLUSIVE**. No value or fingerprint is repeated here. Owner validation and, if warranted, rotation remain required before production. | Repository-verified + owner-controlled decision |
| Backup readiness | Repository defaults (`backups/`, `/mnt/clinic-backups/backups`) do not map to the historically observed tiered layout (`daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, `logs`). Encryption and mount checks are fail-open by default; UUID verification exists only in the host preflight evidence. | Repository-verified + owner-reported historical |
| Monitoring readiness | Repository implementation is template/mock-level. Host env file, directories, service account, real Telegram/heartbeat credentials, WAL/cert paths, backup mount binding, units/timers, and real alert delivery remain owner-controlled and unverified. | Repository-verified + not verified |
| Preservation | Branch, HEAD, 15 modified tracked files, preservation artifacts, and all Phase 7/8 work remain intact. The only Phase 8.2 file added is this report. | Repository-verified |

---

## 3. CI execution readiness

### 3.1 Current workflow

`.github/workflows/ci.yml` defines three independent jobs:

| Job | Workflow lines | Checks |
|---|---|---|
| `static` | `.github/workflows/ci.yml:19-65` | Checkout, Node setup, `npm ci` in root/backend/web, secret scan, root audit, frontend audit, root typecheck, root build, frontend tests. |
| `backend-tests` | `.github/workflows/ci.yml:67-124` | Synthetic PostgreSQL 16.4 service, synthetic env, root/backend install, Prisma generate, `prisma migrate deploy`, full backend test suite. |
| `dependency-audit` | `.github/workflows/ci.yml:126-151` | Backend `npm ci`, `npm audit --omit=dev --json`, classification by `scripts/dependency-audit.mjs`. |

Static properties remain acceptable:

- `permissions: contents: read` only (`:8-9`).
- Triggers are `push`, `pull_request`, and `workflow_dispatch` (`:3-6`); there is no `pull_request_target`.
- Node version is pinned to `22.14.0` (`:15-16`), satisfying repository engine constraints.
- First-party actions are pinned to verified commit SHAs: checkout `v4.2.2` and setup-node `v4.4.0` (`:24`, `:27`).
- Backend test environment is synthetic; `DATABASE_URL` uses `clinic_test`, `NODE_ENV=test`, `COOKIE_SECURE=false`, and JWT/API values are CI-only fixtures (`:84-93`).
- PostgreSQL uses `clinic/clinic/clinic_test` with `pg_isready` health check (`:71-83`).
- Failure propagation is direct for normal commands. The audit command's nonzero exit is deliberately captured (`:148`) and then adjudicated by the fail-closed classifier (`:150-151`).

### 3.2 Exact steps required for the first GitHub Actions execution

1. **Owner authorization is required first.** The workflow currently exists only in the untracked `.github/` directory. It must be included in an owner-approved commit and pushed to GitHub, or included in a pull request, before Actions can see it.
2. GitHub Actions must be enabled for the repository. If this is the first workflow run or the author is not yet trusted, GitHub may require owner approval of the run.
3. Trigger one of the declared events:
   - push to a branch carrying the workflow;
   - open/update a pull request carrying the workflow; or
   - run `workflow_dispatch` manually after the workflow exists on GitHub.
4. GitHub provisions `ubuntu-latest` runners for all three jobs.
5. Each job checks out the repository with the pinned checkout SHA and sets up Node `22.14.0` with the pinned setup-node SHA.
6. The `static` job installs from all three lockfiles, then runs secret scan, root/web audits, typecheck, build, and frontend tests.
7. The `backend-tests` job starts the synthetic PostgreSQL service, installs root/backend dependencies, generates the Prisma client, applies migrations with `prisma migrate deploy`, then runs `npm test`.
8. The `dependency-audit` job installs backend dependencies, writes the production audit JSON to `$RUNNER_TEMP`, and classifies it. With today's exact four-high Prisma cluster, the classifier emits a warning and exits 0; any changed package set, count, or severity fails the job.
9. Owner reviews all job logs and artifacts, confirms there are no real secrets in CI, and only then decides whether to require these checks in branch protection.

### 3.3 Owner blockers

- Commit/push/PR is explicitly forbidden in Phase 8.2; no workflow was triggered and **no GitHub CI result is claimed**.
- Actions enablement and first-run approval are repository settings/owner actions, not repository-file changes.
- Branch protection and required status checks were not modified.
- GitHub-hosted runner access to npm and to `postgres:16.4-alpine` was not verified. No credentials or production secrets are required by this workflow and none should be added.
- Full DB-backed backend validation remains pending until the first real CI run.

---

## 4. Dependency security

### 4.1 Current advisory cluster

Evidence from the Phase 8.1 audit snapshots, re-parsed read-only in Phase 8.2:

| Audit command | Result |
|---|---|
| Full backend `npm audit --json` | `total=4`, `high=4`; `@prisma/config`, `deepmerge-ts`, `effect`, `prisma` |
| Backend `npm audit --omit=dev --json` | Same exact package set and counts |

Cause:

- `@prisma/client@6.18.0` declares `prisma: "*"` as an optional peer (`backend/package-lock.json:519-539`); npm installs the `devOptional` Prisma CLI chain even in production-only audits.
- `prisma@6.18.0` depends on `@prisma/config@6.18.0` (`backend/package-lock.json:2042-2066`), which pins `deepmerge-ts@7.1.5` and `effect@3.18.4` (`backend/package-lock.json:541-552`, `:1104-1113`, `:1194-1204`).

Advisory references observed in the audit snapshot:

- `deepmerge-ts`: `GHSA-ggr8-5vv4-36mx` (range `<8.0.0`).
- `effect`: `GHSA-38f7-945m-qr2g` (`<3.20.0`) and `GHSA-7589-6fvf-x4pw` (`<=3.22.0`).
- `@prisma/config` is affected in `6.13.0-dev.1 - 7.10.0`; `prisma` is affected in `6.13.0-dev.1 - 7.10.0`.
- `npm audit` reports `fixAvailable` as `prisma@7.10.1` with `isSemVerMajor=true`.

### 4.2 Fail-closed exception remains unchanged

`scripts/dependency-audit.mjs:27-63` accepts only the exact four-package, four-High cluster. It passes immediately when total vulnerabilities are zero, emits a non-blocking warning for the known exception, and fails on any unexpected package, missing package, changed count, or non-High severity. No change was made in Phase 8.2.

### 4.3 Safe remediation path (future, not performed)

1. In a separately approved change, upgrade both `prisma` and `@prisma/client` from `6.18.0` to a non-vulnerable release reported by a fresh audit — currently `7.10.1` or later — and regenerate `backend/package-lock.json`.
2. Re-run full and production-only backend audits; remove the documented exception only after a clean audit, while keeping the classifier fail-closed until then.
3. Complete repository typecheck/build and both frontend and full DB-backed backend tests in CI.
4. Review and record the runtime image dependency composition again; do not assume the current `effect` removal remains sufficient without rechecking the new generated client.
5. Obtain owner approval for the major upgrade and any resulting operational change.

### 4.4 Prisma 7 migration impact

Repository-specific impact identified by static inspection:

- `backend/package.json:5` already has `"type": "module"`, but `backend/tsconfig.json:5-6` uses `NodeNext`/`NodeNext`; the Prisma 7 guide recommends validating ESM-compatible TypeScript settings.
- `backend/prisma/schema.prisma:8-10` uses `prisma-client-js` with no `output`. Prisma 7 moves toward the `prisma-client` generator and requires an explicit generated-client output path.
- `backend/src/lib/prisma.ts:1-8` imports `PrismaClient` from `@prisma/client` and constructs it without a driver adapter. Prisma 7 PostgreSQL usage requires an adapter such as `@prisma/adapter-pg`, plus import-path changes to the generated client.
- There is no `prisma.config.ts` in the repository. Prisma 7 expects CLI configuration there, including datasource URL loading via `dotenv/config` and seed configuration.
- `backend/package.json:18-20` defines `seed`, `seed:test-users`, `prisma:generate`, and `prisma:deploy`. Prisma 7 removes automatic seeding during migration commands and no longer auto-generates the client in `migrate dev`/`db push`; CI already calls generate explicitly before deploy.
- No `$use` client middleware, metrics usage, or `@prisma/adapter-*` package was found in repository source, reducing but not eliminating migration scope.
- SSL certificate behavior changes with the `node-pg` adapter, and connection-pool defaults differ from Prisma 6. Both require test validation in an approved environment.

No Prisma upgrade, dependency declaration change, or lockfile modification was performed.

---

## 5. Docker image security

### 5.1 Offline/static scanner discovery

Read-only command and path discovery found:

| Tool | Result |
|---|---|
| `trivy`, `grype`, `syft`, `docker-scan`, `dockle`, `hadolint`, `osv-scanner`, `snyk`, `clair`, `skopeo`, `crane`, `oras`, and related tools | `NOT_FOUND` on PATH and in checked common install locations |
| Vendored scanner files in repository | None found by filename search |
| Docker CLI | `Docker version 29.9.3, build 5457199` |

The Docker CLI was not used against a daemon; no image was built, pulled, started, or inspected.

### 5.2 Safe scan requirements

An approved scan can be performed later without Docker daemon access only if all of the following are satisfied:

1. An owner approves and installs a scanner that supports image archives, OCI archives, filesystem roots, or SBOM input — for example Trivy or Grype.
2. The scanner vulnerability database is supplied through an approved offline channel or an explicitly authorized update path. No production credentials are used.
3. An owner provides immutable image artifacts or digests built from an approved commit/tag. Phase 8.2 did not build or export any image.
4. Backend, web, and monitoring images are scanned; scanner version, database date, artifact identity, and findings are recorded.
5. High/Critical findings are triaged by the owner with remediation decisions; clean results are required before any production-image GO decision.

### 5.3 Assessment

**Image CVE assessment: NOT VERIFIED.** Static Dockerfile review from Phase 8.1 and the absence of `effect` from the backend runtime image reduce runtime surface, but they are not a CVE scan and do not clear the audit advisories.

---

## 6. Historical secret finding

The historical `.env.example` candidate remains classified as **ACTIONABLE / INCONCLUSIVE**. Its value and fingerprint are deliberately not repeated in this report. The candidate is not present on the current branch/HEAD, but remains reachable in non-branch checkpoint objects; the Phase 8.1 history scan reported it as actionable and never allowlisted.

Owner-controlled decision required before production:

1. In an isolated, owner-controlled process, determine whether the historical candidate was ever a live credential. Do not use production systems for validation.
2. If validity cannot be ruled out, treat it as potentially live and rotate/revoke it at the provider.
3. Record the decision, provider, rotation date, and any residual exposure. Do not publish the value or fingerprint.
4. Decide separately whether history cleanup is warranted; no history rewrite is authorized in Phase 8.2.

No validation, provider lookup, rotation, or disclosure was performed.

---

## 7. Backup and monitoring readiness

### 7.1 Backup reconciliation

**Historical owner-reported layout** (`docs/PRODUCTION_READINESS_PHASE8_0.md:114-130`): `/mnt/clinic-backups` contains `daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, and `logs`, reported as `root:root` mode `700`. A host-side preflight reportedly checks mountpoint, UUID, ext4, directory structure, age recipient, and write access, and previously returned `BACKUP PREFLIGHT PASSED`. Current host state was not revalidated.

Repository-only reconciliation:

| Topic | Repository evidence | Reconciliation / blocker |
|---|---|---|
| Backup output path | `scripts/backup.sh:30` defaults `BACKUP_DIR` to `backups`, resolved relative to the repository root. | Does not target `/mnt/clinic-backups` by default and does not map to the observed tiered directories. |
| Documentation path | `docs/backup-restore.md` and `docs/operations.md` describe `/mnt/clinic-backups/backups` (`docs/PRODUCTION_READINESS_PHASE8_0.md:207-213`). | Conflicts with both the script default and the historical tiered layout. No approved mapping exists. |
| Monitoring backup path | `scripts/p7-check-backup.sh:10` and `docker-compose.monitoring.yml:25` default `P7_BACKUP_DIR` to `/mnt/clinic-backups/backups`. | Monitoring would look for `MANIFEST-*.txt` in a `backups` subdirectory that the historical host layout does not show. |
| Mount enforcement | `scripts/backup.sh:31-32`, `:131-146`: `BACKUP_REQUIRE_MOUNT` defaults `0`; when enabled it uses `mountpoint -q` plus containment, and `mkdir -p "$OUT_DIR"` runs before the check. | Fail-open by default; no UUID or filesystem-type check in repository code. The host preflight has those checks but is outside the repository. |
| Encryption | `BACKUP_AGE_RECIPIENT` and `BACKUP_REQUIRE_ENCRYPTION` default empty/`0` (`scripts/backup.sh:37-39`, `:114-128`). | Plaintext PHI is permitted by default with only a warning. Owner must set recipient and require encryption in the approved runtime configuration. |
| Verifier | `scripts/backup-verify.sh:26-31` defaults to `BACKUP_DIR` or `./backups`; `BACKUP_VERIFY_REQUIRE_ENCRYPTION` defaults `0`; `BACKUP_MAX_AGE_HOURS` is optional. | Needs the same path mapping and encryption policy as the producer; no tier awareness. |
| Retention/tiering | No repository retention deletion; only free-space guard and monitoring thresholds (`docs/PRODUCTION_READINESS_PHASE8_0.md:203`). | `daily`/`weekly`/`monthly` policy remains documentation/owner decision, not implemented behavior. |
| Service account / permissions | Repository scripts assume the invoking account can use Docker CLI, `age`, optional `rclone`, and `mountpoint`. Host directories are historically `root:root 700`; backup docs assume `deploy:clinicdeploy`, while monitoring units use `deploy:deploy`. | Group model is inconsistent. Owner must identify the backup operator/service account and confirm write access without weakening `700` permissions. No host verification was performed. |
| WAL/PITR | Host has `wal-archive`, but repository engine is logical `pg_dump -Fc` plus volume archives; no coordinated `pg_backup_start/stop` or physical base backup (`docs/PRODUCTION_READINESS_PHASE8_0.md:196-202`). | WAL archiving/PITR remains unimplemented and unauthorized in this phase. |

Conclusion: the repository engine and host-prepared directories are **not yet integrated**. A path mapping, encryption policy, mount/UUID gate, service account, and retention decision are required from the owner before any backup implementation or schedule work.

### 7.2 Monitoring host-systemd readiness

Repository-verified requirements:

| Requirement | Evidence | Status |
|---|---|---|
| Working directory `/opt/clinic/Clinc-V1.1` | `deploy/clinic-monitor.service:13`, `deploy/clinic-heartbeat-check.service:11` | Template only; host path not verified. |
| Environment file `/etc/clinic/monitor.env`, mode `0600`, owner `deploy:deploy` | `deploy/monitor.env.example:2-3`, service `EnvironmentFile=` lines | Not created/verified. Values are blank in the example. |
| State/sink `/var/lib/clinic-monitor`, `alerts.jsonl` | `deploy/monitor.env.example`, `docker-compose.monitoring.yml:22-23`, `deploy/clinic-monitor.logrotate:5-12` | Host directory/permissions not verified; built-in sink rotation vs host logrotate choice still required. |
| Service account `deploy` | `deploy/clinic-monitor.service:11-12`, heartbeat service `:9-10` | Docker group access and host account state not verified. |
| Telegram | `P7_TELEGRAM_BOT_TOKEN`, `P7_TELEGRAM_CHAT_ID`, `P7_TELEGRAM_API_BASE` in `deploy/monitor.env.example:8-13` | Bot, chat ID, token, and HTTPS egress are owner-controlled; no real delivery test. |
| Heartbeat | `P7_HEARTBEAT_URL` in `deploy/monitor.env.example:21` | Provider/account/URL open; no real ping test. |
| WAL/cert/path checks | `scripts/p7-check-wal.sh:14-16`, `scripts/p7-check-capacity.sh:10`; overlay lacks `P7_WAL_DIRS`, `P7_CERT_FILES`, and `P7_PATHS` mappings (`docs/PRODUCTION_READINESS_PHASE8_0.md:236`) | Owner must map host directories into the monitor; default `PATHS` includes `/mnt/clinic-backups`, but the overlay does not bind it. |
| Docker socket | `docker-compose.monitoring.yml:43-44` mounts `/var/run/docker.sock` read-only | Owner must confirm `deploy` access and accept the socket exposure; no daemon operations were performed. |
| Units/timers | `clinic-monitor.{service,timer}` (`*:0/5`) and `clinic-heartbeat-check.{service,timer}` (`*:0/10`) (`docs/PRODUCTION_READINESS_PHASE8_0.md:239`) | Templates only; not installed/enabled. |
| Production safety | `P7_ALLOW_INSECURE_TEST=0` (`deploy/monitor.env.example:17`) | Must remain `0` in production. |

Conclusion: monitoring is **repository-ready as a template/mock implementation only**. No host configuration, credential insertion, unit/timer installation, schedule activation, or real alert delivery was performed.

### 7.3 Additional backup findings from the read-only reconciliation

- **No approved destination mapping.** Three incompatible destinations exist: repository default `backups/`, documentation `/mnt/clinic-backups/backups`, and the historically observed tiered layout. No final mapping is approved; Phase 8.0 explicitly forbids silently choosing one.
- **Flat-only consumers.** `scripts/backup-verify.sh` scans only the top level for `MANIFEST-*.txt` and orphan artifacts, and `scripts/p7-check-backup.sh` uses `find -maxdepth 1`. A `manifests/` subdirectory would not be scanned; the tiered directories have no repository-defined semantics.
- **Wrapper/WAL/schedule capabilities are documentation-only.** No `findmnt` UUID wrapper, backup systemd unit, schedule, `archive_command`, WAL retention implementation, 70/85/95% sender, or retention deletion was found in repository scripts or `deploy/`. Historical/output-of-repository artifacts cannot be treated as installed repository behavior.
- **Fail-open defaults require explicit runtime configuration.** `BACKUP_REQUIRE_MOUNT=0`, `BACKUP_REQUIRE_ENCRYPTION=0`, empty `BACKUP_AGE_RECIPIENT`, and verifier `BACKUP_VERIFY_REQUIRE_ENCRYPTION=0` permit unencrypted PHI and writes outside the intended mount unless the owner supplies safe values. The documented safe values are in `/etc/clinic/backup.env` prose, but no repository env template exists.
- **Permission checks are advisory.** `mkdir -p` precedes the mount check, `chmod 700 … || true` ignores failure, and the verifier's directory-mode check only warns. These cannot prove host-side `0700`/`0600` enforcement.
- **Monitoring can mask an unmounted disk.** `scripts/p7-check-backup.sh:18-34` falls back from `mountpoint -q` to `directory_only` and reports `mount_present=1` if the directory merely exists. Production configuration must not rely on that fallback.
- **Executable-bit dependency.** The backup monitor invokes `backup-verify.sh` only when it is executable; otherwise the check reports `high`. Host checkout permissions must be verified.
- **Stale terminology in `scripts/backup.sh`.** Comments/refusal text refer to an "external USB HDD" and "internal disk" in a way that contradicts the owner-corrected architecture: internal SATA HDD is backup storage, USB is key escrow only. This is a documentation defect in code comments/messages, not a reason to alter disk handling in this phase.
- **Legacy dump remains an unverified orphan.** `backups/db-20261113T134414Z.dump` is preserved and hashed but is not a verified recovery source. Its quarantine/disposition requires an owner decision; it was not moved or deleted.

### 7.4 Additional monitoring findings from the read-only reconciliation

- **Host-systemd path is the workable design.** The Compose monitoring overlay is optional and default-off; as shipped it lacks `P7_WAL_DIRS`, `P7_CERT_FILES`, `P7_PATHS`, and a `/mnt/clinic-backups` bind mount. Inside the container, `P7_BACKUP_DIR` would not see the host disk.
- **Env template is incomplete for host-systemd.** `deploy/monitor.env.example` covers Telegram, heartbeat, host label, insecure-test flag, and sink rotation, but not `P7_STATE_DIR`, `P7_ALERT_SINK`, `P7_BACKUP_DIR`, `P7_BACKUP_MOUNT`, `P7_REQUIRE_MOUNT`, `P7_MAX_AGE_HOURS`, `P7_COMPOSE_PROJECT`, `P7_CERT_FILES`, `P7_WAL_DIRS`, or `P7_PATHS`. Missing values must be supplied by the owner in the 0600 file; WAL/cert checks remain `unknown` otherwise.
- **Missing env file is non-fatal.** Both units use `EnvironmentFile=-/etc/clinic/monitor.env`. The leading `-` tolerates a missing file, so real alert delivery can remain disabled without an obvious unit failure.
- **State directory must pre-exist.** Units declare `ReadWritePaths=/var/lib/clinic-monitor` but no `StateDirectory=`; the `deploy` account must own/pre-create a `0700` directory.
- **Group mismatch.** Backup documentation uses `deploy:clinicdeploy`; monitor units use `User=deploy`, `Group=deploy`. Docker CLI access for `deploy` is a repository requirement but host membership is **Not verified**.
- **Timers are not persistent.** `clinic-monitor.timer` (`*:0/5`) and `clinic-heartbeat-check.timer` (`*:0/10`) use `Persistent=false`; missed runs are not caught up. Both units/timers are templates only and uninstalled.
- **Test shims must remain off.** `P7_ALLOW_INSECURE_TEST`, `P7_SKIP_CYCLE`, `P7_SKIP_VERIFY`, `P7_MOUNT_PRESENT`, `P7_BIN_DIR`, and `P7_NOW_EPOCH` exist for isolated validation; none may be set in production.
- **Real delivery remains unproven.** Telegram and heartbeat were validated with local mocks and synthetic values only. No bot/chat/token, heartbeat provider URL, HTTPS egress test, timer run, real alert, or no-PHI message audit was performed.

---

## 8. Changes made

The only file created in Phase 8.2 is:

- `docs/PRODUCTION_READINESS_PHASE8_2.md` (this report).

No application code, CI workflow, scanner, classifier, Dockerfile, backup/monitoring script, clinical report template, patient data, dependency declaration, lockfile, or Git history was modified. No repository setting was changed.

---

## 9. Tests and validation

### 9.1 Performed in Phase 8.2

- Read-only Git preservation baseline: branch, HEAD, status counts, `backup.patch` blob and SHA-256, legacy dump SHA-256.
- Static review of `.github/workflows/ci.yml`, including permissions, triggers, env, PostgreSQL service, job dependencies, failure propagation, audit behavior, Node version, and action pinning.
- Read-only parsing of the Phase 8.1 audit snapshot to confirm advisory IDs, ranges, package set, and `fixAvailable`.
- Static Prisma 7 migration-impact review against repository schema, client construction, TypeScript config, scripts, and source greps.
- Read-only scanner discovery on PATH, common install locations, and repository filenames; Docker CLI version query only.
- Repository-only backup/monitoring path, environment-variable, permission, and service-account reconciliation.
- Read-only preservation recheck after creation of this report.

### 9.2 Not performed

- GitHub Actions workflow execution; no CI pass claim.
- PostgreSQL service startup, migrations, full DB-backed backend suite, or local database access.
- Repository build/test re-execution in this phase; Phase 8.1 results remain the latest recorded local results.
- Docker build, pull, run, daemon query, or image CVE scan.
- Ubuntu/SSH access, host inventory, mount revalidation, backup, restore drill, WAL activation, monitoring installation, timer enablement, or alert delivery.
- Secret validation, provider lookup, rotation, or history rewrite.
- Staging, commit, push, tag, release, or any other forbidden Git operation.

---

## 10. Preservation verification

| Item | Baseline | After this report |
|---|---|---|
| Branch | `feature/clinic-quick-actions` | unchanged |
| HEAD | `0d79b7d98962b204806e3e2cf2caf1ac381f1026` | unchanged |
| Modified tracked files | 15 | 15 |
| Untracked entries | 17 | 18 (this report added) |
| `backup.patch` Git blob | `e31aa83e68fd94a76efcfcdad156521c286e6ce6` | unchanged |
| `HEAD:backup.patch` | `e31aa83e68fd94a76efcfcdad156521c286e6ce6` | unchanged |
| `backup.patch` SHA-256 | `4D7440E2813B7A51BE3B3439439071DFCD638EBDDB7F02C0E4893FB1E7690769` | unchanged |
| Legacy dump SHA-256 | `70A4B4D0366AF79C5FF5C273A5927F6B89F2D826A5AAD0D2351067F472574BDF` | unchanged |

All Phase 7/8 work remains present. No forbidden Git operation was performed.

---

## 11. Remaining blockers and owner actions

| ID | Blocker after Phase 8.2 | Required owner action |
|---|---|---|
| B1 | Deterministic timing tests exist; DB-backed/CI proof still missing. | Run full backend suite in first CI execution and record result. |
| B2 | Work remains uncommitted; no tag or release artifact. | After B6 decision and review, authorize logical commits, tag, and deploy-from-tag record in a separate phase. |
| B3 | Backup/recovery integration unresolved; no real app-aware backup or restore. Flat-only verifier/monitor conflict with tiered host layout; encryption/mount checks fail open by default; wrapper/WAL/schedule/retention are docs-only. | Decide path mapping, encryption policy, strict mount/UUID gate, account/group model, retention, and legacy-dump quarantine; review out-of-repository wrapper artifacts; then authorize real backup and restore drill. |
| B4 | CI workflow is static-ready but never executed; no required checks. | Push workflow, enable Actions, approve first run, review logs, enforce checks. |
| B5 | Prisma 6.x High advisories remain; image CVE scan not verified. | Approve/install scanner and scan artifacts; separately approve Prisma 7.10.1+ migration and re-audit. |
| B6 | Historical candidate remains ACTIONABLE / INCONCLUSIVE. | Validate in isolation; rotate/revoke if not provably inert; record decision without publishing value/fingerprint. |
| B7 | Target environment not independently revalidated. Repository paths conflict (`/opt/clinic` vs `/opt/clinic/Clinc-V1.1`); current mount/dir state, account groups, WAL dirs, and cert paths are host-controlled. | Authorize read-only host inventory, domain/TLS/owner decisions, current mount/directory/preflight verification, and path/group reconciliation. |
| B8 | No real deployment, health verification, monitoring, or alert exercise. Units/timers are uninstalled; env template is incomplete; overlay lacks host backup mount; missing env file is non-fatal. | Complete prerequisite blockers, populate the complete 0600 host env, install/enable both timers, then authorize controlled rollout and post-rollout verification. |
| B9 | Telegram/heartbeat credentials, provider, scheduler, and real test remain open; test shims must stay off. | Create/approve accounts and 0600 env values, install timers, keep `P7_ALLOW_INSECURE_TEST=0`, and verify real delivery with no PHI/token leakage. |

---

## 12. Final decision

**Phase 8.2 execution status: COMPLETED for repository-only investigation and documentation.**

**Production readiness: NOT ACHIEVED.**

**Decision for the next operational phase: NO-GO.**

Phase 8.2 clarified exact first-run CI steps, the safe-but-breaking Prisma remediation path, image-scan requirements, the unchanged historical-secret decision, and backup/monitoring integration gaps. None of those owner-controlled blockers was resolved by repository-only work. Deployment, service activation, monitoring, alerting, backup operations, credential changes, Phase 8.3, and any later phase remain unauthorized.
