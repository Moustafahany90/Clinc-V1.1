#!/usr/bin/env bash
# Create a consistent, verifiable, ENCRYPTED backup of the database and volumes.
#
#   ./scripts/backup.sh
#
# Destination convention (verified on the Ubuntu host in Phase 8.3.1):
#   /mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>[-<label>]/
#       db-<STAMP>.dump.age
#       storage-<STAMP>.tar.gz.age
#       storage-files-<STAMP>.sha256.age
#       evolution-<STAMP>.tar.gz.age          (if the volume exists)
#       <caddy-volume>-<STAMP>.tar.gz.age     (if the TLS volumes exist)
#       SHA256SUMS
#       MANIFEST.txt                          (written last; marks a complete set)
#
# Fail-closed rules: the mount, UUID, filesystem, required directory structure,
# destination containment, writability, free space, writer quiescence and age
# recipient are all validated before any artifact is produced. Artifacts are
# built in a hidden staging directory OUTSIDE the published set and the set is
# published with a single directory rename only after checksums and the manifest
# are complete. Plaintext artifacts are removed immediately after encryption.
# No old set is ever deleted by this script; use backup-retention.sh explicitly.
set -euo pipefail

# Git Bash converts container paths such as /data into C:\... unless disabled.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

cd "${SCRIPT_DIR}/.."
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ID="$(backup_new_id)"
DB_SERVICE="${DB_SERVICE:-db}"
STORAGE_VOLUME="${STORAGE_VOLUME:-ultrasound_clinic_storage}"
EVOLUTION_VOLUME="${EVOLUTION_VOLUME:-ultrasound_clinic_evolution_instances}"
CADDY_VOLUMES="${CADDY_VOLUMES:-ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config}"
ENCRYPT_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-1}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
QUIESCE_SERVICES="${BACKUP_QUIESCE_SERVICES:-backend web evolution}"
ALLOW_WRITER_DRIFT="${BACKUP_ALLOW_WRITER_DRIFT:-0}"
BACKUP_LABEL="${BACKUP_LABEL:-}"
SOURCE_MODE="${BACKUP_SOURCE_MODE:-docker}"
STORAGE_DIR="${BACKUP_STORAGE_DIR:-}"
TEST_MODE="${BACKUP_TEST_MODE:-0}"

die() { backup_die "$@"; }
warn() { echo "WARNING: $*" >&2; }

case "$BACKUP_TIER" in
  daily|weekly|monthly) ;;
  *) die "$BACKUP_EXIT_USAGE" "BACKUP_TIER='$BACKUP_TIER' is invalid; expected daily, weekly or monthly." ;;
esac

case "$SOURCE_MODE" in
  docker|local) ;;
  *) die "$BACKUP_EXIT_USAGE" "BACKUP_SOURCE_MODE='$SOURCE_MODE' is invalid; expected docker or local." ;;
esac

if [ "$SOURCE_MODE" = "local" ] && [ "$TEST_MODE" != "1" ]; then
  die "$BACKUP_EXIT_PRECHECK" \
    "BACKUP_SOURCE_MODE=local is an isolated test mode only; set BACKUP_TEST_MODE=1 in a disposable environment."
fi

case "$REQUIRE_ENCRYPTION" in
  1|"") ;;
  *) die "$BACKUP_EXIT_USAGE" \
       "BACKUP_REQUIRE_ENCRYPTION='$REQUIRE_ENCRYPTION' is not supported; encryption is mandatory." ;;
esac
[ -n "$ENCRYPT_RECIPIENT" ] || die "$BACKUP_EXIT_PRECHECK" \
  "BACKUP_AGE_RECIPIENT is empty; refusing to write plaintext PHI."
command -v age >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
  "BACKUP_AGE_RECIPIENT is set but 'age' is not installed."
case "$ENCRYPT_RECIPIENT" in
  age1*) ;;
  *) die "$BACKUP_EXIT_PRECHECK" \
       "BACKUP_AGE_RECIPIENT is not a valid age public recipient (must start with 'age1')." ;;
