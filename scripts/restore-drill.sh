#!/usr/bin/env bash
# Restore a backup into a disposable Postgres database and verify it.
# It never touches the clinic database.
#
#   ./scripts/restore-drill.sh backups/db-YYYYMMDDTHHMMSSZ.dump
#   ./scripts/restore-drill.sh backups/db-YYYYMMDDTHHMMSSZ.dump \
#     backups/storage-YYYYMMDDTHHMMSSZ.tar.gz
#
# The drill database name must end in "_drill"; the script refuses to run
# otherwise. RESTORE_TARGET_CONFIRM must exactly equal DRILL_DB: there is no
# implicit target and Production is never a valid drill target. Set
# KEEP_DRILL_DB=1 to keep the disposable database for inspection.
#
# If a matching SHA256SUMS-<STAMP>.txt sits beside the dump, the dump (and the
# storage archive when supplied) is verified before anything is restored.
# Encrypted artifacts must be decrypted first; this script never handles keys.
set -euo pipefail

# Git Bash converts container paths such as /data into C:\... unless disabled.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
umask 077

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

sha256_check_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c -
  else
    shasum -a 256 -c -
  fi
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

# Extract the YYYYMMDDTHHMMSSZ stamp from a known artifact name.
artifact_stamp() {
  name="$(basename "$1")"
  case "$name" in
    db-*.dump) printf '%s' "${name#db-}" | sed 's/\.dump$//' ;;
    storage-*.tar.gz) printf '%s' "${name#storage-}" | sed 's/\.tar\.gz$//' ;;
    *) printf '' ;;
  esac
}

verify_checksum() {
  artifact="$1"
  dir="$(dirname "$artifact")"
  base="$(basename "$artifact")"
  stamp="$(artifact_stamp "$artifact")"
  [ -n "$stamp" ] || return 0
  sums="$dir/SHA256SUMS-${stamp}.txt"
  if [ ! -f "$sums" ]; then
    warn "no checksum file '$sums'; skipping pre-restore checksum verification for '$base'."
    return 0
  fi
  lines="$(awk -v f="$base" '{ n=$2; sub(/^\*/, "", n); if (n == f) print }' "$sums")"
  [ -n "$lines" ] || die "'$base' is not listed in '$sums'; the backup set is inconsistent."
  echo "Verifying SHA-256 for '$base'..."
  ( cd "$dir" && printf '%s\n' "$lines" | sha256_check_stdin ) || \
    die "checksum verification failed for '$base'. Do not restore this artifact."
}

DUMP="${1:-}"
STORAGE="${2:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Usage: $0 <db-...dump> [storage-...tar.gz]" >&2
  exit 1
fi

case "$DUMP" in
  *.age)
    die "'$DUMP' is age-encrypted. Decrypt it first, for example:
  age -d -i /secure/backup-key.txt -o ${DUMP%.age} '$DUMP'"
    ;;
esac
if [ -n "$STORAGE" ]; then
  [ -f "$STORAGE" ] || die "storage archive '$STORAGE' not found."
  case "$STORAGE" in
    *.age)
      die "'$STORAGE' is age-encrypted. Decrypt it first, for example:
  age -d -i /secure/backup-key.txt -o ${STORAGE%.age} '$STORAGE'"
      ;;
  esac
  dump_stamp="$(artifact_stamp "$DUMP")"
  storage_stamp="$(artifact_stamp "$STORAGE")"
  if [ -n "$dump_stamp" ] && [ -n "$storage_stamp" ] && [ "$dump_stamp" != "$storage_stamp" ]; then
    die "the database dump and storage archive are from different backup sets:
  db stamp:      $dump_stamp
  storage stamp: $storage_stamp"
  fi
fi

verify_checksum "$DUMP"
if [ -n "$STORAGE" ]; then
  verify_checksum "$STORAGE"
fi

DRILL_DB="${DRILL_DB:-clinic_restore_drill}"
case "$DRILL_DB" in
  *_drill) ;;
  *)
    echo "Refusing to restore into '$DRILL_DB': the name must end in '_drill'." >&2
    exit 1
    ;;
esac
if ! printf '%s' "$DRILL_DB" | grep -Eq '^[A-Za-z0-9_]+_drill$'; then
  echo "Refusing to restore into '$DRILL_DB': use only letters, digits and underscores." >&2
  exit 1
fi
[ "${RESTORE_TARGET_CONFIRM:-}" = "$DRILL_DB" ] || die \
  "refusing to restore without explicit target confirmation: set RESTORE_TARGET_CONFIRM='$DRILL_DB'."

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not available."

