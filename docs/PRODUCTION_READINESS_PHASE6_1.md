# Production Readiness — Phase 6.1: Backup/DR Remediation Validation (2026-11-18)

> **Phase 7.2 correction (2026-11-20):** the current approved backup destination is a dedicated **500 GB internal SATA HDD** at `/mnt/clinic-backups`, used for **local backup storage only**. A separate USB flash drive is reserved solely for age private-key escrow. No off-site provider is configured, and no Ubuntu deployment or production rollout has been verified. Section 17's "external USB HDD" wording remains historical evidence and is superseded by this correction; see `docs/PRODUCTION_READINESS_PHASE7_2.md` §7.

## 1. Executive summary

**Overall status: COMPLETE FOR REVIEW — production operational validation: `NOT PERFORMED`. Stop gate is active.**

Phase 6.1 closed the remaining Phase 6 validation gaps without touching production. It:

- Fixed H6 in the repository by removing the hardcoded Evolution API-key fallback from `docker-compose.yml` and requiring `EVOLUTION_API_KEY` for both the backend and Evolution service.
- Proved Compose fails closed when the variable is missing and renders a synthetic key correctly.
- Validated Evolution/Caddy backup and restore markers in a disposable full-recovery drill, while explicitly **not** claiming live WhatsApp session recovery.
- Proved PostgreSQL point-in-time recovery works in a disposable WAL-archiving stack, by both restore point and target time.
- Validated the intended Ubuntu ownership/permission model in an Ubuntu 24.04 container.
- Validated `age` and `rclone` success paths both standalone and through the real `scripts/backup.sh`, using disposable synthetic data and containerized tools.
- Validated legacy dump-only and dump+storage compatibility paths.
- Re-ran the full isolated recovery drill and measured **386 seconds** RTO on a tiny synthetic dataset.

Production was not deployed, restarted intentionally, queried, backed up, or reconfigured. Production credentials were not rotated. No Phase 7 work was started. All changes remain uncommitted and limited to the documentation updates plus the one H6 Compose fix.

### Status legend

- `FIXED` — repository defect removed and verified in the applicable isolated test.
- `PARTIALLY FIXED` — repository/isolated evidence exists, but production deployment/configuration or operational validation remains.
- `OPEN` — no production remedy applied or evidence insufficient for production reliance.
- `ACCEPTED RISK` — explicitly accepted with limitations; no production action in this phase.

---

## 2. Evidence classes

The following separation is mandatory in this report:

| Evidence class | Meaning | Phase 6.1 result |
|---|---|---|
| **Code implementation** | Repository files changed | H6 Compose fix only; documentation additions/updates |
| **Automated test evidence** | Repeatable shell/Compose checks with captured exit codes and outputs | Passed for H6 fail-closed, PITR, `age`, `rclone`, permissions, legacy compatibility, encrypted/off-site `backup.sh` |
| **Isolated runtime validation** | Real containers and synthetic data under unique `p61*` projects | Passed; all resources disposable |
| **Production operational validation** | Real clinic host, real volumes, real credentials, real schedule/monitoring | **`NOT PERFORMED`** |

---

## 3. Scope and safety

### 3.1 In scope

- H6 code disposition and secret-history evidence.
- Evolution and Caddy persistence/recovery evidence.
- PostgreSQL PITR feasibility in an isolated stack.
- Ubuntu file/directory permission model.
- `age` and `rclone` success paths, including real `backup.sh` integration.
- Legacy backup compatibility.
- Full isolated restore drill and measured RTO.
- Documentation updates and review gate.

### 3.2 Constraints honored

