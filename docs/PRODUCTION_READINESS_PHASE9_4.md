# Production Readiness — Phase 9.4 Backup & Recovery

**Date:** 2026-11-21
**Scope:** Implement and validate Backup & Recovery using isolated synthetic environments only. No production database, backup file, volume, container, configuration, deployment, restart, backup/restore/cleanup command, commit, push, merge, branch switch, reset, Prisma upgrade, or dependency change was performed.
**Branch / HEAD:** `fix/phase9-remediation` @ `a828bcf0efed9e061f9fb4fbd32d496d63c28309`
**Final verdict:** **NO-GO for production readiness.** The backup/recovery subsystem is a **synthetic-only PASS** and closes Phase 9.3's “recovery unproven” finding to the extent an isolated drill can, but production RPO/PITR, scheduling, key-escrow/ACL verification, target-host validation, and the other Phase 9.3 deployment blockers remain open.

## Executive summary

Phase 9.4 replaced the backup set with a fail-closed, atomically published format-4 set containing an encrypted database dump, encrypted storage archive, encrypted per-file checksum list, optional Evolution/Caddy archives, `SHA256SUMS`, and a last-written `MANIFEST.txt`. It added an explicit-retention script, an isolated full-set restore script with strong target confirmation, and two synthetic test harnesses.

Validation was entirely synthetic:

- 14 required recovery scenarios were covered by 18 assertions: **18 passed, 0 failed, 0 blocked**.
- The existing isolated storage-validator suite remained green: **16 passed, 0 failed**.
- A full synthetic PostgreSQL restore drill succeeded with real migrations, real `pg_dump`/`age`/`pg_restore`, database-to-file reconciliation, and a focused backend test: **8 passed, 0 failed**.
- A real defect was found and fixed: `sha256sum -c` can exit `0` when some lines in a checksum file are malformed. Strict 64-hex line validation is now enforced by the verifier, restore and retention paths.
- Typecheck, build, secret scan, secret-scan regression tests, `bash -n`, and whitespace checks all passed.

The measured synthetic timings were **341 ms backup** and **1003 ms restore** (backup ID `8bf72d7e-2a0a-42b3-b761-063a78375530`). These are small-data drill timings, **not a production RTO**. WAL archiving/PITR is not deployed; production RPO remains **unbounded**, and the documented five-minute RPO target is **not claimed**.

## 1. Scope and safety

All work was performed in place on the current branch. No branch was switched, no commit was created, and no production system was contacted. No production key, credential, backup path, Docker volume, container, or database was read or modified. Test-only keys were generated inside disposable temporary directories and deleted by cleanup traps; no key material is printed or stored in the repository.

The untracked earlier-phase reports remain present and untouched:

- `docs/PRODUCTION_READINESS_PHASE9_2.md`
- `docs/PRODUCTION_READINESS_PHASE9_2_2.md`
- `docs/PRODUCTION_READINESS_PHASE9_2_3.md`
- `docs/PRODUCTION_READINESS_PHASE9_3.md`

### Environment limitation

Docker Desktop's daemon was unavailable:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

Therefore the production-shaped Compose backup path and `scripts/restore-drill.sh` Compose path were **not executed**. The tests instead used WSL Ubuntu with a disposable PostgreSQL 16 cluster, a temporary backup root, temporary storage, and test-only `BACKUP_TEST_MODE=1` + `BACKUP_SOURCE_MODE=local`, which still exercises the real `psql`, `pg_dump`, `tar`, and `age` code paths. PostgreSQL/age binaries were provisioned only under `$HOME/.local/p94-tools`; no project dependency was changed and no sudo was used.

## 2. Files changed

### Modified

| File | Change |
|---|---|
| `scripts/backup-common.sh` | Stable exit codes, optional numeric `backup_die`, `backup_new_id`, `backup_manifest_load`. |
| `scripts/backup.sh` | Format-4 manifest, backup ID, plaintext and per-file checksums, writer quiescence defaults/evidence, atomic staging, encrypted artifacts, safe cleanup. |
| `scripts/backup-verify.sh` | Accepts formats 3 and 4, validates format-4 fields and artifacts, strict `SHA256SUMS` line syntax, orphan/missing-entry checks. |
| `scripts/restore-drill.sh` | Requires explicit `RESTORE_TARGET_CONFIRM` matching `DRILL_DB`. |
| `docs/backup-restore.md` | Updated layout, format-4 fields, retention, isolated restore, confirmation requirements, measured drill timings, and RPO/PITR limitations. |

