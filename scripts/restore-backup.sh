#!/usr/bin/env bash
# Validate, decrypt and restore a backup set into an EXPLICIT isolated target.
#
#   ./scripts/restore-backup.sh \
#     --set /mnt/clinic-backups/daily/clinic-daily-<STAMP> \
#     --target-db clinic_restore \
#     --confirm-target clinic_restore \
#     --target-dir /secure/restore/storage \
#     --key-file /secure/clinic-backup-key.txt \
#     --pghost 127.0.0.1 --pgport 55433 --pguser clinic
#
# Safety rules:
#   * There is no default target. --target-db and --confirm-target must match.
#   * Target names must end in _restore, _drill or _test; production-style names
#     and the Compose service host 'db'/port 55432 are refused.
#   * The storage target directory must already exist and be empty.
#   * The source backup set is opened read-only and is never modified or deleted.
#   * Decryption and checksum verification happen BEFORE the target is touched.
#   * A target database created by this run is dropped again on failure.
set -euo pipefail

export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

umask 077
START_EPOCH="$(date -u +%s)"

die() { backup_die "$@"; }
warn() { echo "WARNING: $*" >&2; }

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: restore-backup.sh --set <set-dir> --target-db <isolated-db>
       --confirm-target <isolated-db> --target-dir <empty-dir>
       --key-file <age-private-key>
       --pghost <host> --pgport <port> --pguser <user>
       [--skip-db] [--skip-storage]
EOF_USAGE
}

SET_DIR=""
TARGET_DB=""
CONFIRM_TARGET=""
TARGET_DIR=""
KEY_FILE=""
PGHOST_ARG=""
PGPORT_ARG=""
PGUSER_ARG=""
SKIP_DB=0
SKIP_STORAGE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --set)            [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--set needs a value."; SET_DIR="$2"; shift 2 ;;
    --target-db)      [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--target-db needs a value."; TARGET_DB="$2"; shift 2 ;;
    --confirm-target) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--confirm-target needs a value."; CONFIRM_TARGET="$2"; shift 2 ;;
    --target-dir)     [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--target-dir needs a value."; TARGET_DIR="$2"; shift 2 ;;
    --key-file)       [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--key-file needs a value."; KEY_FILE="$2"; shift 2 ;;
    --pghost)         [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pghost needs a value."; PGHOST_ARG="$2"; shift 2 ;;
    --pgport)         [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pgport needs a value."; PGPORT_ARG="$2"; shift 2 ;;
    --pguser)         [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pguser needs a value."; PGUSER_ARG="$2"; shift 2 ;;
    --skip-db)        SKIP_DB=1; shift ;;
    --skip-storage)   SKIP_STORAGE=1; shift ;;
    --help|-h)        usage; exit "$BACKUP_EXIT_OK" ;;
    *) usage; die "$BACKUP_EXIT_USAGE" "unknown argument '$1'." ;;
  esac
done

[ -n "$SET_DIR" ] && [ -d "$SET_DIR" ] || die "$BACKUP_EXIT_USAGE" "--set must be an existing backup set directory."
[ -n "$TARGET_DB" ] || { usage; die "$BACKUP_EXIT_USAGE" "--target-db is required; no default target exists."; }
[ "$CONFIRM_TARGET" = "$TARGET_DB" ] || die "$BACKUP_EXIT_USAGE" \
  "target confirmation did not match: --target-db='$TARGET_DB', --confirm-target='$CONFIRM_TARGET'."
[ -n "$TARGET_DIR" ] && [ -d "$TARGET_DIR" ] || die "$BACKUP_EXIT_USAGE" \
  "--target-dir must be an existing directory. Create it before restoring."
[ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ] || die "$BACKUP_EXIT_USAGE" \
  "--key-file must be an existing age private-key file."
[ -n "$PGHOST_ARG" ] && [ -n "$PGPORT_ARG" ] && [ -n "$PGUSER_ARG" ] || die "$BACKUP_EXIT_USAGE" \
  "--pghost, --pgport and --pguser are mandatory so the target cannot be inferred from production defaults."