| Constraint | How it was honored |
|---|---|
| No production deployment | No production Compose/service/config change was applied. |
| No database access against production | All SQL was run in `p61dr`, `p61fresh`, or `p61-pitr-*` containers. |
| No container restart/stop/recreation in production | Only `p61*` named containers were stopped/removed/recreated. |
| No production volume inspection exposing data | No production volume was mounted or read in Phase 6.1. |
| No credential rotation | Synthetic keys only; production `EVOLUTION_API_KEY` unchanged. |
| No WhatsApp/session operation | No pairing, QR, disconnect, or send was attempted. The recovered API instance list was read only. |
| No scheduling activation | No cron/systemd/Task Scheduler entry was created. |
| No external uploads | `rclone` used a local backend inside an isolated container. |
| No backup deletion or retention cleanup | Only disposable `p61*` artifacts were removed at cleanup. |
| Disposable restore targets only | `p61_legacy_drill`, `p61_legacy_dbonly_drill`, `p61fresh` project; all end in `_drill`/`fresh` and were verified before use. |
| No `prisma migrate reset` / `db push` | Only `prisma migrate deploy` ran through the isolated stack. |
| Repo protection | No `reset`, `clean`, discard, commit, or push. Pre-existing modifications were preserved. |
| Protected content untouched | No `report-blocks/`, clinical templates, finalized reports, or historical report data were modified. |

### 3.3 Isolation ledger

| Resource | Purpose |
|---|---|
| Compose project `p61dr` | Synthetic source stack; volumes `p61_db_data`, `p61_storage`, `p61_evolution`, `p61_caddy_data`, `p61_caddy_config`; ports `65462`/`65480`/`65483` |
| Compose project `p61fresh` | Fresh recovery stack; volumes `p61fresh_*`; ports `65472`/`65490`/`65493` |
| `p61-pitr-*` containers and `p61_pitr_*` volumes | Disposable WAL archive/base backup/PITR test |
| `p61-perm-test` | Ubuntu 24.04 permission test |
| `p61-tools:local` image | Local image containing `age` and `rclone` for isolated wrappers |
| `%TEMP%\opencode\p61` | Synthetic workspace, logs, and test harness |

---

## 4. Repository changes

### 4.1 H6 code fix

File: `docker-compose.yml`

Before Phase 6.1, the backend service used a non-empty fallback for `EVOLUTION_API_KEY`, while the Evolution service already required the variable. Phase 6.1 changed the backend line to the same fail-closed form:

```yaml
EVOLUTION_API_KEY: ${EVOLUTION_API_KEY:?set EVOLUTION_API_KEY in .env}
```

The Evolution service line remains:

```yaml
AUTHENTICATION_API_KEY: ${EVOLUTION_API_KEY:?set EVOLUTION_API_KEY in .env}
```

The hardcoded fallback value is intentionally not reproduced here.

### 4.2 Other repository files

- New: `docs/PRODUCTION_READINESS_PHASE6_1.md` (this report).
- Updated: `docs/PRODUCTION_READINESS_PHASE6.md` (Phase 6.1 addendum and stale H4/H5/H6 references).
- Updated: `docs/PRODUCTION_READINESS_BASELINE.md` (Phase 6.1 status and blockers).
- Updated: `docs/backup-restore.md` (legacy path and Phase 6.1 cross-reference).
- Updated: `docs/operations.md` (legacy cross-reference and Phase 6.1 notes).

No application code, schema, scripts, `.env`, or production configuration was changed in Phase 6.1.

---

## 5. H6 validation and disposition

### 5.1 Automated Compose tests

| Test | Result |
|---|---|
| Synthetic env file without `EVOLUTION_API_KEY` | `docker compose config` exit `1`; errors named both `services.backend.environment.EVOLUTION_API_KEY` and `services.evolution.environment.AUTHENTICATION_API_KEY` as missing. |
| Synthetic env file with a fake `sk_live_...` value | `docker compose config` exit `0`; rendered `sk_live_*` pattern count `0`. |
| Isolated `p61dr` stack startup | Backend and Evolution both healthy with the synthetic key. |

### 5.2 Secret-history evidence without values

- `.env` is untracked and was not read for values.
- `.env.example` contains a placeholder pattern, verified as non-production.
- A scan of tracked history without printing values found two 2026-11-03 commits (`df35a99`, `ebcd2a4`) that changed a different 40-character `sk_live_`-shaped token in `.env.example`.
- The historical token's SHA-256 differs from the Phase 6 fallback. Values were not reproduced in logs or documentation.

