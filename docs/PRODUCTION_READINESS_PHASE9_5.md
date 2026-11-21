# Production Readiness — Phase 9.5 WAL Archiving and PITR

**Date:** 2026-11-21  
**Scope:** Implement and validate PostgreSQL WAL archiving and point-in-time recovery using isolated synthetic PostgreSQL only. No production database, WAL, backup, volume, container, configuration, restart, migration, deployment, secret, commit, push, merge, branch switch, reset, dependency upgrade or unrelated dependency change was performed.  
**Branch / HEAD:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`  
**Final verdict:** **PASS**

This verdict is for the repository implementation and isolated validation described below. It does not claim production readiness, production RPO, or target-host deployment.

## 1. Executive summary

Phase 9.5 adds a fail-closed WAL archiving and PITR subsystem alongside the existing Phase 9.4 logical backup subsystem. The base Compose file is unchanged. All database/WAL settings are in a new optional `docker-compose.pitr.yml` overlay that has not been applied.

The isolated source clusters used real PostgreSQL 16 binaries, real `pg_basebackup`, real archive/restore commands, real Prisma migrations, and age encryption. No real patient data was used.

Validation results:

- The 12-scenario automated PITR harness ran 12/12 successfully.
- The full before/after recovery drill succeeded against a migrated synthetic database with synthetic patient records.
- The Phase 8.3.1 isolated storage validator remained green at 16/16.
- The Phase 9.4 backup/recovery assertions remained green at 18/18.
- The Phase 9.4 full restore drill remained green.
- Typecheck, build, secret scan, secret-scan regression tests, shell syntax checks, Compose render-only validation, and `git diff --check` were clean.
- Docker daemon runtime validation remains unavailable; container execution was not attempted.

Measured synthetic timings: **1972 ms archive delay**, **2596 ms base backup**, **2491 ms restore before the selected transaction**, and **2372 ms restore after it**. These are small-data drill measurements, not a production RTO commitment. The five-minute RPO remains a design target and is not claimed in production.

## 2. Safety and preservation

All work was performed in place on the existing branch. No commit, push, merge, branch switch, reset, deployment, production migration, production restart, or production configuration change was made.

No production path, database, WAL archive, backup set, container, volume, credential, or key was read or modified. Synthetic age keys and synthetic databases were created inside disposable temporary directories and removed by cleanup traps. No key material is printed or stored in the repository.

Existing uncommitted and untracked work was preserved, including:

- `docs/PRODUCTION_READINESS_PHASE9_2.md`
- `docs/PRODUCTION_READINESS_PHASE9_2_2.md`
- `docs/PRODUCTION_READINESS_PHASE9_2_3.md`
- `docs/PRODUCTION_READINESS_PHASE9_3.md`
- `docs/PRODUCTION_READINESS_PHASE9_4.md`
- `scripts/backup-retention.sh`
- `scripts/restore-backup.sh`
- `scripts/p94-backup-recovery-test.sh`
- `scripts/p94-full-restore-drill.sh`

## 3. Files changed

### Modified

| File | Change |
|---|---|
| `scripts/backup-common.sh` | Added WAL segment name/range/checksum helpers. |
| `.env.example` | Added non-secret WAL/PITR overlay variables and monitoring thresholds. |
| `deploy/monitor.env.example` | Added WAL backlog thresholds for the existing read-only WAL monitor. |
| `docker-compose.monitoring.yml` | Passed WAL backlog settings to the monitoring service. |
| `docs/backup-restore.md` | Documented WAL archiving, PITR base sets, restore commands, monitoring, retention requirements, and unclaimed RPO. |

### Added

| File | Purpose |
|---|---|
| `deploy/wal-archive.sh` | POSIX-sh, fail-closed `archive_command` helper with mount, space, sidecar, and atomic publication checks. |
| `deploy/wal-restore.sh` | POSIX-sh, fail-closed `restore_command` helper requiring a valid SHA-256 sidecar. |
| `scripts/pitr-base-backup.sh` | Verified physical base backup with a WAL-linked `pitr-base-1` manifest. |
| `scripts/pitr-restore.sh` | Isolated PITR restore with pre-flight validation, explicit target confirmation, and recovery verification. |
| `scripts/p95-pitr-common.sh` | Shared isolated test-toolchain helpers. |
| `scripts/p95-pitr-test.sh` | 12-scenario automated PITR harness. |
| `scripts/p95-full-pitr-drill.sh` | End-to-end before/after recovery drill with real Prisma migrations and synthetic clinic records. |
| `docker-compose.pitr.yml` | Optional repository-only WAL/PITR overlay; base Compose unchanged. |
| `docs/PRODUCTION_READINESS_PHASE9_5.md` | This report. |

## 4. Implementation

### WAL configuration

| Setting | Value |
|---|---|
| `wal_level` | `replica` |
| `archive_mode` | `on` |
| `archive_command` | `/bin/sh /clinic/scripts/deploy/wal-archive.sh %p %f` |
| `archive_timeout` | `${WAL_ARCHIVE_TIMEOUT_SECONDS:-300}` |
| `max_wal_senders` | `${WAL_MAX_SENDERS:-10}` |
| `wal_keep_size` | `${WAL_KEEP_SIZE:-128MB}` |
| WAL destination | `${WAL_ARCHIVE_HOST_DIR:-/mnt/clinic-backups/wal-archive}:/wal-archive:rw` |
| Free-space reserve | `WAL_ARCHIVE_MIN_FREE_MB=512` |
| Mount check | `WAL_ARCHIVE_SKIP_MOUNT_CHECK=0` in the overlay |

The archiver is POSIX sh and self-contained because `postgres:16-alpine` does not provide `bash`, `mountpoint`, or `findmnt`. It detects a real mount from `/proc/self/mountinfo`, reads the filesystem type from `/proc/self/mounts`, stages the WAL file with mode `0600`, writes a `<segment>.sha256` sidecar in `<sha256>  <filename>` form, and publishes file plus sidecar with atomic hard links. It refuses to overwrite different content, checks free space before publishing, logs redacted `key=value` events to stderr, and exits non-zero on any failure so PostgreSQL retains and retries the segment.

UUID verification remains supported but is empty by default inside the container because `/dev/disk/by-uuid` is not normally available there. The host mount itself must still use the approved UUID. `WAL_ARCHIVE_SKIP_MOUNT_CHECK=1` is used only by isolated tests and is never set by the production overlay.

The restore helper accepts PostgreSQL's `RECOVERYXLOG`/`RECOVERYHISTORY` temporary `%p` paths, requires the matching sidecar, verifies segment size and SHA-256, and atomically publishes the WAL into `pg_wal`. Missing or corrupt WAL exits non-zero with a precise message.

### Base backup

`scripts/pitr-base-backup.sh` uses `pg_basebackup -Fp -X stream` and refuses sources without `wal_level=replica`/`logical`, `archive_mode=on`, and a non-empty `archive_command`. Its `pitr-base-1` manifest records:

- backup ID, format and manifest version;
- PostgreSQL version and UTC creation time;
- start/stop LSN and timeline;
- WAL segment size and archive directory;
- required WAL start/end files, full segment list and per-segment SHA-256 values;
- base artifact name, SHA-256, size, plaintext SHA-256/size, and encryption mode;
- archiver status at backup time.

The set is published only after every required segment is present, size-valid, sidecar-valid, and checksum-valid. Missing or corrupt WAL stops the run before publication, so an incomplete set is never marked `pitr_ready=true`. Optional age encryption is supported; the private key remains in separate escrow.

### PITR restore

`scripts/pitr-restore.sh` performs all manifest, base-artifact, and WAL validation before creating the target directory. It requires an absolute new path ending in `_restore`, `_drill`, or `_test`, an exactly matching `--confirm-target-dir`, and a non-production port; `5432` and `55432` are refused. Production-like paths and protected directories are rejected.

It then extracts the verified base, creates `recovery.signal`, writes a fail-closed `restore_command`, sets `recovery_target_time`, `recovery_target_action='pause'`, and `recovery_target_inclusive='on'`, disables archiving on the recovered instance, starts PostgreSQL on the isolated port, and verifies that the instance is in recovery and that PostgreSQL's log confirms the target was reached. Failures stop the instance and remove the target.

### Monitoring hooks

`P7_WAL_DIRS`, `P7_WAL_COUNT_*`, and `P7_WAL_AGE_*` are wired through `deploy/monitor.env.example` and `docker-compose.monitoring.yml` into the existing read-only `scripts/p7-check-wal.sh`. No service installation, alert delivery, WAL deletion, or scheduler is enabled by this change.

## 5. Automated 12-scenario evidence

Command: `wsl -d Ubuntu -- bash /mnt/c/Users/Moustafa/Desktop/Clinc-V1.1/scripts/p95-pitr-test.sh`

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | WAL archiving starts successfully | OK | `archived_count=7`, `failed_count=0` |
| 2 | WAL files are archived | OK | 7 segments with 7 checksum sidecars |
| 3 | Archive command failure is detected | OK | Missing source returned non-zero with a clear error |
| 4 | Missing WAL is detected | OK | Rejected before target creation |
| 5 | Corrupted WAL is rejected | OK | SHA-256 sidecar mismatch detected |
| 6 | Base backup linked to WAL sequence | OK | `pitr-ready` set with manifest checksums |
| 7 | Recovery to timestamp succeeds | OK | Target `2026-11-21T10:40:05.277301Z` |
| 8 | Recovery stops at requested target | OK | Log confirmed target; instance paused in recovery |
| 9 | Recovery before selected transaction excludes it | OK | A=1, B=0 |
| 10 | Recovery after selected transaction includes it | OK | A=1, B=1, sentinel=0 |
| 11 | Incomplete WAL sequence fails safely | OK | Rejected before target creation |
| 12 | Original source database remains unchanged | OK | Synthetic snapshot unchanged; source not in recovery |

Final automated metadata:

```text
p95-pitr: 12 passed, 0 failed, 0 blocked, 12 total
backup_id: 9cc5205b-95c0-4f48-854c-5177183d73ba
base_backup_duration_ms: 2271
source_wal_file_for_B: 000000010000000000000004
target_before_B: 2026-11-21T10:40:05.277301Z
target_after_B: 2026-11-21T10:40:05.538551Z
```

## 6. Full before/after recovery drill

Command: `wsl -d Ubuntu -- bash /mnt/c/Users/Moustafa/Desktop/Clinc-V1.1/scripts/p95-full-pitr-drill.sh`

The drill created a disposable PostgreSQL 16 cluster, applied the repository's Prisma migrations, committed synthetic transaction A, created an encrypted WAL-linked base backup, committed synthetic transaction B, committed a later sentinel C to bound the after-B target, and restored to two isolated targets.

| Measurement | Result |
|---|---|
| Backup ID | `8c614b22-31d5-4c7f-b8c6-5cb7a7892d44` |
| PostgreSQL version | `16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)` |
| Transaction A commit | `2026-11-21T10:40:22.747967Z`, LSN `0/1AEB560`, WAL `000000010000000000000001` |
| Transaction B commit | `2026-11-21T10:40:26.789235Z`, LSN `0/5000440`, WAL `000000010000000000000005` |
| Sentinel C commit | `2026-11-21T10:40:29.065442Z`, WAL `000000010000000000000006` |
| Target before B | `2026-11-21T10:40:26.739235Z` |
| Target after B | `2026-11-21T10:40:27.927339Z` |
| Base backup duration | 2596 ms |
| Archive delay for B | 1972 ms |
| Restore before B | 2491 ms |
| Restore after B | 2372 ms |
| Before-B rows | A=1, B=0, sentinel=0 |
| After-B rows | A=1, B=1, sentinel=0 |
| Source rows after drill | A=1, B=1, sentinel=1 |
| Integrity | `pg_amcheck` completed on both restored instances |
| Migrations | Applied rows present; no unfinished or rolled-back rows on either target |

The source database still contained all three synthetic rows after both restores, confirming that recovery did not alter the source.

## 7. Timing, RTO, and RPO conclusion

**Archive delay:** 1972 ms in the full drill, measured from the transaction B start through availability of its WAL segment and sidecar in the archive. This used forced WAL switches because a 16 MB segment is not filled by a tiny drill. It is not a worst-case measurement; the overlay's `archive_timeout=300` means a partially filled segment can take up to roughly five minutes plus I/O and retry delay to be archived.

**Measured synthetic RTO:** 2491 ms for the before-B target and 2372 ms for the after-B target, measured from invoking `pitr-restore.sh` to a paused, verified isolated PostgreSQL instance. This excludes operator decision time, target-host provisioning, storage transfer, and promotion. It is not a production RTO commitment.

**RPO conclusion:** The implementation supports a five-minute RPO target through continuous archiving, fail-closed archive failures, WAL-linked base backups, and backlog monitoring. That target is not claimed in production. The overlay is not applied, no target-host WAL mount has been provisioned or validated, no production archive has been exercised, and no production recovery has been rehearsed. Current production RPO therefore remains unclaimed and effectively unbounded.

## 8. Validation sweep

| Check | Result |
|---|---|
| `bash -n` on all touched shell files | OK |
| `sh -n` on POSIX archive/restore helpers | OK |
| Phase 9.5 automated PITR suite | 12/12 |
| Phase 9.5 full before/after drill | OK |
| Phase 8.3.1 isolated storage validator | 16/16 |
| Phase 9.4 backup/recovery assertions | 18/18 |
| Phase 9.4 full restore drill | OK; 8 focused backend tests also green |
| `npm run typecheck` | OK |
| `npm run build` | OK |
| `node scripts/secret-scan.mjs` | OK; 0 actionable findings, 2 allowlisted test fixtures |
| `node --test scripts/secret-scan-regression.test.mjs` | 10/10 |
| `git diff --check` | OK |
| `docker compose -f docker-compose.yml -f docker-compose.pitr.yml config --quiet` | OK, render-only |

## 9. Docker and Compose limitation

The Compose overlay renders successfully, but the Docker daemon was unavailable:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running
```