### Added

| File | Purpose |
|---|---|
| `scripts/backup-retention.sh` | Conservative per-tier retention; dry-run default, explicit `--apply --confirm DELETE`, verified sets only. |
| `scripts/restore-backup.sh` | Manifest-validating, checksum-verifying, decrypting restore into an explicitly confirmed isolated target. |
| `scripts/p94-backup-recovery-test.sh` | 18-assertion harness covering all 14 required recovery scenarios. |
| `scripts/p94-full-restore-drill.sh` | End-to-end synthetic PostgreSQL/file/app-test restore drill with measured timings. |
| `docs/PRODUCTION_READINESS_PHASE9_4.md` | This report. |

## 3. Implementation details

### Backup format 4

Each set is `clinic-<tier>-<STAMP>[-<label>]/` and now contains:

- `db-<STAMP>.dump.age`
- `storage-<STAMP>.tar.gz.age`
- `storage-files-<STAMP>.sha256.age`
- `evolution-<STAMP>.tar.gz.age` and Caddy archives when the volumes exist
- `SHA256SUMS` for encrypted artifacts
- `MANIFEST.txt` written last

New manifest fields include `backup_id`, `backup_format=4`, `manifest_version=4`, `encryption_status=encrypted`, `consistency_mode`, `quiesced_services`, `wal_lsn_before_quiesce`, `database_plain_sha256`, `storage_plain_sha256`, `storage_files_checksums*`, and `storage_files_count`. Formats 3 and 4 remain accepted by the verifier, retention and restore paths; format 3 has weaker assurance and is documented as legacy-compatible only.

### Consistency and publication

- Default `BACKUP_QUIESCE_SERVICES` is `backend web evolution`; the `db` service is always refused.
- An empty quiesce list requires `BACKUP_ALLOW_WRITER_DRIFT=1` and is intended only for isolated sources.
- Artifacts are created in a hidden staging directory in the tier, outside the final set. The published directory appears through a single `mv` only after plaintext hashes, encryption, encrypted hashes and `SHA256SUMS` are complete.
- A failed run removes only its own staging directory; older sets are never touched by `backup.sh`.
- `wal_lsn_before_quiesce` is recorded as evidence only. It is not WAL history and does not enable PITR.

### Integrity defect found and fixed

During testing it was observed that `sha256sum -c` may exit `0` when a checksum file contains a mixture of valid and malformed lines. Strict validation requiring `^[0-9a-f]{64} ( |\*).+$` was added to:

- `scripts/backup-verify.sh`
- `scripts/restore-backup.sh`
- `scripts/backup-retention.sh`

This prevents a damaged or partially malformed `SHA256SUMS` from being treated as a successful verification.

### Retention

`scripts/backup-retention.sh` defaults to dry-run. Deletion requires both `--apply` and `--confirm DELETE`. Limits are clamped to at least one, so the newest valid set in each tier is always kept. Invalid, incomplete or checksum-dirty sets are reported and left untouched. No scheduler, timer, alert delivery or automatic deletion was installed.

### Restore safety

`scripts/restore-backup.sh`:

- has no default target; `--target-db` and `--confirm-target` must match;
- requires target names ending in `_restore`, `_drill` or `_test`;
- refuses reserved production names, Compose service hosts `db`/`database`/`clinic-db`, and port `55432`;
- requires an existing, empty storage target directory;
- validates manifest topology/format, declared artifacts, encrypted hashes/sizes and strict checksum syntax before decryption;
- for format 4, verifies decrypted database/archive/checksum-list hashes against the manifest;
- checks the `PGDMP` header, tar readability and absence of absolute/parent-traversal paths;
- opens the source set read-only and drops a database it created on failure.

`scripts/restore-drill.sh` now also refuses to run unless `RESTORE_TARGET_CONFIRM` exactly equals `DRILL_DB`.

## 4. Validation evidence