### 5.3 Disposition

| Finding | Status | Notes |
|---|---|---|
| H6 hardcoded Evolution key fallback | **`PARTIALLY FIXED`** | Code path is `FIXED` and fail-closed is proven; production credential rotation and deployment verification remain `NOT PERFORMED`. |
| Production key rotation | **`OPEN`** | Explicitly out of scope. No credential was rotated. |

---

## 6. Evolution and Caddy recovery evidence

### 6.1 Full drill observations

The corrected full recovery drill rebuilt the `p61fresh` stack from the synthetic backup stamp `20261118T175653Z`.

| Check | Evidence |
|---|---|
| Report marker | `REPORT_MARKER=P61-RECOVERY-MARKER-7f3a91` |
| File row | `FILE_ROW=clinical/2026/11/p61-synthetic.txt|33` |
| Migrations | `MIGRATIONS=7`; `Database schema is up to date!` |
| Evolution schema | `EVOLUTION_TABLES=37` |
| Evolution DB metadata | `INSTANCE=p61_clinic|dccd308e-f4bb-406d-baba-e79600e57bc2|connecting` |
| Evolution volume marker | `{"marker":"P61-EVOLUTION-PERSISTENCE-MARKER","synthetic":true}` |
| Caddy markers | Both `p61_caddy_data` and `p61_caddy_config` markers restored |
| Caddy HTTP | `caddy_http=p61-synthetic-caddy` |
| Web health | `web_healthz=ok` |
| Backend health | `status=ok`, `database=reachable` |
| Healthy services | 4 healthy + migrate exited 0 |

### 6.2 Evolution limitation — important

The recovered Evolution API returned `STATUS=200 []` from `/instance/fetchInstances`, even though the Evolution database row and synthetic volume marker were restored. The synthetic instance was never paired and never had valid Baileys auth state. Therefore:

- **Proven:** Evolution service startup, schema/DB metadata restore, and session-volume archive restore.
- **Not proven:** recovery of a live paired WhatsApp session or Baileys auth state.
- **Required later:** a clinic-owner-supervised re-pair/send test on the real target host.

### 6.3 Disposition

| Area | Status |
|---|---|
| Evolution DB/volume/service restore mechanics | `PARTIALLY FIXED` |
| Live WhatsApp session recovery | `OPEN` / not proven |
| Caddy TLS archive restore mechanics | `PARTIALLY FIXED` |
| Production Evolution/Caddy restore validation | **`NOT PERFORMED`** |

---

## 7. PITR assessment

### 7.1 Isolated test design

A disposable PostgreSQL 16 stack was configured with:

- `wal_level=replica`
- `archive_mode=on`
- `archive_command=test ! -f /archive/%f && cp %p /archive/%f`
- `archive_timeout=10s`
- `max_wal_senders=10`, `wal_keep_size=128MB`
- `pg_basebackup -D /base -Fp -X stream`
- Named restore point `p61_before_delete`
- Both `recovery_target_name` and `recovery_target_time` recoveries

Two harness defects were found and fixed before a valid run: the archive volume was root-owned (PostgreSQL UID 70 could not write), and the `-c recovery_target_*` argument was initially passed as one token. These were test-harness issues, not product findings.

### 7.2 Result

| Check | Result |
|---|---|
| Base backup | exit `0` |
| Archived WAL files | `6` |
| Mutation applied | `INSERT 1`, `DELETE 1`; final source row was `P61_AFTER_RESTORE_POINT_MARKER` |
| Restore by name | ready `True`; rows `P61_BEFORE_DELETE_MARKER` |
| Restore by time | ready `True`; rows `P61_BEFORE_DELETE_MARKER` |

Both targets correctly excluded the later insert and delete.

### 7.3 Disposition and RPO implication

