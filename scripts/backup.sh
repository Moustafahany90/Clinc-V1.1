#!/usr/bin/env bash
# Create a consistent, verifiable, ENCRYPTED backup of the database and volumes.
#
#   ./scripts/backup.sh
#
# Destination convention (verified on the Ubuntu host in Phase 8.3.1):
#   /mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>[-<label>]/
#       db-<STAMP>.dump.age
#       storage-<STAMP>.tar.gz.age
#       evolution-<STAMP>.tar.gz.age          (if the volume exists)
#       <caddy-volume>-<STAMP>.tar.gz.age     (if the TLS volumes exist)
#       SHA256SUMS
#       MANIFEST.txt                          (written last; marks a complete set)
#
# Storage is fail-closed: the mount, its UUID, filesystem, required directory
# structure, destination containment and writability are validated BEFORE any
# backup directory is created. Plaintext backups are never produced.
#
# This script never deletes old backups or touches quarantined artifacts. The
# only directory it removes is the set directory created by THIS run if the run
# fails. Retention is an operator/policy decision; no automatic deletion exists.
set -euo pipefail

# Git Bash converts container paths such as /data into C:\... unless disabled.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

cd "${SCRIPT_DIR}/.."
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_SERVICE="${DB_SERVICE:-db}"
STORAGE_VOLUME="${STORAGE_VOLUME:-ultrasound_clinic_storage}"
EVOLUTION_VOLUME="${EVOLUTION_VOLUME:-ultrasound_clinic_evolution_instances}"
CADDY_VOLUMES="${CADDY_VOLUMES:-ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config}"
ENCRYPT_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-1}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
QUIESCE_SERVICES="${BACKUP_QUIESCE_SERVICES:-}"
BACKUP_LABEL="${BACKUP_LABEL:-}"

die() { backup_die "$@"; }
warn() { echo "WARNING: $*" >&2; }

case "$BACKUP_TIER" in
  daily|weekly|monthly) ;;
  *) die "BACKUP_TIER='$BACKUP_TIER' is invalid; expected daily, weekly or monthly." ;;
esac

case "$REQUIRE_ENCRYPTION" in
  1|"") ;;
  *) die "BACKUP_REQUIRE_ENCRYPTION='$REQUIRE_ENCRYPTION' is not supported; encryption is mandatory." ;;
esac
[ -n "$ENCRYPT_RECIPIENT" ] || die \
  "BACKUP_AGE_RECIPIENT is empty; refusing to write plaintext PHI."
command -v age >/dev/null 2>&1 || die \
  "BACKUP_AGE_RECIPIENT is set but 'age' is not installed."
case "$ENCRYPT_RECIPIENT" in
  age1*) ;;
  *) die "BACKUP_AGE_RECIPIENT is not a valid age public recipient (must start with 'age1')." ;;
esac
if [ -n "$OFFSITE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || die \
    "BACKUP_OFFSITE_REMOTE is set but 'rclone' is not installed."
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not available."

TIER_DIR="${BACKUP_ROOT}/${BACKUP_TIER}"

# Validate the mounted disk and destination BEFORE creating any directory.
backup_require_storage "$TIER_DIR"

SET_NAME="clinic-${BACKUP_TIER}-${STAMP}"
if [ -n "$BACKUP_LABEL" ]; then
  safe_label="$(printf '%s' "$BACKUP_LABEL" | tr -c 'A-Za-z0-9._-' '_')"
  SET_NAME="${SET_NAME}-${safe_label}"
fi
SET_DIR="${TIER_DIR}/${SET_NAME}"
[ ! -e "$SET_DIR" ] || die "backup set directory '$SET_DIR' already exists; refusing to overwrite."

STAGE="${SET_DIR}/.stage-$$"
CREATED_SET=0
RESTART_SERVICES=0
cleanup() {
  rc=$?
  trap - EXIT
  if [ "$RESTART_SERVICES" = "1" ]; then
    # shellcheck disable=SC2086
    docker compose start $QUIESCE_SERVICES >/dev/null 2>&1 || \
      warn "could not restart quiesced services: $QUIESCE_SERVICES"
  fi
  [ -z "${STAGE:-}" ] || rm -rf "$STAGE" 2>/dev/null || true
  if [ "$rc" -ne 0 ] && [ "$CREATED_SET" = "1" ]; then
    # Remove only the set directory this run created; never touch older sets.
    rm -rf "$SET_DIR" 2>/dev/null || true
  fi
  if [ "$rc" -eq 0 ]; then
    printf '%s backup %s published: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SET_NAME" \
      >> "${BACKUP_ROOT}/logs/backup-${BACKUP_TIER}.log" 2>/dev/null || true
  fi
  exit "$rc"
}

mkdir -p "$SET_DIR"
CREATED_SET=1
chmod 700 "$SET_DIR" 2>/dev/null || true
mkdir -p "$STAGE"
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
  [ -s "${STAGE}/${archive}" ] || die "volume archive '${archive}' is empty."
  if command -v tar >/dev/null 2>&1; then
    tar tzf "${STAGE}/${archive}" >/dev/null 2>&1 || die \
      "volume archive '${archive}' is not a readable gzip tar file."
  fi
}