Therefore no container was started, no container-side mount ownership was checked, and the archive helper was not executed as the `postgres` user inside `postgres:16-alpine`. The helpers were deliberately rewritten as POSIX sh with `/proc`-based mount detection to remove the known `bash`/`mountpoint`/`findmnt` dependency gap, but Alpine runtime behaviour remains unvalidated. All functional evidence in this report comes from isolated WSL PostgreSQL 16 instances.

## 10. Remaining blockers

The following remain open and out of scope for this phase:

1. Written owner approval and a controlled maintenance window to apply the overlay and restart `db`.
2. Provisioning `/mnt/clinic-backups/wal-archive` as a dedicated `0700` mount owned by the PostgreSQL runtime user, with the approved UUID/filesystem recorded.
3. Target-host verification of the POSIX archiver under `postgres:16-alpine`, including UID/GID access to the bind mount.
4. Scheduling PITR base backups and retaining each set with every WAL segment it requires.
5. A WAL retention/deletion policy with capacity alarms; no pruning is automatic.
6. Installation and alert routing for the WAL backlog monitor.
7. Age key escrow and restore-permission verification on the target host.
8. A production-shaped recovery rehearsal and measured production RTO.
9. Docker daemon availability for container runtime validation.

Until these are closed, no production RPO or production readiness claim is made.