case "$TARGET_DB" in
  *[!A-Za-z0-9_]*) die "$BACKUP_EXIT_USAGE" \
    "target database '$TARGET_DB' contains invalid characters." ;;
  ultrasound_clinic|clinic|postgres|template0|template1|clinic_app) die "$BACKUP_EXIT_USAGE" \
    "target database '$TARGET_DB' is a production/reserved name." ;;
  *_restore|*_drill|*_test) : ;;
  *) die "$BACKUP_EXIT_USAGE" \
       "target database '$TARGET_DB' must end in _restore, _drill or _test." ;;
esac
case "$PGHOST_ARG" in
  db|database|clinic-db) die "$BACKUP_EXIT_USAGE" \
    "PG target host '$PGHOST_ARG' is a Compose service name; specify an isolated host explicitly." ;;
esac
[ "$PGPORT_ARG" != "55432" ] || die "$BACKUP_EXIT_USAGE" \
  "port 55432 is the production PostgreSQL port; choose an isolated target port."

case "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit)" in
  "") : ;;
  *) die "$BACKUP_EXIT_USAGE" \
       "storage target '$TARGET_DIR' is not empty; refusing to overwrite any existing file." ;;
esac

command -v age >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" "age is not installed or not on PATH."
if [ "$SKIP_DB" = "0" ]; then
  for tool in psql pg_restore; do
    command -v "$tool" >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
      "'$tool' is required for database restore; use --skip-db for storage-only restores."
  done
fi

# ---------------------------------------------------------------------------
# Read-only validation of the backup set BEFORE any target is modified.
# ---------------------------------------------------------------------------
MANIFEST="${SET_DIR}/MANIFEST.txt"
SUMS="${SET_DIR}/SHA256SUMS"
[ -f "$MANIFEST" ] || die "$BACKUP_EXIT_VERIFY" \
  "backup set '$SET_DIR' has no MANIFEST.txt; incomplete sets cannot be restored."
[ -f "$SUMS" ] || die "$BACKUP_EXIT_VERIFY" \
  "backup set '$SET_DIR' has no SHA256SUMS; integrity cannot be verified."

declare -A M=()
backup_manifest_load "$MANIFEST" M

FMT="${M[backup_format]:-}"
case "$FMT" in
  3|4) ;;
  *) die "$BACKUP_EXIT_VERIFY" "unsupported backup_format='${FMT:-missing}' (expected 3 or 4)." ;;
esac

BASE="$(basename "$SET_DIR")"
TIER="$(basename "$(dirname "$SET_DIR")")"
[ "${M[set_directory]:-}" = "$BASE" ] || die "$BACKUP_EXIT_VERIFY" \
  "manifest set_directory='${M[set_directory]:-}' does not match '$BASE'."
[ "${M[backup_tier]:-}" = "$TIER" ] || die "$BACKUP_EXIT_VERIFY" \
  "manifest backup_tier='${M[backup_tier]:-}' does not match tier '$TIER'."
[ "${M[checksums]:-}" = "SHA256SUMS" ] || die "$BACKUP_EXIT_VERIFY" \
  "manifest checksums='${M[checksums]:-}' is not SHA256SUMS."
[ "${M[encryption]:-}" = "age" ] || die "$BACKUP_EXIT_VERIFY" \
  "manifest encryption='${M[encryption]:-}'; only age-encrypted sets are accepted."
[ -n "${M[database_dump]:-}" ] || die "$BACKUP_EXIT_VERIFY" "manifest has no database_dump."
[ -n "${M[storage_archive]:-}" ] || die "$BACKUP_EXIT_VERIFY" "manifest has no storage_archive."

