# Backup and Restore

Backups contain PHI (patient names, reports, uploaded images, password hashes).
Encrypt them at rest, restrict access, and never copy them to an unapproved
machine or commit them to Git. A backup that has never been restored is not a
backup.

All commands assume the repository is at `/opt/clinic` on the Ubuntu host and
the Compose project is `ultrasound-clinic`. Run them from the repository root.
If the checkout does not preserve executable bits, run `chmod +x scripts/*.sh`
once, or invoke each script as `bash scripts/<name>.sh`.

## What a complete backup set contains

Phase 8.3.1 verified the actual host layout; Phase 9.4 extended the set format
to `backup_format=4`. One set per run is a **directory** inside its tier, named
`clinic-<tier>-<STAMP>[-<label>]`, where `<tier>` is `daily`, `weekly` or
`monthly` and `<STAMP>` is `YYYYMMDDTHHMMSSZ`:

```
/mnt/clinic-backups/
├── daily/clinic-daily-<STAMP>/       # or weekly/…, monthly/…
│   ├── db-<STAMP>.dump.age
│   ├── storage-<STAMP>.tar.gz.age
│   ├── storage-files-<STAMP>.sha256.age
│   ├── evolution-<STAMP>.tar.gz.age      (when the volume exists)
│   ├── <volume>-<STAMP>.tar.gz.age       (when TLS volumes exist)
│   ├── SHA256SUMS                        # checksums for encrypted artifacts
│   └── MANIFEST.txt                      # written last; marks a complete set
├── manifests/                        # present on host; reserved, not used by this engine
├── quarantine/                       # operator-controlled; scripts never write here
├── logs/                             # backup-<tier>.log and preflight write probe
└── wal-archive/                      # dedicated WAL archive; optional overlay only
```

| File | Contents |
|---|---|
| `db-<STAMP>.dump.age` | age-encrypted PostgreSQL custom-format dump |
| `storage-<STAMP>.tar.gz.age` | age-encrypted `uploads` volume (clinical files) |
| `storage-files-<STAMP>.sha256.age` | age-encrypted SHA-256 list for every individual uploaded file |
| `evolution-<STAMP>.tar.gz.age` | age-encrypted Evolution/WhatsApp session volume, when present |
| `<volume>-<STAMP>.tar.gz.age` | age-encrypted Caddy TLS state, when present |
| `SHA256SUMS` | SHA-256 for every encrypted artifact in the set |
| `MANIFEST.txt` | Backup ID, format/version, timestamp, tier, mount UUID, filesystem, consistency mode, quiesced services, pre-quiesce WAL LSN, database/volume names, encrypted and plaintext checksums, sizes, file count, PostgreSQL version, Git commit and encryption state |

Format 4 adds `backup_id`, `manifest_version=4`, `encryption_status=encrypted`,
`consistency_mode`, `quiesced_services`, `wal_lsn_before_quiesce`,
`database_plain_sha256`, `storage_plain_sha256`, the
`storage_files_checksums*` fields and `storage_files_count`. The verifier and
restore script also accept legacy format 3 sets, but format 3 has no per-file
checksum list and no plaintext-content verification.

`MANIFEST.txt` is written last and marks a complete set. Artifacts are built in
a hidden `.stage-<set>-<pid>` directory in the tier, **outside** the final set,
and the published set appears through a single directory `mv` only after the
plaintext hashes are recorded, artifacts are encrypted, and `SHA256SUMS` is
verified. A failed run removes only the staging directory it created; older
sets are never touched by `backup.sh`.

The database dump and the storage archive are still sequential, not a
point-in-time snapshot. The default writer list is `backend web evolution`;
the `db` service is always refused in that list. An empty list is accepted only
with the isolated-test acknowledgement `BACKUP_ALLOW_WRITER_DRIFT=1`. Format 4
records the chosen consistency mode and the WAL LSN observed before writers
were stopped as evidence, but this is **not** WAL archiving and does not reduce
RPO. A database dump without its matching storage archive is not a usable
restore.

## Automated backup

```bash
./scripts/backup.sh
```

