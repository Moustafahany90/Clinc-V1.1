# Backup and Restore

Backups contain PHI. Encrypt them at rest, restrict access, and never copy them
to an unapproved machine or commit them to Git.

## Automated backup

```bash
./scripts/backup.sh
```

The script writes a custom-format Postgres dump, a tar archive of the uploads
volume, SHA-256 checksums, and a manifest into `backups/` (mode 0700). It does
not encrypt the output and does not delete old backups. Copy the encrypted
backup off-host and verify it with a restore drill.

## Restore drill (safe, repeatable)

```bash
./scripts/restore-drill.sh backups/db-YYYYMMDDTHHMMSSZ.dump
```

The drill restores into `clinic_restore_drill` (the name must end in `_drill`),
prints migration/user/patient/report counts, then drops the disposable database
unless `KEEP_DRILL_DB=1` is set. It never touches `ultrasound_clinic`. Record the
result and operator in the operations log.

## Full restore (requires written approval)

1. Announce downtime and stop writes:
   ```bash
   docker compose stop web backend
   ```
2. Take a fresh backup of the current state before changing anything.
3. Restore the database from the same snapshot as the uploads:
   ```bash
   docker compose exec -T db sh -c \
     'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
     < backups/db-YYYYMMDDTHHMMSSZ.dump
   ```
4. Restore uploads from the matching archive (then give the backend's `node`
   user ownership so it can continue writing):
   ```bash
   docker run --rm \
     -v ultrasound_clinic_storage:/data \
     -v "$(pwd)/backups":/backup \
     alpine:3.22 \
     sh -c 'tar xzf /backup/storage-YYYYMMDDTHHMMSSZ.tar.gz -C /data && chown -R 1000:1000 /data'
   ```
5. Start the stack and verify (include the TLS overlay on a production host):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
   curl -fsS https://clinic.example.com/healthz
   ```
   Then sign in, open a known patient/report, and confirm audit history.
6. Do **not** delete Docker volumes as part of a restore without the clinic
   owner's written approval. Prefer `pg_restore --clean --if-exists` into the
   existing database.

## Uploaded files

Files live in the named volume `ultrasound_clinic_storage` at
`/app/storage/uploads` and are served only through authorised API endpoints.
Always back up the database and storage from the same point in time; a database
dump without its files (or vice versa) is not a usable restore.