esac
if [ -n "$OFFSITE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "BACKUP_OFFSITE_REMOTE is set but 'rclone' is not installed."
fi

if [ "$SOURCE_MODE" = "docker" ]; then
  command -v docker >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" "docker is not installed or not on PATH."
  docker compose version >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "the Docker Compose plugin is not available."
else
  command -v psql >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "psql is required for BACKUP_SOURCE_MODE=local."
  command -v pg_dump >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "pg_dump is required for BACKUP_SOURCE_MODE=local."
  [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
    "BACKUP_STORAGE_DIR must be an existing directory in local source mode."
  : "${PGHOST:?PGHOST must name the isolated target host in local source mode}"
  : "${PGPORT:?PGPORT must name the isolated target port in local source mode}"
  : "${PGUSER:?PGUSER must name the isolated target user in local source mode}"
  : "${PGDATABASE:?PGDATABASE must name the isolated source database in local source mode}"
fi

case "$QUIESCE_SERVICES" in
  "") [ "$ALLOW_WRITER_DRIFT" = "1" ] || die "$BACKUP_EXIT_PRECHECK" \
        "BACKUP_QUIESCE_SERVICES is empty; set writers to stop, or set BACKUP_ALLOW_WRITER_DRIFT=1 only for an isolated/test source." ;;
  *) case " $QUIESCE_SERVICES " in
       *" $DB_SERVICE "*) die "$BACKUP_EXIT_PRECHECK" \
         "BACKUP_QUIESCE_SERVICES must not include the database service '$DB_SERVICE'." ;;
     esac ;;
esac

TIER_DIR="${BACKUP_ROOT}/${BACKUP_TIER}"

# Validate the destination BEFORE creating any directory. TEST_MODE is a narrow,
# synthetic-fixture override: it still enforces directory layout, containment
# and writability, but skips mountpoint/findmnt checks that require the real HDD.
if [ "$TEST_MODE" = "1" ]; then
  [ "$BACKUP_ROOT" != "/mnt/clinic-backups" ] || die "$BACKUP_EXIT_PRECHECK" \
    "BACKUP_TEST_MODE=1 refuses the production BACKUP_ROOT."
  for dir in $BACKUP_REQUIRED_DIRS; do
    [ -d "$BACKUP_ROOT/$dir" ] || die "$BACKUP_EXIT_PRECHECK" \
      "required backup directory '$BACKUP_ROOT/$dir' is missing."
  done
  root_c="$(backup_canonical "$BACKUP_ROOT")" || die "$BACKUP_EXIT_PRECHECK" \
    "could not resolve backup mount '$BACKUP_ROOT'."
  dest_c="$(backup_canonical "$TIER_DIR")" || die "$BACKUP_EXIT_PRECHECK" \
    "backup destination '$TIER_DIR' does not exist inside the mount."
  case "${dest_c}/" in
    "${root_c}/"*) : ;;
    *) die "$BACKUP_EXIT_PRECHECK" \
         "backup destination '$dest_c' resolves outside approved mount '$root_c'." ;;
  esac
  [ -w "$dest_c" ] || die "$BACKUP_EXIT_PRECHECK" \
    "backup destination '$dest_c' is not writable by the backup account."
  BACKUP_MOUNT_UUID="synthetic-test-mount"
  BACKUP_MOUNT_FSTYPE="synthetic"
  warn "mount validation skipped by BACKUP_TEST_MODE (test only)."
else
  backup_require_storage "$TIER_DIR"
fi

SET_NAME="clinic-${BACKUP_TIER}-${STAMP}"
if [ -n "$BACKUP_LABEL" ]; then
  safe_label="$(printf '%s' "$BACKUP_LABEL" | tr -c 'A-Za-z0-9._-' '_')"
  SET_NAME="${SET_NAME}-${safe_label}"