Useful environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_ROOT` | `/mnt/clinic-backups` | The one approved mount root. Tier/support directories are derived from it; no repository-local `backups/` destination exists. |
| `BACKUP_TIER` | `daily` | Target tier: `daily`, `weekly` or `monthly`. |
| `BACKUP_LABEL` | empty | Optional suffix for the set directory name (sanitised). |
| `BACKUP_EXPECTED_UUID` | `0f21089c-c507-4903-96e5-daf637100d53` | Approved filesystem UUID, verified against the mounted disk. |
| `BACKUP_EXPECTED_FSTYPE` | `ext4` | Approved filesystem type. |
| `BACKUP_AGE_RECIPIENT` | empty | **Required.** age public recipient; every artifact is encrypted and plaintext removed. |
| `BACKUP_REQUIRE_ENCRYPTION` | `1` | Must be `1` (or unset). Setting `0` is rejected; plaintext backups are never produced. |
| `BACKUP_OFFSITE_REMOTE` | empty | Legacy rclone option only. `rclone` is not installed on the verified host; no off-site copy is claimed. |
| `BACKUP_QUIESCE_SERVICES` | `backend web evolution` | Space-separated writers to stop for the dump/tar window. Never include `db`. Restarted on success or failure. |
| `BACKUP_ALLOW_WRITER_DRIFT` | `0` | Test-only acknowledgement for an empty quiesce list. Do not use for a production source. |
| `BACKUP_MIN_FREE_MB` | `1024` | Refuse to start below this much free space in the tier directory. |
| `STORAGE_VOLUME` | `ultrasound_clinic_storage` | Uploads volume name. |
| `EVOLUTION_VOLUME` | `ultrasound_clinic_evolution_instances` | Evolution session volume name. |
| `CADDY_VOLUMES` | `ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config` | TLS volumes; missing volumes are warned about. |

`BACKUP_TEST_MODE=1` together with `BACKUP_SOURCE_MODE=local` is an
**isolated-test-only** path that exercises real `pg_dump`, `tar` and `age`
against a disposable database and directory. It refuses the production
`BACKUP_ROOT`; never set either variable on a production host.

### Encryption and internal SATA backup storage (approved production architecture)

Encryption is mandatory in the approved production architecture. Generate an
age keypair on a machine that is **not** the backup host, keep the private key
in independently secured escrow on a separate USB flash drive, and put only the
public recipient on the host. The private key must not be stored on the backup
HDD or on the production server. The USB flash drive is for age key escrow only;
it is not backup or WAL storage.

```bash
# On the trusted administrator machine, once:
age-keygen -o clinic-backup-key.txt
# Copy only the public key value into the backup host's protected environment.