DB_USER="$(docker compose exec -T db printenv POSTGRES_USER | tr -d '\r')" || \
  die "could not read POSTGRES_USER from the db service. Is the stack running?"
[ -n "$DB_USER" ] || die "POSTGRES_USER is empty in the db service."
DB_NAME="$(docker compose exec -T db printenv POSTGRES_DB | tr -d '\r')" || \
  die "could not read POSTGRES_DB from the db service. Is the stack running?"
[ -n "$DB_NAME" ] || die "POSTGRES_DB is empty in the db service."
[ "$DRILL_DB" != "$DB_NAME" ] || die "refusing to use the live database name '$DB_NAME' as the drill database."

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clinic-restore-drill.XXXXXX")" || die "could not create a temp directory."
DB_CREATED=0

cleanup() {
  rc=$?
  trap - EXIT INT TERM
  rm -rf "$TMP_DIR"
  if [ "$DB_CREATED" = "1" ]; then
    if [ "${KEEP_DRILL_DB:-0}" = "1" ]; then
      echo "Keeping disposable database '$DRILL_DB' for inspection (KEEP_DRILL_DB=1)."
    else
      echo "Dropping disposable database '$DRILL_DB'..."
      docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
        -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null || \
        warn "could not drop '$DRILL_DB'; drop it manually."
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Recreating disposable database '$DRILL_DB'..."
docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '$DRILL_DB' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";"
docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$DRILL_DB\";"
DB_CREATED=1

echo "Restoring $DUMP ..."
docker compose exec -T db pg_restore -U "$DB_USER" -d "$DRILL_DB" \
  --no-owner --no-acl --single-transaction --exit-on-error < "$DUMP"

echo "Verifying restored schema and per-table row counts..."
docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -P pager=off -c '
WITH counts AS (
  SELECT table_name,
         (xpath($$/row/cnt/text()$$,
                query_to_xml(format($$select count(*) as cnt from public.%I$$, table_name),
                             false, true, $$$$)))[1]::text::bigint AS rows
  FROM information_schema.tables
  WHERE table_schema = $$public$$ AND table_type = $$BASE TABLE$$
)
SELECT table_name, rows FROM counts ORDER BY table_name;'

echo "Summary:"
docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -P pager=off -c '
WITH counts AS (
  SELECT table_name,
         (xpath($$/row/cnt/text()$$,
                query_to_xml(format($$select count(*) as cnt from public.%I$$, table_name),
                             false, true, $$$$)))[1]::text::bigint AS rows
  FROM information_schema.tables
  WHERE table_schema = $$public$$ AND table_type = $$BASE TABLE$$
)
SELECT count(*) AS tables,
       coalesce(sum(rows), 0) AS total_rows,
       coalesce(max(rows) FILTER (WHERE table_name = $$_prisma_migrations$$), 0) AS migrations,
       coalesce(max(rows) FILTER (WHERE table_name = $$User$$), 0) AS users,
       coalesce(max(rows) FILTER (WHERE table_name = $$Patient$$), 0) AS patients,
       coalesce(max(rows) FILTER (WHERE table_name = $$Visit$$), 0) AS visits,
       coalesce(max(rows) FILTER (WHERE table_name = $$Report$$), 0) AS reports,
       coalesce(max(rows) FILTER (WHERE table_name = $$FileAsset$$), 0) AS file_assets
FROM counts;'

has_migrations="$(docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq \
  -c "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL" | tr -d '\r')"
[ "$has_migrations" = "t" ] || die "restored database has no _prisma_migrations table; this is not a clinic schema."

failed_migrations="$(docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq \
  -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL' | tr -d '\r')"
[ "$failed_migrations" = "0" ] || die "restored database has $failed_migrations unfinished or rolled-back migration(s)."

migrations="$(docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq \
  -c 'SELECT count(*) FROM "_prisma_migrations"' | tr -d '\r')"
[ "$migrations" -gt 0 ] || die "restored database has no applied migrations."

echo "Checking Evolution schema..."
evolution_tables="$(docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'evolution' AND table_type = 'BASE TABLE'" | tr -d '\r')"
if [ "$evolution_tables" -gt 0 ]; then
  docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 -P pager=off -c '
