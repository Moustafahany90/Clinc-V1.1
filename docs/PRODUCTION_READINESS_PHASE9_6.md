# Phase 9.6 Production Infrastructure Readiness

**Date:** 2026-11-21  
**Branch:** `fix/phase9-remediation`  
**Scope:** Final infrastructure-readiness sweep for WAL/PITR, Compose overlays, scheduling templates, monitoring checks, Docker runtime, resource limits, local TLS/proxy behavior, migrations, and Prisma advisories.

## 1. Scope and safety boundary

All work was performed in the existing worktree with synthetic data and isolated Docker/WSL environments only.

No Production access or Production-affecting operation was performed. Specifically, there was no Production login, config change, container restart, database query or write, migration, backup, restore, WAL cleanup, deployment, external notification, real patient data use, secret logging, commit, push, merge, branch switch, reset, or dependency upgrade.

The only database writes were to throwaway PostgreSQL instances created inside the isolated project `p96iso` and to disposable `initdb` clusters under WSL temporary directories. All were removed after evidence capture.

The isolated Compose project used:

- Project name: `p96iso`
- Network: `p96iso_net`
- External volumes: `p96_db`, `p96_wal`, `p96_storage`, `p96_evolution`
- Synthetic env file outside the repository
- Final stack: `base + pitr + limits` plus a temporary volume/network override

Cleanup was completed: containers, network, volumes, temp env files, test harnesses, audit JSON, and the temporary `p96-migrate:latest` image were removed. Pre-existing Phase 9.2–9.5 reports and harnesses were left in place.

## 2. Environment

| Item | Result |
| --- | --- |
| Docker Engine | `29.9.3` |
| Docker Compose | `5.7.0` |
| Daemon | Reachable |
| Isolated DB image | `postgres:16-alpine` |
| WAL archiver runtime user | `postgres`, UID/GID `70:70` |
| WSL Ubuntu toolchain | PostgreSQL 16 + `age` already present under `~/.local/p94-tools/root` |
| Application images | Existing local `ultrasound-clinic-backend:latest`, `ultrasound-clinic-web:latest` |
| TLS image | Existing local `caddy:2.11-alpine` |

## 3. Files changed

### 3.1 Tracked files modified

| Path | Phase 9.6 change |
| --- | --- |
| `.env.example` | Added PITR/WAL threshold documentation. |
| `deploy/Caddyfile` | Added explicit HTTP→HTTPS redirect block. |
| `deploy/monitor.env.example` | Added PITR base age, WAL range, and WAL freshness thresholds. |
| `docker-compose.limits.yml` | Rewrote conservative CPU/memory/pids limits; moved Caddy limits out to avoid an invalid `base + limits` combination. |
| `docker-compose.monitoring.yml` | Wired new PITR/WAL monitor variables. |
| `docker-compose.tls.yml` | Added Caddy resource caps so TLS and limits overlays compose correctly. |
| `docs/backup-restore.md` | Corrected WAL archive command/path and Alpine tooling description. |
| `scripts/backup-common.sh` | WAL range/checksum helpers and related shared hardening. |
| `scripts/backup-verify.sh` | PITR-aware manifest handling and strict validation. |
| `scripts/backup.sh` | Format-4 backup hardening retained and revalidated. |
| `scripts/p7-check-backup.sh` | Skips PITR base manifests when selecting logical backups. |
| `scripts/p7-monitor.sh` | Added `pitr` to the default check set. |
| `scripts/restore-drill.sh` | Preserved Phase 9.4 restoration behavior. |

### 3.2 Untracked files touched or added by this work

| Path | Purpose |
| --- | --- |
| `deploy/clinic-backup-schedule@.service` | Repository-only dispatcher unit template. |
| `deploy/clinic-backup-full.timer` | Repository-only full-backup timer template. |
| `deploy/clinic-backup-pitr-base.timer` | Repository-only PITR base timer template. |
| `deploy/clinic-backup-verify.timer` | Repository-only verify timer template. |
| `deploy/clinic-backup-retention.timer` | Repository-only retention timer template. |
| `deploy/clinic-wal-prune.timer` | Repository-only WAL-prune timer template. |
| `deploy/wal-archive.sh` | Fail-closed WAL archiver; path and UUID checks corrected. |
| `deploy/wal-restore.sh` | Fail-closed restore helper; path and UUID checks corrected. |
| `docker-compose.pitr.yml` | Corrected WAL archive mount and command path. |
| `scripts/backup-retention.sh` | Retained Phase 9.4 retention behavior. |
| `scripts/backup-scheduler.sh` | New single-lock scheduling dispatcher. |
| `scripts/p7-check-pitr.sh` | New read-only PITR monitor check. |
| `scripts/pitr-base-backup.sh` | Added free-space preflight. |
| `scripts/pitr-restore.sh` | Preserved Phase 9.5 restoration behavior. |
| `scripts/p94-*.sh`, `scripts/p95-*.sh`, `scripts/restore-backup.sh` | Pre-existing Phase 9.4/9.5 harnesses preserved and rerun. |
| `docs/PRODUCTION_READINESS_PHASE9_6.md` | This report. |