# On the Ubuntu host, in /etc/clinic/backup.env (mode 0600, root:root):
BACKUP_ROOT=/mnt/clinic-backups
BACKUP_TIER=daily
BACKUP_EXPECTED_UUID=0f21089c-c507-4903-96e5-daf637100d53
BACKUP_EXPECTED_FSTYPE=ext4
# Public recipient ONLY; read from the root-only file /etc/clinic-backup/recipient.txt
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REQUIRE_ENCRYPTION=1
BACKUP_QUIESCE_SERVICES='backend web evolution'
```

The approved destination is a dedicated **500 GB internal SATA HDD**
(`/dev/sda1`, ext4, label `clinic-backups`) mounted read-write at
`/mnt/clinic-backups`. Phase 8.3.1 revalidated the UUID, `findmnt`, `blkid` and
`/etc/fstab` entry directly on the host. It is **local backup storage only**;
`rclone` is not installed and no off-site protection is claimed.

Before any directory is created, `backup.sh` calls the shared validator in
`scripts/backup-common.sh`, which refuses to proceed unless the mount is real,
its UUID and filesystem match the approved values, all seven required
directories exist, the destination resolves inside the mount, and the target is
writable. There is no fallback to the root filesystem. A missing
`BACKUP_AGE_RECIPIENT`, a disabled `BACKUP_REQUIRE_ENCRYPTION`, or a missing
`age` binary also fails closed. The base Compose stack still has WAL archiving
**disabled**. The optional `docker-compose.pitr.yml` overlay can enable it on a
dedicated mount, but the overlay is repository configuration only and has not
been applied to production. See “WAL archiving and point-in-time recovery” below.

Capacity is checked in the tier directory before every backup after validation.
Retention is available as a separate explicit script (see below), but no
schedule, timer, alert delivery or automatic deletion is enabled by this change.

### Scheduler dispatcher (repository configuration only)

`scripts/backup-scheduler.sh` is the reviewed dispatcher for the five systemd
jobs. Phase 9.8 corrected its argument contract; Phase 9.8 did **not** install,
enable or run any unit. Every job accepts only its documented flags:

```bash
./scripts/backup-scheduler.sh full --dry-run
./scripts/backup-scheduler.sh pitr-base --dry-run
./scripts/backup-scheduler.sh verify --dry-run
./scripts/backup-scheduler.sh retention --dry-run --keep-daily 7
./scripts/backup-scheduler.sh wal-prune --dry-run
```

The `pitr-base` job requires `--pghost`, `--pgport`, `--pguser` and
`--wal-archive-dir`. In the installed unit these are supplied from the protected
`/etc/clinic/backup.env` file (mode `0600`, `root:root`) using the variables
`PITR_PGHOST`, `PITR_PGPORT`, `PITR_PGUSER` and `WAL_ARCHIVE_DIR`; optional
`PITR_PGDATABASE`, `PITR_TIER` and `PITR_AGE_RECIPIENT` are also documented in
`deploy/backup.env.example`. The dispatcher never logs credentials. A missing
mandatory value is a hard failure, not a usage fallback.

Safety behaviour that must be re-verified on any target-shaped host:

- `wal-prune` validates the mount, UUID and filesystem before creating any log
  file or evaluating WAL candidates. An unmounted or mismatched disk fails
  closed and deletes nothing.
- `wal-prune` refuses to act unless a validated `pitr_ready` base exists, and
  recomputes the same deterministic `plan_sha256` for dry-run and apply.
- `verify` covers both logical format-3/4 sets and PITR `pitr-base-1` sets via
  `scripts/verify-pitr-base.sh`, including base artifact SHA-256/size, the full
  required WAL list, and per-segment sidecars.
- `--apply --confirm DELETE` is required for every destructive cleanup. Timers
  remain dry-run by default.
- A repeated `flock` contention emits a structured monitor alert and exits
  non-zero instead of silently reporting success. Failure of the unit itself
  starts `clinic-backup-alert@<job>.service`, which writes a journal notice.
- All active units use the single repository root `/opt/clinic`.

The isolated proof is `bash scripts/p98-backup-isolated-test.sh` (30/30 synthetic
checks). It uses stubbed mount tools and disposable fixtures; it does not prove
target-host storage, installed timers, or a real base backup.

## Verify backup sets (read-only)

```bash
./scripts/backup-verify.sh                    # defaults to /mnt/clinic-backups
./scripts/backup-verify.sh /path/to/backup-root
```

The verifier discovers `clinic-<tier>-<STAMP>` set directories across `daily/`,
`weekly/` and `monthly/` and accepts `backup_format=3` or `4`. For each
`MANIFEST.txt` it checks that declared artifacts exist, are age-encrypted,
match their declared SHA-256 and size, and pass `SHA256SUMS`. Format 4 must also
carry a backup ID, manifest version, encryption status, consistency mode,
plaintext hashes and the encrypted per-file checksum artifact. `SHA256SUMS`
lines are checked for strict `64-hex + separator + filename` syntax before
`sha256sum -c` is trusted, because `sha256sum -c` can exit 0 when some lines are
malformed. The verifier also checks manifest/directory consistency, undeclared
or missing checksum entries, orphan artifacts, incomplete sets, set age and
directory/file permissions. It validates the same mount/UUID/filesystem
assumptions as the producer and never writes, decrypts, or contacts the
database. Decrypted-content verification is performed by `restore-backup.sh`,
not by this read-only verifier. `BACKUP_VERIFY_SKIP_MOUNT_CHECK=1` exists only
for isolated synthetic tests and must never be used in production.

```bash
# Monitoring example: fail if the newest complete set is older than 26 hours.
BACKUP_MAX_AGE_HOURS=26 BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 \
  ./scripts/backup-verify.sh /mnt/clinic-backups
```

Expected result for the current repository state is **failure**: the legacy
`backups/db-20261113T134414Z.dump` is outside the approved layout and has no
manifest or checksums. It is preserved unchanged and must not be moved,
deleted, or presented as a recovery source without an owner decision.

## Retention (explicit, never automatic)

`scripts/backup-retention.sh` plans per-tier retention from verified complete
sets only. Dry-run is the default and performs no writes:

```bash
./scripts/backup-retention.sh --root /mnt/clinic-backups
```

Deletion requires both flags and is refused otherwise:

```bash
./scripts/backup-retention.sh --root /mnt/clinic-backups \
  --apply --confirm DELETE --keep-daily 7 --keep-weekly 4 --keep-monthly 12
