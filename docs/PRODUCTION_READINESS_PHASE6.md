# Production Readiness — Phase 6: Backup, Restore & Disaster Recovery (2026-11-18)

## 1. Executive summary

**Overall status: COMPLETE FOR REVIEW — audit executed on an isolated synthetic stack. Restore mechanics are proven; disaster-recovery operations are NOT production-ready. No production data, volume, container, or configuration was modified.**

Phase 6 audited the backup/restore/disaster-recovery posture of the Ultrasound Clinic Management System. The real `scripts/backup.sh` and `scripts/restore-drill.sh` were executed unchanged (only line endings were normalized on temporary copies so they could run under Windows/Git Bash), against a disposable Compose project (`phase6audit`) loaded with synthetic data. Backups were verified, tampered, restored into disposable databases, restored again into a clean database, and finally restored into a **fresh PostgreSQL cluster**. Database row counts and per-table row hashes matched in every drill; the only observed difference was timezone rendering in `_prisma_migrations` text, and the underlying epoch sums were proven identical.

The technical restore path works. The operational DR posture does not:

- Backups are **unencrypted**, **single-copy**, and **same-host only**. They contain PHI (names, clinical reports, password hashes).
- There is **no schedule, no retention, no monitoring, and no automatic verification**. RPO is therefore "since the last manual run" — unbounded.
- The backup set omits the **Evolution WhatsApp session volume** and the **Caddy TLS state**, and the restore runbook stops only `web` and `backend`, not `evolution`.
- `scripts/backup.sh` can leave a **partial, unmanifested backup set** when the storage step fails; this was reproduced (orphan dump with no archive, checksums, or manifest).
- The documented full-restore command uses `--clean --if-exists` without `--single-transaction` or `--exit-on-error`; a partially failed restore can still report success.
- No WAL archiving/PITR exists (`wal_level=replica`, `archive_mode=off`), so recovery is limited to the last dump.

**Finding counts:** Critical 2 · High 6 · Medium 10 · Low 3. Details in §13.

**Changes applied during the audit:** documentation only (this report and a Phase 6 cross-reference in `docs/PRODUCTION_READINESS_BASELINE.md`). No application code, script, Compose file, `.env`, volume, container, or production database was changed during the audit.

**Post-review repo remediation:** after review, the owner approved repo fixes only. `scripts/backup.sh`, `scripts/restore-drill.sh`, `scripts/backup-verify.sh`, `.gitattributes`, and the backup runbooks were hardened. Nothing was deployed, scheduled, or configured on production; no Compose or application file was changed. See §21 for the finding-by-finding disposition. Phase 7 was not started.

**Production safety:** the running production stack (`ultrasound-clinic`) was only observed with read-only Docker commands (`ps`, `volume ls`, `volume inspect`, `system df`). Its database was never queried, and no production file or volume was written. See §17.

## 2. Scope, constraints and isolation

### 2.1 In scope

- Actual backup script behavior, artifacts, checksums, manifests, and failure modes.
- Actual restore-drill behavior, safety guards, and verification depth.
- Database restore fidelity (schema, data, constraints, migrations, financial invariants).
- Storage archive fidelity and database-to-file reconciliation.
- Evolution/WhatsApp persistence and recovery assumptions.
- Encryption, off-site copying, key management, retention, scheduling, and monitoring.
- RPO/RTO evidence, measured where possible and explicitly estimated otherwise.
- OS/platform assumptions for the as-yet-undecided target environment.

### 2.2 Constraints honored

| Constraint | How it was honored |
|---|---|
| Audit only; no fixes without approval | No script, Compose, schema, or app change was made. All recommendations are marked approval-gated. |
| No production data or infrastructure changes | Production was never queried or written. All drills used synthetic data in `*_drill` databases. |
| Unique isolated project and temp directory | Compose project `phase6audit`; temp workspace `%TEMP%\phase6-20261118T160839Z`. |
| Disposable database names only | `phase6_synthetic`, `phase6_synthetic_drill`, `phase6_scale_drill`, `phase6_clean_drill`, `phase6_fresh_drill`, `phase6_drop_drill`. |
| Never restore into production | Every restore targeted an isolated cluster or a `*_drill` database. Restore guard was also tested against a non-`_drill` name. |
| Never touch real Evolution/WhatsApp sessions | A new empty Evolution container/volume was used. The production session volume was inspected **read-only for a file count only** (0 files); no file contents were read, copied, or written, and no session was started or paired. |
| Never delete existing backups | The repository artifact `backups/db-20261113T134414Z.dump` was inspected TOC-only and left untouched. |
| No broad destructive Docker commands | No `down -v`, `volume prune`, or `system prune` was run. Only Phase 6 resources were removed during cleanup. |
| No `migrate reset` / `db push` | None was run. Only committed migrations (`migrate deploy`) were used. |
| No secret values in reports/logs | Artifacts were scanned; only names, patterns, and pass/fail results are documented. |

### 2.3 Disclosures

1. **One accidental empty production-scoped volume was created and removed.** During a read-only volume-size inspection, a `docker run -v ultrasound_clinic_caddy_data:/d ...` command created an empty named volume `ultrasound_clinic_caddy_data`. It was immediately inspected (0 files), confirmed empty, and removed. No production container referenced it; no data was written. This is disclosed here and in §17.
2. **Docker Desktop's Linux engine crashed five times during the audit.** Each crash stopped all containers. The production stack auto-restarted via `restart: unless-stopped` and returned healthy; the isolated audit stack did not auto-restart (its Compose file intentionally uses `restart: "no"`) and was restarted manually. This is recorded as a platform risk in §16.
3. **Windows path conversion produced one stray empty directory.** The first backup-script invocation without `MSYS_NO_PATHCONV=1` caused Git Bash to mangle a `-v` argument and create an empty `backups;C` directory in the temp workspace. Subsequent commands used `MSYS_NO_PATHCONV=1`. The stray directory was inside the temp workspace only.
4. **Temporary script copies were normalized from CRLF to LF.** The repository working tree has CRLF line endings; temporary copies were converted solely to execute under Git Bash. The originals were not modified. The CRLF condition itself is reported as an OS/platform finding (§16).

## 3. Environment and tooling

| Item | Value |
|---|---|
| Host OS | Windows (win32), NTFS; Git Bash used for bash scripts |
| Docker engine | Docker Desktop 29.9.3 |
| Docker Compose | v5.7.0 |
| PostgreSQL image | `postgres:16-alpine`, server 16.16 |
| `pg_dump` / `pg_restore` | 16.16 (no client/server version mismatch) |
| WSL Docker integration | Disabled; all Docker calls made through Git Bash with `MSYS_NO_PATHCONV=1` |
| Audit workspace | `C:\Users\Moustafa\AppData\Local\Temp\phase6-20261118T160839Z` |
| Isolated project | `phase6audit` (network `phase6audit_net`) |
| Isolated DB | container `phase6audit-db-1`, `127.0.0.1:65432`, database `phase6_synthetic`, user `phase6_user`, synthetic password only |
| Isolated Evolution | container `phase6audit-evolution-1`, synthetic API key only, empty instances volume |
| Fresh-cluster DB | container `phase6audit-fresh-db`, `127.0.0.1:65433`, database `phase6_fresh_drill` |
| Repository baseline | branch `feature/clinic-quick-actions`, HEAD `fd128f5b`; pre-existing working-tree changes preserved |

The production Compose stack was running before and after the audit. Its published ports and volume sizes were observed read-only; its database was never contacted.

## 4. Files inspected and changed

### 4.1 Inspected (read-only)

| Area | Files / evidence |
|---|---|
| Backup/restore scripts | `scripts/backup.sh`, `scripts/restore-drill.sh` |
| Compose and volumes | `docker-compose.yml`, `docker-compose.tls.yml`, `deploy/Caddyfile` |
| Operations documentation | `docs/backup-restore.md`, `docs/operations.md`, `SECURITY.md` |
| Application data model | `backend/prisma/schema.prisma` (`FileAsset`, `Report`, `ReportVersion`, `Charge`, `Payment`, `PaymentAllocation`, `Expense`, `User`, `RefreshToken`, `PasswordSetupToken`, `TokenBlacklist`) |
| Upload/storage behavior | `backend/src/modules/files/routes.ts` |
| Environment/secrets inventory | `.env.example`; `.env` inspected for **names and ACLs only**, never values |
| Existing backup | `backups/db-20261113T134414Z.dump` — TOC-only (`pg_restore --list`), contents not read |
| Git/OS state | `.gitignore`, absence of `.gitattributes`, `git ls-files --eol`, `icacls` |

### 4.2 Changed

