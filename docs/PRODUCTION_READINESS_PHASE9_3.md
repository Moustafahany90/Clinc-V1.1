# Production Readiness — Phase 9.3 Post-Merge Audit

**Date:** 2026-11-21
**Scope:** Read-only audit of `main` after PR #4 merge. No deployment, migration, restore, container run, dependency change, commit, or configuration change was performed.
**Final verdict:** **NO-GO**

## Executive summary

The merge is intact and CI on the exact merge commit is green. That establishes code and pipeline health, not production readiness. Recovery is unproven (no real backup/restore, no PITR), the target host and TLS/topology decisions are not revalidated, migration deployment has populated-table and rollback risks, and four High dependency advisories remain under an explicit CI exception. These are concrete blockers; deployment must not proceed.

## 1. Current branch and HEAD

| Item | Verified value | Evidence |
|---|---|---|
| Local branch / HEAD | `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309` | `git branch --show-current`, `git rev-parse HEAD` |
| Local `main` / `origin/main` | Both stale at `e55119fd8067316ebc4af23d93c468f399a7efc6` | `git rev-parse main origin/main` |
| Remote `main` (authoritative) | `766c8898db5c7a1dc8b020a7a076d420c8eba370` | GitHub API `GET /branches/main` |
| Merge commit | `766c889...`, parents `e55119f...` (old main) and `a828bcf...` (PR head) | `GET /commits/766c889`, PR #4 `merge_commit_sha` |
| PR #4 | `closed`, `merged: true`, merged 2026-11-21T09:28:06Z | `GET /pulls/4` |
| Ancestry check | `main` is 15 commits ahead of `e55119f`, 0 behind; all 14 feature commits plus merge present | `GET /compare/e55119f...766c889` |

Local refs were intentionally not fetched; remote state was verified read-only through the API. The untracked files from earlier phases remain untouched.

## 2. Git / CI status

- Latest `main` workflow run: `44889720451` (push, **success**, 2026-11-21T09:30:20Z). PR run `44889443848` also **success**. Evidence: `GET /actions/runs?sha=766c889...`.
- Check runs on `766c889...`: **3/3 completed, all `success`** — `Secret scan, typecheck, build, unit tests`; `Backend tests (synthetic PostgreSQL)`; `Backend dependency audit`. No failed or pending Actions check runs.
- The legacy commit-status API reports `pending` with `total_count: 0`; no statuses are posted by this workflow, so this is not a pending check.
- Branch protection on `main` is enabled.
- CI limits: the workflow has only those three jobs. There is no production smoke test, image CVE scan, migration rollback test, or target-host validation. `Backend tests` applies migrations to an **empty synthetic** database (`.github/workflows/ci.yml:132`), not to production-like data.
- Green CI does **not** imply production readiness.

## 3. Database migrations

Nine migrations exist in lexicographic application order: `20261026085618_init` → `20261029120000_add_token_blacklist` → `20261030120000_report_template_pinning` → `20261031120000_token_version_and_override_permissions` → `20261101120000_report_whatsapp_delivery` → `20261102120000_patient_referring_doctor` → `20261113135000_remove_email_delivery` → `20261120222405_db_integrity_constraints` → `20261121220000_phase91_performance_indexes`. `migration_lock.toml` declares PostgreSQL. `migrate` is a one-shot Compose service that runs `prisma migrate deploy` and gates `backend` via `service_completed_successfully` (`docker-compose.yml`), so a failed migration prevents API startup (availability risk, not silent corruption).

Evidence and limitations:

- CI proved the full chain applies cleanly to a fresh synthetic database.
- `20261120222405_db_integrity_constraints/migration.sql:14-16,184-221` adds constraints `NOT VALID` then `VALIDATE`s all of them in one transaction: dirty production rows cause an atomic migration failure, not partial constraints. A manual `rollback.sql` exists but requires hand-editing `_prisma_migrations` for a successful migration (rollback is not automated).
- `20261121220000_phase91_performance_indexes/migration.sql:2-7` uses plain `CREATE INDEX` on four tables. The file itself states tables are expected empty pre-launch and recommends `CONCURRENTLY` for a populated database. On populated production tables this can block writes and cause downtime. **Production table state was not checked (no access authorized).**
- Earlier migrations are destructive/irreversible without a restore: `20261102120000_patient_referring_doctor` drops `Patient.email`; `20261113135000_remove_email_delivery` drops `EmailLog` and five `ClinicSettings` columns; `20261031120000...` performs a data `UPDATE` on `User.permissions`. If these have not already been applied, deployment permanently removes those columns/table.
- No migration was executed and no production migration status was queried in this audit.

## 4. Backup and rollback

- Repository scripts `backup.sh`, `backup-common.sh`, `backup-verify.sh`, `restore-drill.sh`, `p831-backup-isolated-test.sh` were reviewed; `bash -n` on all of them and on both p72 scripts returned 0.
- Historical isolated evidence: `p831-backup-isolated-test.sh` passed **16/16** in Ubuntu/WSL; it uses temporary directories and stubs, not real backups (`docs/PRODUCTION_READINESS_PHASE8_3_1.md:296,323-325`).
- No real application-aware encrypted backup, decryption check, or restore drill has been performed (`docs/PRODUCTION_READINESS_PHASE8_0.md:189`, `PHASE8_4.md:176`, `PHASE8_3_1.md:357`).
- `docs/backup-restore.md:32,116-117,268` states WAL archiving is **disabled**, `wal-archive/` is reserved only, and the 5-minute RPO is **not claimed**. Full restore requires written approval and downtime (`:314-333`).
- `backups/` contains only `db-20261113T134414Z.dump`; documentation classifies dump-only/legacy sets as non-compliant for production verification (`backup-restore.md:151-200`).
- Age private-key escrow verification, backup account/ACL, automatic schedule, retention, monitoring installation, and real alert delivery remain unverified (`PHASE8_4.md:207-231`; `PHASE8_3_1.md:367`).
- **No production restore was performed.** Recovery, RTO and RPO are unproven: this is a hard blocker.

## 5. Docker / Nginx

- Static validation passed: `docker compose ... config --quiet` exit 0 for base, base+TLS, base+limits, and all three overlays together (secrets suppressed).
- Compose defines healthchecks for `db`, `backend`, `web`, `evolution`, and optional `caddy`; `migrate` is intentionally one-shot. Named volumes: `ultrasound_clinic_db_data`, `ultrasound_clinic_storage`, `ultrasound_clinic_evolution_instances`, plus Caddy data/config. Base binds `db`/`web` to loopback; only Caddy publishes 80/443.
- `web/nginx.conf` has `/healthz`, 32 MB body limit, and PHI/secret-redacting logs; lines 124-126 forward client-provided `X-Forwarded-For`, `X-Real-IP`, and `X-Forwarded-Proto` unchanged. Spoof-safety was proven only with Caddy in front (`PHASE9_2.md:186,192`); a directly exposed nginx could let clients control `req.ip` and bypass IP-keyed limits.
- `deploy/Caddyfile` is a valid TLS front door template with HSTS and log redaction; `CLINIC_DOMAIN`, `APP_ORIGIN=https://...`, and `COOKIE_SECURE=true` are required. Domain/DNS/TLS mode were not revalidated.
- Runtime validation is **BLOCKED**: Docker Desktop daemon is unavailable (`failed to connect to the docker API`), `nginx` CLI is absent, and `python3` is absent. No container was built, started, stopped, or inspected; no production resource was touched.
- The p72 nginx shell harness remains blocked in this environment (`PHASE9_2_2.md:465-466`; `PHASE9_2_1.md:239-241`). Historical Phase 7.2 results (`nginx -t` OK, `caddy validate` OK, 3/3 focused tests) exist but were not reproduced.
- `docker-compose.limits.yml` is opt-in and over-subscribes the stated 4-core host (4.75 vCPU steady, 5.75 during migration; Caddy uncapped) (`PHASE9_2.md:219-228`); sizing was never validated on the target host. No image CVE scan has ever been performed (no scanner installed).
- Failures that could cause downtime: migration failure blocks API start; plain `CREATE INDEX` on populated tables; unvalidated resource caps; direct-nginx exposure without Caddy.