```

Limits are clamped to at least 1 so the newest valid set in each tier is always
kept. Invalid, incomplete or checksum-dirty sets are reported as warnings and
left untouched for operator review; they are never automatically deleted. The
script re-validates manifest declarations, artifact hashes/sizes and strict
`SHA256SUMS` syntax before adding a set to its deletion plan. No cron job,
systemd timer or monitoring hook installs this script; scheduling remains an
owner decision.

### Legacy backup sets (pre-manifest dumps)

> **Phase 9.4 compatibility note:** the current verifier accepts the
> `clinic-<tier>-<STAMP>/MANIFEST.txt` convention with `backup_format=3` or `4`
> and `SHA256SUMS`. New sets are always format 4. The `backup_format=1` staging
> example below is retained as historical handling guidance; those staged
> copies will be reported as non-compliant by the current verifier and must not
> be treated as production backups.

Older sets may contain only `db-<STAMP>.dump`, sometimes with a matching
`storage-<STAMP>.tar.gz`, but no `SHA256SUMS-*` or `MANIFEST-*`. The verifier
intentionally reports these as incomplete/orphaned artifacts. **Work only on
copies**; never rename, rewrite, or "repair" the original artifact.

```bash
# Copy the legacy artifacts into a staging directory, using their original stamp.
mkdir -p /secure/legacy-restore
cp /path/to/db-<STAMP>.dump /secure/legacy-restore/
cp /path/to/storage-<STAMP>.tar.gz /secure/legacy-restore/ 2>/dev/null || true
cd /secure/legacy-restore

# Record real hashes/sizes for the staged copies, then describe the old format.
sha256sum db-<STAMP>.dump storage-<STAMP>.tar.gz > SHA256SUMS-<STAMP>.txt
cat > MANIFEST-<STAMP>.txt <<EOF
created_utc=<STAMP>
database_name=<database name from pg_restore --list>
database_dump=db-<STAMP>.dump
database_sha256=<sha256 from SHA256SUMS>
database_bytes=<wc -c of dump>
storage_archive=storage-<STAMP>.tar.gz
storage_sha256=<sha256 from SHA256SUMS>
storage_bytes=<wc -c of archive>
evolution_archive=none
evolution_sha256=none
evolution_bytes=0
caddy_archives=none
checksums=SHA256SUMS-<STAMP>.txt
encryption=none
postgres_version=<server version from pg_restore --list>
git_commit=unknown
backup_format=1
EOF

/opt/clinic/scripts/backup-verify.sh /secure/legacy-restore
```

`backup_format=1` and the missing Evolution/Caddy entries produce warnings but
not errors when the real hashes and sizes match. A dump-only copy is still
restorable, but there is no storage archive to reconcile, so uploaded files
cannot be verified or restored from that set.

`restore-drill.sh` also accepts a legacy dump without a checksum file. It prints
`skipping pre-restore checksum verification` and continues; treat that as an
explicit loss of integrity assurance, not as a passed check:

```bash
cd /opt/clinic
DRILL_DB=clinic_legacy_drill \
  ./scripts/restore-drill.sh /secure/legacy-restore/db-<STAMP>.dump \
  /secure/legacy-restore/storage-<STAMP>.tar.gz
```

If no storage archive exists, omit the second argument. Do not use a legacy
dump for a production restore until the staged verifier and drill both pass and
the missing companions are recorded as accepted limitations.

## Isolated full-set restore (validated in Phase 9.4)

`scripts/restore-backup.sh` restores a complete encrypted set into a
**disposable** PostgreSQL database and an empty directory. It does not
overwrite a production database or volume. It is the only path that exercises
decryption plus per-file checksum validation end to end.

```bash
./scripts/restore-backup.sh \
  --set /mnt/clinic-backups/daily/clinic-daily-<STAMP> \
  --target-db clinic_restore \
  --confirm-target clinic_restore \
  --target-dir /secure/restore/storage \
  --key-file /secure/clinic-backup-key.txt \
  --pghost 127.0.0.1 --pgport 55433 --pguser clinic
```

Before touching the target it validates manifest topology and format (3 or 4),
declared artifacts, strict `SHA256SUMS` syntax, encrypted artifact hashes and
sizes, then decrypts with the supplied private key. For format 4 it also
verifies the decrypted database/archive/checksum-list hashes against the
manifest. It checks the `PGDMP` dump header, tar readability and rejects
absolute or parent-traversal paths in the storage archive.

Safety rules: `--target-db` and `--confirm-target` must match; target names must
end in `_restore`, `_drill` or `_test`; reserved production names, Compose
service host `db` and port `55432` are refused; the storage target must already
exist and be empty. The source set is opened read-only, and a database created
by the run is dropped again on failure. `--skip-db` and `--skip-storage` exist
only for deliberately partial diagnostics and reduce assurance accordingly.
Keep the age private key in separate escrow with mode `0600`; it is never part
of the backup set or printed by these scripts.

In the final Phase 9.4 synthetic full-set drill (backup ID
`8bf72d7e-2a0a-42b3-b761-063a78375530`), backup completion took **341 ms** and
isolated restore completion took **1003 ms** for a small migrated database with
three uploaded files. Earlier runs measured 311 ms / 913 ms and 337 ms / 999 ms.
These are small-data drill timings, **not a production RTO commitment**.

## Restore drill (safe, repeatable)

```bash
DRILL_DB=clinic_restore_drill \
RESTORE_TARGET_CONFIRM=clinic_restore_drill \
  ./scripts/restore-drill.sh backups/db-YYYYMMDDTHHMMSSZ.dump