fi
SET_DIR="${TIER_DIR}/${SET_NAME}"
[ ! -e "$SET_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
  "backup set directory '$SET_DIR' already exists; refusing to overwrite."

# The published directory does not exist until every artifact is complete.
STAGE="${TIER_DIR}/.stage-${SET_NAME}-$$"
[ ! -e "$STAGE" ] || die "$BACKUP_EXIT_IO" "staging directory '$STAGE' already exists."
CREATED_STAGE=0
RESTART_SERVICES=0
RECIPIENT_TMP=""
mkdir -p "$STAGE"
CREATED_STAGE=1
chmod 700 "$STAGE" 2>/dev/null || true
RECIPIENT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/clinic-age-recipient.XXXXXX")" || die "$BACKUP_EXIT_IO" \
  "could not create a temporary directory for the age recipient."
chmod 700 "$RECIPIENT_TMP"
RECIPIENT_FILE="${RECIPIENT_TMP}/recipient.txt"
printf '%s\n' "$ENCRYPT_RECIPIENT" > "$RECIPIENT_FILE"
chmod 600 "$RECIPIENT_FILE"

cleanup() {
  rc=$?
  trap - EXIT
  if [ "$RESTART_SERVICES" = "1" ] && [ "$SOURCE_MODE" = "docker" ]; then
    # shellcheck disable=SC2086
    docker compose start $QUIESCE_SERVICES >/dev/null 2>&1 || \
      warn "could not restart quiesced services: $QUIESCE_SERVICES"
  fi
  [ -z "${RECIPIENT_TMP:-}" ] || rm -rf "$RECIPIENT_TMP" 2>/dev/null || true
  if [ "$CREATED_STAGE" = "1" ]; then
    # Remove only the staging directory created by THIS run.
    rm -rf "$STAGE" 2>/dev/null || true
  fi
  if [ "$rc" -eq 0 ]; then
    printf '%s backup %s published: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SET_NAME" \
      >> "${BACKUP_ROOT}/logs/backup-${BACKUP_TIER}.log" 2>/dev/null || true
  fi
  exit "$rc"
}
trap cleanup EXIT

sha256_write() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
sha256_check_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi
}
sha256_one() { sha256_write "$1" | awk '{print $1}'; }
file_bytes() { wc -c < "$1" | tr -d ' '; }

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

archive_volume() {
  volume="$1"; archive="$2"
  # Stream the archive to the host instead of bind-mounting the staging
  # directory: bind mounts of Git Bash paths are unreliable on Windows.
  docker run --rm \
    -v "${volume}:/data:ro" \
    alpine:3.22 \
    tar czf - -C /data . > "${STAGE}/${archive}"
  [ -s "${STAGE}/${archive}" ] || die "$BACKUP_EXIT_BACKUP" \
    "volume archive '${archive}' is empty."
  tar tzf "${STAGE}/${archive}" >/dev/null 2>&1 || die "$BACKUP_EXIT_VERIFY" \
    "volume archive '${archive}' is not a readable gzip tar file."
}

archive_storage_dir() {
  archive="$1"
  tar czf "${STAGE}/${archive}" -C "$STORAGE_DIR" .
  [ -s "${STAGE}/${archive}" ] || die "$BACKUP_EXIT_BACKUP" \
    "storage archive '${archive}' is empty."
  tar tzf "${STAGE}/${archive}" >/dev/null 2>&1 || die "$BACKUP_EXIT_VERIFY" \
    "storage archive '${archive}' is not a readable gzip tar file."
}

write_storage_file_checksums() {
  target="$1"
  if [ "$SOURCE_MODE" = "docker" ]; then
    docker run --rm \
      -v "${STORAGE_VOLUME}:/data:ro" \
      alpine:3.22 \
      sh -c 'cd /data && find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done' \
      > "$target"
  else
    ( cd "$STORAGE_DIR" && find . -type f -print | LC_ALL=C sort |
        while IFS= read -r f; do sha256sum "$f"; done ) > "$target"
  fi
  [ -f "$target" ] || die "$BACKUP_EXIT_BACKUP" "storage file checksum list was not created."
}

encrypt_artifact() {
  src="$1" encrypted_name="$2"
  age -R "$RECIPIENT_FILE" -o "${STAGE}/${encrypted_name}" "$src" || \
    die "$BACKUP_EXIT_ENCRYPTION" "age encryption failed for '$(basename "$src")'."
  [ -s "${STAGE}/${encrypted_name}" ] || die "$BACKUP_EXIT_ENCRYPTION" \
    "age produced an empty file for '$(basename "$src")'."
  rm -f "$src"
  printf '%s' "$encrypted_name"
}

available_kb="$(df -Pk "$TIER_DIR" | awk 'NR==2 {print $4}')"
case "$available_kb" in
  ''|*[!0-9]*) die "$BACKUP_EXIT_PRECHECK" "could not determine free space for $TIER_DIR" ;;