Phase 9.2–9.5 reports were preserved. `docs/PRODUCTION_READINESS_PHASE9_5.md` was deliberately not edited; its historical Alpine/`bash` description and old WAL command path are now stale and should be treated as historical drift. The corrected operational reference is `docs/backup-restore.md`.

## 4. Infrastructure improvements

### 4.1 WAL/PITR correctness

- Fixed a real PITR overlay defect: `archive_command` pointed at `/clinic/scripts/deploy/wal-archive.sh`, but `deploy/` was not mounted there. It now mounts `./deploy:/clinic/deploy:ro` and runs `/bin/sh /clinic/deploy/wal-archive.sh %p %f`.
- Fixed a fail-open branch in both WAL helpers: when `findmnt` was available, a mismatched filesystem UUID no longer fell through to success.
- Confirmed the archiver works in `postgres:16-alpine` as UID `70`, using `/proc/self/mountinfo` and `/proc/self/mounts` rather than unavailable `findmnt`.
- Added a dedicated base-backup free-space preflight, `PITR_BASE_MIN_FREE_MB` (default `512`).
- Kept WAL staging at mode `0600`, wrote `<segment>.sha256` sidecars, published with atomic hard links, refused conflicting content, and exited non-zero on failure so PostgreSQL retries the segment.

### 4.2 Scheduling

- Added `scripts/backup-scheduler.sh` with one non-blocking `flock`, start/completion/failure logging, backup-root and WAL free-space preflights, and dry-run defaults for cleanup jobs.
- Added repository-only systemd service/timer templates for full, PITR base, verify, retention, and WAL prune jobs.
- WAL prune is dependency-aware: it computes the oldest required WAL segment across retained PITR manifests, preserves the full required range, and never deletes the newest archived segment.
- No timer or dispatcher was installed, enabled, or invoked on any host outside isolated tests.

### 4.3 Monitoring

- Fixed `scripts/p7-check-backup.sh` so PITR base manifests are not mistaken for logical backup sets.
- Added `scripts/p7-check-pitr.sh` to check newest PITR base age, required WAL presence, SHA-256 sidecar validity, and newest-WAL freshness.
- Added `pitr` to the default `scripts/p7-monitor.sh` check list.
- Added monitor threshold variables to `deploy/monitor.env.example` and `docker-compose.monitoring.yml`.
- Monitoring remains profile-gated and opt-in; no alert delivery or heartbeat was enabled.

### 4.4 Docker resources and overlays

- Rewrote `docker-compose.limits.yml` with conservative defaults for the stated 4-core/16 GB host.
- Found and fixed a final regression: `base + limits` failed because the limits overlay defined `caddy`, which only exists in the TLS overlay. Caddy caps now live in `docker-compose.tls.yml`; all tested overlay combinations render cleanly.
- Final steady CPU budget including Caddy: `3.75` vCPU. Migration burst: `4.50` vCPU. Hard memory ceiling: about `8.5 GB`. These are configuration defaults, not measured production load.

### 4.5 TLS/proxy

- Added an explicit HTTP→HTTPS redirect to `deploy/Caddyfile`, making redirect behavior visible in config and locally testable without public certificate issuance.
- Validated Caddy config with `caddy validate`.
- Validated local redirect/HSTS behavior with a throwaway Caddy configuration using `tls internal` and a local synthetic responder only.

## 5. Tests and results