# Optional second argument: also reconcile the matching storage archive.
DRILL_DB=clinic_restore_drill \
RESTORE_TARGET_CONFIRM=clinic_restore_drill \
  ./scripts/restore-drill.sh \
    backups/db-YYYYMMDDTHHMMSSZ.dump \
    backups/storage-YYYYMMDDTHHMMSSZ.tar.gz
```

The drill restores into `clinic_restore_drill`; the name must end in `_drill`
and contain only letters, digits, and underscores. `RESTORE_TARGET_CONFIRM`
must exactly equal `DRILL_DB` — there is no implicit target confirmation. It:

1. Refuses `.age` inputs and prints the decryption command to run first.
2. Verifies the dump (and storage archive) against the matching
   `SHA256SUMS-<STAMP>.txt`, if present.
3. Recreates the drill database and restores with
   `--single-transaction --exit-on-error`.
4. Prints per-table row counts and a summary (tables, total rows, migrations,
   users, patients, visits, reports, file assets), and checks for failed
   migrations.
5. Reports the Evolution schema/table/row counts when present.
6. With a storage archive, reconciles `FileAsset.storedName` and `sizeBytes`
   against extracted files, reporting missing files, orphans, and size
   mismatches.

The disposable database is dropped even when the drill fails, unless
`KEEP_DRILL_DB=1` is set. Orphans fail the drill by default; set
`DRILL_ALLOW_ORPHANS=1` only when the drift is understood. It never touches
`ultrasound_clinic`. Record the date, dump/storage names, counts, and operator
in the operations log. Run a drill at least quarterly, after any backup-process
change, and before relying on a new USB backup set.

```bash
# Decrypt only on a trusted host, then drill the plaintext artifact.
age -d -i /secure/clinic-backup-key.txt \
  -o /secure/db-YYYYMMDDTHHMMSSZ.dump \
  backups/db-YYYYMMDDTHHMMSSZ.dump.age
DRILL_DB=clinic_restore_drill \
RESTORE_TARGET_CONFIRM=clinic_restore_drill \
  ./scripts/restore-drill.sh /secure/db-YYYYMMDDTHHMMSSZ.dump
