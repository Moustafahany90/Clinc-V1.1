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

Phase 8.3.1 verified the actual host layout and aligned all scripts to it. One
set per run is a **directory** inside its tier, named
`clinic-<tier>-<STAMP>[-<label>]`, where `<tier>` is `daily`, `weekly` or
`monthly` and `<STAMP>` is `YYYYMMDDTHHMMSSZ`:

```
/mnt/clinic-backups/
├── daily/clinic-daily-<STAMP>/       # or weekly/…, monthly/…
│   ├── db-<STAMP>.dump.age
│   ├── storage-<STAMP>.tar.gz.age
│   ├── evolution-<STAMP>.tar.gz.age      (when the volume exists)
│   ├── <volume>-<STAMP>.tar.gz.age       (when TLS volumes exist)
│   ├── SHA256SUMS                        # checksums for this set
│   └── MANIFEST.txt                      # written last; marks a complete set
├── manifests/                        # present on host; reserved, not used by this engine
├── quarantine/                       # operator-controlled; scripts never write here
├── logs/                             # backup-<tier>.log and preflight write probe
└── wal-archive/                      # reserved; WAL archiving is NOT enabled
```

| File | Contents |
|---|---|
| `db-<STAMP>.dump.age` | age-encrypted PostgreSQL custom-format dump |
| `storage-<STAMP>.tar.gz.age` | age-encrypted `uploads` volume (clinical files) |
| `evolution-<STAMP>.tar.gz.age` | age-encrypted Evolution/WhatsApp session volume, when present |
| `<volume>-<STAMP>.tar.gz.age` | age-encrypted Caddy TLS state, when present |
| `SHA256SUMS` | SHA-256 for every artifact in the set |
| `MANIFEST.txt` | Timestamp, tier, mount UUID, filesystem, database/volume names, sizes, checksums, PostgreSQL version, Git commit, encryption state, format version |

`MANIFEST.txt` is written last and marks a complete set. Artifacts are staged
in a hidden temporary directory inside the set directory and checksummed before
publication. A failed run removes only the set directory it created; older sets
are never touched. Retention is an operator/policy decision; no automatic
deletion exists.

The database dump and the storage archive are still sequential, not a
point-in-time snapshot. Stop writers during the backup window (see
`BACKUP_QUIESCE_SERVICES`) or accept the small drift window. A database dump
without its matching storage archive is not a usable restore.

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
| `BACKUP_QUIESCE_SERVICES` | empty | Space-separated writers to stop for the dump/tar window, e.g. `backend web evolution`. Never include `db`. Restarted on success or failure. |
| `BACKUP_MIN_FREE_MB` | `1024` | Refuse to start below this much free space in the tier directory. |
| `STORAGE_VOLUME` | `ultrasound_clinic_storage` | Uploads volume name. |
| `EVOLUTION_VOLUME` | `ultrasound_clinic_evolution_instances` | Evolution session volume name. |
| `CADDY_VOLUMES` | `ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config` | TLS volumes; missing volumes are warned about. |

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
`age` binary also fails closed. WAL archiving remains **disabled**; the
`wal-archive/` directory is reserved only.

Capacity is checked in the tier directory before every backup after validation.
No schedules, timers, alert delivery or retention deletion are enabled by this
phase.

## Verify backup sets (read-only)

```bash
./scripts/backup-verify.sh                    # defaults to /mnt/clinic-backups
./scripts/backup-verify.sh /path/to/backup-root
```

The verifier discovers `clinic-<tier>-<STAMP>` set directories across `daily/`,
`weekly/` and `monthly/`. For each `MANIFEST.txt` it checks that declared
artifacts exist, are age-encrypted, match their declared SHA-256 and size, and
pass `SHA256SUMS`. It also checks manifest/directory consistency, undeclared
or missing checksum entries, orphan artifacts, incomplete sets, set age and
directory/file permissions. It validates the same mount/UUID/filesystem
assumptions as the producer and never writes, decrypts, or contacts the
database. `BACKUP_VERIFY_SKIP_MOUNT_CHECK=1` exists only for isolated synthetic
tests and must never be used in production.

```bash
# Monitoring example: fail if the newest complete set is older than 26 hours.
BACKUP_MAX_AGE_HOURS=26 BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 \
  ./scripts/backup-verify.sh /mnt/clinic-backups
```

Expected result for the current repository state is **failure**: the legacy
`backups/db-20261113T134414Z.dump` is outside the approved layout and has no
manifest or checksums. It is preserved unchanged and must not be moved,
deleted, or presented as a recovery source without an owner decision.

### Legacy backup sets (pre-manifest dumps)

> **Phase 8.3.1 compatibility note:** the current verifier only accepts the
> `clinic-<tier>-<STAMP>/MANIFEST.txt` convention with `backup_format=3` and
> `SHA256SUMS`. The `backup_format=1` staging example below is retained as
> historical handling guidance; those staged copies will be reported as
> non-compliant by the current verifier and must not be treated as production
> backups.

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

## Restore drill (safe, repeatable)

```bash
./scripts/restore-drill.sh backups/db-YYYYMMDDTHHMMSSZ.dump
# Optional second argument: also reconcile the matching storage archive.
./scripts/restore-drill.sh \
  backups/db-YYYYMMDDTHHMMSSZ.dump \
  backups/storage-YYYYMMDDTHHMMSSZ.tar.gz
```

The drill restores into `clinic_restore_drill`; the name must end in `_drill`
and contain only letters, digits, and underscores. It:

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
./scripts/restore-drill.sh /secure/db-YYYYMMDDTHHMMSSZ.dump
```

## Point-in-time recovery (validated in isolation, not deployed)

Phase 6.1 proved that PITR works with this PostgreSQL 16 stack: a disposable
cluster used `wal_level=replica`, `archive_mode=on`, a WAL `archive_command`,
and `archive_timeout=10s`; a base backup plus six archived WAL files restored
correctly by both restore point and target time. See
`docs/PRODUCTION_READINESS_PHASE6_1.md` §7.

The approved production design uses the internal SATA backup HDD at
`/mnt/clinic-backups/wal-archive` with `archive_timeout=300s` for a target RPO
of five minutes. **The 5-minute RPO is not claimed until an isolated
point-in-time recovery succeeds on the Ubuntu host.** Production still has no
WAL archiving and no PITR runbook activation. Do not assume a better RPO until
the following are deployed and rehearsed on the target host with written
approval:

- a dedicated, access-controlled WAL archive destination on the verified internal
  backup HDD mount, with `mountpoint` checked by `archive_command`;
- `wal_level=replica`, `archive_mode=on`, a tested `archive_command`, and the
  chosen `archive_timeout=300s`/5-minute RPO target;
- base backups retained with their matching WAL history;
- monitoring for archive failures and WAL retention growth;
- a documented restore flow using `restore_command`, `recovery.signal`, and
  either `recovery_target_name` or `recovery_target_time`.

Never change production PostgreSQL settings or restart the database for PITR
without explicit approval. The production RPO remains unbounded until this is
deployed and verified.

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
   cd backups
   sha256sum -c SHA256SUMS-<STAMP>.txt
   gzip -t storage-<STAMP>.tar.gz
   cat MANIFEST-<STAMP>.txt
   ```
   Confirm the manifest's database name, Postgres version, and Git commit are
   compatible with the deployed code. If the dump is newer than the code, stop
   and deploy the matching release first. Decrypt `.age` artifacts before use.
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