| Finding | Status | Notes |
|---|---|---|
| H4 no WAL/PITR | **`PARTIALLY FIXED`** | Capability proven in isolation; production still has no WAL archive, no PITR runbook activation, and no configured destination. |
| Production PITR operational validation | **`NOT PERFORMED`** | Must be deployed, monitored, retained off-site, and restored on the target host before changing the production RPO claim. |

Current production RPO remains **unbounded / since the last manual backup**. A 10-second archive timeout in the test demonstrates technical feasibility only; it does not create a production RPO guarantee.

---

## 8. Ubuntu permissions

Test image: `ubuntu:24.04`. Synthetic users `deploy` (`3001:clinicdeploy`) and `otherapp` (`3002:clinicread`).

| Path | Expected | Observed |
|---|---|---|
| `/var/backups/clinic` | `0700 deploy:clinicdeploy` | `deploy:clinicdeploy 700` |
| `/var/backups/clinic/.stage-test` | `0700` staging | `deploy:clinicdeploy 700` |
| `/etc/clinic/keys` | `0700` | `deploy:clinicdeploy 700` |
| `/srv/clinic/restore` | `0750` | `deploy:clinicdeploy 750` |
| `db-x.dump` | `0600` | `deploy:clinicdeploy 600` |
| `backup-age-identity.txt` | `0600` | `deploy:clinicdeploy 600` |
| Other app reading backup | deny | `OTHERAPP_READ_BACKUP=DENIED` |
| Other app reading key | deny | `OTHERAPP_READ_KEY=DENIED` |
| Other app reading restore file | deny | `OTHERAPP_READ_RESTORE=DENIED` |
| Deploy reading backup | allow | `DEPLOY_READ_BACKUP=ALLOWED` |
| Other app listing backup dir | deny | `OTHERAPP_LIST_BACKUPDIR=DENIED` |

Overall permission test exit: `0`.

### Disposition

| Finding | Status |
|---|---|
| H5 on the current Windows host | **`OPEN`** — NTFS ACLs were not changed. |
| Ubuntu target permission model | **`PARTIALLY FIXED`** — documented and validated in an isolated Ubuntu container. |
| Production Ubuntu host permissions | **`NOT PERFORMED`** |

---

## 9. Encryption and off-site validation

### 9.1 Standalone `age` success/failure path

| Check | Result |
|---|---|
| Recipient extraction | `OK` |
| Encryption exit | `0` |
| Ciphertext size | `240` bytes |
| Plaintext marker occurrences in ciphertext | `0` |
| Decryption exit | `0` |
| Decrypted SHA-256 match | `YES` |
| Wrong identity rejected | `YES` |
| Corrupt artifact rejected | `YES` |
| Synthetic plaintext/key cleanup | `YES` |

### 9.2 Standalone `rclone` success/failure path

A local backend inside a disposable container was used; no external credentials or network destination.

| Check | Result |
|---|---|
| Config create | `0` |
| Upload | `0` |
| Remote check | `0`, `0 differences found` |
| Remote listing/hash | SHA-256 matched source |
| Download | `0` |
| Recovered SHA-256 match | `YES` |
| Tampered remote detected | `YES` |
| Repair check | `0` |

### 9.3 Real `scripts/backup.sh` integration

The real script ran under the isolated `p61dr` stack with containerized `age`/`rclone` wrappers:

- `BACKUP_AGE_RECIPIENT` set from a synthetic recipient; value not logged.
- `BACKUP_REQUIRE_ENCRYPTION=1`.
- `BACKUP_OFFSITE_REMOTE=p61remote:/remote` mapped to a local directory in the disposable container.
- `BACKUP_QUIESCE_SERVICES='backend web evolution caddy'`.
- Backup stamp: `20261118T185005Z`.