| Check | Command | Result |
|---|---|---|
| Shell syntax | `bash -n` on 9 touched/new scripts | **PASS** |
| Existing isolated storage tests | `wsl -d Ubuntu -- bash /mnt/c/Users/Moustafa/Desktop/Clinc-V1.1/scripts/p831-backup-isolated-test.sh` | **16 passed, 0 failed, 16 total** |
| Required recovery scenarios | `wsl -d Ubuntu -- bash /mnt/c/Users/Moustafa/Desktop/Clinc-V1.1/scripts/p94-backup-recovery-test.sh` | **18 passed, 0 failed, 0 blocked, 18 total** |
| Full synthetic restore drill | `wsl -d Ubuntu -- bash /mnt/c/Users/Moustafa/Desktop/Clinc-V1.1/scripts/p94-full-restore-drill.sh` | **PASS** |
| Secret scan | `node scripts/secret-scan.mjs` | **0 actionable; 2 allowlisted fixtures, values redacted** |
| Secret-scan regression | `node --test scripts/secret-scan-regression.test.mjs` | **10 passed, 0 failed** |
| Typecheck | `npm run typecheck` | **PASS** (backend and web) |
| Build | `npm run build` | **PASS** (backend and web; Vite build 1782 modules) |
| Whitespace | `git diff --check` plus checks on new files | **PASS** |

### Full synthetic drill result

The final drill used a disposable PostgreSQL cluster on isolated port `55433`, applied the repository migrations from a temporary Prisma copy with a synthetic `.env`, inserted representative clinic records and three uploaded files, created a format-4 encrypted backup, verified it, restored into a separate database and storage directory, and ran a focused backend test.

Final measurements:

```text
backup_id: 8bf72d7e-2a0a-42b3-b761-063a78375530
backup_duration_ms: 341
restore_duration_ms: 1003
backend_test: PASS (8 pass, 0 fail)
verification: backup-verify passed; restored records and file checksums match source
```

Earlier successful runs measured 311 ms / 913 ms (backup ID `d276b1f5-f43b-43b2-a069-440157dc381e`) and 337 ms / 999 ms (backup ID `e49950f0-398f-49c7-b73a-25a0622d3e69`).

Restored data comparison:

| Check | Result |
|---|---|
| Applied Prisma migrations | All repository migrations applied synthetically; earlier drill explicitly reported **9**; restore script checks `_prisma_migrations` has rows and no unfinished/rolled-back entries |
| `User` rows | 2 == 2 |
| `Patient` rows | 1 == 1 |
| `Appointment` rows | 1 == 1 |
| `Visit` rows | 1 == 1 |
| `Report` rows | 1 == 1 |
| `FileAsset` rows | 1 == 1 |
| Uploaded file checksums | identical source vs restored |
| Uploaded file mode | source `640`, restored `640` |
| Focused backend test (`backend/tests/db-constraints.test.ts`) | 8 pass, 0 fail |

## 5. Required 14-scenario coverage

The Phase 9.4 harness produced 18 assertions because scenarios 1–3 include separate artifact-content checks and scenario 12 includes both dry-run and apply checks. All 14 required scenarios passed.

| # | Scenario | Assertion(s) | Result |
|---|---|---|---|
| 1 | Successful database backup | encrypted backup created; decrypted dump has `PGDMP` header | PASS |
| 2 | Successful storage backup | encrypted storage archive created; decrypted tar is readable | PASS |
| 3 | Successful encrypted backup | all artifacts end in `.age`; wrong key is rejected | PASS |
| 4 | Complete restore | isolated restore succeeds; restored row count matches | PASS |
| 5 | Corrupted archive detection | verifier and restore both reject the tampered copy | PASS |
| 6 | Checksum mismatch detection | verifier rejects modified `SHA256SUMS` | PASS |
| 7 | Missing database backup | restore fails with a precise missing-artifact error | PASS |
| 8 | Missing storage archive | restore fails with a precise missing-artifact error | PASS |
| 9 | Invalid encryption key | restore fails at decryption | PASS |
| 10 | Interrupted backup cleanup | failed encryption leaves no stage or published set | PASS |
| 11 | Insufficient disk space | preflight fails before staging | PASS |
| 12 | Retention cleanup | dry run deletes nothing; apply keeps newest valid set and leaves invalid set untouched | PASS |
| 13 | Failed restore without damaging source | source hash/source DB unchanged; no target DB or files left behind | PASS |
| 14 | Manifest validation | mismatched `set_directory` is rejected before restore | PASS |

## 6. RTO, RPO and PITR findings