encrypt_artifact() {
  src="$1"
  age -r "$ENCRYPT_RECIPIENT" -o "${src}.age" "$src"
  [ -s "${src}.age" ] || die "age produced an empty file for '$(basename "$src")'."
  rm -f "$src"
  basename "${src}.age"
}

available_kb="$(df -Pk "$TIER_DIR" | awk 'NR==2 {print $4}')"
case "$available_kb" in
  ''|*[!0-9]*) die "could not determine free space for $TIER_DIR" ;;
esac
if [ "$available_kb" -lt $((MIN_FREE_MB * 1024)) ]; then
  die "not enough free space in $TIER_DIR: ${available_kb} KB available, ${MIN_FREE_MB} MB required."
fi

volume_exists "$STORAGE_VOLUME" || die \
  "storage volume '$STORAGE_VOLUME' not found. Set STORAGE_VOLUME or start the stack."

DB_NAME="$(docker compose exec -T "$DB_SERVICE" printenv POSTGRES_DB | tr -d '\r')"
DB_USER="$(docker compose exec -T "$DB_SERVICE" printenv POSTGRES_USER | tr -d '\r')"
[ -n "$DB_NAME" ] || die "could not determine POSTGRES_DB from the '$DB_SERVICE' service."
[ -n "$DB_USER" ] || die "could not determine POSTGRES_USER from the '$DB_SERVICE' service."

PG_VERSION="$(docker compose exec -T "$DB_SERVICE" \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show server_version"')" || \
  die "could not query the PostgreSQL version from the '$DB_SERVICE' service."
PG_VERSION="$(printf '%s' "$PG_VERSION" | tr -d '\r')"
DB_SIZE_BYTES="$(docker compose exec -T "$DB_SERVICE" \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_database_size(current_database())"')" || \
  die "could not query the database size from the '$DB_SERVICE' service."
DB_SIZE_BYTES="$(printf '%s' "$DB_SIZE_BYTES" | tr -d '\r')"
[ -n "$PG_VERSION" ] || die "the PostgreSQL version query returned no value."
[ -n "$DB_SIZE_BYTES" ] || die "the database size query returned no value."

if [ -n "$QUIESCE_SERVICES" ]; then
  case " $QUIESCE_SERVICES " in
    *" $DB_SERVICE "*) die "BACKUP_QUIESCE_SERVICES must not include the database service '$DB_SERVICE'." ;;
  esac
  echo "Stopping writers for a consistent backup: $QUIESCE_SERVICES"
  RESTART_SERVICES=1
  # shellcheck disable=SC2086
  docker compose stop $QUIESCE_SERVICES
fi

echo "Backing up database '$DB_NAME'..."
docker compose exec -T "$DB_SERVICE" \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$STAGE/db-${STAMP}.dump"
[ -s "$STAGE/db-${STAMP}.dump" ] || die "database dump is empty."

echo "Backing up uploaded files from '$STORAGE_VOLUME'..."
archive_volume "$STORAGE_VOLUME" "storage-${STAMP}.tar.gz"

EVOLUTION_ARCHIVE="none"
if volume_exists "$EVOLUTION_VOLUME"; then
  echo "Backing up Evolution session state from '$EVOLUTION_VOLUME'..."
  archive_volume "$EVOLUTION_VOLUME" "evolution-${STAMP}.tar.gz"
  EVOLUTION_ARCHIVE="evolution-${STAMP}.tar.gz"
else
  warn "Evolution volume '$EVOLUTION_VOLUME' not found; the backup set will not contain WhatsApp session state."
fi

CADDY_ARCHIVES=""
for volume in $CADDY_VOLUMES; do
  [ -n "$volume" ] || continue
  if volume_exists "$volume"; then
    safe_name="$(printf '%s' "$volume" | tr -c 'A-Za-z0-9._-' '_')"
    echo "Backing up TLS state from '$volume'..."
    archive_volume "$volume" "${safe_name}-${STAMP}.tar.gz"
    CADDY_ARCHIVES="${CADDY_ARCHIVES} ${safe_name}-${STAMP}.tar.gz"
  fi