```

## WAL archiving and point-in-time recovery (validated in isolation, not deployed)

Phase 6.1 first proved PITR on this PostgreSQL 16 stack with a disposable cluster.
Phase 9.5 adds a complete, fail-closed implementation and a separate
`pitr-base-1` base-backup/restore path. The base Compose file is unchanged; all
WAL/PITR configuration lives in the optional `docker-compose.pitr.yml` overlay.
Nothing has been applied to production. See
`docs/PRODUCTION_READINESS_PHASE9_5.md` for evidence and limitations.

A format-4 dump set from `backup.sh` is still a logical backup and is **not** a
PITR base set. PITR requires a `pitr-base-1` set created by
`scripts/pitr-base-backup.sh` plus the matching WAL segments in the dedicated
archive. Never mix the two set formats.

### WAL configuration in the optional overlay

| Setting | Value | Purpose |
|---|---|---|
| `wal_level` | `replica` | Emit enough WAL for physical recovery. |
| `archive_mode` | `on` | Continuous archiving. |
| `archive_command` | `/bin/sh /clinic/deploy/wal-archive.sh %p %f` | Fail-closed, POSIX-sh archiver; non-zero means PostgreSQL retries. The repository `deploy/` directory is mounted read-only at `/clinic/deploy` by the overlay. |
| `archive_timeout` | `${WAL_ARCHIVE_TIMEOUT_SECONDS:-300}` | Five-minute target for partially filled segments. |
| `max_wal_senders` | `${WAL_MAX_SENDERS:-10}` | Allows `pg_basebackup -X stream`. |
| `wal_keep_size` | `${WAL_KEEP_SIZE:-128MB}` | Local cushion while archive catches up. |
| `WAL_ARCHIVE_DIR` | `/wal-archive` | Container-side dedicated mount. |
| host bind | `${WAL_ARCHIVE_HOST_DIR:-/mnt/clinic-backups/wal-archive}:/wal-archive:rw` | Keeps WAL on the approved backup disk, not in `db_data`. |
| `WAL_ARCHIVE_MIN_FREE_MB` | `512` | Reserve before publishing a segment. |
| `WAL_ARCHIVE_SKIP_MOUNT_CHECK` | `0` | Fail unless the destination is a real mount. |

`deploy/wal-archive.sh` is POSIX sh and self-contained so it does not depend on
host-specific shell tooling. The validated `postgres:16-alpine` image does ship
`bash` and `mountpoint` but not `findmnt`; the helper prefers those tools when
present and otherwise detects a real mount from `/proc/self/mountinfo` and reads
the filesystem type from `/proc/self/mounts`. UUID verification is optional and is empty by default in
the container because `/dev/disk/by-uuid` is not normally mounted there; the
host mount must still use the approved UUID. The helper checks the mount,
optional UUID/filesystem match, source size, free space, and destination
conflicts. It stages the segment, writes a `<segment>.sha256` sidecar
(`<sha256>  <filename>`), and publishes both with atomic hard links. It never
overwrites a different valid file, and logs redacted `key=value` events to
stderr for PostgreSQL's log. Any failure is non-zero, so PostgreSQL retains and
retries the WAL file.

`deploy/wal-restore.sh` is the matching `restore_command`. It accepts
PostgreSQL's `RECOVERYXLOG`/`RECOVERYHISTORY` temporary `%p` names, requires the
segment and its sidecar, verifies size and SHA-256, then atomically publishes
the file into `pg_wal`. Missing or corrupt WAL produces a clear non-zero error
so recovery stops instead of silently skipping history.

`WAL_ARCHIVE_SKIP_MOUNT_CHECK=1` exists only for isolated tests. Do not set it
in production. The `P7_WAL_DIRS`, `P7_WAL_COUNT_*` and `P7_WAL_AGE_*` settings in
`deploy/monitor.env.example` and `docker-compose.monitoring.yml` feed the
existing read-only `scripts/p7-check-wal.sh` backlog check; no alert delivery or
monitoring service is installed by this change.

### Create a PITR base set

The host WAL archive directory must already exist as a dedicated, access-controlled
mount. With the overlay applied, an example from a trusted host is:

```bash
./scripts/pitr-base-backup.sh \
  --pghost 127.0.0.1 --pgport 55432 --pguser <db-user> \
  --pgdatabase <db-name> \
  --wal-archive-dir /mnt/clinic-backups/wal-archive \
  --backup-root /mnt/clinic-backups --tier daily \
  --age-recipient <age-public-recipient>
```

Use the production database port only for an authorised production run; the test
scripts use isolated ports. The script refuses a source without
`wal_level=replica`/`logical`, `archive_mode=on` and a non-empty
`archive_command`. It uses `pg_basebackup -Fp -X stream`, records the PostgreSQL
version, UTC creation time, start/stop LSNs, timeline, WAL segment size, WAL
archive location, required WAL range, per-segment SHA-256 values, base artifact
checksum/size and encryption mode in `MANIFEST.txt`, and writes `SHA256SUMS`
last.

A set is published only when every required WAL segment exists, has the expected
size, matches its sidecar, and matches the checksum recorded in the manifest.
Missing or corrupt WAL stops the run before the set is published, so an
incomplete base set is never marked `pitr_ready=true`. With `--age-recipient`,
the base artifact is age-encrypted and the private key remains in separate
escrow.

### Restore to a point in time

Restores are deliberately restricted to new, isolated targets:

```bash
./scripts/pitr-restore.sh \
  --set /mnt/clinic-backups/daily/clinic-daily-<STAMP>-pitr \
  --target-time '2026-11-21T12:34:56+00' \
  --target-dir /secure/restore/pitr_before_incident \
  --confirm-target-dir /secure/restore/pitr_before_incident \
  --pgport 55437 --pguser <db-user> \
  --key-file /secure/clinic-backup-key.txt
