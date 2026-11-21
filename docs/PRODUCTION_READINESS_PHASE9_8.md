# Phase 9.8 — Repository-Only Operational Defect Remediation

**Date:** 2026-11-21  
**Branch:** `fix/phase9-8-operational-defects` (local only)  
**Base:** `main` @ `40829881923e62f0012e6006cb1248faaf4d493b`  
**Scope:** PB-11 and PB-25–PB-31. Repository and disposable synthetic environments only.

> **Verdict: PARTIAL.** The repository defects assigned to Phase 9.8 are corrected and proved with isolated synthetic evidence. This is **not** Production readiness. Every target-host, DNS/TLS, scheduler-installation, image-scanning, and RTO/RPO blocker remains open or blocked. GitHub Actions has **not** run on this branch.

## 1. Safety and authorization boundary

- No Production login, target-host command, database query, migration, backup, restore, WAL prune, DNS change, certificate issuance, container/volume mutation, or deployment was performed.
- No systemd unit, timer, cron job, external heartbeat, Telegram, ACME, or real TLS endpoint was installed, enabled, or contacted.
- No push, PR, merge, branch deletion, reset, force operation, or history rewrite was performed. `main` was not modified.
- Every disposable Docker resource was named `p98*` and used a cached image with `--pull=never`; exact printed targets were removed by traps or `--rm`.
- All credentials, certificates, users, groups, hosts and file paths in proofs are synthetic. No real secret or patient data was used.

## 2. Per-ID outcome

| ID | Repository correction | Isolated proof | Residual status |
|---|---|---|---|
| PB-11 | Removed unsafe direct ledger SQL from the live rollback helper; updated the live rollback runbook; marked the historical Phase M quote `UNSAFE / SUPERSEDED`. No `migration.sql` or schema file changed. | `p97-readiness-preflight.sh` fails on an unmarked reintroduction; current repository PASS. | **CLOSED** (repository-only). Target-host reconciliation still requires separate approval. |
| PB-25 | Dispatcher now supplies job-specific arguments. Four mandatory `pitr-base` values come from flags or protected `PITR_*` / `WAL_ARCHIVE_DIR` env documented in `deploy/backup.env.example`. | `p98-backup-isolated-test.sh`: mandatory args passed; absent value fails closed. | **BLOCKED**: real staged base set with `pitr_ready=true` still required. |
| PB-26 | Monitor runs `root:clinc_server` with `UMask=0007`; heartbeat check runs `clinc_server:clinc_server`; `0750 root:clinc_server` state model documented. | `p98-monitor-isolated-test.sh`: synthetic users prove member read and non-member deny. | **BLOCKED**: target-host directory ownership and observed heartbeat check still required. |
| PB-27 | Mount/UUID validation happens before log creation or WAL evaluation; prune refuses invalid mounts, missing or tampered bases, and missing confirmation. | `p98-backup-isolated-test.sh`: unmounted disk exits non-zero, writes no log, deletes nothing. | **CLOSED** (repository-only); installation remains PB-07. |
| PB-28 | Dispatcher uses per-job flag allowlists; unsupported flags are rejected. | All five jobs pass with documented flags; no usage errors. | **CLOSED** (repository-only); installation remains PB-06/PB-07. |
| PB-29 | Added `P7_CERT_FILES`, `P7_CERT_ENDPOINTS`, thresholds and timeout to env/compose; certificate check supports local files and explicit TLS endpoints; time/container checks fail closed; crashing checks alert; global alert cap. | `p98-monitor-isolated-test.sh`: 37/37 including local synthetic TLS endpoint, clock/container failure injection, crash alert and cap=2. | **BLOCKED**: target-host env values and alert drill still required. |
| PB-30 | Added `verify-pitr-base.sh` and wired it into scheduled verify; checks base SHA-256/size, `SHA256SUMS`, full required WAL list and sidecars. | `p98-backup-isolated-test.sh`: tampered base fails the verifier with `SHA-256 mismatch` and is refused by prune. | **CLOSED** (repository-only); first real base under PB-03 still required. |
| PB-31 | Reconciled all active units to `/opt/clinic`; added `[Install]`, `OnFailure=clinic-backup-alert@%i.service`, journal-only alert unit, and visible overlap failure. | `p98-backup-isolated-test.sh`: lock contention exits 75 and emits a structured alert; preflight enforces single root. | **BLOCKED**: owner approval of root and target-host overlap drill still required. |

## 3. Validation evidence