| Check | Result |
|---|---|
| `backup.sh` exit | `0` |
| Automatic checksum verification | `OK` for all five artifacts |
| Published set | 7 files: 5 `.age` artifacts + checksums + manifest |
| Off-site copy | 7 files |
| Local/off-site SHA-256 matches | `7/7` |
| `backup-verify.sh` with `BACKUP_VERIFY_REQUIRE_ENCRYPTION=1` | exit `0`, `0 warnings`, `0 errors` |
| Decrypt real dump artifact | exit `0` |
| Decrypted TOC | `pg_restore --list` exit `0`, `438` lines |
| Synthetic identity and decrypted plaintext removed | `YES` |

### 9.4 Disposition

| Area | Status |
|---|---|
| Tool success paths in isolation | `FIXED` |
| Real `backup.sh` encrypted/off-site integration in isolation | `FIXED` |
| Production age key escrow, off-site destination, credentials, versioning/object lock | **`OPEN`** |
| Production operational validation | **`NOT PERFORMED`** |

Overall production posture remains `PARTIALLY FIXED`: the code path works, but none of it is configured on production.

---

## 10. Legacy compatibility

Using only copies of the synthetic backup stamp `20261118T175653Z`, renamed to a legacy stamp:

| Test | Result |
|---|---|
| Dump + storage with no manifest/checksums | `backup-verify.sh` exit `1`; 3 errors (no manifest, 2 orphan artifacts) |
| Legacy dump + storage drill | exit `0`; warning `skipping pre-restore checksum verification` for both artifacts |
| Legacy dump-only drill | exit `0`; same explicit checksum warning |
| Recovered counts | 31 tables, 13 rows, 7 migrations, 1 user, 1 patient, 1 visit, 1 report, 1 file asset, 37 Evolution tables / 60 rows |
| Storage reconciliation | 1 database row, 1 file, 0 missing, 0 orphaned, 0 size mismatches |
| Synthetic `backup_format=1` manifest with real hashes/sizes | `backup-verify.sh` exit `0`; expected warnings for format, Evolution, Caddy, and plaintext |

The original repository dump `backups/db-20261113T134414Z.dump` was not copied into the test, modified, or restored from.

Status: legacy compatibility path `PARTIALLY FIXED` in isolation; production legacy artifact replacement remains `OPEN`.

---

## 11. Full recovery drill and measured RTO

### 11.1 Scenario

Fresh `p61fresh` Compose project with new volumes, archive extraction, database drop/create/restore, full stack startup, migration check, health checks, and marker verification.

### 11.2 Result

| Check | Result |
|---|---|
| Volume recreation | `p61fresh_storage`, `p61fresh_evolution`, `p61fresh_caddy_data`, `p61fresh_caddy_config` |
| Archive extraction | all four exit `0` |
| Database restore | exit `0` |
| Service health | 4 healthy; migrate exited `0` |
| Web `/healthz` | `ok` |
| Backend `/healthz` | `status=ok`, `database=reachable` |
| Migration status | `Database schema is up to date!` |
| Measured RTO | **386 seconds** |

### 11.3 Interpretation

386 seconds includes volume recreation, archive extraction, database restore, stack startup, and verification. It is a tiny, highly compressible synthetic dataset. It is **not** a production RTO. Real multi-GB JPEG/PDF storage, image pulls, DNS/TLS, secret escrow retrieval, and Evolution re-pairing are excluded or unrepresentative.

Status: `PARTIALLY FIXED` — isolated runtime validation passed; production drill remains `NOT PERFORMED`.

---

## 12. Finding disposition summary