esac
if [ "$available_kb" -lt $((MIN_FREE_MB * 1024)) ]; then
  die "$BACKUP_EXIT_PRECHECK" \
    "not enough free space in $TIER_DIR: ${available_kb} KB available, ${MIN_FREE_MB} MB required."
fi

if [ "$SOURCE_MODE" = "docker" ]; then
  volume_exists "$STORAGE_VOLUME" || die "$BACKUP_EXIT_PRECHECK" \
    "storage volume '$STORAGE_VOLUME' not found. Set STORAGE_VOLUME or start the stack."
  DB_NAME="$(docker compose exec -T "$DB_SERVICE" printenv POSTGRES_DB | tr -d '\r')"
  DB_USER="$(docker compose exec -T "$DB_SERVICE" printenv POSTGRES_USER | tr -d '\r')"
  [ -n "$DB_NAME" ] || die "$BACKUP_EXIT_PRECHECK" \
    "could not determine POSTGRES_DB from the '$DB_SERVICE' service."
  [ -n "$DB_USER" ] || die "$BACKUP_EXIT_PRECHECK" \
    "could not determine POSTGRES_USER from the '$DB_SERVICE' service."
  PG_VERSION="$(docker compose exec -T "$DB_SERVICE" \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show server_version"')" || \
    die "$BACKUP_EXIT_PRECHECK" \
      "could not query the PostgreSQL version from the '$DB_SERVICE' service."
  DB_SIZE_BYTES="$(docker compose exec -T "$DB_SERVICE" \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_database_size(current_database())"')" || \
    die "$BACKUP_EXIT_PRECHECK" \
      "could not query the database size from the '$DB_SERVICE' service."
  WAL_LSN="$(docker compose exec -T "$DB_SERVICE" \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_current_wal_lsn()::text"' 2>/dev/null || true)"
else
  DB_NAME="$PGDATABASE"
  DB_USER="$PGUSER"
  PG_VERSION="$(psql -Atq -c 'show server_version')" || die "$BACKUP_EXIT_PRECHECK" \
    "could not query the PostgreSQL version from the isolated source."
  DB_SIZE_BYTES="$(psql -Atq -c 'select pg_database_size(current_database())')" || \
    die "$BACKUP_EXIT_PRECHECK" "could not query the isolated source database size."
  WAL_LSN="$(psql -Atq -c 'select pg_current_wal_lsn()::text' 2>/dev/null || true)"
fi
PG_VERSION="$(printf '%s' "$PG_VERSION" | tr -d '\r')"
DB_SIZE_BYTES="$(printf '%s' "$DB_SIZE_BYTES" | tr -d '\r')"
WAL_LSN="$(printf '%s' "$WAL_LSN" | tr -d '\r')"
[ -n "$PG_VERSION" ] || die "$BACKUP_EXIT_PRECHECK" "the PostgreSQL version query returned no value."
[ -n "$DB_SIZE_BYTES" ] || die "$BACKUP_EXIT_PRECHECK" "the database size query returned no value."
[ -n "$WAL_LSN" ] || WAL_LSN="unavailable"

if [ "$SOURCE_MODE" = "docker" ] && [ -n "$QUIESCE_SERVICES" ]; then
  echo "Stopping writers for a consistent backup: $QUIESCE_SERVICES"
  RESTART_SERVICES=1
  # shellcheck disable=SC2086
  docker compose stop $QUIESCE_SERVICES
  CONSISTENCY_MODE="quiesced-writers"
elif [ "$SOURCE_MODE" = "docker" ]; then
  CONSISTENCY_MODE="writer-drift-acknowledged"
else
  CONSISTENCY_MODE="isolated-local-source"
fi

DB_PLAIN="db-${STAMP}.dump"
echo "Backing up database '$DB_NAME'..."
if [ "$SOURCE_MODE" = "docker" ]; then
  docker compose exec -T "$DB_SERVICE" \
    sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl' \
    > "${STAGE}/${DB_PLAIN}"
else
  pg_dump -Fc --no-owner --no-acl -d "$DB_NAME" > "${STAGE}/${DB_PLAIN}"