WITH counts AS (
  SELECT table_name,
         (xpath($$/row/cnt/text()$$,
                query_to_xml(format($$select count(*) as cnt from evolution.%I$$, table_name),
                             false, true, $$$$)))[1]::text::bigint AS rows
  FROM information_schema.tables
  WHERE table_schema = $$evolution$$ AND table_type = $$BASE TABLE$$
)
SELECT count(*) AS evolution_tables, coalesce(sum(rows), 0) AS evolution_rows FROM counts;'
else
  warn "no 'evolution' schema in this dump; WhatsApp metadata will be absent."
fi

if [ -n "$STORAGE" ]; then
  echo "Extracting storage archive for database-to-file reconciliation..."
  if tar tzf "$STORAGE" 2>/dev/null | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    die "storage archive '$STORAGE' contains absolute or parent-traversal paths; refusing to extract it."
  fi
  mkdir -p "$TMP_DIR/storage"
  tar xzf "$STORAGE" -C "$TMP_DIR/storage"
  UPLOADS_DIR="$(find "$TMP_DIR/storage" -type d -name uploads -print -quit)"
  [ -n "$UPLOADS_DIR" ] || UPLOADS_DIR="$TMP_DIR/storage"

  has_file_asset="$(docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq \
    -c "SELECT to_regclass('public.\"FileAsset\"') IS NOT NULL" | tr -d '\r')"
  if [ "$has_file_asset" = "t" ]; then
    docker compose exec -T db psql -U "$DB_USER" -d "$DRILL_DB" -Atq -F '|' \
      -c 'SELECT "storedName", "sizeBytes" FROM "FileAsset" ORDER BY 1' \
      > "$TMP_DIR/fileassets.txt"
    cut -d'|' -f1 "$TMP_DIR/fileassets.txt" | LC_ALL=C sort -u > "$TMP_DIR/db-names.txt"
    find "$UPLOADS_DIR" -type f -print | while IFS= read -r f; do
      printf '%s\n' "${f#"$UPLOADS_DIR"/}"
    done | grep -v '^tmp/' | LC_ALL=C sort > "$TMP_DIR/fs-names.txt" || true

    db_files="$(wc -l < "$TMP_DIR/db-names.txt" | tr -d ' ')"
    disk_files="$(wc -l < "$TMP_DIR/fs-names.txt" | tr -d ' ')"
    missing="$(LC_ALL=C comm -23 "$TMP_DIR/db-names.txt" "$TMP_DIR/fs-names.txt" | wc -l | tr -d ' ')"
    orphans="$(LC_ALL=C comm -13 "$TMP_DIR/db-names.txt" "$TMP_DIR/fs-names.txt" | wc -l | tr -d ' ')"

    size_mismatch=0
    while IFS='|' read -r stored size; do
      [ -n "$stored" ] || continue
      path="$UPLOADS_DIR/$stored"
      [ -f "$path" ] || continue
      if [ "$(file_bytes "$path")" != "$size" ]; then
        echo "SIZE MISMATCH: $stored (expected $size bytes, found $(file_bytes "$path"))" >&2
        size_mismatch=$((size_mismatch + 1))
      fi
    done < "$TMP_DIR/fileassets.txt"

    echo "Storage reconciliation: $db_files database rows, $disk_files files, $missing missing, $orphans orphaned, $size_mismatch size mismatches."
    if [ "$missing" -gt 0 ]; then
      echo "Missing files (database row has no archive entry):" >&2
      LC_ALL=C comm -23 "$TMP_DIR/db-names.txt" "$TMP_DIR/fs-names.txt" | head -n 20 >&2
      die "$missing referenced file(s) are missing from the storage archive."
    fi
    if [ "$size_mismatch" -gt 0 ]; then
      die "$size_mismatch file(s) do not match FileAsset.sizeBytes."
    fi
    if [ "$orphans" -gt 0 ]; then
      echo "Orphaned files (archive entry has no database row):" >&2
      LC_ALL=C comm -13 "$TMP_DIR/db-names.txt" "$TMP_DIR/fs-names.txt" | head -n 20 >&2
      if [ "${DRILL_ALLOW_ORPHANS:-0}" = "1" ]; then
        warn "$orphans orphaned file(s); continuing because DRILL_ALLOW_ORPHANS=1."
      else
        die "$orphans orphaned file(s); set DRILL_ALLOW_ORPHANS=1 only if the drift is understood."
      fi
    fi
  else
    warn "no FileAsset table in this dump; counted files without database reconciliation."
    find "$UPLOADS_DIR" -type f | wc -l | awk '{print "Storage files: " $1}'
  fi
fi

echo "Restore drill passed for '$DRILL_DB'. No clinic data was modified."