| Check | Result |
|---|---|
| `bash -n` for every `scripts/*.sh` | PASS |
| `git diff --check` | PASS |
| `bash scripts/p98-backup-isolated-test.sh` | 30 passed, 0 failed |
| `bash scripts/p98-monitor-isolated-test.sh` | 37 passed, 0 failed |
| `bash scripts/p97-readiness-preflight.sh` | PASS (repository invariants only; NOT Production readiness) |
| `bash scripts/p72-phase7-regression.sh` | PASS (telegram/heartbeat/rotation/redaction mocks) |
| `P94_PROVISION_TOOLS=0 bash scripts/p94-backup-recovery-test.sh` | 18 passed, 0 failed, 0 blocked |
| `P95_PROVISION_TOOLS=0 bash scripts/p95-pitr-test.sh` | 12 passed, 0 failed, 0 blocked |
| `bash scripts/p831-backup-isolated-test.sh` | 16 passed, 0 failed |
| `p94-full-restore-drill.sh` (cached local toolchain) | PASS; 353 ms backup / 1470 ms restore, synthetic only |
| `p95-full-pitr-drill.sh` (cached local toolchain) | PASS; integrity and migration checks passed on both restored instances |
| Secret scan | 0 actionable; 2 exact allowlisted fixtures |
| Secret-scan encoding regression tests | 10 passed, 0 failed |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| Web tests (`--reporter=dot`) | 7 files passed, 42 tests passed |
| Backend audit wrapper (offline cached advisory data) | PASS; reported no vulnerabilities. Not equivalent to live CI; PB-15 remains OPEN. |
| Docker Compose `config --quiet`, 7 supported overlays with `CLINIC_DOMAIN=clinic.test` | 7/7 OK |
| Backend suite, `TZ=UTC` | PASS — 202 passed, 0 failed, 0 skipped (synthetic `p98-ci-postgres`, cached image, 84.5 s) |
| Backend suite, `TZ=Africa/Cairo` | PASS — 202 passed, 0 failed, 0 skipped (same disposable DB, 86.7 s) |
| GitHub Actions on this branch | NOT RUN |

## 4. Findings by severity

### High

- PB-11's unsafe migration-ledger guidance was removed from live material and is now rejected by repository invariants.
- PB-25/27/28/30/31 scheduler and PITR verification defects are corrected and synthetically proved, but their target-host installation and evidence remain blocked under PB-06/PB-07/PB-03.
- PB-26/29 monitoring ownership, fail-closed behavior and configuration blind spots are corrected synthetically, but real host configuration and installation remain blocked under PB-08.

### Medium

- Alert delivery is still not proven on a real target channel; the local sink and mocks are the only evidence.
- Historical readiness reports retain their original claims by design; active runbooks and the blocker register are the current reference.

### Low

- Working-tree CRLF normalization warnings from Git on Windows are cosmetic; all tracked `.sh` and unit blobs are `i/lf`, with no NUL bytes or BOM.

## 5. Residual blockers and decision gate

The final acceptance gate remains **PARTIAL**. The following remain unresolved and must not be inferred from this repository-only work:

- PB-01–PB-10, PB-12–PB-14, PB-16–PB-21: target-host, migration-window, DNS/TLS, image-scanning, and restore-drill evidence.
- PB-15: explicit owner acceptance of the Prisma advisory exception or an approved upgrade.
- PB-22: green CI on the exact final worktree/HEAD after owner authorization.
- PB-25, PB-26, PB-29, PB-31: repository corrections are proved, but target-host values, installation, or drills remain required.

No Production blocker is CLOSED on documentation or assumption alone. The six CLOSED items in the register are repository-only corrections with local synthetic evidence.

## 6. Commits and change footprint

Local commits on `fix/phase9-8-operational-defects`:

- `93509a2` — PB-11 rollback guidance.
- `62be9b6` — PB-25/27/28/30/31 backup scheduling.
- `3ace484` — PB-26/29 monitoring.
- `f84d358` — PB-30 direct tampered-base verifier proof.
- final documentation commits — blocker register statuses/counts, live runbooks, and this report (`d05a050` plus a final cleanup-accuracy follow-up). Other commit SHAs are listed above; use `git log` on the branch to confirm the exact final SHA.

Final footprint: 28 files changed, 1835 insertions(+), 237 deletions(-) (verified with `git diff --shortstat main..HEAD` after this commit)

## 7. Allowlist confirmation

Changed paths are limited to the Phase 9.8 allowlist: the listed rollback SQL file, `scripts/**`, `deploy/**`, `docker-compose.monitoring.yml`, and the listed live runbooks/register/report. No application source, `schema.prisma`, `migration.sql`, CI workflow, dependency, lockfile, Prisma version, advisory exception, report-block or template was changed.

## 8. p98 disposable resource list

- Temporary directories: `p98-backup-tests.*`, `p98-monitor-tests.*`, and p98-cap/crash state directories created under the approved temp root; removed by EXIT traps.
- Synthetic Docker containers: `p98-monitor-perms` (removed by the monitor harness) and `p98-ci-postgres` (created with `--rm` for the backend suite; stopped and removed, with no `p98*` containers remaining).
- Cached images only: `ubuntu:24.04` and `postgres:16.4-alpine`, both started with `--pull=never`.
- No `ultrasound-clinic-*` container or volume was touched.

## 9. Final statement

Phase 9.8 repository remediation is complete for the assigned defects. The proof is intentionally synthetic and local. It does not authorize or replace a change window, target-host verification, CI on the final HEAD, or Production deployment. Stop and wait for owner review.
