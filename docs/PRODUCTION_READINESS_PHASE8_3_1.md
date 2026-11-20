# Production Readiness — Phase 8.3.1

**Project:** Ultrasound Clinic Management System — Clinc-V1.1
**Document type:** Server storage discovery and backup repository alignment
**Branch / HEAD:** `feature/clinic-quick-actions` / `0d79b7d`
**Date:** 2026-11-20
**Final status:** **COMPLETED for repository scope**
**Deployment decision:** **NO-GO — unchanged.** No production operation was authorized or performed beyond read-only SSH inspection executed by the server owner.

---

## 1. Actual server storage discovery evidence

Read-only discovery was authorized for this phase. Direct SSH authentication from the coding agent remained unavailable (`Permission denied (publickey,password)` for all attempted users; the `phase6_deploy` key present locally was not accepted). Per owner decision, the owner executed the supplied **read-only** discovery scripts on the server and pasted the output. All findings below are that output, not repository assumptions.

Evidence was captured in three passes:

| Pass | Content | Delimiter range |
|---|---|---|
| 1 | Host/OS, `lsblk`, `findmnt`, `blkid`, `fstab`, `df`, initial directory listing, utilities, preflight helper, users, config metadata, repo paths, Docker | `00 IDENTITY` → `13 DOCKER ROOT` |
| 2 | `sudo` directory tree, ownership, writability probes, full preflight logic, Docker as root, host repo discovery, full user/group list, key-material metadata, scheduler state | `A DIRECTORY TREE` → `H KNOWN HOST STATE` |
| 3 | Full preflight script, recipient-file metadata/format, existing test-set contents, all files on the disk, logs, exact mount options | `I FULL PREFLIGHT SCRIPT` → `N DISK MOUNT OPTIONS` |

Host identity from pass 1:

```
Fri Nov 20 07:24:44 PM UTC 2026
clincserver
clinc_server
uid=1000(clinc_server) gid=1000(clinc_server)
groups=1000(clinc_server),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),100(users),101(lxd)
PRETTY_NAME="Ubuntu 26.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="26.04"
VERSION="26.04.1 LTS (Resolute Raccoon)"
```

> The host runs **Ubuntu 26.04.1 LTS**, not the Ubuntu 24.04 assumed in earlier phase documentation.

### 1.1 Block devices (`lsblk`)

```
NAME        MODEL    SIZE TYPE FSTYPE     FSVER   LABEL          UUID                                   MOUNTPOINTS
sda         ST3500 465.8G disk
└─sda1             465.8G part ext4       1.0     clinic-backups 0f21089c-c507-4903-96e5-daf637100d53   /mnt/clinic-backups
sdb         Samsun 465.8G disk
├─sdb1                 1G part vfat       FAT32                  7397-F1EC                              /boot/efi
├─sdb2                 2G part ext4       1.0                    00e87bf4-944c-44df-a683-5427bfe8eaa1   /boot
└─sdb3             462.7G part LVM2_membe LVM2 00                W1qO2K-9dPU-WjC3-Dm3x-mOFm-gGWC-blCxiE
  └─ubuntu--vg-ubuntu--lv
                     200G lvm  ext4       1.0                    22a8d78b-db04-44d2-aa1a-f11b07934c3a   /
```

The pass-3 `sudo lsblk` gave the full model: **`ST3500312CS`**, 465.8 G. The OS root is on the separate `sdb` LVM volume; the backup disk is `sda1` only.

### 1.2 Mount and capacity

```
findmnt --target /mnt/clinic-backups
TARGET              SOURCE    FSTYPE OPTIONS
/mnt/clinic-backups /dev/sda1 ext4   rw,relatime

findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,LABEL -M /mnt/clinic-backups
/mnt/clinic-backups /dev/sda1 ext4 rw,relatime 0f21089c-c507-4903-96e5-daf637100d53 clinic-backups
mountpoint -q: TRUE
```

```
df -hT /mnt/clinic-backups
Filesystem     Type  Size  Used Avail Use% Mounted on
/dev/sda1      ext4  458G  2.1M  435G   1% /mnt/clinic-backups

df -i /mnt/clinic-backups
Filesystem       Inodes IUsed    IFree IUse% Mounted on
/dev/sda1      30531584    24 30531560    1% /mnt/clinic-backups
```

The disk is essentially empty (2.1 MB used, 435 GB available).

---

## 2. Actual filesystem UUID and mount verification