| Area | Command/summary | Result |
| --- | --- | --- |
| Shell syntax | `bash -n` on 19 touched/new shell scripts | OK, 19/19 |
| Compose render | `docker compose ... config --quiet` for base, TLS, PITR, limits, monitoring, TLS+limits, and all overlays with synthetic env | OK, 7/7 combinations |
| Overlay regression | Initial `base + limits` failed with `service "caddy" has neither an image nor a build context`; fixed by moving Caddy caps into `docker-compose.tls.yml` | OK after fix |
| Isolated runtime | `up -d --force-recreate --wait` for `base + pitr + limits` | OK; all four long-running services healthy, migrate exit `0` |
| Migration execution | `prisma migrate deploy` in isolated stack and separate synthetic `*_test` DB | OK; all 9 migrations applied |
| Runtime resource caps | `docker inspect` on recreated containers | OK; values match final overlay |
| WAL archiver in container | 8 scenarios as UID `70` in `postgres:16-alpine` | OK, 8/8 |
| WAL archive artifacts | 9 segments with 9 SHA-256 sidecars, mode `600`, owner `70:70` | OK |
| Scheduler harness | `backup-scheduler.sh` dry-run, apply, lock, low-disk, logging | OK, 7/7 checks |
| PITR monitor harness | Healthy, missing WAL, invalid checksum | OK; summary statuses `ok`, `critical`, `critical`; exit codes `0`, `3`, `3` |
| Phase 9.4 backup/recovery | `wsl -d Ubuntu -- bash .../p94-backup-recovery-test.sh` | OK, 18/18 assertions |
| Phase 9.5 PITR | `wsl -d Ubuntu -- bash .../p95-pitr-test.sh` | OK, 12/12 assertions |
| Backend typecheck | `npm --prefix backend run typecheck` | OK |
| Backend build | `npm --prefix backend run build` | OK |
| Web typecheck | `npm --prefix web run typecheck` | OK |
| Web build | `npm --prefix web run build` | OK |
| Backend test suite | First attempt failed only because env pointed at a non-`_test` DB with `NODE_ENV=production`; rerun with synthetic `ultrasound_clinic_test` and `NODE_ENV=test` | OK, 202/202 |
| Secret scan | `node scripts/secret-scan.mjs` | OK; 0 actionable, 2 allowlisted fixtures |
| Secret-scan regression | `node scripts/secret-scan-regression.test.mjs` | OK, 10/10 |
| Nginx config | `nginx -t` with repo config on the isolated Docker network | OK |
| Caddy config | `caddy validate --config deploy/Caddyfile --adapter caddyfile` | OK |
| Caddy local redirect/HSTS | Throwaway `tls internal` Caddy; HTTP request returned `301` to HTTPS, HTTPS returned `200` with HSTS | OK, local-only |
| Migration safety | Synthetic migrated schema checks | OK; 38 CHECK constraints from migration #8, 4 Phase 9.1 indexes, 43 total public CHECK constraints |
| Dependency audit | `scripts/dependency-audit.mjs` with generated npm audit JSON | OK with documented 4-high Prisma exception; no unexpected findings |
| Whitespace | `git diff --check` | OK; benign LF→CRLF notice on `docker-compose.limits.yml` |
| Cleanup | Compose down, external volumes removed, temp harness dir removed | OK |

### 5.1 Final runtime resource evidence

| Service | Memory | CPU quota | CPU shares | pids |
| --- | ---: | ---: | ---: | ---: |
| `db` | 4 GiB | 1.5 | 1024 | 200 |
| `backend` | 3 GiB | 1.0 | 2048 | 300 |
| `web` | 256 MiB | 0.25 | 128 | 100 |
| `evolution` | 1 GiB | 0.5 | 512 | 200 |
| `migrate` | 1 GiB | 0.75 | 512 | 100 |
| `caddy` | 256 MiB | 0.5 | 256 | 100 |

Caddy values are config-render validated only; the TLS overlay was not started because that would require public DNS/certificate issuance.

## 6. Docker limitations

- Docker Engine and Compose were available in this session, unlike earlier phases.
- The full Phase 7.2 nginx privacy runtime harness remained environment-blocked: from WSL Ubuntu, `docker` was not available inside the distro; using `docker.exe` failed during Windows/WSL path conversion. `nginx -t`, Caddy validation, and the local Caddy redirect test were used instead. This is a harness limitation, not an application failure.
- No image CVE scanner or image-content assertion tool was installed or run. No Production image was pulled, scanned, restarted, or replaced.
- No real ACME or public certificate issuance was attempted.
- Resource arithmetic is based on the stated host capacity and visual inspection of configuration, not host telemetry or load testing.
- The local Caddy runtime check used `tls internal` and a synthetic responder. It proves redirect and HSTS behavior, not real certificate trust, DNS, or the repository `reverse_proxy web:80` path under production traffic.

## 7. WAL status

**Local implementation: OK. Production mount: BLOCKED.**

- Correct archive command verified in the running container: `/bin/sh /clinic/deploy/wal-archive.sh %p %f`.
- `archive_mode=on`, `wal_level=replica`, `archive_timeout=30`.
- Archive files were published as UID/GID `70:70`, mode `600`, each with a SHA-256 sidecar.
- Container tests covered happy path, idempotency, conflict rejection, missing directory, read-only filesystem, low space, non-mount fail-closed behavior, and explicit isolated bypass.
- UUID verification is fail-closed when an expected UUID is supplied. It remains empty by default in-container because `/dev/disk/by-uuid` is not normally available there.
- The host-provided mount, UUID, filesystem type, capacity, and ownership on the Production host remain unverified because host access was prohibited.

## 8. Scheduling and monitoring status