| ID / area | Status | Code implementation | Automated evidence | Isolated runtime | Production operational |
|---|---|---|---|---|---|
| H6 hardcoded key fallback | `PARTIALLY FIXED` | `FIXED` | `PASS` | `PASS` | `NOT PERFORMED` |
| Production key rotation | `OPEN` | N/A | N/A | N/A | `NOT PERFORMED` |
| H4 WAL/PITR | `PARTIALLY FIXED` | `OPEN` | `PASS` | `PASS` | `NOT PERFORMED` |
| H5 Windows ACLs | `OPEN` | `OPEN` | N/A | N/A | `NOT PERFORMED` |
| Ubuntu permission model | `PARTIALLY FIXED` | Documented | `PASS` | `PASS` | `NOT PERFORMED` |
| Evolution DB/volume/service recovery | `PARTIALLY FIXED` | Existing repo fix | `PASS` | `PASS` with API limitation | `NOT PERFORMED` |
| Live WhatsApp session recovery | `OPEN` | N/A | N/A | Not proven | `NOT PERFORMED` |
| Caddy TLS recovery | `PARTIALLY FIXED` | Existing repo fix | `PASS` | `PASS` | `NOT PERFORMED` |
| `age` encryption | `PARTIALLY FIXED` | Existing repo hook | `PASS` | `PASS` | `NOT PERFORMED` |
| `rclone` off-site | `PARTIALLY FIXED` | Existing repo hook | `PASS` | `PASS` local backend only | `NOT PERFORMED` |
| Legacy compatibility | `PARTIALLY FIXED` | N/A | `PASS` | `PASS` | `NOT PERFORMED` |
| Full recovery drill | `PARTIALLY FIXED` | N/A | `PASS` | `PASS`, RTO 386 s | `NOT PERFORMED` |
| Schedule/monitoring | `OPEN` | N/A | N/A | N/A | `NOT PERFORMED` |
| Review/approval gate | `OPEN` | N/A | N/A | N/A | Awaiting explicit approval |

No item in this phase is marked `ACCEPTED RISK`.

---

## 13. Limitations and not-tested items

- No production data, real PHI, or production volume was used.
- No production database was queried.
- No production backup was created, verified, moved, or deleted.
- No real external off-site provider or credential was used; `rclone` used a local backend.
- No real age private key escrow was created; a synthetic key was generated and deleted.
- No live WhatsApp pairing, QR scan, or message send was attempted.
- No real host failure, ransomware, or object-lock scenario was simulated.
- No scheduler, retention job, or alerting was activated.
- No large-file/multi-GB restore timing was measured.
- PITR was proven only on a disposable PostgreSQL cluster; production WAL archiving remains off.
- The 386-second RTO is not representative of production storage volumes.

---

## 14. Production non-interference

- The production stack was never intentionally stopped, restarted, recreated, or reconfigured.
- No production credential was read for its value or rotated.
- No production volume was mounted or inspected in Phase 6.1.
- No production backup artifact was deleted or changed.
- The repository's existing backup dump remains untouched.
- Earlier in the overall session, Docker Desktop engine instability caused containers to stop; the production stack's `restart: unless-stopped` policy restored them automatically. No manual restart was performed.
- All Phase 6.1 Docker actions used unique `p61*` names, volumes, and ports.
- No commit, push, `git reset --hard`, `git clean -fd`, or discard occurred.
- Pre-existing working-tree modifications and untracked files were preserved.

### 14.1 Cleanup verification

After evidence collection, only the disposable Phase 6.1 resources were removed:

- Containers: 15 `p61*` containers (`p61dr-*`, `p61fresh-*`, `p61-pitr-*`, `p61-perm-test` where present).
- Volumes: 15 `p61_*` / `p61fresh_*` / `p61_pitr_*` volumes.
- Networks: `p61_net`, `p61fresh_net`.
- Image: `p61-tools:local`.
- Workspace: `%TEMP%\opencode\p61`, including all synthetic logs, keys, and artifacts.

Read-only verification after cleanup returned zero container, volume, network, and image matches for the `p61` filter; `Test-Path` for the temporary workspace returned `False`. Production `ultrasound-clinic-*` containers remained present: `db`, `backend`, `web`, and `evolution` were `Up (healthy)`, and `migrate` was `Exited (0)`. Pre-existing non-production resources (`evoaudit`, `clinic-qa`, `cms`, `phase5audit*`) were not touched.

---

## 15. Review gate checklist