All three independent sources agree:

| Source | Verified value |
|---|---|
| `lsblk` | `sda1`, ext4, label `clinic-backups`, UUID `0f21089c-c507-4903-96e5-daf637100d53` |
| `findmnt -M /mnt/clinic-backups` | `/dev/sda1`, ext4, `rw,relatime`, UUID `0f21089c-…`, label `clinic-backups` |
| `blkid /dev/sda1` | `LABEL="clinic-backups" UUID="0f21089c-c507-4903-96e5-daf637100d53" BLOCK_SIZE="4096" TYPE="ext4" PARTLABEL="primary" PARTUUID="0cf8f027-6cb0-40d8-aaf3-baa34eb61417"` |
| `blkid -U 0f21089c-…` | `/dev/sda1` |
| `/etc/fstab` line 15 | `UUID=0f21089c-c507-4903-96e5-daf637100d53 /mnt/clinic-backups ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2` |

`/etc/fstab` and `/etc/fstab.before-clinic-backups` are both `root:root 0644`. The historical observations supplied in Phase 8.0 are therefore **confirmed as current host state** for the device, filesystem, label, UUID, mount point and persistent fstab entry. No disk, partition, filesystem, mount or fstab change was made.

---

## 3. Actual directory tree, ownership and permissions

### 3.1 Verified tree (all directories `drwx------ root:root`)

```
/mnt/clinic-backups                                   0700 root:root
├── daily                                             0700 root:root
│   ├── clinic-daily-20261120T153524Z-clinic-backup-test   0700 root:root
│   │   ├── SHA256SUMS                                 0600 root:root (84 B)
│   │   ├── backup.tar.gz.age                          0600 root:root (559 B)
│   │   └── MANIFEST.txt                               0600 root:root (171 B)
│   └── .staging                                       0700 root:root (empty)
├── logs                                              0700 root:root (empty)
├── lost+found                                        0700 root:root (ext4 standard)
├── manifests                                         0700 root:root (EMPTY)
├── monthly                                           0700 root:root (empty)
├── quarantine                                        0700 root:root (empty)
├── wal-archive                                       0700 root:root (empty)
└── weekly                                            0700 root:root (empty)
```

`find /mnt/clinic-backups -type f` returned exactly the three files inside the single test set. No other backup artifacts exist on the disk.

### 3.2 Differences from the historically reported structure

| Historical report | Verified now | Difference |
|---|---|---|
| `daily/ weekly/ monthly/ wal-archive/ manifests/ quarantine/ logs/` | All seven present | **Confirmed** |
| — | `lost+found/` | **Extra** — normal ext4 lost+found directory |
| — | `daily/.staging/` | **Extra** — empty staging directory from host helper |
| — | `daily/clinic-daily-20261120T153524Z-clinic-backup-test/` | **Extra** — synthetic test set created 2026-11-20 15:35 |
| Implied manifests under `manifests/` | `manifests/` is empty; the only observed `MANIFEST.txt` lives **inside the set directory** | **Material difference** — manifest location corrected in implementation |
| — | Flat per-set files named `SHA256SUMS`, `MANIFEST.txt`, `backup.tar.gz.age` | **Material difference** — host helper uses per-set directories, not the repository's flat `MANIFEST-<STAMP>.txt` convention |

### 3.3 Writability (read-only `test -w` probes)

```
root writable: YES
clinc_server writable: NO
backup user writable: NO
```

No file was created by these probes. The preflight helper itself writes and removes a temporary file at `$MOUNT/logs/.preflight.XXXXXX` as root; no leftover file was found in `logs/`.

### 3.4 Utilities (presence and version)

| Utility | Result |
|---|---|
| `age` | `/usr/bin/age`, version **1.2.1** |
| `docker` | `/usr/bin/docker`, **29.1.3**, build `29.1.3-0ubuntu4.1` |
| `docker compose` | **2.40.3+ds1-0ubuntu1** |
| `mountpoint` | `/usr/bin/mountpoint`, util-linux **2.41.3** |
| `rclone` | **NOT FOUND** |
| `sha256sum`, `shasum`, `tar`, `curl`, `jq`, `findmnt`, `lsblk`, `blkid`, `stat`, `sudo`, `systemctl` | Present |
| `pg_dump`, `psql` | Not on host (expected: run inside the `db` container) |

Docker as root reported `root=/var/lib/docker driver=overlayfs server=29.1.3`; `sudo docker ps` listed no running containers.