```

`--target-dir` and `--confirm-target-dir` must match exactly. The target directory
must not exist, must be absolute, must end in `_restore`, `_drill` or `_test`,
and must not be production-like or inside protected paths. Ports `5432` and
`55432` are refused. All manifest, base-artifact and WAL validation happens
before the target directory is created; on any failure the target is removed.

The restore extracts the verified base, creates `recovery.signal`, writes a
fail-closed `restore_command`, sets `recovery_target_time`,
`recovery_target_action='pause'` and `recovery_target_inclusive='on'`, disables
archiving on the recovered instance, and starts PostgreSQL on the isolated port.
It verifies that the instance is still in recovery, that PostgreSQL's log
confirms the target was reached, and reports the replay timestamp and elapsed
recovery time. The recovered instance is left paused for inspection; promote it
only after the target is verified.

### Operational requirements before production use

Do not enable the overlay without written approval. The following remain owner
decisions and are not implemented by this repository-only change:

- provision `/mnt/clinic-backups/wal-archive` as a dedicated `0700` mount owned
  by the PostgreSQL runtime user, with the expected UUID/filesystem recorded;
- apply the overlay and restart `db` in a controlled maintenance window;
- schedule PITR base backups and retain each set with all WAL it requires;
- add a WAL retention/deletion policy with capacity alarms (no pruning is
  automatic);
- install the WAL backlog monitor and route alerts;
- verify age key escrow and restore permissions on the target host;
- rehearse a full restore and measure production-shaped RTO.

The approved five-minute RPO is a design target, not a claimed result. The
synthetic drill measured sub-second archive delay and roughly two-second
recovery for a small database, but production has no WAL archiving enabled, so
the current production RPO remains unbounded. Never change production
PostgreSQL settings or restart the database for PITR without explicit approval.

## Ubuntu host permissions

**Verified host state (Phase 8.3.1, read-only inspection):** the mount root and
every backup directory are `root:root 0700`; write access is available to
`root` only. The recipient file `/etc/clinic-backup/recipient.txt` is
`root:root 0600` and contains a valid age public recipient (value not printed).
The only non-system account is `clinc_server` (UID 1000, `sudo` group); there is
**no** `deploy` or `clinicdeploy` account and no `postgres` host user. The
system `backup` account (UID 34) also cannot write to the mount. Historical
`deploy:clinicdeploy` and `deploy:deploy` documentation is therefore incorrect
for this host. See `docs/PRODUCTION_READINESS_PHASE8_3_1.md` §4.

**Workable model today (no host changes were made):** backup creation must run
as root (e.g. a root systemd unit or restricted sudo), because only root can
write the backup directories and read the recipient file. The monitor must also
run as root to validate the mount and read manifests. This is broader privilege
than is ideal.

**Least-privilege recommendation (NOT implemented, requires owner-approved host
changes):** create a dedicated `clinicbackup` service account, make it the owner
of the seven backup directories (`0700`) and of a `0600` recipient file, and run
the producer with that account. Give a separate read-only `clinicmonitor`
account traversal/read access to the backup tree, or have the monitor consume a
root-produced status file, so it never needs root. Keep age private-key escrow
on the separate USB flash drive, never on this disk. Do not change host users,
groups, ownership or permissions until that plan is approved.

## Full restore (requires written approval)

> This section is destructive. Do not start it without the clinic owner's
> written approval, a named operator, and a recorded start time. Take a fresh
> backup first.

1. **Announce downtime and stop every writer, including Evolution and Caddy.**
   Evolution keeps a database connection and Caddy holds TLS state; a restore
   that leaves them running is not consistent. Include `docker-compose.tls.yml`
   and `caddy` only when the TLS overlay is deployed.
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tls.yml stop web backend evolution caddy
   ```
2. **Preserve the current state.**
   ```bash
   ./scripts/backup.sh
   ./scripts/backup-verify.sh
   ```
   Do not continue if this fails or if free space is low.
3. **Verify the chosen set before changing anything.**
   ```bash
   ./scripts/backup-verify.sh
   SET=/mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>
   cat "$SET/MANIFEST.txt"
   ( cd "$SET" && sha256sum -c SHA256SUMS )
   ```
   Confirm the manifest's backup ID, database name, consistency mode, Postgres
   version and Git commit are compatible with the deployed code. If the dump is
   newer than the code, stop and deploy the matching release first. Decrypt
   `.age` artifacts on a trusted host before use. Do **not** use
   `restore-backup.sh` for this production overwrite: it intentionally refuses
   production-style database names and port `55432`.
4. **Restore the database.** Use a single transaction so a failure rolls back
   instead of leaving a half-restored database:
   ```bash
   docker compose exec -T db sh -c \
     'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --clean --if-exists --no-owner --no-acl \
        --single-transaction --exit-on-error' \
     < backups/db-<STAMP>.dump
   ```