### RTO

The measured 1003 ms restore is the wall-clock time of the synthetic restore script: encrypted artifact validation, decryption, plaintext hash checks, PostgreSQL custom-format restore into an isolated database, migration/table assertions, tar extraction and per-file checksum verification. It excludes the subsequent application test and all human/operational steps.

This is **not** a production RTO. A real recovery requires owner approval, downtime annunciation, writer shutdown, a fresh pre-restore backup, host I/O for potentially production-sized data, volume replacement, session invalidation, application startup and end-user verification. No production-sized rehearsal was permitted, so no production RTO is claimed.

### RPO

Backups remain full, sequential dumps rather than a continuous WAL-protected stream. The effective data-loss window is the time since the last successful complete set plus any acknowledged drift between the database dump and file archive. Writer quiescence narrows that window, but:

- no backup schedule, timer or alerting was installed;
- WAL archiving is disabled;
- `wal_lsn_before_quiesce` is evidence only;
- production backup creation remains a root-run manual operation on the verified host.

Therefore **production RPO is unbounded**.

### PITR

Phase 6.1 previously proved PITR in a disposable PostgreSQL 16 cluster with `wal_level=replica`, `archive_mode=on`, an `archive_command` and `archive_timeout=10s`. Phase 9.4 did **not** deploy that design. There is no WAL archive in the format-4 set, no `restore_command`, and no activated `recovery.signal`/`recovery_target_*` runbook. The five-minute RPO target remains a proposal, not a claim. Do not change production PostgreSQL settings or restart the database for PITR without explicit owner approval.

## 7. Findings and residual limitations

1. **Recovery is now proven in isolation, not in production.** The 14 scenarios and full drill are strong evidence for the scripts' logic, but the Compose path could not be exercised because the Docker daemon was unavailable.
2. **RPO/PITR remain hard blockers.** No WAL archiving, no PITR deployment, unbounded RPO.
3. **Operational controls are not installed.** No backup schedule, retention schedule, monitoring hook, alert delivery or routine drill calendar was created.
4. **Key escrow and account model are unverified.** Age private-key escrow retrieval, recipient-file protection and the least-privilege `clinicbackup`/`clinicmonitor` account recommendation from `docs/backup-restore.md` require owner-approved host changes and a separate test.
5. **Target-host validation remains open.** The host UUID/filesystem layout was historically verified in Phase 8.3.1 but was not re-checked here; no production host was accessed.
6. **Legacy artifacts remain out of scope.** The flat `backups/db-20261113T134414Z.dump` is preserved unchanged and is still non-compliant for production verification.
7. **Format 3 compatibility is weaker.** It is accepted for continuity, but only format 4 provides per-file checksums and decrypted-content verification.
8. **Other Phase 9.3 blockers are unchanged.** Migration status/table sizes on target, runtime container validation, topology/TLS decisions, and the four High Prisma advisories are not resolved by this phase and are not risk-accepted here.

## 8. Prerequisites before any production reliance

- Obtain written owner approval and a named operator for a production-shaped backup and restore rehearsal.
- Run the Compose-shaped backup path and `restore-drill.sh` on the target host with a working Docker daemon.
- Verify age private-key escrow retrieval and file permissions without placing the private key on the backup host.
- Decide and install a backup schedule, retention limits, monitoring and alert delivery.
- Decide the backup account/ACL model and apply the approved least-privilege change.
- If a finite RPO is required, deploy and rehearse WAL archiving/PITR on the target host with matching base backups and a documented `restore_command` flow.
- Re-run the full drill on production-sized synthetic data and record a measured, host-specific RTO.
- Close or explicitly risk-accept the remaining Phase 9.3 deployment blockers before deploying.

## 9. Final decision

**NO-GO for production deployment/readiness.**

The backup/recovery implementation is a **synthetic-only PASS**: all 14 required recovery scenarios, the full encrypted backup/restore drill, data/file reconciliation, focused application test, static checks, secret scan and build/typecheck succeeded. This closes the specific “no real backup/restore evidence” gap in Phase 9.3, but it does not establish production RTO, finite RPO, PITR, scheduling, key escrow, host permissions, or Compose-path runtime behavior.

No commit, push, merge, deployment, restart, production backup/restore/cleanup, or unrelated dependency change was performed. Work stops here pending separate authorization.
