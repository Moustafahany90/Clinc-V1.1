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

`scripts/backup.sh` publishes one set per run, identified by a UTC stamp
(`YYYYMMDDTHHMMSSZ`):

| File | Contents |
|---|---|
| `db-<STAMP>.dump[.age]` | PostgreSQL custom-format dump |
| `storage-<STAMP>.tar.gz[.age]` | `uploads` volume (clinical files) |
| `evolution-<STAMP>.tar.gz[.age]` | Evolution/WhatsApp session volume, when present |
| `ultrasound_clinic_caddy_data-<STAMP>.tar.gz[.age]` | Caddy TLS data, when the TLS overlay is present |
| `ultrasound_clinic_caddy_config-<STAMP>.tar.gz[.age]` | Caddy TLS config, when present |
| `SHA256SUMS-<STAMP>.txt` | SHA-256 for every artifact in the set |
| `MANIFEST-<STAMP>.txt` | Timestamp, database/volume names, sizes, checksums, Postgres version, Git commit, encryption state, format version |

`MANIFEST-<STAMP>.txt` is written last and marks a complete set. Artifacts are
staged in a hidden temporary directory and checksummed before they are
published, so a failed run does not leave a normal-looking partial set. The
script never deletes old backups; retention is an operator/policy decision.

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
| `BACKUP_DIR` | `backups` | Output directory. On the Ubuntu host this must be under `/mnt/clinic-backups`. |
| `BACKUP_MOUNT_POINT` | empty | Required external USB mount point. |
| `BACKUP_REQUIRE_MOUNT` | `0` | Set to `1` to fail closed unless the mount exists and `BACKUP_DIR` is underneath it. |
| `BACKUP_AGE_RECIPIENT` | empty | age public key. When set, every artifact is encrypted and the plaintext is removed. |
| `BACKUP_REQUIRE_ENCRYPTION` | `0` | Set to `1` to refuse plaintext output when no recipient is configured. |
| `BACKUP_OFFSITE_REMOTE` | empty | Legacy rclone option only. Not used in the approved USB architecture; no off-site copy is claimed. |
| `BACKUP_QUIESCE_SERVICES` | empty | Space-separated application services to stop for the dump/tar window, for example `backend web evolution`. Never include `db`. They are restarted on success or failure. |
| `BACKUP_MIN_FREE_MB` | `1024` | Refuse to start below this much free space in `BACKUP_DIR`. |
| `STORAGE_VOLUME` | `ultrasound_clinic_storage` | Uploads volume name. |
| `EVOLUTION_VOLUME` | `ultrasound_clinic_evolution_instances` | Evolution session volume name. |
| `CADDY_VOLUMES` | `ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config` | TLS volumes; missing volumes are warned about. |

### Encryption and external USB storage (approved production architecture)

Encryption is mandatory in the approved production architecture. Generate an
age keypair on a machine that is **not** the backup host, keep the private key
in independently secured escrow, and put only the public recipient on the host.
The private key must not be stored on the external HDD or on the production
server.

```bash
# On the trusted administrator machine, once:
age-keygen -o clinic-backup-key.txt
# Copy only the public key value into the backup host's protected environment.

# On the Ubuntu host, in /etc/clinic/backup.env (mode 0600):
BACKUP_DIR=/mnt/clinic-backups/backups
BACKUP_MOUNT_POINT=/mnt/clinic-backups
BACKUP_REQUIRE_MOUNT=1
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REQUIRE_ENCRYPTION=1
BACKUP_QUIESCE_SERVICES='backend web evolution'
```

The approved destination is a dedicated 500 GB external USB HDD permanently
attached to the Ubuntu server and mounted by UUID at `/mnt/clinic-backups`.
It is **local backup storage, not off-site storage**. No rclone remote is
configured and no off-site protection is claimed. The Phase 6.1 isolated
rclone test remains historical validation only.

`BACKUP_REQUIRE_MOUNT=1` makes `backup.sh` fail closed if the mount is absent or
if `BACKUP_DIR` is not underneath it. The scheduled wrapper additionally checks
the mountpoint and expected UUID device before starting. WAL archiving uses the
same disk under `/mnt/clinic-backups/wal-archive` and its `archive_command`
checks the mount before writing, so a disconnected disk cannot silently spill
WAL to the internal filesystem.

Capacity is checked before every backup and every six hours, with email alerts
at 70%, 85%, and 95%. The 95% threshold aborts backup creation. If `age` is
configured but not installed, `backup.sh` refuses to run rather than silently
writing plaintext.

## Verify backup sets (read-only)

```bash
./scripts/backup-verify.sh
./scripts/backup-verify.sh /path/to/backups
```

For every `MANIFEST-*` it checks that all declared artifacts exist, match their
declared SHA-256 and size, and pass `SHA256SUMS-*.txt`. It reports encryption
state, set age, artifact sizes, missing Evolution/Caddy volumes, and
orphan/incomplete artifacts with no manifest. It never writes, decrypts, or
contacts the database.

```bash
# Monitoring example: fail if the newest complete set is older than 26 hours.
BACKUP_MAX_AGE_HOURS=26 BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 \
  ./scripts/backup-verify.sh
```

Expected result for the current repository state is **failure**: the only
existing artifact, `backups/db-20261113T134414Z.dump`, has no manifest,
checksums, or storage archive. Treat it as unverified and replace it with a
complete set. Once a complete set exists, move the old dump to a quarantined
location outside the verifier's scan path; do not delete it. Otherwise the
verifier will keep reporting it as an orphan artifact.

### Legacy backup sets (pre-manifest dumps)

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

The approved production design uses the external USB HDD at
`/mnt/clinic-backups/wal-archive` with `archive_timeout=300s` for a target RPO
of five minutes. **The 5-minute RPO is not claimed until an isolated
point-in-time recovery succeeds on the Ubuntu host.** Production still has no
WAL archiving and no PITR runbook activation. Do not assume a better RPO until
the following are deployed and rehearsed on the target host with written
approval:

- a dedicated, access-controlled WAL archive destination on the verified USB
  mount, with `mountpoint` checked by `archive_command`;
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

Phase 6.1 validated the intended ownership model in Ubuntu 24.04 containers.
Apply the equivalent on the target host before storing real backups or keys:

```bash
# Example: deploy account is UID/GID 3001 in group clinicdeploy.
sudo groupadd --gid 3001 clinicdeploy 2>/dev/null || true
sudo useradd --uid 3001 --gid clinicdeploy --create-home --shell /bin/sh deploy 2>/dev/null || true
sudo install -d -m 0700 -o deploy -g clinicdeploy /var/backups/clinic /etc/clinic/keys
sudo install -d -m 0750 -o deploy -g clinicdeploy /srv/clinic/restore
sudo install -m 0600 -o deploy -g clinicdeploy /dev/null \
  /etc/clinic/keys/backup-age-identity.txt
```

The isolated test confirmed that a second local account could not read the
backup, the age identity, or the restore file, and could not list the backup
directory. Verify the same on the production Ubuntu host; do not rely on
`chmod` alone on Windows/NTFS.

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