5. **Replace the uploads volume contents with the matching archive.** This is
   destructive; a stale file from the previous state must not survive. The
   backend runs as UID/GID 1000, so restore ownership.
   ```bash
   docker run --rm \
     -v ultrasound_clinic_storage:/data \
     -v "$(pwd)/backups:/backup:ro" \
     alpine:3.22 \
     sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; \
            tar xzf /backup/storage-<STAMP>.tar.gz -C /data; \
            chown -R 1000:1000 /data'
   ```
   Replace `$(pwd)/backups` with the absolute backup path. On a host where
   `1000:1000` is not the container user, check the backend image first.
6. **Restore Evolution session state and Caddy TLS state only when needed.**
   If the volumes were lost, recreate them and extract the matching archives.
   Stop the services first; the archives contain the complete volume root.
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tls.yml stop evolution caddy
   docker volume create ultrasound_clinic_evolution_instances
   docker run --rm \
     -v ultrasound_clinic_evolution_instances:/data \
     -v "$(pwd)/backups:/backup:ro" \
     alpine:3.22 \
     sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; \
            tar xzf /backup/evolution-<STAMP>.tar.gz -C /data'
   # Repeat for ultrasound_clinic_caddy_data / _config when those archives exist.
   ```
   Omit the TLS overlay and `caddy` from the stop command when TLS is not
   deployed. If the Caddy data volume was lost, Caddy re-issues certificates on
   start when DNS and ports are correct.
7. **Invalidate restored sessions before serving traffic.** A restored database
   may contain tokens issued before the incident. Run this once, and rotate JWT
   secrets instead if compromise is suspected:
   ```bash
   docker compose exec -T db sh -c \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
   BEGIN;
   UPDATE "User"
      SET "tokenVersion" = "tokenVersion" + 1,
          "mustChangePassword" = true;
   UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
   UPDATE "PasswordSetupToken" SET "revokedAt" = now()
    WHERE "revokedAt" IS NULL AND "usedAt" IS NULL;
   DELETE FROM "TokenBlacklist";
   COMMIT;
   SQL
   ```
   For a like-for-like restore onto a trusted host, setting
   `mustChangePassword=true` for every user may be unnecessary; keep it for a
   suspected compromise or an untrusted restore.
8. **Start the stack and verify.**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
   curl -fsS https://<domain>/healthz
   docker compose run --rm migrate npx prisma migrate status
   ```
   Then sign in, open a known patient/report, confirm audit history, download a
   stored file, and run a database-to-file reconciliation (the drill does this
   when given the storage archive). Record the measured result and RTO.
9. **Do not delete Docker volumes as part of a routine restore.** Prefer
   `pg_restore --clean --if-exists` into the existing database. The storage
   replacement in step 5 already clears stale files; never run
   `docker compose down -v`, `docker volume prune`, or `docker system prune` on
   a production host.

## Fresh-host restore

1. Install the documented Ubuntu release, Docker Engine, and the Compose plugin.
   Do not use Docker Desktop for production.
2. Clone the repository at the exact release tag and restore `.env` from the
   secret escrow (§ Secrets in `docs/PRODUCTION_READINESS_PHASE6.md`) with mode
   `0600`. Never keep the escrow with the backups.
3. Create the named volumes without starting the application:
   ```bash
   docker compose create db
   docker volume create ultrasound_clinic_storage
   docker volume create ultrasound_clinic_evolution_instances
   ```
4. Start `db`, wait for health, and confirm the database exists.
5. Restore the database and storage as in steps 4–6 above; omitting `--clean` on
   an empty database is safe.
6. Start the stack (including the TLS overlay when used), then confirm
   `prisma migrate status`.
7. Re-pair WhatsApp if the Evolution session volume was lost. The database
   restores Evolution metadata, but the phone pairing/auth state must be
   re-established through the Evolution manager/API with the clinic phone
   present; verify with a synthetic message and record the operator and time.
8. Re-issue or confirm TLS certificates, run the session-invalidation step,
   verify `/healthz` and a known record, then record the measured RTO.

## Secrets and break-glass

A restore needs `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `EVOLUTION_API_KEY`, and the TLS/domain settings. These
are deliberately **not** in the backup set. Keep a break-glass copy in a
password manager or sealed offline store, separate from the backups, and test
retrieval. If the escrow is lost, plan for rotation and WhatsApp re-pairing
rather than assuming the backup is self-contained.

## Uploaded files

Files live in the named volume `ultrasound_clinic_storage` under
`/app/storage/uploads` and are served only through authorised API endpoints.
`FileAsset.storedName` is relative to `uploads/`; the backup archive preserves
the whole volume root. Always back up the database and storage from the same
point in time.
