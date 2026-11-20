#!/usr/bin/env bash
# Create a consistent, verifiable backup of the database and persistent volumes.
#
#   ./scripts/backup.sh
#
# Outputs are written to backups/ (mode 0700) as one complete set:
#   db-<stamp>.dump[.age]
#   storage-<stamp>.tar.gz[.age]
#   evolution-<stamp>.tar.gz[.age]          (if the volume exists)
#   <caddy-volume>-<stamp>.tar.gz[.age]     (if the TLS overlay volume exists)
#   SHA256SUMS-<stamp>.txt
#   MANIFEST-<stamp>.txt
#
# Backups contain PHI. Configure BACKUP_AGE_RECIPIENT to encrypt them and
# BACKUP_OFFSITE_REMOTE to copy the set off-host with rclone. This script never
# deletes old backups; retention is an operator/policy decision.
#
# Exit status is non-zero on any failure. A failed run leaves no partial set in
# BACKUP_DIR: artifacts are staged in a temporary directory and published only
# after checksums pass.
set -euo pipefail

# Git Bash converts container paths such as /data into C:\... unless disabled.
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-backups}"
MOUNT_POINT="${BACKUP_MOUNT_POINT:-}"
REQUIRE_MOUNT="${BACKUP_REQUIRE_MOUNT:-0}"
DB_SERVICE="${DB_SERVICE:-db}"
STORAGE_VOLUME="${STORAGE_VOLUME:-ultrasound_clinic_storage}"
EVOLUTION_VOLUME="${EVOLUTION_VOLUME:-ultrasound_clinic_evolution_instances}"
CADDY_VOLUMES="${CADDY_VOLUMES:-ultrasound_clinic_caddy_data ultrasound_clinic_caddy_config}"
ENCRYPT_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
REQUIRE_ENCRYPTION="${BACKUP_REQUIRE_ENCRYPTION:-0}"
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
QUIESCE_SERVICES="${BACKUP_QUIESCE_SERVICES:-}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

sha256_write() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

sha256_check_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c -
  else
    shasum -a 256 -c -
  fi
}