| # | Requested item | Evidence / disposition |
|---|---|---|
| 1 | Close H6 in code | `docker-compose.yml` fallback removed; both services require the variable; §5 |
| 2 | H6 fail-closed and synthetic-key tests | Missing key exit `1`; synthetic key exit `0`, rendered `sk_live_*` count `0`; §5.1 |
| 3 | Secret-history evidence without values | Two commits identified; different token SHA; values not reproduced; rotation `OPEN`; §5.2 |
| 4 | Backup set completeness | DB, storage, Evolution, two Caddy archives verified in isolated sets; §6, §9.3 |
| 5 | Backup verifier evidence | Plaintext and encrypted sets verified; encrypted set with require-encryption exit `0`; §9.3 |
| 6 | Evolution recovery evidence | DB row, 37 tables, volume marker, service health restored; §6 |
| 7 | Evolution limitation honest | API `200 []`; live session recovery explicitly unproven; §6.2 |
| 8 | Caddy recovery evidence | Both volume markers restored; HTTP marker served; §6.1 |
| 9 | PITR assessment | Base backup + 6 WAL files; named and time recovery both exclude later mutation; §7 |
| 10 | Ubuntu permissions | 0700/0600/0750 model and cross-user denial validated; §8 |
| 11 | `age` success path | Standalone and real `backup.sh` integration passed; decrypt TOC 438 lines; §9 |
| 12 | `rclone` success path | Standalone local backend and real `backup.sh` copy/check passed; 7/7 hash matches; §9 |
| 13 | Legacy compatibility | No-manifest rejection, dump+storage and dump-only drills, format=1 manifest verification; §10 |
| 14 | Full drill and RTO | Fresh stack restore passed; measured RTO 386 s with caveats; §11 |
| 15 | Status labels, separation, stop gate | Evidence classes and status table in §2/§12; production validation `NOT PERFORMED`; §16 |

---

## 16. Approval gate and next actions

**Historical gate at review time: stop here and await explicit review/approval before any operational change.**

**Update (2026-11-18): the owner subsequently approved all ten gated actions and changed the production backup destination to a dedicated external USB HDD. Execution prerequisites and dependency order are in §17. Production operational validation remains `NOT PERFORMED` until the Ubuntu host is accessed and evidence is captured.**

The following were approval-gated and were explicitly not performed during Phase 6.1:

1. Deploy the H6 Compose fix to the production host.
2. Rotate `EVOLUTION_API_KEY` and update both backend and Evolution together.
3. Restrict Windows NTFS ACLs or complete the Ubuntu host permission setup.
4. Configure age key escrow and the approved external USB HDD backup destination (local storage, **not** off-site).
5. Schedule `backup.sh` + `backup-verify.sh` on the Ubuntu host and add failure/capacity alerting (Phase 7 overlap).
6. Enable and monitor WAL archiving/PITR in production, then re-test restore.
7. Replace the unverified 2026-11-13 dump with a complete encrypted set.
8. Run a real-host restore drill with representative storage and record production RTO.
9. Validate Evolution re-pair with the clinic owner.
10. Perform a production backup/restore only under written incident/change approval.

**Phase 7 was not started. No production deployment or operational activation occurred.**

---

## 17. Execution plan update — external USB HDD architecture (2026-11-18)

### 17.1 Approved production architecture

The owner replaced the cloud/off-site destination with a **500 GB external USB HDD permanently attached to the Ubuntu production server**.

| Item | Decision |
|---|---|
| Mount point | `/mnt/clinic-backups` |
| Mount method | UUID-based entry in `/etc/fstab`; UUID and filesystem to be read from the real disk |
| Role | **Local backup storage, not off-site storage** |
| External upload / rclone | Not configured; no off-site protection is claimed |
| Backup directory | `/mnt/clinic-backups/backups`, mode `0700`, deploy account only |
| WAL archive | `/mnt/clinic-backups/wal-archive`, mode `0700`, owned by the PostgreSQL runtime user |
| Age private key | Outside the external HDD and outside the production server; independently secured escrow |
| Schedule | Daily `02:00 Africa/Cairo` |
| Max backup age alert | `26 hours` |
| Capacity alerts | `70%`, `85%`, `95%` |
| PITR target | `5 minutes` RPO via `archive_timeout=300s`; **not claimed until an isolated restore succeeds** |
| Legacy dump | Quarantine, do not delete |