| File | Change |
|---|---|
| `docs/PRODUCTION_READINESS_PHASE6.md` | New report (this file), plus §21 post-review remediation. |
| `docs/PRODUCTION_READINESS_BASELINE.md` | Phase 6 status, blocker update, new backup/recovery section, changelog entry. |
| `scripts/backup.sh` | Repo remediation: atomic staging/checksums, disk precheck, optional quiesce, encrypted/off-site hooks, Evolution/Caddy archives, richer manifest. |
| `scripts/restore-drill.sh` | Repo remediation: checksum verification, expanded counts/schema/migration checks, optional storage reconciliation, `.age` guard. |
| `scripts/backup-verify.sh` | New read-only backup-set verifier/inventory, suitable for monitoring. |
| `.gitattributes` | Shell/SQL/Dockerfiles forced to LF. |
| `docs/backup-restore.md`, `docs/operations.md` | Encrypted/off-site workflow, verification, exact full-restore order, fresh-host and Evolution procedures. |
| Temp workspace | Synthetic seeds, SQL probes, backup artifacts, restored storage, fingerprint files. Deleted at the end of the phase. |

The audit itself changed no repository application, script, Compose, schema, or environment file. The script/docs changes listed above were applied after review under the repo-fixes-only approval; nothing was deployed to production.

## 5. Backup inventory

### 5.1 Existing repository backup

| Property | Observed value |
|---|---|
| Path | `backups/db-20261113T134414Z.dump` |
| Size | 198,449 bytes |
| Modified | 2026-11-13 15:44 local |
| Format | PostgreSQL custom (`pg_dump -Fc`) |
| Database name in TOC | `ultrasound_clinic` |
| TOC entries | 431 |
| Companion storage archive | **absent** |
| Checksum file | **absent** |
| Manifest | **absent** |
| Restore evidence | **none** |
| Permissions | NTFS ACL grants `BUILTIN\Users:(M)` (Modify) |

The dump was not restored or read beyond its table-of-contents, to avoid exposing any real PHI. As an inventory item it is incomplete: a database dump without its matching uploads archive is not a usable clinic restore (see §8 and `docs/backup-restore.md`).

### 5.2 Synthetic backups produced by the real script

| Artifact set | Dump size | Storage archive | Files | Contents | Result |
|---|---:|---:|---:|---|---|
| `db-20261118T161416Z` (small) | 203,199 B | 5,636 B | 6 | 30 public model tables + 7 migrations; Evolution schema | Complete set + manifest + checksums |
| `db-20261118T162022Z` (scale) | 3,845,422 B | 8,921 B | 206 | ~54.8k synthetic rows across public + Evolution; 200 extra tiny files | Complete set + manifest + checksums |
| `db-20261118T161340Z` (failure test) | 203,199 B | **absent** | — | Dump only | **Orphaned**; no manifest or checksums |

Manifest contents are only:

```text
created_utc=<stamp>
database_dump=db-<stamp>.dump
storage_archive=storage-<stamp>.tar.gz
checksums=SHA256SUMS-<stamp>.txt
git_commit=<short-sha or unknown>
```

It does not record file sizes, the database name, volume names, PostgreSQL version, script version, or the checksum values themselves. On the isolated copy `git_commit` was `unknown` because the temp directory is not a Git repository; that specific value is not a production finding, but it demonstrates that the manifest silently degrades.

### 5.3 Backup-set completeness

| Data store | In `backup.sh`? | Recoverable from this backup set? |
|---|---|---|
| PostgreSQL `public` schema (clinical/finance) | Yes | Yes — proven by drill |
| PostgreSQL `evolution` schema | Yes, because it is in the same database | Yes — proven by drill |
| Uploads volume `ultrasound_clinic_storage` | Yes | Yes — proven by drill |
| Evolution session volume `ultrasound_clinic_evolution_instances` | **No** | **No** — pairing state absent |
| Caddy `caddy_data` / `caddy_config` (TLS overlay) | **No** | **No** — certificates must be re-issued |
| `.env` / secrets | **No** | **No** — must come from separate escrow |

## 6. Backup integrity and checksum verification

### 6.1 Valid artifacts

For both synthetic sets, on the original files:

```text
db-20261118T161416Z.dump: OK
storage-20261118T161416Z.tar.gz: OK
db-20261118T162022Z.dump: OK
storage-20261118T162022Z.tar.gz: OK
exit=0
```

Additional checks:

| Check | Result |
|---|---|
| SHA-256 comparison (`sha256sum -c`) | PASS, exit 0 |
| gzip archive integrity (`gzip -t`) | PASS |
| `pg_restore --list` readability | PASS — 438 TOC entries for the small set |
| Evolution portion of TOC | PASS — 203 entries (including 57 Evolution migrations) |
| Manifest filenames match artifacts | PASS |
| Manifest checksum values present inside `SHA256SUMS-*` | PASS |
| Automatic checksum verification inside `backup.sh` | **Not implemented** — checksums are written, not re-read |

### 6.2 Tamper and missing-file test

A copy of the small dump was modified by 24 bytes, and the storage archive was intentionally omitted from the copy. Running the original checksum file produced:

```text
db-20261118T161416Z.dump: FAILED
storage-20261118T161416Z.tar.gz: FAILED open or read
WARNING: 1 computed checksum did NOT match
WARNING: 1 listed file could not be read
exit=1
```

Conclusion: `sha256sum -c` detects both corruption and missing files. The gap is that nothing runs it automatically after a backup, before an off-site copy, or before a restore.

### 6.3 Failure-mode reproduction

The real `backup.sh` was run with a storage volume that did not exist (or a storage step that failed). Behavior:

- `set -euo pipefail` stopped the script at the failing step.
- The database dump had already been written.
- No storage archive, no checksums, and no manifest were produced.
- The orphan dump remained in `backups/` with a normal-looking name.

This is a real operational hazard: a later inventory check that only looks for `db-*.dump` can mistake an incomplete set for a valid backup. There is no disk-space precheck, no temporary-directory staging, no `.partial` suffix, and no `trap` to clean up or mark the failed set.

### 6.4 Secret-leak scan

The plain-SQL dump, manifest, checksums, and restored storage were scanned without printing any values:

- Literal production secret values from `.env`: **0 matches**.
- Generic credential patterns (`sk_live_`, `AKIA`, `ghp_`, `xoxb-`, `postgresql://`, private-key headers): **0 matches**.
- Synthetic hashes/values used by the drill: present, as expected.

This confirms the backup script does not embed environment secrets into the dump or manifest. It does **not** mean the artifacts are safe to share: a clinic dump still contains PHI, password hashes, and clinical content, which is why encryption at rest and access control are required.

## 7. PostgreSQL restore drill

### 7.1 Method

- `scripts/restore-drill.sh` was executed unchanged (modulo CRLF) against the isolated `db` service.
- It creates a disposable `*_drill` database, runs `pg_restore --no-owner --no-acl --exit-on-error`, prints four counts, and drops the database unless `KEEP_DRILL_DB=1`.
- After each drill, a full fingerprint was taken: per-table row count plus `md5` of an ordered row representation, for every public table, plus `_prisma_migrations` and the Evolution schema.
- Critical financial/clinical invariants were compared source vs drill.
- Constraint probes exercised foreign keys, unique constraints, and `NOT NULL` enforcement.

### 7.2 Small dataset result

| Item | Result |
|---|---|
| Database | `phase6_synthetic_drill` |
| Restore | PASS |
| Public tables compared | 30 model tables + `_prisma_migrations` |
| Row counts / hashes | **All matched** |
| Migrations restored | 7, `prisma migrate status` up to date |
| Evolution schema | 37 tables restored; migrations matched |
| Ledger query | Source = drill (`charges=10100`, `payments=10100`, `refunds=550`, `rows=3`) |
| Daily finance query | Source = drill (`payments_minor=127800`, `refunds_minor=0`, `expenses_minor=0`, `charges_minor=162000`) |
| Report versions | Source = drill (version/final/content-hash list identical) |
| Allocation reconciliation | Source = drill (`settled_charges=12`, `mismatched=0`) |
| Orphan checks | Source = drill (0 file-asset, 0 report, 0 payment orphans) |
| FK / unique / NOT NULL probes | All PASS |

### 7.3 Scale dataset result

| Item | Result |
|---|---|
| Database | `phase6_scale_drill` |
| Restore | PASS |
| Data volume | ~54.8k synthetic rows including Evolution |
| Row counts / hashes | **All matched** |
| Migrations / Evolution | 7 public; 57 Evolution migrations; 37 Evolution tables |
| Critical queries | Identical to source |
| Constraint probes | All PASS |

### 7.4 Clean re-restore

The documented full-restore form was executed twice into `phase6_clean_drill`:

```bash
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/db-20261118T161416Z.dump
```

Result: exit 0 both times, 4.18 s per run, fingerprint matched the source. This proves `--clean --if-exists` works on a database that already has the schema. It does **not** prove atomicity: without `--single-transaction` and `--exit-on-error`, a mid-restore failure can leave a partially dropped/restored database while the command still exits 0. The runbook in §14 recommends the stricter form as an approval-gated change.

### 7.5 Fresh-cluster restore

To separate "restore into the same cluster" from "rebuild on a new host", a second empty PostgreSQL 16 container was started on port 65433 with an empty volume, and the small dump was restored into `phase6_fresh_drill`.