if [ "$FMT" = "4" ]; then
  [ -n "${M[backup_id]:-}" ] || die "$BACKUP_EXIT_VERIFY" "manifest has no backup_id."
  [ "${M[manifest_version]:-}" = "4" ] || die "$BACKUP_EXIT_VERIFY" \
    "manifest_version='${M[manifest_version]:-}' (expected 4)."
  [ "${M[encryption_status]:-}" = "encrypted" ] || die "$BACKUP_EXIT_VERIFY" \
    "encryption_status='${M[encryption_status]:-}' (expected encrypted)."
  [ -n "${M[consistency_mode]:-}" ] || die "$BACKUP_EXIT_VERIFY" "manifest has no consistency_mode."
  [ -n "${M[storage_files_checksums]:-}" ] || die "$BACKUP_EXIT_VERIFY" \
    "format 4 manifest has no storage_files_checksums."
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
file_bytes() { wc -c < "$1" | tr -d ' '; }

DECLARED=""
check_artifact() {
  label="$1" name="$2" want_sha="$3" want_bytes="$4"
  case "$name" in
    ''|none) return 0 ;;
    */*|*..*) die "$BACKUP_EXIT_VERIFY" "$label path '$name' is not a plain filename." ;;
    *.age) : ;;
    *) die "$BACKUP_EXIT_VERIFY" "$label artifact '$name' is not age-encrypted." ;;
  esac
  path="${SET_DIR}/${name}"
  [ -f "$path" ] || die "$BACKUP_EXIT_VERIFY" "$label artifact '$name' is missing."
  [ -s "$path" ] || die "$BACKUP_EXIT_VERIFY" "$label artifact '$name' is empty."
  bytes="$(file_bytes "$path")"
  case "$want_bytes" in
    ''|none|0) : ;;
    *[!0-9]*) die "$BACKUP_EXIT_VERIFY" "$label size '$want_bytes' is not numeric." ;;
    *) [ "$bytes" = "$want_bytes" ] || die "$BACKUP_EXIT_VERIFY" \
         "$label size mismatch for '$name': manifest $want_bytes, actual $bytes." ;;
  esac
  if [ -n "$want_sha" ] && [ "$want_sha" != "none" ]; then
    [ "$(sha256_of "$path")" = "$want_sha" ] || die "$BACKUP_EXIT_VERIFY" \
      "$label SHA-256 mismatch for '$name'."
  fi
  DECLARED="${DECLARED} ${name}"
}

check_artifact "database" "${M[database_dump]}" "${M[database_sha256]:-}" "${M[database_bytes]:-}"
check_artifact "storage" "${M[storage_archive]}" "${M[storage_sha256]:-}" "${M[storage_bytes]:-}"
if [ "$FMT" = "4" ]; then
  check_artifact "storage-file-checksums" "${M[storage_files_checksums]}" \
    "${M[storage_files_checksums_sha256]:-}" "${M[storage_files_checksums_bytes]:-}"
fi
check_artifact "evolution" "${M[evolution_archive]:-}" "${M[evolution_sha256]:-}" "${M[evolution_bytes]:-}"
for archive in ${M[caddy_archives]:-}; do
  [ "$archive" = "none" ] && continue
  check_artifact "caddy" "$archive" "" ""
done

# Reject malformed checksum lines as well as checksum mismatches: sha256sum -c
# treats a mix of valid and malformed lines as success.
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  printf '%s\n' "$line" | grep -Eq '^[0-9a-f]{64} ( |\*).+$' || \
    die "$BACKUP_EXIT_VERIFY" "SHA256SUMS in '$SET_DIR' has a malformed line."
done < "$SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$SET_DIR" && sha256sum -c SHA256SUMS ) >/dev/null 2>&1 || \
    die "$BACKUP_EXIT_VERIFY" "SHA256SUMS verification failed for '$SET_DIR'."
else
  ( cd "$SET_DIR" && shasum -a 256 -c SHA256SUMS ) >/dev/null 2>&1 || \
    die "$BACKUP_EXIT_VERIFY" "SHA256SUMS verification failed for '$SET_DIR'."
fi
for name in $DECLARED; do
  grep -q " ${name}\$" "$SUMS" || die "$BACKUP_EXIT_VERIFY" "SHA256SUMS does not list '$name'."
done
echo "Manifest and SHA-256 verification passed for backup ID '${M[backup_id]:-unknown}'."

# ---------------------------------------------------------------------------
# Decrypt into a temporary directory. The backup set remains read-only.
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clinic-restore.XXXXXX")" || die "$BACKUP_EXIT_IO" \
  "could not create a temporary restore directory."
DB_CREATED=0
DB_CREATED_THIS_RUN=0
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$DB_CREATED_THIS_RUN" = "1" ] && [ "$rc" -ne 0 ] && [ "$SKIP_DB" = "0" ]; then
    PGHOST="$PGHOST_ARG" PGPORT="$PGPORT_ARG" PGUSER="$PGUSER_ARG" PGDATABASE=postgres \
      psql -v ON_ERROR_STOP=1 -Atq \
      -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";" >/dev/null 2>&1 || \
      warn "could not drop failed target database '$TARGET_DB'; drop it manually."
  fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

decrypt_artifact() {
  encrypted="$1" plain="$2" label="$3"
  age -d -i "$KEY_FILE" -o "${TMP_DIR}/${plain}" "${SET_DIR}/${encrypted}" || \
    die "$BACKUP_EXIT_ENCRYPTION" \
      "decryption failed for ${label}; check that --key-file is the age private key for this set."
  [ -s "${TMP_DIR}/${plain}" ] || die "$BACKUP_EXIT_ENCRYPTION" \
    "decryption produced an empty ${label} file."
}

decrypt_artifact "${M[database_dump]}" "database.dump" "database"
decrypt_artifact "${M[storage_archive]}" "storage.tar.gz" "storage"
FILES_PLAIN=""
if [ "$FMT" = "4" ]; then
  decrypt_artifact "${M[storage_files_checksums]}" "storage-files.sha256" "storage file checksums"
  FILES_PLAIN="${TMP_DIR}/storage-files.sha256"
fi

if [ "$FMT" = "4" ]; then
  [ "$(sha256_of "${TMP_DIR}/database.dump")" = "${M[database_plain_sha256]}" ] || \
    die "$BACKUP_EXIT_VERIFY" "decrypted database checksum does not match the manifest."
  [ "$(sha256_of "${TMP_DIR}/storage.tar.gz")" = "${M[storage_plain_sha256]}" ] || \
    die "$BACKUP_EXIT_VERIFY" "decrypted storage archive checksum does not match the manifest."
  [ "$(sha256_of "$FILES_PLAIN")" = "${M[storage_files_checksums_plain_sha256]}" ] || \
    die "$BACKUP_EXIT_VERIFY" "decrypted storage file checksum list does not match the manifest."
fi
[ "$(head -c 5 "${TMP_DIR}/database.dump")" = "PGDMP" ] || die "$BACKUP_EXIT_VERIFY" \
  "decrypted database dump is not a PostgreSQL custom-format archive."
tar tzf "${TMP_DIR}/storage.tar.gz" >/dev/null 2>&1 || die "$BACKUP_EXIT_VERIFY" \
  "decrypted storage archive is not a readable gzip tar file."
if tar tzf "${TMP_DIR}/storage.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "$BACKUP_EXIT_VERIFY" "storage archive contains absolute or parent-traversal paths."
fi
echo "Decryption and decrypted-content verification passed."

export PGHOST="$PGHOST_ARG"
export PGPORT="$PGPORT_ARG"
export PGUSER="$PGUSER_ARG"

if [ "$SKIP_DB" = "0" ]; then
  existing_tables="$(PGDATABASE=postgres psql -Atq -c \
    "select count(*) from information_schema.tables where table_schema='public';")" || \
    die "$BACKUP_EXIT_RESTORE" "could not connect to the isolated PostgreSQL target."
  case "$existing_tables" in
    ''|*[!0-9]*) die "$BACKUP_EXIT_RESTORE" "unexpected table count from target server." ;;
  esac
  admin_count="$(PGDATABASE=postgres psql -Atq -c \
    "select count(*) from pg_database where datname='$TARGET_DB';")" || \
    die "$BACKUP_EXIT_RESTORE" "could not inspect target databases."
  if [ "$admin_count" != "0" ]; then
    target_tables="$(PGDATABASE="$TARGET_DB" psql -Atq -c \
      "select count(*) from information_schema.tables where table_schema='public';")" || \
      die "$BACKUP_EXIT_RESTORE" "could not inspect target database '$TARGET_DB'."
    [ "$target_tables" = "0" ] || die "$BACKUP_EXIT_RESTORE" \
      "target database '$TARGET_DB' is not empty; refusing to overwrite it."
  else
    PGDATABASE=postgres psql -v ON_ERROR_STOP=1 -Atq \
      -c "CREATE DATABASE \"${TARGET_DB}\";" >/dev/null || \
      die "$BACKUP_EXIT_RESTORE" "could not create isolated target database '$TARGET_DB'."
    DB_CREATED_THIS_RUN=1
  fi
  DB_CREATED=1

  echo "Restoring database into isolated target '$TARGET_DB'..."
  PGDATABASE="$TARGET_DB" pg_restore --no-owner --no-acl --single-transaction --exit-on-error \
    -d "$TARGET_DB" "${TMP_DIR}/database.dump" || \
    die "$BACKUP_EXIT_RESTORE" "pg_restore failed; the target database will be dropped."

  echo "Verifying restored database integrity..."
  restored_tables="$(PGDATABASE="$TARGET_DB" psql -Atq -c \
    "select count(*) from information_schema.tables where table_schema='public';")" || \
    die "$BACKUP_EXIT_RESTORE" "could not query the restored database."
  [ "$restored_tables" -gt 0 ] || die "$BACKUP_EXIT_RESTORE" \
    "restored database has no public tables."

  has_migrations="$(PGDATABASE="$TARGET_DB" psql -Atq -c \
    "select to_regclass('public.\"_prisma_migrations\"') is not null;")" || \
    die "$BACKUP_EXIT_RESTORE" "could not check the restored migration table."
  if [ "$has_migrations" = "t" ]; then
    failed_migrations="$(PGDATABASE="$TARGET_DB" psql -Atq -c \
      'select count(*) from "_prisma_migrations" where finished_at is null or rolled_back_at is not null;')"
    [ "$failed_migrations" = "0" ] || die "$BACKUP_EXIT_RESTORE" \
      "restored database has $failed_migrations unfinished or rolled-back migration(s)."
    migrations="$(PGDATABASE="$TARGET_DB" psql -Atq -c \
      'select count(*) from "_prisma_migrations";')"
    [ "$migrations" -gt 0 ] || die "$BACKUP_EXIT_RESTORE" \
      "restored database has no applied migrations."
    echo "  tables=$restored_tables migrations=$migrations"
  else
    warn "restored database has no _prisma_migrations table; clinic schema check is incomplete."
  fi
else
  echo "Database restore skipped (--skip-db)."
fi

if [ "$SKIP_STORAGE" = "0" ]; then
  echo "Restoring uploaded files into '$TARGET_DIR'..."
  if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ]; then
    tar xzf "${TMP_DIR}/storage.tar.gz" -C "$TARGET_DIR" --same-permissions --same-owner
  else
    tar xzf "${TMP_DIR}/storage.tar.gz" -C "$TARGET_DIR" --same-permissions
  fi
  if [ -n "$FILES_PLAIN" ]; then
    ( cd "$TARGET_DIR" && sha256sum -c "$FILES_PLAIN" ) >/dev/null 2>&1 || \
      die "$BACKUP_EXIT_VERIFY" \
        "restored files do not match the per-file checksums from the backup set."
    echo "  files=$(wc -l < "$FILES_PLAIN" | tr -d ' ') checksums verified"
  else
    warn "format 3 set has no per-file checksum list; directory structure was restored but file contents were not checksum-verified."
  fi
else
  echo "Storage restore skipped (--skip-storage)."
fi

END_EPOCH="$(date -u +%s)"
echo "RESTORE SUCCESS"
echo "  backup_id: ${M[backup_id]:-unknown}"
echo "  target_db: ${TARGET_DB:-skipped}"
echo "  target_dir: $TARGET_DIR"
echo "  duration_seconds: $((END_EPOCH - START_EPOCH))"