fi
[ -s "${STAGE}/${DB_PLAIN}" ] || die "$BACKUP_EXIT_BACKUP" "database dump is empty."
[ "$(head -c 5 "${STAGE}/${DB_PLAIN}")" = "PGDMP" ] || die "$BACKUP_EXIT_VERIFY" \
  "database dump does not have the PostgreSQL custom-format header (PGDMP)."
DB_PLAIN_SHA="$(sha256_one "${STAGE}/${DB_PLAIN}")"
DB_PLAIN_BYTES="$(file_bytes "${STAGE}/${DB_PLAIN}")"

echo "Backing up uploaded files..."
STORAGE_PLAIN="storage-${STAMP}.tar.gz"
if [ "$SOURCE_MODE" = "docker" ]; then
  archive_volume "$STORAGE_VOLUME" "$STORAGE_PLAIN"
else
  archive_storage_dir "$STORAGE_PLAIN"
fi
STORAGE_PLAIN_SHA="$(sha256_one "${STAGE}/${STORAGE_PLAIN}")"
STORAGE_PLAIN_BYTES="$(file_bytes "${STAGE}/${STORAGE_PLAIN}")"

FILES_PLAIN="storage-files-${STAMP}.sha256"
write_storage_file_checksums "${STAGE}/${FILES_PLAIN}"
STORAGE_FILES_COUNT="$(wc -l < "${STAGE}/${FILES_PLAIN}" | tr -d ' ')"
STORAGE_FILES_PLAIN_SHA="$(sha256_one "${STAGE}/${FILES_PLAIN}")"

EVOLUTION_ARCHIVE="none"
if [ "$SOURCE_MODE" = "docker" ] && volume_exists "$EVOLUTION_VOLUME"; then
  echo "Backing up Evolution session state from '$EVOLUTION_VOLUME'..."
  archive_volume "$EVOLUTION_VOLUME" "evolution-${STAMP}.tar.gz"
  EVOLUTION_ARCHIVE="evolution-${STAMP}.tar.gz"
else
  warn "Evolution session state is not in this backup set."
fi

CADDY_ARCHIVES=""
if [ "$SOURCE_MODE" = "docker" ]; then
  for volume in $CADDY_VOLUMES; do
    [ -n "$volume" ] || continue
    if volume_exists "$volume"; then
      safe_name="$(printf '%s' "$volume" | tr -c 'A-Za-z0-9._-' '_')"
      echo "Backing up TLS state from '$volume'..."
      archive_volume "$volume" "${safe_name}-${STAMP}.tar.gz"
      CADDY_ARCHIVES="${CADDY_ARCHIVES} ${safe_name}-${STAMP}.tar.gz"
    fi
  done
fi
CADDY_ARCHIVES="${CADDY_ARCHIVES# }"
[ -n "$CADDY_ARCHIVES" ] || warn "no Caddy volumes found; TLS state is not in this backup set."

DB_REL="$(encrypt_artifact "$STAGE/${DB_PLAIN}" "db-${STAMP}.dump.age")"
STORAGE_REL="$(encrypt_artifact "$STAGE/${STORAGE_PLAIN}" "storage-${STAMP}.tar.gz.age")"
FILES_REL="$(encrypt_artifact "$STAGE/${FILES_PLAIN}" "storage-files-${STAMP}.sha256.age")"

EVOLUTION_REL="none"
if [ "$EVOLUTION_ARCHIVE" != "none" ]; then
  EVOLUTION_REL="$(encrypt_artifact "$STAGE/${EVOLUTION_ARCHIVE}" "evolution-${STAMP}.tar.gz.age")"
fi

CADDY_RELS=""
for archive in $CADDY_ARCHIVES; do
  encrypted="$(encrypt_artifact "$STAGE/$archive" "${archive}.age")"
  CADDY_RELS="${CADDY_RELS} ${encrypted}"
done
CADDY_RELS="${CADDY_RELS# }"
[ -n "$CADDY_RELS" ] || CADDY_RELS="none"

ARTIFACTS="$DB_REL $STORAGE_REL $FILES_REL"
[ "$EVOLUTION_REL" != "none" ] && ARTIFACTS="$ARTIFACTS $EVOLUTION_REL"
[ "$CADDY_RELS" != "none" ] && ARTIFACTS="$ARTIFACTS $CADDY_RELS"