- Repository templates: OK.
- Dispatcher logic: OK in isolated tests.
- No timer installation, service enablement, cron entry, or automatic deletion exists outside the isolated test harness.
- Retention and WAL prune default to dry-run. Mutation requires explicit `--apply` plus `--confirm DELETE`.
- Monitor checks are read-only and profile-gated; no external notification, heartbeat, or alert delivery was enabled.
- Target-host state directories, alert sink ownership, outage procedures, named job owners, and retry policy remain BLOCKED pending separate authorization.

## 9. TLS and proxy status

- TLS Compose overlay renders with all other overlays.
- Caddyfile validates with `CLINIC_DOMAIN=clinic.test`.
- Explicit `http://<domain>` block redirects to HTTPS; local runtime returned `301 https://clinic.test/api/test`.
- HTTPS response included `strict-transport-security: max-age=31536000; includeSubDomains`.
- Nginx config syntax is valid and uses path-only access logs, sanitized upstream-failure logs, and the expected proxy headers.
- Real domain DNS, public certificate issuance/renewal, certificate chain, browser trust, `APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY`, and the full reverse-proxy traffic path on the target host remain BLOCKED.

## 10. Migration risks

All 9 repository migrations applied cleanly and in order against synthetic PostgreSQL. No unfinished or rolled-back rows were present.

| Migration | Risk |
| --- | --- |
| `20261120222405_db_integrity_constraints` | Adds 38 CHECK constraints as `NOT VALID`, then validates them all in the same transaction. On dirty production rows, `VALIDATE` fails and the transaction rolls back; Prisma's migration record can be left in a failed/rolled-back state requiring documented manual `_prisma_migrations` reconciliation. Production data validity is unknown. |
| `20261121220000_phase91_performance_indexes` | Uses plain `CREATE INDEX` on `Refund`, `Measurement`, and `FileAsset`. On a populated production database this can block writes. `CREATE INDEX CONCURRENTLY` should be considered only after table sizes and maintenance windows are approved. |
| `20261102120000_patient_referring_doctor` | Destructive: drops `Patient.email`. Requires a verified backup and owner confirmation. |
| `20261113135000_remove_email_delivery` | Destructive: drops email settings columns and `EmailLog`. Requires a verified backup and owner confirmation. |

Production migration status, table sizes, row validity, lock budget, backup freshness, and rollback rehearsal remain BLOCKED.

## 11. Prisma findings

| Package | Installed version |
| --- | --- |
| `prisma` | `6.18.0` |
| `@prisma/client` | `6.18.0` |
| `@prisma/config` | `6.18.0` |
| `deepmerge-ts` | `7.1.5` |
| `effect` | `3.18.4` |

The dependency wrapper accepts exactly the documented 4-high Prisma advisory cluster and found no unexpected findings. Advisories observed:

- `GHSA-ggr8-5vv4-36mx` / CVE-2026-40345 — `deepmerge-ts` stack exhaustion.
- `GHSA-38f7-945m-qr2g` / CVE-2026-32887 — `effect` `AsyncLocalStorage` context contamination.
- `GHSA-7589-6fvf-x4pw` / CVE-2026-121707 — `effect` ReDoS in `Schema.TemplateLiteral`.
- CLI-high assignment through `@prisma/config` / `prisma`, accepted only under the existing CI exception.

No dependency was upgraded. Prisma 7 remains a separate owner-approved decision.

## 12. Remaining blockers

1. Production host WAL mount UUID, filesystem type, capacity, and UID/GID ownership are unverified.
2. Production migration inventory, table sizes, data validity, and lock budget are unknown; migrations #8, #9, #6, and #7 carry the risks above.
3. Real domain/DNS/ACME/TLS trust and the production reverse-proxy path are unverified.
4. Host monitoring state, alert delivery, heartbeat, scheduler installation, ownership, and rotation are not configured or authorized.
5. Resource limits are conservative defaults, not measured under production load; Caddy runtime limits were not exercised.
6. The Phase 7.2 nginx privacy runtime harness is blocked by Docker-in-WSL integration in this environment.
7. No image CVE scan or image-content assertion was performed.
8. Production-shaped RTO/RPO, restore timing, and operational runbook rehearsal remain unmeasured.
9. `docs/PRODUCTION_READINESS_PHASE9_5.md` retains historical stale tooling/path text; it was intentionally not rewritten.

## 13. Final verdict

**PARTIAL**

Phase 9.6 closes the isolated Docker/WAL/runtime, scheduling-template, monitoring, local TLS/proxy, and regression-test gaps. Production-facing mount verification, target-host migration/data checks, real TLS issuance, monitoring/scheduler installation, resource measurement, and the four High Prisma advisories remain unresolved. No Production action was taken; separate authorization is required before any rollout.