## 6. Prisma security (4 High advisories)

| Package (installed) | Advisory / affected | Fixed | Project exposure |
|---|---|---|---|
| `prisma` 6.18.0 and `@prisma/config` 6.18.0 | `npm audit` range `6.13.0-dev.1 - 7.10.0` (via `@prisma/config`) | `prisma` 7.10.1 (npm fix; semver-major, not applied) | CLI/build/migrate stage; not imported by runtime source |
| `deepmerge-ts` 7.1.5 | GHSA-ggr8-5vv4-36mx / CVE-2026-40345, `< 8.0.0` | 8.0.0 | Transitive via `@prisma/config`; requires attacker-controlled recursive objects |
| `effect` 3.18.4 | GHSA-38f7-945m-qr2g / CVE-2026-32887, `< 3.20.0` | 3.20.0 | Transitive via `@prisma/config`; ALS/RPC concurrency issue |
| `effect` 3.18.4 | GHSA-7589-6fvf-x4pw / CVE-2026-121707, `<= 3.22.0` | 3.22.1 | Transitive via `@prisma/config`; ReDoS in schema decoding |

Evidence: `npm --prefix backend audit --json` reports exactly 4 high / 0 critical; `npm ls` resolves the versions above; `@prisma/client` itself is not flagged. No source file imports `effect`, `deepmerge-ts`, or `@prisma/config` (grep of `backend/src`). `backend/Dockerfile:38-40` explicitly removes the CLI and transitive packages from the runtime image; the build/migrate stage still contains them. CI's `Backend dependency audit` passes because `scripts/dependency-audit.mjs:1-14,52-62` accepts this exact cluster as a documented temporary exception and emits a warning. No dependency was upgraded. Residual risk is limited but the advisories are real and unfixed; owner acceptance and a separately validated Prisma 7 migration remain required (`PHASE8_4.md:212`).

## 7. Previous blockers rechecked

Resolved: branch publication, PR existence, CI on exact HEAD, pre-push whitespace, and the Phase 9.2 queue-position/shutdown defects (fixed in 9.2.1 and covered by green CI).

Still open (actual blockers):

1. **Recovery unproven.** No real encrypted backup/restore, no PITR/WAL, unbounded RPO, unverified key escrow and backup account. Evidence: §4 above. Required: owner-authorized backup, isolated restore drill, measured RTO/RPO, and a decided schedule/retention policy.
2. **Deployment-state unknown.** Migration status on target, table sizes before plain `CREATE INDEX`, and existing data validity against 38 new CHECK constraints cannot be verified without authorized access. Required: read-only host/DB inventory and a staging rehearsal with production-shaped data.
3. **Target/host and topology decisions outstanding.** Domain/DNS/TLS mode, Caddy-fronted enforcement (or XFF fix), `/opt/clinic` path, permissions/account model, host version, and monitoring installation are not revalidated. Evidence: `PHASE8_4.md:208-231`, `PHASE9_2.md:192`.
4. **Runtime validation blocked here.** p72 nginx harness, container health/startup, image CVE scan, and target-host resource validation could not run. Evidence: §5 above.
5. **Four High Prisma advisories** remain under a temporary CI exception; no upgrade or formal owner risk acceptance is recorded here. Evidence: §6 above.

## 8. Final decision

**NO-GO.** Production deployment must not proceed. Items 1–3 are hard prerequisites; items 4–5 must be closed or explicitly risk-accepted by the owner. CI success on `766c889...` is necessary but not sufficient.

No push, PR change, merge, deployment, restart, migration, restore, dependency change, or production configuration change was performed in this audit. Work stops here pending separate authorization.