| Step | Result |
|---|---|
| Container start → healthy | PASS |
| Database creation + restore | PASS |
| Public table counts / hashes | **All matched** |
| Evolution schema | Restored and matched |
| End-to-end time | **7.69 s** from container start to verified restore |
| Only textual difference | `_prisma_migrations` md5 differed for both public and Evolution tables (epoch sums matched) |

The migration-table difference was investigated. The dump was created in `Africa/Cairo`; the fresh cluster runs UTC. `timestamptz` values render differently in text, which changes the text hash. The epoch sums were compared directly:

```text
source:  MIGRATION_EPOCH|7|12565127202.012033|12565127203.034140
fresh:   MIGRATION_EPOCH|7|12565127202.012033|12565127203.034140
source:  MIGRATION_EPOCH_EVO|57|102316034610.798235|102316034612.177855
fresh:   MIGRATION_EPOCH_EVO|57|102316034610.798235|102316034612.177855
```

Epoch values are identical to the microsecond. **Conclusion: no data loss; the difference is timezone rendering only.** Future fingerprint checks must compare epochs for timestamp columns, not text hashes across different `TZ` settings.

### 7.6 Restore-script safety guard

| Test | Result |
|---|---|
| Default behavior drops the drill DB | PASS — `phase6_drop_drill` count = 0 afterward |
| `DRILL_DB=ultrasound_clinic` | **Refused**, exit 1, correct message |
| Name validation (letters/digits/underscore + `_drill`) | PASS |
| `KEEP_DRILL_DB=1` path | Exercised during fingerprinting; DB retained until cleanup |

The guard is sound. Its verification depth is not (§13, M1): it checks only `_prisma_migrations`, `User`, `Patient`, and `Report` counts.

## 8. Storage restore and database-to-file reconciliation

### 8.1 Archive fidelity

| Set | Files | Bytes on disk | Restore result |
|---|---:|---:|---|
| Small | 6 | 5,291,668 | 6/6 extracted; SHA-256 and size identical |
| Scale | 206 | 5,291,668 + 200 × 100 B | 206/206 extracted; SHA-256 and size identical |

Directory structure (`clinical/YYYY/MM/<uuid>.<ext>`) was preserved. Extraction took 3.32 s in the isolated environment. The small dataset intentionally included one 5 MiB file; the rest were tiny. The scale set added 200 × 100-byte files, so the archive compresses unrealistically well (8.9 KB for 206 files). **These timings and sizes are not representative of real JPEG/PDF uploads.**

The documented storage restore command extracts with `tar xzf ... -C /data` and then `chown -R 1000:1000 /data`. Two gaps:

1. Extraction does not remove files already in the volume. A restore over an existing volume can leave **stale files** from the pre-restore state.
2. `tar` preserves modes/ownership stored in the archive unless `--no-same-owner`/`--no-same-permissions` is used; the subsequent `chown` fixes ownership but not unexpected modes. The drill archive was created from a root-owned read-only mount, so this needs care on a real volume.

### 8.2 Consistency between database and files

Method: compare every `FileAsset.storedName` with a file on disk, and every file with a `FileAsset` row.

| Scenario | Result |
|---|---|
| Baseline small dataset | 0 orphan rows, 0 orphan files |
| Simulated DB row without file | Detected: 1 missing file |
| Simulated file without DB row | Detected: 1 orphan file |
| Scale dataset | 206 rows ↔ 206 files, 0 mismatches |

The detection works. The production risk is that **nothing runs it** as part of backup or restore, and the application does not maintain a checksum:

- `backend/src/modules/files/routes.ts` writes `checksum: null` on every upload (`FileAsset.checksum` is always `NULL`).
- Upload writes the file before creating the database row; a database failure leaves an orphan file.
- Delete removes the database row first and swallows `unlink` failures (`.catch(() => undefined)`); a filesystem failure leaves an orphan file.
- `backup.sh` dumps the database and then tars storage sequentially, without quiescing writers. A file uploaded between the two steps can exist in the archive without a database row or vice versa.

Because `checksum` is null, even a successful restore cannot prove byte-level integrity from the database alone. The drill compared archive files to restored files directly; production has no stored baseline to compare against.

## 9. Evolution / WhatsApp recovery assessment

| Aspect | Finding |
|---|---|
| Database storage | Evolution uses the same PostgreSQL database, schema `evolution` (Compose line 157). It is included in every `pg_dump`. |
| Schema restore | Verified: 37 tables, 57 migrations, row hashes matched in both drills and the fresh cluster. |
| Session storage | Dedicated volume `ultrasound_clinic_evolution_instances` mounted at `/evolution/instances`. |
| Session volume in backup | **Absent.** `backup.sh` has no reference to it. |
| Observed session state | Both the isolated and production volumes contained **0 files** (no pairing on this host). The production volume was inspected read-only for a file count only; no contents were read or copied. |
| Redis | Disabled (`CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true`); no Redis service to back up. |
| API key | Required by the Evolution service; the backend also has a hardcoded fallback (see H6). |
| Recovery after host loss | Database metadata can be restored, but the WhatsApp/Baileys auth state in the volume cannot. Re-pairing via QR from the clinic phone is required; this was **not tested** because it needs a real phone/session and is explicitly out of bounds. |
| Caddy TLS state | `caddy_data`/`caddy_config` are not backed up. Loss means certificate re-issuance; no clinical data loss. |

**Conclusion:** the Evolution **database schema is proven restorable**, but a complete WhatsApp recovery is unproven and currently impossible from the backup set alone. This is High severity for operational continuity, not for clinical data integrity.

## 10. Encryption, off-site copy and key management

| Control | Status | Evidence |
|---|---|---|
| Encryption at rest of backups | **Missing** | `backup.sh` writes plain custom-format dump and plain tar.gz. No `age`, `gpg`, or equivalent. Docs say "encrypt before off-host" but the script does not. |
| Encryption in transit to off-site | **Missing** | No off-site copy step at all. |
| Off-site/second copy | **Missing** | Output stays in `backups/` on the same host. |
| Separate credentials for backup destination | **Not applicable / missing** | No destination integration. |
| Immutability / object lock / versioning | **Missing** | Local directory only; deletable by any process with Modify rights. |
| Key management / escrow | **Missing** | No documented escrow for encryption keys or `.env` secrets. |
| Backup directory permissions | Intended 0700; **not effective on Windows** | `chmod 700` is a no-op for NTFS ACLs; `backups` grants `BUILTIN\Users:(M)`. |
| PHI handling | Documented, not enforced | `docs/backup-restore.md` and `SECURITY.md` warn correctly. |

A backup that is unencrypted and on the same host fails both directions of DR: it exposes PHI if the host or directory is compromised, and it is lost with the host in a disk failure, theft, fire, or ransomware event. This is the primary reason Phase 6 cannot be marked production-ready.

**Recommended target design (not applied; requires approval):**

1. Stream the dump and storage archive through `age` (or `gpg`) with a public recipient key; keep the private key offline/password-managed, separate from the host.
2. Copy the encrypted artifacts to a second location (S3-compatible bucket, Backblaze B2, or a different physical host) using a dedicated least-privilege credential, over TLS.
3. Enable bucket versioning/object lock and a lifecycle policy; never let the backup host credential delete old versions.
4. Restore-test from the **off-site copy**, not the local directory, at least quarterly.
5. Record the encryption recipient/key ID in the manifest (never the private key).

## 11. Retention, scheduling and monitoring

| Control | Status | Evidence |
|---|---|---|
| Automated schedule | **Missing** | No cron/systemd timer/Task Scheduler entry in the repo or on the host. `docs/operations.md` only *suggests* nightly 02:00. |
| Retention / pruning | **Missing** | `backup.sh` explicitly says it does not delete old backups. No 7/4/3 implementation. |
| Verification schedule | **Missing** | `docs/operations.md` suggests quarterly drills; nothing enforces or records them. |
| "Backup missing" alert | **Missing** | `docs/operations.md` suggests an alert; no implementation. |
| Checksum-failure alert | **Missing** | No monitoring integration. |
| Restore-drill result log | **Missing** | No machine-readable record; docs ask for an operations log only. |
| Disk-space guard | **Missing** | No precheck; a full disk can produce a truncated/failed set. |
| Backup age/size inventory | **Missing** | Manifest does not include sizes; no inventory command. |

The only artifact in the repository's `backups/` directory is a single 198 KB dump from 2026-11-13 with no companions. If that is the clinic's only backup, the current RPO is already measured in days and the storage archive for that point in time does not exist.

## 12. RPO/RTO: measured versus estimated

### 12.1 Measured timings (isolated, synthetic)

| Operation | Data | Measured | Notes |
|---|---|---:|---|
| `backup.sh` small | 203,199 B dump; 6 files / 5.29 MB | **1.65 s** | Includes dump + tar + SHA-256 + manifest |
| `backup.sh` scale | 3,845,422 B dump; 206 files | **1.98 s** | Tiny/compressible synthetic files |
| `restore-drill.sh` small | → `phase6_synthetic_drill` | **4.38 s** | Includes create/drop and 4-count check |
| `restore-drill.sh` scale | → `phase6_scale_drill` | **4.58 s** | ~54.8k rows |
| Documented clean re-restore | → `phase6_clean_drill` (twice) | **4.18 s** | `--clean --if-exists --no-owner` |
| Fresh-cluster restore | Empty container → verified `phase6_fresh_drill` | **7.69 s** | Includes container start |
| Storage extraction | 206 files / 5.29 MB | **3.32 s** | Not representative of real images |
| Database size at audit end | 32,103,447 B total | — | `public` 20,922,368 B; `evolution` 1,024,000 B |
| Host free disk | — | **37.7 GB** | Audit host, not target server |