done
CADDY_ARCHIVES="${CADDY_ARCHIVES# }"
[ -n "$CADDY_ARCHIVES" ] || warn "no Caddy volumes found; TLS state is not in this backup set."

DB_REL="$(encrypt_artifact "$STAGE/db-${STAMP}.dump")"
STORAGE_REL="$(encrypt_artifact "$STAGE/storage-${STAMP}.tar.gz")"
EVOLUTION_REL="none"
if [ "$EVOLUTION_ARCHIVE" != "none" ]; then
  EVOLUTION_REL="$(encrypt_artifact "$STAGE/evolution-${STAMP}.tar.gz")"
fi

CADDY_RELS=""
for archive in $CADDY_ARCHIVES; do
  rel="$(encrypt_artifact "$STAGE/$archive")"
  CADDY_RELS="${CADDY_RELS} ${rel}"
done
CADDY_RELS="${CADDY_RELS# }"
[ -n "$CADDY_RELS" ] || CADDY_RELS="none"

ARTIFACTS="$DB_REL $STORAGE_REL"
[ "$EVOLUTION_REL" != "none" ] && ARTIFACTS="$ARTIFACTS $EVOLUTION_REL"
[ "$CADDY_RELS" != "none" ] && ARTIFACTS="$ARTIFACTS $CADDY_RELS"

echo "Computing and verifying checksums..."
(
  cd "$STAGE"
  # shellcheck disable=SC2086
  sha256_write $ARTIFACTS > "SHA256SUMS"
  sha256_check_stdin < "SHA256SUMS"
)

DB_SHA="$(sha256_one "$STAGE/$DB_REL")"
STORAGE_SHA="$(sha256_one "$STAGE/$STORAGE_REL")"
DB_BYTES="$(file_bytes "$STAGE/$DB_REL")"
STORAGE_BYTES="$(file_bytes "$STAGE/$STORAGE_REL")"
EVOLUTION_SHA="none"; EVOLUTION_BYTES="0"
if [ "$EVOLUTION_REL" != "none" ]; then
  EVOLUTION_SHA="$(sha256_one "$STAGE/$EVOLUTION_REL")"
  EVOLUTION_BYTES="$(file_bytes "$STAGE/$EVOLUTION_REL")"
fi

cat > "$STAGE/MANIFEST.txt" <<EOF_MANIFEST
created_utc=${STAMP}
backup_root=${BACKUP_ROOT}
backup_tier=${BACKUP_TIER}
set_directory=${SET_NAME}
mount_uuid=${BACKUP_MOUNT_UUID}
filesystem=${BACKUP_MOUNT_FSTYPE}
database_name=${DB_NAME}
database_dump=${DB_REL}
database_sha256=${DB_SHA}
database_bytes=${DB_BYTES}
database_size_bytes=${DB_SIZE_BYTES}
storage_archive=${STORAGE_REL}
storage_sha256=${STORAGE_SHA}
storage_bytes=${STORAGE_BYTES}
storage_volume=${STORAGE_VOLUME}
evolution_archive=${EVOLUTION_REL}
evolution_sha256=${EVOLUTION_SHA}
evolution_bytes=${EVOLUTION_BYTES}
evolution_volume=${EVOLUTION_VOLUME}
caddy_archives=${CADDY_RELS}
checksums=SHA256SUMS
encryption=age
postgres_version=${PG_VERSION}
git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
backup_format=3
EOF_MANIFEST

echo "Publishing backup set atomically..."
for name in $ARTIFACTS "SHA256SUMS"; do
  mv "$STAGE/$name" "$SET_DIR/$name"
done
# Publish the manifest last; its presence marks a complete set.
mv "$STAGE/MANIFEST.txt" "$SET_DIR/MANIFEST.txt"
rmdir "$STAGE" 2>/dev/null || true

if [ -n "$OFFSITE_REMOTE" ]; then
  echo "Copying backup set to off-site target..."
  rclone copy "$SET_DIR" "$OFFSITE_REMOTE/${SET_NAME}" --checksum
  rclone check "$SET_DIR" "$OFFSITE_REMOTE/${SET_NAME}" --one-way
  echo "Off-site copy verified."
fi

echo "Backup complete: $SET_DIR/MANIFEST.txt"
echo "Set is encrypted with age. Store the private key separately from the backups."