### 3.5 Host preflight helper

`/usr/local/sbin/clinic-backup-preflight` exists: `-rwx------ 1 root:root 1318 Nov 20 15:32`, SHA-256
`c6251bdf803fcee0b9003b74451b95dcf03cf9108cb2fd5be35958205b08c20f`. Its verified logic:

1. `mountpoint -q /mnt/clinic-backups`
2. `findmnt -n -o UUID -M "$MOUNT"` equals `0f21089c-c507-4903-96e5-daf637100d53`
3. `findmnt -n -o FSTYPE -M "$MOUNT"` equals `ext4`
4. Requires directories `daily weekly monthly wal-archive manifests quarantine logs`
5. Requires recipient file `/etc/clinic-backup/recipient.txt` and validates `^age1[a-z0-9]+$`
6. Writes and removes a `mktemp` probe under `$MOUNT/logs/` to prove writability
7. Prints `BACKUP PREFLIGHT PASSED` plus UUID/filesystem (no secret values)

The repository implementation now reproduces checks 1–6 (recipient validation is performed on `BACKUP_AGE_RECIPIENT` supplied from that file by the operator).

### 3.6 Encryption material (values never printed)

```
-rw------- 600 root:root 63 /etc/clinic-backup/recipient.txt
format: age1... OK (value redacted; length=62)
drwx------ 700 root:root /etc/clinic-backup
```

No private key, identity, token, password or `.env` value was read or printed. Directories checked and reported **missing**: `/root/.age`, `/root/.config/sops/age`, `/home/clinc_server/.age`, `/home/clinc_server/.config/sops/age`, `/etc/clinic`, `/etc/clinic/age`. Note the actual recipient path is **`/etc/clinic-backup/recipient.txt`**, not the `/etc/clinic/...` paths used in older templates.

---

## 4. Actual backup user/group findings

| Finding | Verified evidence |
|---|---|
| Non-system accounts | `clinc_server:1000:1000:/home/clinc_server:/bin/bash` — the only UID ≥ 1000 account |
| `clinc_server` group membership | `clinc_server`, `adm`, `cdrom`, `sudo`, `dip`, `plugdev`, `users`, `lxd` |
| `deploy` | **does not exist** |
| `clinicdeploy` | **does not exist** |
| `postgres` (host user) | **does not exist** |
| System `backup` user | `backup:34:34:/var/backups:/usr/sbin/nologin`; group `backup:34:`; cannot write to the mount |
| Groups | `sudo:x:27:clinc_server`, `docker:x:107:` (no members listed), `backup:x:34:` |
| Docker API | `clinc_server` got `permission denied` on `/var/run/docker.sock`; root succeeded |

Documentation mismatch resolution:

- `deploy:clinicdeploy` — historical Phase 6.1 container test model; **not present on this host**.
- `deploy:deploy` — used in `deploy/monitor.env.example`, `clinic-monitor.service` and `clinic-heartbeat-check.service`; **not present on this host**.
- `root:root 0700` — **verified current state** for the mount root and every backup directory, with root-only write.

**Workable model today (no host changes made):** backup production and backup monitoring must run as **root**, because only root can write the backup directories, traverse them, and read the `0600 root:root` recipient file. The owner's `clinc_server` account can reach root via `sudo`.

**Least-privilege recommendation (NOT implemented; requires owner-approved host changes):** create a dedicated `clinicbackup` service account owning the seven backup directories (`0700`) and a `0600` recipient file; run the producer as that account. Give a separate read-only `clinicmonitor` identity traversal/read access (or have it consume a root-produced status file) so monitoring never needs root. Keep the age private key on the separate USB escrow drive. No user, group, ownership or permission change was performed in this phase.

---

## 5. Repository files modified and reasons