DB_SHA="$(sha256_one "$STAGE/$DB_REL")"
STORAGE_SHA="$(sha256_one "$STAGE/$STORAGE_REL")"
FILES_SHA="$(sha256_one "$STAGE/$FILES_REL")"
DB_BYTES="$(file_bytes "$STAGE/$DB_REL")"
STORAGE_BYTES="$(file_bytes "$STAGE/$STORAGE_REL")"
FILES_BYTES="$(file_bytes "$STAGE/$FILES_REL")"

echo "Computing and verifying checksums..."
(
  cd "$STAGE"
  # shellcheck disable=SC2086
  sha256_write $ARTIFACTS > "SHA256SUMS"
  sha256_check_stdin < "SHA256SUMS"
)

EVOLUTION_SHA="none"; EVOLUTION_BYTES="0"
if [ "$EVOLUTION_REL" != "none" ]; then
  EVOLUTION_SHA="$(sha256_one "$STAGE/$EVOLUTION_REL")"
  EVOLUTION_BYTES="$(file_bytes "$STAGE/$EVOLUTION_REL")"
fi

cat > "${STAGE}/MANIFEST.txt" <<EOF_MANIFEST
backup_id=${BACKUP_ID}
backup_format=4
manifest_version=4
created_utc=${STAMP}
backup_root=${BACKUP_ROOT}
backup_tier=${BACKUP_TIER}
set_directory=${SET_NAME}
mount_uuid=${BACKUP_MOUNT_UUID}
filesystem=${BACKUP_MOUNT_FSTYPE}
database_name=${DB_NAME}
database_user=${DB_USER}
consistency_mode=${CONSISTENCY_MODE}
quiesced_services=${QUIESCE_SERVICES:-none}
wal_lsn_before_quiesce=${WAL_LSN}
database_dump=${DB_REL}
database_sha256=${DB_SHA}
database_bytes=${DB_BYTES}
database_plain_sha256=${DB_PLAIN_SHA}
database_plain_bytes=${DB_PLAIN_BYTES}
database_size_bytes=${DB_SIZE_BYTES}
storage_archive=${STORAGE_REL}
storage_sha256=${STORAGE_SHA}
storage_bytes=${STORAGE_BYTES}
storage_plain_sha256=${STORAGE_PLAIN_SHA}
storage_plain_bytes=${STORAGE_PLAIN_BYTES}
storage_volume=${STORAGE_VOLUME}
storage_files_checksums=${FILES_REL}
storage_files_checksums_sha256=${FILES_SHA}
storage_files_checksums_bytes=${FILES_BYTES}
storage_files_checksums_plain_sha256=${STORAGE_FILES_PLAIN_SHA}
storage_files_count=${STORAGE_FILES_COUNT}
evolution_archive=${EVOLUTION_REL}
evolution_sha256=${EVOLUTION_SHA}
evolution_bytes=${EVOLUTION_BYTES}
evolution_volume=${EVOLUTION_VOLUME}
caddy_archives=${CADDY_RELS}
checksums=SHA256SUMS
encryption=age
encryption_status=encrypted
postgres_version=${PG_VERSION}
git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
EOF_MANIFEST

# Final pre-publication gate: the manifest must not exist until every artifact,
# checksum and metadata value above is complete.
[ -s "${STAGE}/MANIFEST.txt" ] || die "$BACKUP_EXIT_VERIFY" \
  "manifest generation failed; refusing to publish."

echo "Publishing backup set atomically..."
mv "$STAGE" "$SET_DIR"
CREATED_STAGE=0

if [ -n "$OFFSITE_REMOTE" ]; then
  echo "Copying backup set to off-site target..."
  rclone copy "$SET_DIR" "$OFFSITE_REMOTE/${SET_NAME}" --checksum
  rclone check "$SET_DIR" "$OFFSITE_REMOTE/${SET_NAME}" --one-way
  echo "Off-site copy verified."
fi

echo "Backup complete: $SET_DIR/MANIFEST.txt"
echo "Backup ID: $BACKUP_ID"
echo "Set is encrypted with age. Store the private key separately from the backups."