These timings exclude image pulls, stack startup/health checks, DNS/TLS, operator verification, and Evolution re-pairing. Real clinic storage (JPEG/PDF, potentially many GB) will dominate both backup and restore.

### 12.2 RPO scenarios

| Scenario | RPO | Status |
|---|---|---|
| **Current state** — manual backup, no schedule | **Unbounded** (since the last operator run; the only artifact in `backups/` is from 2026-11-13) | Verified by absence of scheduler/monitoring |
| Nightly dump at 02:00 (documented suggestion) | **≤ 24 h** | Estimated; not implemented |
| Nightly dump + WAL archiving/PITR | **Minutes** (e.g. `archive_timeout=5min`) | Not implemented; `archive_mode=off` |
| Evolution session/pairing | **Total loss of pairing on host loss** | Not backed up; re-pair required |
| Uploaded files | **Same as DB interval**, plus intra-backup drift | Not measured with real files |
| Accidental deletion/corruption noticed late | **Until the last good backup** | No versioning/immutability |

### 12.3 RTO scenarios

| Scenario | Estimated RTO | Basis |
|---|---:|---|
| Same host, volumes intact; restore DB + storage from local backup | **15–30 min** | Measured restore 4–5 s + stack start/health + verification + operator checks; estimate |
| Same host, full stack recreated (volumes gone) | **30–60 min** | Adds volume creation, migrations, storage ownership, TLS; estimate |
| Fresh Ubuntu host with Docker/images available | **1–3 h** | Adds OS/Docker setup, image pulls (backend image ≈2.31 GB), DNS/TLS, secret escrow retrieval; estimate |
| Fresh host, no registry access | **Unknown / blocked** | Images are tag-pinned, not archived or digest-pinned |
| Real data with multi-GB storage | **Unknown; likely hours** | Not measured |
| Evolution re-pair | **15–60 min + phone owner availability** | Untested |

**Caveat:** every measured number above is from a synthetic dataset that is small and highly compressible. Do not present these as production RTOs. A real restore drill on the target host, with a representative storage volume, is required before go-live.

## 13. Findings and severity

Status legend: **Verified** = directly exercised; **Partially verified** = exercised with synthetic/limited data; **Not tested** = requires real environment or approval; **Recommended** = action documented, not applied; **Requires approval** = change to production/scripts.

### 13.1 Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| C1 | **Critical** | Backups are unencrypted, single-copy, same-host only | Verified |
| C2 | **Critical** | No schedule, retention, verification, or monitoring; RPO unbounded | Verified |
| H1 | High | Restore runbook is incomplete and non-atomic; Evolution not stopped | Verified / Requires approval |
| H2 | High | `backup.sh` can leave a partial unmanifested set; no disk precheck/trap | Verified |
| H3 | High | Evolution session volume and Caddy TLS state are not backed up | Verified |
| H4 | High | No WAL archiving/PITR; recovery limited to the last dump | Verified |
| H5 | High | Windows ACLs expose `.env` and backups to `BUILTIN\Users` | Verified (Windows host) |
| H6 | High | Hardcoded Evolution API-key fallback in tracked Compose file | Verified |
| M1 | Medium | Restore drill checks only four row counts | Verified |
| M2 | Medium | No automatic DB↔file reconciliation; `FileAsset.checksum` always null | Verified |
| M3 | Medium | Database and storage are not point-in-time consistent | Verified |
| M4 | Medium | Manifest lacks sizes, DB name, volume names, tool versions | Verified |
| M5 | Medium | Existing `backups/` dump has no companions and is untested | Verified (TOC only) |
| M6 | Medium | No secrets escrow/restore procedure for a new host | Verified / Recommended |
| M7 | Medium | CRLF worktree + no `.gitattributes`; scripts can break on Linux | Verified |
| M8 | Medium | Docker Desktop engine instability and single-host dependency | Verified (audit host) |
| M9 | Medium | No retention, immutability, or ransomware resistance | Verified |
| M10 | Medium | No image/digest inventory; recovery depends on registry availability | Verified |
| L1 | Low | `restore-drill.sh` does not verify the dump checksum automatically | Verified |
| L2 | Low | `backup.sh` hardcodes the default storage volume name | Verified |
| L3 | Low | No backup inventory/report command; age/size requires manual inspection | Verified |

### 13.2 Critical

**C1 — Backups are unencrypted, single-copy, same-host only.**
Evidence: `backup.sh` writes plain `db-*.dump` and `storage-*.tar.gz`; no encryption tool; output stays under `backups/`; docs only advise encryption. The directory ACL on Windows grants `BUILTIN\Users:(M)`. Impact: PHI exposure on host compromise, and total loss on disk/host failure, theft, fire, or ransomware. Action: implement encrypted off-site copies with separate credentials and immutability; treat existing plaintext backups as exposed until reviewed. **Requires approval.**

**C2 — No schedule, retention, verification, or monitoring; RPO unbounded.**
Evidence: no cron/systemd/Task Scheduler entry; `backup.sh` explicitly does not delete; no alerting; only one local dump exists. Impact: backups may silently not run; when they do, nobody knows whether they are restorable; RPO is whatever the last manual run happened to be. Action: automate backup + verification + alerting, and record drill results. **Requires approval (Phase 7 overlap).**

### 13.3 High

**H1 — Restore runbook is incomplete and non-atomic.**
Evidence: `docs/backup-restore.md` stops only `web` and `backend`, leaving `evolution` connected to the database; the documented `pg_restore` uses `--clean --if-exists` without `--single-transaction`/`--exit-on-error`; storage extraction does not clear stale files; no post-restore session invalidation step. Impact: a restore can fail midway, leave a half-restored database/SQL errors, keep Evolution writing during the restore, or retain stale clinical files. Action: adopt the stricter procedure in §14 (stop all writers including Evolution, safety backup, `--single-transaction --exit-on-error`, clean storage target, invalidate sessions, verify). **Requires approval.**

**H2 — `backup.sh` can leave a partial unmanifested set.**
Evidence: reproduced an orphan `db-20261118T161340Z.dump` with no storage archive, checksums, or manifest after the storage step failed; no `trap`, no staging directory, no `.partial` marker, no disk-space check. Impact: an incomplete set looks like a valid dump; a restore attempt fails or, worse, restores only the database. Action: stage into a temporary directory, check free space, verify checksums before publishing, and write the manifest last atomically. **Requires approval.**

**H3 — Evolution session volume and Caddy TLS state are not backed up.**
Evidence: `backup.sh` references only `ultrasound_clinic_storage`; `docker-compose.yml` also defines `evolution_instances`; `docker-compose.tls.yml` defines `caddy_data`/`caddy_config`. Impact: host loss requires WhatsApp re-pairing (clinic phone + operator time) and certificate re-issuance; Evolution session history/auth state is unrecoverable. The session volume currently contains 0 files on this host (no pairing), so no live session exists to lose today; the gap becomes material as soon as WhatsApp is paired. Action: add both volumes to the backup set (or document an explicit accepted risk) and add an Evolution re-pair runbook. **Requires approval.**

**H4 — No WAL archiving/PITR.**
Evidence: `SHOW wal_level` = `replica`; `SHOW archive_mode` = `off`. Impact: cannot recover changes made after the last dump, and cannot recover to a point before a logical corruption that was subsequently dumped. RPO cannot be better than the backup interval. Action: decide whether ≤24 h RPO is acceptable; if not, implement WAL archiving/PITR with tested restore. **Requires approval.**

**H5 — Windows ACLs expose `.env` and backups.**
Evidence: `icacls .env` → `BUILTIN\Users:(M)`; `icacls backups` → `BUILTIN\Users:(OI)(CI)(M)`. Impact: any local user can read/modify secrets and PHI backups; `chmod 700` does not fix NTFS ACLs. This applies only if the clinic runs on Windows. Action: restrict ACLs to the deploy account, SYSTEM, and Administrators; store backups outside user-writable paths; prefer the documented Ubuntu target. **Requires approval.**

**H6 — Hardcoded Evolution API-key fallback in a tracked Compose file.**
Cross-cutting security finding, recorded here because it affects secret restore and rotation. Evidence: `docker-compose.yml` line 94 provides a non-empty fallback for `EVOLUTION_API_KEY`, so a missing `.env` value silently uses a key committed to Git. Impact: if that key is or was used in production, it is compromised; it also defeats the mandatory-variable guard used by the Evolution service. Action: remove the fallback, require `EVOLUTION_API_KEY` (like the Evolution service does), rotate the key, and verify both backend and Evolution use the new value. **Requires approval.** (Value intentionally not reproduced.)