| File | Change and reason |
|---|---|
| `scripts/backup-common.sh` **(new)** | Single source of truth for the verified mount root, UUID, filesystem, tier names, required directory list, set-path helpers, fail-closed `backup_check_storage()` and a defined `backup_die()` fatal helper. Eliminates conflicting path defaults; a final review caught that `backup_die()` was referenced by five call sites but undefined, which is now corrected so every error path reports a precise reason. |
| `scripts/backup.sh` | Rewritten output convention to `<root>/<tier>/clinic-<tier>-<STAMP>[-label]/`; sources shared validator; validates **before** creating any directory; mandatory age encryption (no plaintext path); `MANIFEST.txt`/`SHA256SUMS` inside the set; manifest published last; removes only the set directory created by the failed run; logs to `<root>/logs/`. |
| `scripts/backup-verify.sh` | Rewritten for per-set directory discovery across daily/weekly/monthly; validates mount/UUID/filesystem/dirs/writability; checks encryption, checksums, manifest consistency, missing/orphan artifacts, age and permissions; strictly read-only. |
| `scripts/p7-check-backup.sh` | Replaced directory-existence fallback with real mount+UUID+filesystem validation; discovers `MANIFEST.txt` in tier set directories; reports actual/expected UUID and filesystem in JSON; returns `critical` (exit 3) for absent/invalid mount; removed the `P7_MOUNT_PRESENT` test override. |
| `docker-compose.monitoring.yml` | Replaced `P7_BACKUP_DIR=/mnt/clinic-backups/backups` with `P7_BACKUP_ROOT`, `P7_BACKUP_UUID`, `P7_BACKUP_FSTYPE`; added read-only `/mnt/clinic-backups` bind mount so a containerised monitor can see the disk. Overlay remains default-off. |
| `deploy/monitor.env.example` | Corrected owner guidance to verified host state; added backup root/UUID/filesystem variables. |
| `deploy/clinic-monitor.service` | `deploy:deploy` → `root:root` with explanation: the disk is `root:root 0700` and no `deploy` account exists. |
| `deploy/clinic-heartbeat-check.service` | `deploy:deploy` → `clinc_server:clinc_server` (real account; this check does not read the backup disk). |
| `docs/backup-restore.md` | Documented the verified per-set layout, fail-closed variables, encryption requirement, verifier behavior and the corrected account model. |
| `docs/operations.md` | Aligned backup invocation, paths, verification text and host permission facts. |
| `docs/monitoring-runbook.md` | Documented new monitor variables, real-mount validation, manifest location, JSON fields and removal of `P7_MOUNT_PRESENT`. |
| `scripts/p831-backup-isolated-test.sh` **(new)** | 16 isolated synthetic tests with temp directories and stubbed `mountpoint`/`findmnt`; no production paths, Docker or real data. |
| `docs/PRODUCTION_READINESS_PHASE8_3_1.md` **(new)** | This report. |

No other files were touched. Pre-existing modifications and untracked files outside this list were left exactly as found.

---

## 6. Final backup directory convention

One destination only:

```
BACKUP_ROOT = /mnt/clinic-backups          # approved ext4 mount, UUID 0f21089c-…
│
├── daily/clinic-daily-<STAMP>[-<label>]/    # BACKUP_TIER=daily (default)
├── weekly/clinic-weekly-<STAMP>[-<label>]/  # BACKUP_TIER=weekly
├── monthly/clinic-monthly-<STAMP>[-<label>]/# BACKUP_TIER=monthly
│   ├── db-<STAMP>.dump.age
│   ├── storage-<STAMP>.tar.gz.age
│   ├── evolution-<STAMP>.tar.gz.age          (optional)
│   ├── <volume>-<STAMP>.tar.gz.age           (optional Caddy)
│   ├── SHA256SUMS
│   └── MANIFEST.txt                          (published last)
│
├── manifests/     # present on host; reserved, deliberately NOT used by this engine
├── quarantine/    # operator-controlled; no script writes, deletes or moves here
├── logs/          # backup-<tier>.log; host preflight .preflight.XXXXXX probe
├── wal-archive/   # reserved for a separately approved WAL implementation
└── lost+found/    # ext4 standard; untouched
```

Decision rationale: the only artifact actually observed on the disk is a **per-set directory** under `daily/` containing `MANIFEST.txt`, `SHA256SUMS` and a `.age` artifact, while the top-level `manifests/` directory is empty. The repository has therefore been aligned to the observed per-set convention rather than the previous flat `MANIFEST-<STAMP>.txt` model. The three repository-local `/mnt/clinic-backups/backups` and `backups/` defaults have been removed from producer, verifier and monitor.

Tier selection is explicit via `BACKUP_TIER`; it controls placement only. Manifests and checksums travel with their set so a set is self-describing. WAL archiving and automatic retention deletion are **not** implemented; `wal-archive/` is reserved and no PITR readiness is claimed.

---

## 7. Encryption and fail-closed behavior