The USB HDD will hold encrypted database dumps, application storage archives, Evolution recovery data, Caddy data only if the TLS overlay is actually deployed on the host, checksums, manifests, and PostgreSQL WAL archives.

### 17.2 Fail-closed controls

- `scripts/backup.sh` now accepts `BACKUP_MOUNT_POINT` and `BACKUP_REQUIRE_MOUNT=1`. When enabled, it refuses to run unless the mount exists and `BACKUP_DIR` is underneath it.
- The scheduled wrapper performs a mount preflight and verifies the expected UUID device with `findmnt` before any backup starts.
- A wrong-directory test returned exit `1` with `BACKUP_DIR ... is not under required mount ...`.
- An unmounted test returned exit `1` with `required backup mount ... is not mounted; refusing to write backups to the internal disk`.
- The PITR `archive_command` checks `mountpoint -q /mnt/clinic-backups` before writing WAL files, so a disconnected disk causes PostgreSQL archive failures rather than silently writing to the root filesystem.
- Capacity is checked before backup and every six hours. `95%` aborts backup creation; `70%`/`85%` generate email alerts.

These checks were exercised locally with synthetic paths and a stubbed `mountpoint` command; real Ubuntu evidence is still required.

### 17.3 Retention position

Retention will be proposed only after measuring actual backup-set sizes, database growth, WAL generation rate, and free capacity on the 500 GB disk. Starting point to validate: keep at least 7 daily, 4 weekly, and 3 monthly complete sets where capacity allows. WAL files must be retained with every base backup they can restore. **No automatic deletion of backups or WAL archives will be enabled until dependency-aware retention is implemented and tested.**

### 17.4 Blocking prerequisites

| Prerequisite | Current state |
|---|---|
| SSH authentication to `clincserver` / `100.109.244.71` | `BLOCKED` — BatchMode attempt returned `Permission denied (publickey,password)`; no key/agent available |
| Disk survey (`lsblk`, `blkid`, SMART, capacity, contents, filesystem) | `NOT PERFORMED` |
| UUID-based `/etc/fstab` mount and permissions | `PENDING` survey result |
| Age private-key escrow location/method | `PENDING` owner involvement |
| Alert email address | `PENDING` owner input |
| Maintenance window and named operator | `PENDING` owner input |
| Pinned Ubuntu `age` binary | `PENDING` host access |
| Actual sizes, growth, and WAL rate | `PENDING` first measured backups |

### 17.5 Dependency order for execution

1. Establish SSH access and verify the Ubuntu production environment.
2. Survey the USB disk; record capacity, filesystem, UUID, SMART health, and contents. Do not format or repartition.
3. Create the UUID mount, backup directory, WAL directory, and restrictive permissions.
4. Generate the age keypair only after escrow is defined; store the private key outside the server and HDD.
5. Run the first real encrypted production backup to the USB HDD and verify it before any disruptive change.
6. In the maintenance window, deploy the H6 Compose fix and rotate `EVOLUTION_API_KEY` together; preserve WhatsApp session volume.
7. Install/enable the systemd schedule, email alerts, capacity checks, and read-only verification.
8. Only after mount reliability, capacity, permissions, and recovery are validated: enable WAL archiving with `archive_timeout=300s`, monitor `pg_stat_archiver`, and prove isolated PITR before claiming a 5-minute RPO.
9. Publish a complete encrypted set, quarantine the legacy dump without deleting it, then run a real-host isolated restore drill and record RTO.
10. Validate Evolution re-pair with the clinic owner, then close documentation with real evidence and explicit status changes.

### 17.6 Current execution status

No production operation has been performed under this approved plan. The local wrapper scripts, systemd units, UUID/fstab template, USB capacity checks, retention dry-run report, and PITR overlay are prepared outside the repo at `%TEMP%\opencode\phase6_exec`. Production validation remains `NOT PERFORMED`.