### 13.4 Medium

**M1 — Restore drill checks only four row counts.**
`restore-drill.sh` verifies `_prisma_migrations`, `User`, `Patient`, `Report` counts. It does not compare per-table hashes, financial invariants, constraints, storage, Evolution, or migrations status. A restore that loses charges/payments/report versions but keeps those four counts would pass. Action: extend the drill with the fingerprint/invariant checks used in §7, or run them as a wrapper. **Requires approval.**

**M2 — No automatic DB↔file reconciliation; `FileAsset.checksum` always null.**
Uploads set `checksum: null`; delete removes the row before unlinking and swallows unlink errors; upload writes the file before the row. Drift is therefore possible in both directions, and nothing detects it. Action: compute and store SHA-256 on upload, add a reconciliation job, and include reconciliation in the restore checklist. **Requires approval.**

**M3 — Database and storage are not point-in-time consistent.**
`backup.sh` dumps the database, then tars storage, with no quiesce. Uploads/deletes during that window can produce a mismatched set. Action: stop writers for the backup window, or snapshot the volume/database together, or reconcile after restore and document the accepted drift. **Requires approval.**

**M4 — Manifest metadata is insufficient.**
It has no sizes, hashes, database name, volume names, PostgreSQL/client versions, or script version. Action: extend the manifest (and include the checksum file's digest). **Requires approval.**

**M5 — Existing local dump is incomplete and untested.**
`backups/db-20261113T134414Z.dump` (198,449 B, 431 TOC entries, dbname `ultrasound_clinic`) has no storage archive, checksums, or manifest. It was not restored. Action: treat it as unverified; do not rely on it; replace it with a complete, encrypted, off-site set. **Requires approval.**

**M6 — No secrets escrow/restore procedure.**
A new host needs `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `EVOLUTION_API_KEY`, domain/TLS config. These are not in the backup set; losing `.env` means an unusable restore or forced credential rotation. Action: maintain a break-glass secret escrow in a password manager/sealed offline copy, separate from backups; test retrieval. **Recommended.**

**M7 — CRLF worktree and no `.gitattributes`.**
`git ls-files --eol` shows `i/lf w/crlf` for `scripts/backup.sh` and `scripts/restore-drill.sh`; the shebang on disk is `#!/usr/bin/env bash\r`. If the working tree is copied to Linux or bind-mounted, bash fails with `bad interpreter`. Action: add `.gitattributes` with `*.sh text eol=lf`, re-checkout/normalize, and test on the target OS. **Requires approval.**

**M8 — Docker Desktop instability and single-host dependency.**
The Linux engine crashed five times during the audit; the production stack auto-restarted, but the audit stack required manual restarts. Backup and production run on the same host. Action: if production is Windows/Docker Desktop, move to a supported Linux host or accept and monitor the risk; keep backups independent of the Docker engine. **Requires approval / environment decision.**

**M9 — No retention, immutability, or ransomware resistance.**
Local backups are deletable/modifiable by any process with directory rights; there is no versioning or object lock. Action: encrypted off-site storage with versioning/object lock and a documented 7-daily/4-weekly/3-monthly retention policy. **Requires approval.**

**M10 — No image/digest inventory; recovery depends on registry availability.**
Compose uses tags (`postgres:16-alpine`, `evoapicloud/evolution-api:v2.3.7`, `alpine:3.22`), and `backup.sh` pulls `alpine:3.22` at backup time. On an isolated/offline recovery host, missing images block both backup and restore. Action: record image digests in the manifest and keep an offline image archive (or a private registry) for DR. **Requires approval.**

### 13.5 Low

**L1 — No automatic checksum verification in the drill.**
`restore-drill.sh` accepts a dump path and restores it without running `sha256sum -c`. Action: verify the matching `SHA256SUMS-*` first, and refuse on failure. **Requires approval.**

**L2 — Hardcoded default storage volume name.**
`STORAGE_VOLUME` defaults to `ultrasound_clinic_storage`; a renamed project/volume silently points at the wrong volume (the script fails if absent, which is good, but it cannot back up a differently named volume without an env override). Action: derive from Compose or document the override prominently. **Recommended.**

**L3 — No backup inventory/report command.**
Operators must inspect files manually; age/size/completeness are not summarized. Action: add a read-only inventory command that checks set completeness, checksum presence, and age. **Recommended.**

### 13.6 Positive controls verified

- `pg_dump -Fc` produces a transactionally consistent snapshot; full row-hash comparison matched in all drills.
- Restore into a fresh empty cluster works; no hidden same-cluster dependency.
- `restore-drill.sh` correctly refuses non-`_drill` names and drops the drill DB by default.
- Checksums are generated, and `sha256sum -c` detects corruption and missing files.
- The manifest names match the artifacts.
- The dump/manifest/storage do not contain production secrets.
- `set -euo pipefail` stops the script on failure (though it leaves partial artifacts).
- No destructive Docker command was needed or used for restores.

## 14. Exact recovery procedures (approval-gated)

> Everything in this section is documentation, not an executed production action. Commands assume the repository is at `/opt/clinic` on Linux, the Compose project is `ultrasound-clinic`, and the operator has written approval for a restore. Replace `<STAMP>` and `<domain>`.

### 14.1 Pre-flight decisions

1. Confirm the target host and OS (Ubuntu is the current documented assumption).
2. Confirm the backup set is complete: `db-<STAMP>.dump`, `storage-<STAMP>.tar.gz`, `SHA256SUMS-<STAMP>.txt`, `MANIFEST-<STAMP>.txt`.
3. Confirm the application/image version matches the dump's schema. If the dump is older, `migrate deploy` will upgrade it; if the dump is newer than the deployed code, **stop** and deploy the matching version first.
4. Confirm you have the secret escrow (§14.7). Without it, plan for credential rotation.
5. Announce downtime and record the operator, start time, backup name, and approval reference.

### 14.2 Verify the artifacts before touching anything

```bash
cd /opt/clinic/backups
sha256sum -c SHA256SUMS-<STAMP>.txt
gzip -t storage-<STAMP>.tar.gz
docker compose -f /opt/clinic/docker-compose.yml exec -T db \
  pg_restore --list < db-<STAMP>.dump > /tmp/toc-<STAMP>.txt
grep -c '^' /tmp/toc-<STAMP>.txt
```

Do not proceed if any checksum fails, the gzip test fails, or the TOC cannot be read. Also confirm the manifest's filenames match.

### 14.3 Safe restore drill (disposable database)

```bash
cd /opt/clinic
DRILL_DB=clinic_restore_drill KEEP_DRILL_DB=1 \
  ./scripts/restore-drill.sh backups/db-<STAMP>.dump
```

Then run the stronger checks (the ones used in §7) against `clinic_restore_drill`: per-table counts/hashes, ledger/daily-finance/report-version/allocation queries, FK/unique/NOT NULL probes, `prisma migrate status`, and a storage extraction with SHA-256 comparison. Drop the drill database only after the results are recorded.

### 14.4 Full restore on the same host (written approval required)

```bash
cd /opt/clinic

# 1. Preserve the current state first.
./scripts/backup.sh

# 2. Stop every writer, including Evolution.
docker compose stop web backend evolution

# 3. Confirm nothing else is connected to the target database.
docker compose ps

# 4. Restore the database. The stricter flags are recommended but were not
#    part of the original documented command; validate them in a drill first.
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     --clean --if-exists --no-owner --single-transaction --exit-on-error' \
  < backups/db-<STAMP>.dump

# 5. Replace the uploads volume contents with the matching archive.
#    DESTRUCTIVE: only with explicit approval. Prefer a fresh volume if possible.
docker compose stop backend
docker run --rm \
  -v ultrasound_clinic_storage:/data \
  -v "/opt/clinic/backups:/backup:ro" \
  alpine:3.22 \
  sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; \
         tar xzf /backup/storage-<STAMP>.tar.gz -C /data; \
         chown -R 1000:1000 /data'

# 6. Invalidate sessions before serving traffic (see §14.6).
# 7. Start the stack (include the TLS overlay on a production host).
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d

# 8. Verify.
curl -fsS https://<domain>/healthz
docker compose run --rm migrate npx prisma migrate status
```

Then sign in with a known account, open a known patient/report, confirm audit history, download one stored file, and run the DB↔file reconciliation in §14.8. Record the result in the operations log.

If the original documented command is used unchanged (`--clean --if-exists --no-owner`), capture the full output and check for errors manually; it can exit 0 after partial failures.

### 14.5 Fresh-host restore

1. Install the documented OS, Docker Engine, and Compose plugin. Do not use Docker Desktop for production.
2. Clone the repository at the exact release tag; restore `.env` from escrow (§14.7) with mode `600`.
3. Create the named volumes (`db_data`, `clinic_storage`, `evolution_instances`, and Caddy volumes if TLS).
4. Start only `db`, wait for health, then create an empty database if it does not exist.
5. Restore the database and storage exactly as in §14.4, without `--clean` on an empty database (or keep it; it is harmless).
6. Start the stack; `migrate deploy` runs before the backend. Confirm `prisma migrate status`.
7. Re-issue TLS certificates (Caddy does this automatically if `caddy_data` was lost and DNS/ports are correct).
8. Re-pair WhatsApp if the Evolution session volume was lost (§14.9).
9. Run the full verification and reconciliation, then record the measured RTO.

### 14.6 Post-restore security order

Run this **after** the data restore and **before** the system is announced as available. It was exercised on the disposable `phase6_scale_drill` database only.

```bash
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN;
UPDATE "User"
   SET "tokenVersion" = "tokenVersion" + 1,
       "mustChangePassword" = true;
UPDATE "RefreshToken"
   SET "revokedAt" = now()
 WHERE "revokedAt" IS NULL;
UPDATE "PasswordSetupToken"
   SET "revokedAt" = now()
 WHERE "revokedAt" IS NULL AND "usedAt" IS NULL;
DELETE FROM "TokenBlacklist";
COMMIT;
SQL
```

Expected result on the drill: all users bumped, all refresh/setup tokens revoked, blacklist empty. Rationale and order:

1. **Invalidate sessions first** — a restored database may contain tokens issued before the incident; bumping `tokenVersion` invalidates access tokens, and revoking refresh/setup tokens prevents silent re-entry.
2. **Clear the blacklist** — it is safe only after the version bump; old blacklist entries are no longer needed and may reference tokens from the compromised timeline.
3. **Force password change only when appropriate** — the drill sets `mustChangePassword=true` for every user. For a like-for-like restore onto a trusted host this may be unnecessarily disruptive; for a suspected compromise or an untrusted restore, keep it.
4. **Rotate JWT secrets if exposure is suspected** — this invalidates all tokens immediately and requires restarting the backend. If the `.env` was not exposed and tokens are already invalidated, rotation can be deferred to the normal schedule.
5. **Rotate the database password and Evolution key if either was exposed**; update `.env` and the database/Evolution configuration together, then restart.
6. **Start services only after steps 1–5**, then verify login and audit.

### 14.7 Secrets procedure

**Escrow contents (store in a password manager with break-glass access, never with the backups):**

- `POSTGRES_PASSWORD`
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (distinct, random, ≥32 chars)
- `EVOLUTION_API_KEY` (must match both the backend and the Evolution service)
- `CLINIC_DOMAIN`, DNS provider access, TLS account email
- Any SMTP/notification credentials if added later

**Restore procedure:**

```bash
cd /opt/clinic
umask 077
# Populate from the password manager without echoing to the terminal or shell history.
# Example: `read -rs POSTGRES_PASSWORD` then write the file with a here-document.
install -m 600 /dev/null .env
# ... write values ...
```

Rules:

- Never paste secrets into chat, tickets, screenshots, or logs.
- Never store the escrow in `backups/`, the repository, or the same host.
- If the escrow is unavailable: generate a new database password, update the role, generate new JWT secrets (all sessions invalidated), generate a new Evolution key and update both services, then re-pair if needed.
- After any restore onto a host you do not fully control, rotate all three secrets before announcing availability.
- Verify `.env` is mode `600` and owned by the deploy account; on Windows, verify the ACL instead (see H5).

### 14.8 Database-to-file reconciliation after restore

Run a query for every `FileAsset.storedName`, then check the file exists and its size matches `sizeBytes`. A minimal check inside the storage container:

```bash
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
   "SELECT \"storedName\" || E'\''|'\'' || \"sizeBytes\" FROM \"FileAsset\" ORDER BY 1"' \
  > /tmp/fileassets.txt

docker run --rm \
  -v ultrasound_clinic_storage:/data:ro \
  -v /tmp/fileassets.txt:/fileassets.txt:ro \
  alpine:3.22 \
  sh -c 'while IFS="|" read -r p s; do
           [ -f "/data/$p" ] || echo "MISSING $p";
           [ "$(stat -c %s "/data/$p" 2>/dev/null)" = "$s" ] || echo "SIZE $p";
         done < /fileassets.txt'
```

Then find files with no row (orphan files) by comparing the file list with `storedName`. Because `FileAsset.checksum` is always null, byte-level verification requires comparing the restored archive's SHA-256 directly, as the drill did.

### 14.9 Evolution re-pair (manual, untested)

If `ultrasound_clinic_evolution_instances` was lost:

1. Restore the database (which restores the `evolution` schema metadata).
2. Start Evolution; inspect its logs/manager for the instance state.
3. If the instance exists but has no auth state, remove/recreate it through the supported Evolution API/manager, then pair by scanning the QR code from the clinic's WhatsApp phone.
4. Verify a synthetic WhatsApp delivery end-to-end.
5. Record the phone owner, operator, time, and result. Do not attempt this against a real session without the clinic owner present.

## 15. Manual actions required (priority order)

> Post-review status: repo-only fixes for the backup script, drill, verification, completeness, and `.gitattributes` are applied (§21). Deployment/configuration, scheduling/monitoring, WAL/PITR, ACLs, Compose-key rotation, and real-host validation remain open.

| Priority | Action | Owner | Approval | Reference |
|---|---|---|---|---|
| P0 | Implement encrypted off-site backups with versioning/object lock and separate credentials | Infrastructure | **Required** | C1, M9 |
| P0 | Automate nightly backup + checksum verification + "backup missing/old" alerting | Infrastructure / Phase 7 | **Required** | C2 |
| P0 | Add Evolution session volume and Caddy data to the backup set (or formally accept the risk) | Infrastructure | **Required** | H3 |
| P0 | Adopt the stricter restore runbook (stop Evolution, atomic restore, storage cleanup, session invalidation) | Operations | **Required** | H1 |
| P0 | Rotate and remove the hardcoded Evolution key fallback; require the variable | Backend / Security | **Required** | H6 |
| P1 | Fix `backup.sh`: disk precheck, staging dir, trap cleanup, checksum verification, richer manifest | Backend / DevOps | **Required** | H2, M4 |
| P1 | Extend `restore-drill.sh` to full fingerprints, constraints, storage, Evolution, and checksum | Backend / QA | **Required** | M1, L1 |
| P1 | Restrict `.env` and backup ACLs; move backups off user-writable paths | Infrastructure | **Required** | H5 |
| P1 | Decide RPO target; implement WAL/PITR if better than 24 h is required | Infrastructure / DBA | **Required** | H4 |
| P1 | Add DB↔file reconciliation and compute/store upload checksums | Backend | **Required** | M2, M3 |
| P1 | Add `.gitattributes` (`*.sh text eol=lf`) and validate scripts on Linux | Backend | **Required** | M7 |
| P2 | Create and test a secrets escrow; document retrieval and rotation | Operations | **Required** | M6 |
| P2 | Record image digests and keep an offline image archive for DR | Infrastructure | **Required** | M10 |
| P2 | Test a full restore on the real target host with representative storage; record measured RTO | Operations | **Required** | §12 |
| P2 | Test Evolution re-pair with the clinic owner and document it | Operations | **Required** | §14.9 |
| P3 | Replace the incomplete 2026-11-13 local dump with a verified complete set | Operations | **Required** | M5 |
| P3 | Add a read-only backup inventory command | DevOps | Recommended | L3 |

## 16. OS/platform findings (Windows audit host)

| Finding | Evidence | Impact / action |
|---|---|---|
| NTFS ACLs do not honor `chmod 700` | `.env` → `BUILTIN\Users:(M)`; `backups` → `BUILTIN\Users:(OI)(CI)(M)` | Any local user can read secrets/PHI; fix ACLs or move to Linux |
| CRLF in working tree | `git ls-files --eol`: `i/lf w/crlf`; `cat -A` shows `^M$` on the shebang | Bash scripts fail on Linux if copied/bind-mounted; add `.gitattributes` |
| Git Bash path conversion | First `backup.sh` run created an empty `backups;C` directory from a mangled `-v` path | Use `MSYS_NO_PATHCONV=1` or, preferably, run on Linux |
| Docker Desktop engine instability | Engine crashed five times; all containers stopped each time | Unacceptable for production backup/DR; use Docker Engine on Linux |
| No native scheduler evidence | No cron/systemd/Task Scheduler entry found | Windows would need Task Scheduler and a WSL2/Docker Desktop plan; Linux cron/systemd is simpler |
| Target OS still undecided | Baseline §3 says Ubuntu, owner/domain blank | Decide before implementing Phase 7; current scripts assume Linux paths/cron |

The documented target is Ubuntu. The audit host's Windows behavior should not be used as the production design. If Windows Server is chosen instead, the bash scripts, scheduler, path handling, ACLs, and Docker runtime all need a separate plan and re-test.

## 17. Production non-interference and resource ledger

### 17.1 Production statement

- The production stack `ultrasound-clinic` (`db`, `backend`, `web`, `evolution`) was observed before, during, and after the audit. It was never stopped, restarted intentionally, or reconfigured.
- The production database was **never queried**; no `psql`, `pg_dump`, or `pg_restore` was run against it.
- No production volume was written or deleted. Sizes were observed with read-only Docker metadata commands; the Evolution session volume was additionally mounted read-only for a file count (see below). The one accidental empty volume is disclosed in §2.3.
- No production backup was deleted or modified. `backups/db-20261113T134414Z.dump` was inspected TOC-only.
- The production Evolution session volume was mounted **read-only once for a file count** (0 files). No file contents were read, copied, or written, and no session was started or paired.
- When Docker Desktop crashed, `restart: unless-stopped` restarted the production containers automatically; they returned healthy. That was an engine event, not an intentional production action.
- One accidentally created empty volume, `ultrasound_clinic_caddy_data`, was removed immediately (see §2.3). It never held data and was not referenced by a container.

### 17.2 Resources created during the audit

| Resource | Type | Purpose |
|---|---|---|
| `phase6audit` | Compose project | Isolated stack |
| `phase6audit-db-1` | Container | PostgreSQL 16, port 65432 |
| `phase6audit-evolution-1` | Container | Evolution v2.3.7, synthetic key, empty volume |
| `phase6audit-fresh-db` | Container | Fresh PostgreSQL 16, port 65433 |
| `phase6audit_db_data` | Volume | Isolated DB data (incl. drill DBs) |
| `phase6audit_storage` | Volume | Synthetic uploads |
| `phase6audit_evolution_instances` | Volume | Empty Evolution session volume |
| `phase6audit_fresh_db_data` | Volume | Fresh-cluster DB data |
| `phase6audit_net` | Network | Isolated bridge |
| `phase6_synthetic` | Database | Synthetic source |
| `phase6_synthetic_drill` | Database | Small restore drill |
| `phase6_scale_drill` | Database | Scale restore drill + security drill |
| `phase6_clean_drill` | Database | Clean re-restore drill |
| `phase6_fresh_drill` | Database | Fresh-cluster restore |
| `phase6_drop_drill` | Database | Drop-behavior test (already dropped) |
| `%TEMP%\phase6-20261118T160839Z` | Directory | Temp workspace, backups, SQL, fingerprints |

### 17.3 Resources removed during cleanup

Cleanup completed at 2026-11-18T16:41Z. The destroy step touched only Phase 6 resources; no `down -v`, `volume prune`, or `system prune` was used.

| Resource | Type | Disposition |
|---|---|---|
| `phase6_synthetic_drill`, `phase6_scale_drill`, `phase6_clean_drill` | Databases | Dropped before container removal |
| `phase6_fresh_drill` | Database | Removed with its isolated container/volume |
| `phase6_drop_drill` | Database | Dropped during the guard test |
| `phase6audit-db-1`, `phase6audit-evolution-1`, `phase6audit-fresh-db` | Containers | Removed |
| `phase6audit_net` | Network | Removed |
| `phase6audit_db_data`, `phase6audit_storage`, `phase6audit_evolution_instances`, `phase6audit_fresh_db_data` | Volumes | Removed |
| `%TEMP%\phase6-20261118T160839Z` | Directory | Deleted recursively |
| `ultrasound_clinic_caddy_data` (accidental) | Volume | Confirmed empty and removed earlier |

Final verification: `docker ps -a`, `docker volume ls`, and `docker network ls` return **0** matches for `phase6`; the temp directory no longer exists. Production volumes `ultrasound_clinic_db_data`, `ultrasound_clinic_storage`, `ultrasound_clinic_evolution_instances`, and `ultrasound_clinic_pgdata` remain present, and all four production containers are healthy.

### 17.4 Left untouched

- Production containers, network, volumes, database, `.env`, and `backups/`.
- All pre-existing working-tree changes on `feature/clinic-quick-actions`.
- The repository's only existing dump.
- Phase 5 and earlier reports.

## 18. Limitations and not-tested items

- **No real PHI or real storage volume was used.** Synthetic data was small and compressible; real JPEG/PDF storage will change backup/restore timing substantially.
- **No real Evolution pairing.** The isolated session volume was empty (0 files), so a live WhatsApp session restore, Baileys auth-state recovery, and re-pair were not tested.
- **No real host failure or ransomware simulation.** Off-site copy, object lock, and immutability do not exist yet, so they could not be tested.
- **No PITR test.** `archive_mode=off`; no WAL archive to restore.
- **No production restore.** The full restore was exercised only on isolated databases, including a fresh cluster.
- **No scheduled backup test.** No scheduler exists to test.
- **No Windows Server test.** The audit host is Windows with Docker Desktop; the documented target is Ubuntu.
- **No large-file/multi-GB test.** Storage timings are not representative.
- **No concurrent-write consistency measurement.** The sequential dump/tar window was reasoned about and simulated, not measured under real load.
- **No multi-tenant/off-site credential test.** The recommended encryption/off-site design is not implemented.

## 19. Review gate

Phase 6 is **complete for review**, and the owner approved **repo fixes only**. The approved remediation is applied in the repository (§21): backup completeness/atomicity, checksum verification, encryption/off-site hooks, a stronger restore drill and verifier, LF enforcement, and the stricter runbooks. The restore mechanics remain proven only on synthetic data, and **nothing was deployed, scheduled, or configured on production**. The DR program is therefore still not production-ready until the remaining environment actions in §15 and §21 are completed and a real-host drill with representative storage is recorded.

**Phase 7 (logging, monitoring, alerting) was not started.** No further phase work should begin until this remediation is reviewed and the production-side actions are decided.

## 20. Appendix — evidence index

| Evidence | Location (temp workspace; deleted at cleanup) |
|---|---|
| Small backup set | `backups/db-20261118T161416Z.dump`, `storage-20261118T161416Z.tar.gz`, `SHA256SUMS-*`, `MANIFEST-*` |
| Scale backup set | `backups/db-20261118T162022Z.dump`, `storage-20261118T162022Z.tar.gz`, companions |
| Orphan failure artifact | `backups/db-20261118T161340Z.dump` |
| Tamper test | `mismatch-copy/` |
| Fingerprints | `fingerprint-source.txt`, `fingerprint-drill.txt`, `fingerprint-clean.txt`, `fingerprint-scale-source.txt`, `fingerprint-scale-drill.txt`, `fingerprint-fresh.txt`, `fingerprint-fresh-all.txt` |
| Critical-query outputs | `crit-source.txt`, `crit-drill.txt` |
| SQL probes | `repo/fingerprint*.sql`, `repo/critical-queries.sql`, `repo/constraints.sql`, `repo/columns.sql`, `repo/gap-probe.sql`, `repo/post-restore-security.sql`, `repo/migration-epoch.sql` |
| Restored storage | `storage-restored/`, `storage-scale-restored/` |
| Isolated Compose | `repo/docker-compose.yml` (project `phase6audit`) |
| Plain dump used for secret scan | `dump-plain.sql` (deleted with the temp workspace; no secret values recorded in this report) |

## 21. Post-review repo remediation (2026-11-18)

### 21.1 Scope and safety

The owner approved **repo fixes only**. This section records what changed in the repository and what remains a production/environment action. No Compose file, application code, schema, `.env`, container, volume, scheduler, key, or off-site destination was changed **during Phase 6**. Production was not queried or written. The only production effect was the already-known Docker Desktop engine instability, which recurred twice during/after testing; `restart: unless-stopped` brought the four production containers back healthy each time.

> **Phase 6.1 addendum:** the only new repository change after this section is the H6 fix in `docker-compose.yml` (removal of the hardcoded Evolution API-key fallback). Phase 6.1 also ran isolated PITR, Ubuntu permission, `age`, `rclone`, legacy-compatibility and full-recovery tests. Production credentials were **not** rotated and no production configuration was deployed. See §22 and `PRODUCTION_READINESS_PHASE6_1.md`.

### 21.2 Repository changes

| File | Change |
|---|---|
| `scripts/backup.sh` | Complete, atomic set: staging directory + trap cleanup, disk-space precheck, checksum verification before publish, manifest published last. Adds Evolution and Caddy volume archives, optional writer quiesce, optional age encryption (`BACKUP_AGE_RECIPIENT`, `BACKUP_REQUIRE_ENCRYPTION`), optional rclone copy/check (`BACKUP_OFFSITE_REMOTE`), and a richer manifest (sizes, DB/volume names, Postgres version, Git commit, format). |
| `scripts/restore-drill.sh` | Rejects `.age` with a decryption instruction; verifies matching `SHA256SUMS`; uses `--single-transaction --exit-on-error`; prints per-table counts, total rows, key-table counts, failed-migration checks, and Evolution schema/table/row counts; optional storage archive extraction with `FileAsset` missing/orphan/size reconciliation; drops the drill DB on failure unless `KEEP_DRILL_DB=1`. |
| `scripts/backup-verify.sh` | New read-only verifier/inventory: manifest fields, artifact presence, declared SHA-256/size, `SHA256SUMS` verification, encryption state, set age/size, orphan artifacts, optional `BACKUP_MAX_AGE_HOURS` and `BACKUP_VERIFY_REQUIRE_ENCRYPTION` monitoring gates. |
| `.gitattributes` | `*.sh`, `*.bash`, `*.sql`, and Dockerfiles forced to LF. |
| `docs/backup-restore.md` | Complete-set description, encryption/off-site workflow and key handling, verifier, stronger drill, exact full-restore order (Evolution/Caddy), storage cleanup, session invalidation, fresh-host and re-pair procedures, secret escrow pointer. |
| `docs/operations.md` | Backup/verify/drill commands, environment variables, schedule/retention/monitoring examples, stricter full-restore summary. |
| `docs/PRODUCTION_READINESS_BASELINE.md` | Phase 6 status, B3, backup section, next actions and changelog updated to distinguish repo-remediated from deployed. |

No secret values were added to any script, document, manifest, or command.

### 21.3 Finding disposition

| Finding | Repo status | Remaining production action |
|---|---|---|
| C1 unencrypted, single-copy, same-host | **Mitigated in repo** — opt-in age encryption, rclone off-site copy with verification, fail-closed if tools are missing, loud plaintext warnings | Create age key pair/escrow, configure recipient and a separately credentialed off-site destination with versioning/object lock, re-run and verify |
| C2 no schedule/retention/verification/monitoring | **Partially mitigated** — verifier/inventory and age gate exist; no scheduler | Deploy, schedule backup + verify, alert on non-zero/age, define 7/4/3 retention; Phase 7 overlap |
| H1 incomplete/non-atomic restore runbook | **Mitigated in docs** — all writers stopped, fresh verified backup, single transaction, storage cleanup, session invalidation, Evolution/Caddy steps | Execute once on the real target host with approval and record the result |
| H2 partial unmanifested set | **Fixed in repo** — staging, trap, pre-publish checksums, manifest last, disk precheck | Deploy the script and confirm in the real environment |
| H3 Evolution/Caddy not backed up | **Fixed in repo** — both archives included when volumes exist; missing volume warns | Deploy and confirm the real volumes appear in the manifest |
| H4 no WAL/PITR | **Open in Phase 6; `PARTIALLY FIXED` in Phase 6.1** — isolated WAL/PITR restore passed (§22) | Decide RPO; deploy WAL archiving/PITR, off-site WAL retention, monitoring and a production restore test |
| H5 Windows ACLs expose `.env`/backups | **Open** on the current Windows host; Ubuntu model `PARTIALLY FIXED` in Phase 6.1 (§22) | Fix NTFS ACLs or complete and verify the Ubuntu host permission setup |
| H6 hardcoded Evolution key fallback | **`PARTIALLY FIXED` in Phase 6.1** — fallback removed from `docker-compose.yml`; fail-closed tests passed (§22) | Deploy the Compose change and rotate `EVOLUTION_API_KEY`; rotation was not performed |
| M1 drill checked only four counts | **Fixed in repo** — expanded counts/sums, migrations, Evolution, optional storage reconciliation | Run on representative data |
| M2 no DB↔file reconciliation | **Partially mitigated** — drill reconciles `storedName`/`sizeBytes`; `FileAsset.checksum` still null | Add upload checksums in the application under a separate change |
| M3 DB/storage not point-in-time consistent | **Partially mitigated** — optional quiesce documented; still sequential | Use quiesce in production or accept/document the drift window |
| M4 thin manifest | **Fixed in repo** — sizes, names, versions, commit, format | Verify a real set |
| M5 old unverified dump | **Open** — verifier correctly flags it | Replace with a complete encrypted set after production configuration |
| M6 no secret escrow | **Documented** — procedure and contents listed; not tested | Create/test the escrow separately from backups |
| M7 CRLF/no `.gitattributes` | **Fixed in repo** — attributes added, scripts LF and executable | Confirm on the Linux checkout |
| M8 Docker Desktop instability | **Open** — environment | Move to supported Linux/Docker Engine or accept and monitor |
| M9 no retention/immutability/ransomware resistance | **Partially mitigated by design** — off-site hook and docs | Configure versioning/object lock and a retention lifecycle |
| M10 no image/digest inventory | **Open** | Record digests and keep an offline image archive for DR |
| L1 drill did not verify checksums | **Fixed in repo** | — |
| L2 hardcoded storage volume | **Fixed in repo** — `STORAGE_VOLUME`/`EVOLUTION_VOLUME`/`CADDY_VOLUMES` overrides | — |
| L3 no inventory/report command | **Fixed in repo** — `backup-verify.sh` | Schedule it with alerting |

### 21.4 Verification performed

All work used an isolated Compose project (`p6fixaudit`, PostgreSQL 16 plus synthetic volume contents). No production database was queried and no production volume was written.

| Check | Result |
|---|---|
| `bash -n` on all three scripts | Pass |
| Complete backup on synthetic stack | Pass: DB dump, storage, Evolution, two Caddy archives, `SHA256SUMS`, `MANIFEST`; automatic checksum verification printed `OK` for every artifact |
| `backup-verify.sh` on that set | Pass: 1 set, all artifacts/checksums/sizes matched, plaintext warning as expected |
| `restore-drill.sh` with storage archive | Pass: 6 tables / 9 rows, 1 migration, Evolution 1 table / 1 row, 1 file, 0 missing/orphan/size mismatch; drill DB dropped |
| Tampered DB dump | Detected: `SHA-256 mismatch`, checksum file failed, exit 1 |
| Missing storage archive | Detected: missing artifact + checksum failure, exit 1 |
| `.age` input to the drill | Rejected before restore with the decrypt command, exit 1 |
| Missing storage volume | Refused, exit 1; no artifacts or staging directory published |
| Encryption configured but `age` absent | Refused before backup, exit 1 |
| `BACKUP_QUIESCE_SERVICES` containing `db` | Refused, exit 1 |
| Repository `backups/` verification | Expected failure: old `db-20261113T134414Z.dump` has no manifest/checksums/storage |
| Cleanup | `p6fix` containers, volumes, network, and temp directory removed; 0 matches. Production containers healthy after the Docker Desktop engine instability recurred |

Not exercised because the tools are not installed on this host: real `age` encryption/decryption and real rclone copy/check. Their fail-closed paths were tested; the success paths still need a staging test with the actual binaries and destination.

### 21.5 Status

The approved **repo** remediation is complete. Phase 6 remains **not production-ready** because the fixes are not deployed or configured, a real-host restore with representative storage has not been recorded, and H4/H5/H6 plus scheduling/monitoring/off-site setup remain open. **Phase 7 was not started.**

## 22. Phase 6.1 addendum (2026-11-18)

Phase 6.1 closed the remaining validation gaps without production changes. Full evidence, status labels and the review gate are in `docs/PRODUCTION_READINESS_PHASE6_1.md`.

- **H6:** the Compose fallback was removed; both backend and Evolution now require `EVOLUTION_API_KEY`. Missing-key config fails closed; a synthetic key renders with no `sk_live_*` pattern. Production key rotation was `NOT PERFORMED`.
- **H4:** a disposable PostgreSQL stack with WAL archiving passed both named-restore-point and time-based PITR. Six WAL files were archived and both targets excluded the later insert/delete. Production PITR remains unconfigured, so H4 is `PARTIALLY FIXED`, not closed operationally.
- **H5:** the Ubuntu 24.04 permission model was validated in an isolated container (`0700` backup/key directories, `0600` dump/key, cross-user reads denied). The current Windows ACL finding remains `OPEN`.
- **Evolution/Caddy:** DB metadata, 37 Evolution tables, the synthetic session-volume marker, both Caddy markers and Caddy HTTP state were restored in a fresh stack. The recovered Evolution API still returned an empty instance list because the synthetic instance was never paired; live session recovery remains unproven.
- **Encryption/off-site:** `age` and `rclone` success/failure paths passed standalone, and the real `scripts/backup.sh` produced an encrypted, off-site-copied 7-file set verified with `BACKUP_VERIFY_REQUIRE_ENCRYPTION=1`; 7/7 off-site SHA-256 hashes matched. No external destination or production key escrow was configured.
- **Legacy compatibility:** manifest-less synthetic copies were correctly rejected by the verifier and restored by the drill with explicit checksum warnings; a synthetic `backup_format=1` manifest verified with expected warnings.
- **Full drill:** fresh-stack recovery passed with `REPORT_MARKER=P61-RECOVERY-MARKER-7f3a91`, `MIGRATIONS=7`, 37 Evolution tables, `Database schema is up to date!`, and a measured RTO of **386 seconds** on a tiny synthetic dataset.

All Phase 6.1 runtime work used unique `p61*` resources. Production was not queried, deployed, restarted intentionally, backed up, or reconfigured. Production operational validation remains **`NOT PERFORMED`**, and the review/approval gate is active.

> **2026-11-18 execution-plan update:** the owner subsequently selected a dedicated 500 GB external USB HDD on the Ubuntu server as the production backup/WAL destination, mounted by UUID at `/mnt/clinic-backups`. Historical off-site/rclone recommendations in this report are superseded for production by that decision. The USB disk is local backup storage, **not** off-site storage; no rclone remote is configured and no off-site protection is claimed. See `docs/PRODUCTION_READINESS_PHASE6_1.md` §17.