- `BACKUP_AGE_RECIPIENT` is mandatory. Missing/empty value → immediate failure.
- `BACKUP_REQUIRE_ENCRYPTION` defaults to `1`; setting it to `0` is rejected rather than honoured.
- `age` must be installed and the recipient must match `age1…`; otherwise the run fails.
- Every artifact is encrypted and the plaintext is removed before checksums/manifest are written. The manifest records `encryption=age` and `backup_format=3`; the verifier rejects any non-`age` set.
- No private key, identity or recipient *value* is printed or stored in the repository. The public recipient remains external at `/etc/clinic-backup/recipient.txt`; it was not changed, rotated or regenerated.
- Storage validation runs **before** any directory creation and refuses to proceed unless: `mountpoint -q` succeeds; `findmnt` UUID equals `0f21089c-…`; `findmnt` filesystem equals `ext4`; all seven required directories exist; the destination canonicalizes inside the mount; and the destination is writable.
- There is no fallback to `/` or to a repository-local path. A missing/invalid mount is a hard error in the producer, the verifier and the monitor.

---

## 8. Verification and monitoring changes

**`backup-verify.sh`** now:
- discovers sets across `daily/`, `weekly/`, `monthly/`;
- validates the mount and its directory/permission assumptions;
- checks required manifest fields, `set_directory`/`backup_tier`/`created_utc` consistency and `backup_format=3`;
- verifies every declared artifact exists, is `.age`-encrypted, non-empty, size-correct and SHA-256-correct;
- runs `sha256sum -c SHA256SUMS` and cross-checks that the checksum file lists exactly the declared artifacts;
- detects missing manifests, missing artifacts, undeclared/orphan files, flat-layout strays, incomplete sets and stale sets (`BACKUP_MAX_AGE_HOURS`);
- warns on unsafe directory (0700) or file (0600) modes;
- never writes, deletes, quarantines, decrypts or contacts the database. `BACKUP_VERIFY_SKIP_MOUNT_CHECK=1` exists solely for isolated tests.

**`p7-check-backup.sh`** now:
- calls the same `backup_check_storage()` validator; an existing directory with no mount is **not** accepted;
- reports `actualUuid`, `actualFstype`, expected values and a precise `mountCheck` reason in its JSON line;
- finds the newest `MANIFEST.txt` inside `clinic-<tier>-<STAMP>` directories and uses its declared `created_utc`;
- invokes the verifier with the same root and escalates verification failure to `high`;
- returns `critical`/exit 3 on absent mount, wrong UUID, wrong filesystem or no complete manifest;
- emits only a local JSONL status line through the existing P7 sink — **no monitoring service, timer, Telegram/heartbeat alert or external delivery was enabled**.

---

## 9. Synthetic tests performed and results

Harness: `scripts/p831-backup-isolated-test.sh` (temporary directories, synthetic payloads, stubbed `mountpoint`/`findmnt`, no Docker, no real backup paths). Final run: **16 passed, 0 failed, 16 total** (`p831-backup: PASS 16/16`).

| # | Test | Result |
|---|---|---|
| 1 | Correct mount UUID and ext4 accepted | PASS |
| 2 | Missing mount rejected (mount-point directory still exists) | PASS |
| 3 | Wrong UUID rejected | PASS |
| 4 | Wrong filesystem type rejected | PASS |
| 5 | Destination resolving outside approved mount rejected | PASS |
| 6 | Missing `BACKUP_AGE_RECIPIENT` rejected by producer with a precise, non-undefined error | PASS |
| 7 | `BACKUP_REQUIRE_ENCRYPTION=0` rejected by producer with a precise, non-undefined error | PASS |
| 8 | Valid synthetic encrypted set passes verification | PASS |
| 9 | Corrupted checksum rejected | PASS |
| 10 | Missing manifest artifact detected | PASS |
| 11 | Orphan artifact detected | PASS |
| 12 | Daily, weekly and monthly set discovery (3 sets reported) | PASS |
| 13 | Monitor detects absent mount despite existing directory (critical, exit 3) | PASS |
| 14 | Monitor detects invalid UUID (critical, exit 3) | PASS |
| 15 | No existing backup artifact deleted or modified (before/after SHA-256 tree identical) | PASS |
| 16 | Fail-closed storage validator reports a precise UUID-mismatch reason (no undefined-command error) | PASS |

Additional checks: `bash -n` syntax validation passed for all five new/modified shell scripts. The on-host preflight helper and its recipient file were inspected but **not executed or modified**.