sha256_one() {
  sha256_write "$1" | awk '{print $1}'
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

volume_exists() {
  docker volume inspect "$1" >/dev/null 2>&1
}

archive_volume() {
  volume="$1"
  archive="$2"
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
  if [ -z "$ENCRYPT_RECIPIENT" ]; then
    basename "$src"
    return 0
  fi
  command -v age >/dev/null 2>&1 || die \
    "BACKUP_AGE_RECIPIENT is set but 'age' is not installed. Install age or unset the variable."
  age -r "$ENCRYPT_RECIPIENT" -o "${src}.age" "$src"
  [ -s "${src}.age" ] || die "age produced an empty file for '$(basename "$src")'."
  rm -f "$src"
  basename "${src}.age"
}

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not available."

if [ "$REQUIRE_ENCRYPTION" = "1" ] && [ -z "$ENCRYPT_RECIPIENT" ]; then
  die "BACKUP_REQUIRE_ENCRYPTION=1 but BACKUP_AGE_RECIPIENT is empty; refusing to write plaintext PHI."
fi
if [ -n "$ENCRYPT_RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || die \
    "BACKUP_AGE_RECIPIENT is set but 'age' is not installed. Install age or unset the variable."
fi
if [ -n "$OFFSITE_REMOTE" ]; then
  command -v rclone >/dev/null 2>&1 || die \
    "BACKUP_OFFSITE_REMOTE is set but 'rclone' is not installed. Install rclone or unset the variable."
  if [ -z "$ENCRYPT_RECIPIENT" ]; then
    warn "off-site copy is configured without encryption; PHI will leave this host in plaintext."
  fi
fi
if [ -z "$ENCRYPT_RECIPIENT" ]; then
  warn "BACKUP_AGE_RECIPIENT is not set; backup artifacts will be written UNENCRYPTED."
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"

# On the production Ubuntu host the backup destination is a dedicated external
# USB HDD. Refuse to write anywhere else if the mount is required but absent.
if [ "$REQUIRE_MOUNT" = "1" ]; then
  [ -n "$MOUNT_POINT" ] || die \
    "BACKUP_REQUIRE_MOUNT=1 but BACKUP_MOUNT_POINT is empty; refusing to write backups."
  command -v mountpoint >/dev/null 2>&1 || die \
    "mountpoint is required when BACKUP_REQUIRE_MOUNT=1, but it is not installed."
  mountpoint -q "$MOUNT_POINT" || die \
    "required backup mount '$MOUNT_POINT' is not mounted; refusing to write backups to the internal disk."
  case "$OUT_DIR_ABS/" in
    "$MOUNT_POINT"/*) ;;
    *) die "BACKUP_DIR '$OUT_DIR_ABS' is not under required mount '$MOUNT_POINT'." ;;
  esac
fi

STAGE="${OUT_DIR_ABS}/.stage-${STAMP}"
mkdir -p "$STAGE"

RESTART_SERVICES=0
cleanup() {
  rc=$?
  trap - EXIT
  if [ "$RESTART_SERVICES" = "1" ]; then
    # shellcheck disable=SC2086
    docker compose start $QUIESCE_SERVICES >/dev/null 2>&1 || \
      warn "could not restart quiesced services: $QUIESCE_SERVICES"
  fi
  rm -rf "$STAGE"
  exit "$rc"
}
trap cleanup EXIT

available_kb="$(df -Pk "$OUT_DIR_ABS" | awk 'NR==2 {print $4}')"
case "$available_kb" in
  ''|*[!0-9]*) die "could not determine free space for $OUT_DIR_ABS" ;;
esac
if [ "$available_kb" -lt $((MIN_FREE_MB * 1024)) ]; then
  die "not enough free space in $OUT_DIR_ABS: ${available_kb} KB available, ${MIN_FREE_MB} MB required (set BACKUP_MIN_FREE_MB to override)."
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
  # Mark before stopping so a partial/failed stop is still recovered by cleanup.
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
if [ -z "$CADDY_ARCHIVES" ]; then
  warn "no Caddy volumes found (checked: $CADDY_VOLUMES); TLS state is not in this backup set."
fi

DB_REL="$(encrypt_artifact "$STAGE/db-${STAMP}.dump")"
STORAGE_REL="$(encrypt_artifact "$STAGE/storage-${STAMP}.tar.gz")"
if [ "$EVOLUTION_ARCHIVE" != "none" ]; then
  EVOLUTION_REL="$(encrypt_artifact "$STAGE/evolution-${STAMP}.tar.gz")"
else
  EVOLUTION_REL="none"
fi

CADDY_RELS=""
for archive in $CADDY_ARCHIVES; do
  rel="$(encrypt_artifact "$STAGE/$archive")"
  CADDY_RELS="${CADDY_RELS} ${rel}"
done
CADDY_RELS="${CADDY_RELS# }"
[ -n "$CADDY_RELS" ] || CADDY_RELS="none"

ARTIFACTS="$DB_REL $STORAGE_REL"
if [ "$EVOLUTION_REL" != "none" ]; then
  ARTIFACTS="$ARTIFACTS $EVOLUTION_REL"
fi
if [ "$CADDY_RELS" != "none" ]; then
  ARTIFACTS="$ARTIFACTS $CADDY_RELS"
fi

echo "Computing and verifying checksums..."
(
  cd "$STAGE"
  # shellcheck disable=SC2086
  sha256_write $ARTIFACTS > "SHA256SUMS-${STAMP}.txt"
  sha256_check_stdin < "SHA256SUMS-${STAMP}.txt"
)

DB_SHA="$(sha256_one "$STAGE/$DB_REL")"
STORAGE_SHA="$(sha256_one "$STAGE/$STORAGE_REL")"
DB_BYTES="$(file_bytes "$STAGE/$DB_REL")"
STORAGE_BYTES="$(file_bytes "$STAGE/$STORAGE_REL")"
EVOLUTION_SHA="none"
EVOLUTION_BYTES="0"
if [ "$EVOLUTION_REL" != "none" ]; then
  EVOLUTION_SHA="$(sha256_one "$STAGE/$EVOLUTION_REL")"
  EVOLUTION_BYTES="$(file_bytes "$STAGE/$EVOLUTION_REL")"
fi

cat > "$STAGE/MANIFEST-${STAMP}.txt" <<EOF_MANIFEST
created_utc=${STAMP}
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
checksums=SHA256SUMS-${STAMP}.txt
encryption=$([ -n "$ENCRYPT_RECIPIENT" ] && echo age || echo none)
postgres_version=${PG_VERSION}
git_commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
backup_format=2
EOF_MANIFEST

echo "Publishing backup set atomically..."
for name in $ARTIFACTS "SHA256SUMS-${STAMP}.txt"; do
  mv "$STAGE/$name" "$OUT_DIR_ABS/$name"
done
# Publish the manifest last; its presence marks a complete set.
mv "$STAGE/MANIFEST-${STAMP}.txt" "$OUT_DIR_ABS/MANIFEST-${STAMP}.txt"
rmdir "$STAGE" 2>/dev/null || true

if [ -n "$OFFSITE_REMOTE" ]; then
  echo "Copying backup set to off-site target..."
  rclone copy "$OUT_DIR_ABS" "$OFFSITE_REMOTE" --include "*-${STAMP}*" --checksum
  rclone check "$OUT_DIR_ABS" "$OFFSITE_REMOTE" --include "*-${STAMP}*" --one-way
  echo "Off-site copy verified."
fi

echo "Backup complete: $OUT_DIR_ABS/MANIFEST-${STAMP}.txt"
if [ -z "$ENCRYPT_RECIPIENT" ]; then
  echo "WARNING: this set is unencrypted. Encrypt it before copying off-host." >&2
else
  echo "Set is encrypted with age. Store the private key separately from the backups."
fi