---

## 10. Tests not performed

- No real production backup, no restore and no restore drill.
- No real `age` decryption round-trip locally (`age` is not installed on the audit host); test 8 uses synthetic `.age`-named encrypted-format artifacts, consistent with the verifier's design, which never decrypts.
- No PostgreSQL WAL archiving or PITR test; no `archive_command` change.
- No schedule, cron, systemd service/timer installation or activation; no monitoring service enabled.
- No real Telegram/heartbeat/email alert delivery.
- No Docker build/pull/run/restart; no production container, volume, network or Compose deployment change.
- No host user/group/ownership/permission change; no fstab, disk, partition or filesystem change.
- No key generation, rotation, replacement or escrow validation; no private-key or identity access.
- No production `.env` read; no token/password/secret value printed.
- No patient-data access. Only backup artifact filenames, sizes, modes and ownership were inspected.
- No deployment of these repository changes to the Ubuntu host (`/opt/clinic` does not exist there).
- No backup retention/deletion operation; the legacy dump and the host's synthetic test set were left untouched.

---

## 11. Git preservation evidence

Repository state was captured before and after the phase. No Git command that changes history or the index was used: no `add`, `commit`, `push`, `tag`, `reset`, `clean`, `checkout`, `restore`, `stash`, `rebase` or history rewrite.

| Artifact | SHA-256 before and after | Status |
|---|---|---|
| `backup.patch` | `4D7440E2813B7A51BE3B3439439071DFCD638EBDDB7F02C0E4893FB1E7690769` | Byte-identical, unmodified, preserved exactly |
| `backups/db-20261113T134414Z.dump` | `70A4B4D0366AF79C5FF5C273A5927F6B89F2D826A5AAD0D2351067F472574BDF` | Byte-identical, not moved or deleted |

All pre-existing modified files (e.g. `backend/Dockerfile`, `backend/src/lib/logger.ts`, `docs/PRODUCTION_READINESS_BASELINE.md`, `scripts/p7-common.sh`, `docker-compose.monitoring.yml`) and all pre-existing untracked files remain present with their prior status. This phase added only the three new files listed in §5 and made the narrowly scoped edits listed there. Nothing was staged or committed.

---

## 12. Remaining blockers

| # | Blocker / owner action | Impact |
|---|---|---|
| 1 | **No application repository or Compose file on the host** (`/opt/clinic` missing; no `docker-compose.yml` found; no containers running) | Corrected scripts cannot be deployed or executed against the real stack. |
| 2 | Backup disk and all directories are `root:root 0700`, root-only write; no `deploy`/`clinicdeploy` account | Producer and monitor must run as root. No least-privilege service account exists; owner approval needed for one. |
| 3 | No real application-aware encrypted backup has been produced; no restore drill | Recovery remains unproven despite correct storage and configuration. |
| 4 | Recipient file is valid, but matching private-key escrow was not verified (value never accessed) | Encryption recoverability unverified. |
| 5 | Host is Ubuntu 26.04.1; earlier phase validation used Ubuntu 24.04 containers | Real-host compatibility of the full stack still needs deployment validation. |
| 6 | `rclone` absent and no off-site destination | Local-only backup; no disaster recovery off-host. Expected, but must be stated. |
| 7 | WAL archiving/PITR disabled; `wal-archive/` empty | Production RPO remains unbounded. No PITR readiness is claimed. |
| 8 | No scheduler/timer installed; `/etc/clinic/monitor.env` and `/etc/clinic/backup.env` absent (actual recipient path is `/etc/clinic-backup/recipient.txt`) | No automated backup or monitoring yet. |
| 9 | Host has a leftover synthetic test set and `daily/.staging/`; legacy dump in the repo remains an unverified orphan | Owner decision required; this phase did not delete, move or quarantine anything. |
| 10 | Docker socket access denied for `clinc_server`; Compose overlay needs the new bind mount and root service account | Containerised monitoring is not workable as shipped; host-systemd is the workable path and is still not installed. |
| 11 | Direct agent SSH remains unavailable | Future host revalidation depends on owner-executed commands or approved credentials. |

**Final decision:** repository configuration is now aligned to verified host evidence and locally proven by 16/16 isolated tests, but **production readiness is NOT achieved**. Deployment, real backup/restore, account changes, scheduling, WAL/PITR and real alerting remain **NO-GO** pending the owner actions above.
