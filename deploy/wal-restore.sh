#!/bin/sh
# Phase 9.5 fail-closed WAL restore helper for PostgreSQL restore_command.
#
# This file is intentionally POSIX sh and self-contained so it also runs in a
# minimal environment. PostgreSQL calls it with two arguments:
#
#   restore_command = '/bin/sh /clinic/deploy/wal-restore.sh %f "%p"'
#
# It reads only the dedicated WAL archive, requires a matching SHA-256 sidecar,
# and publishes the file atomically into PostgreSQL's pg_wal directory. Missing
# or corrupt WAL returns non-zero with a clear, redacted error so recovery stops
# instead of silently skipping history.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
RESTORE_NAME=""
WAL_RESTORE_RESULT=error

wal_log() {
  wal_log_result=$1
  printf '%s wal_restore name=%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RESTORE_NAME:-unknown}" "$wal_log_result" >&2
}

wal_die() {
  wal_log fail
  printf 'BACKUP ERROR: %s\n' "$2" >&2
  exit "$1"
}

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: wal-restore.sh <wal-filename-%f> <pg-wal-target-path-%p>
Environment (all non-secret):
  WAL_ARCHIVE_DIR                    dedicated archive directory (required)
  WAL_SEGMENT_SIZE                   expected size of plain WAL segments
  WAL_ARCHIVE_SKIP_MOUNT_CHECK       1 only for isolated tests; default 0
  WAL_ARCHIVE_EXPECTED_UUID          optional expected filesystem UUID
  WAL_ARCHIVE_EXPECTED_FSTYPE        optional expected filesystem type
EOF_USAGE
}

wal_is_segment() {
  wal_name_check=${1:-}
  case "$wal_name_check" in
    ????????????????????????)
      case "$wal_name_check" in
        *[!0-9A-Fa-f]*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

wal_is_sha256() {
  wal_digest_check=${1:-}
  case "$wal_digest_check" in
    ????????????????????????????????????????????????????????????????)
      case "$wal_digest_check" in
        *[!0-9a-fA-F]*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

wal_file_bytes() {
  wc -c < "$1" | tr -d '[:space:]'
}

wal_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  fi
}

wal_is_mountpoint() {
  if command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$1" 2>/dev/null; then
    return 0
  fi
  [ -r /proc/self/mountinfo ] || return 1
  awk -v p="$1" '$5 == p { found = 1 } END { exit !found }' /proc/self/mountinfo
}

wal_fstype() {
  if command -v findmnt >/dev/null 2>&1; then
    findmnt -n -o FSTYPE -M "$1" 2>/dev/null | head -n 1
    return 0
  fi
  [ -r /proc/self/mounts ] || return 1
  awk -v p="$1" '$2 == p { print $3; exit }' /proc/self/mounts
}

wal_uuid() {
  wal_uuid_dir=$1
  wal_uuid_expected=$2
  if command -v findmnt >/dev/null 2>&1; then
    wal_uuid_actual=$(findmnt -n -o UUID -M "$wal_uuid_dir" 2>/dev/null | head -n 1)
    [ -n "$wal_uuid_actual" ] || return 1
    [ "$wal_uuid_actual" = "$wal_uuid_expected" ] || return 1
    printf '%s\n' "$wal_uuid_actual"
    return 0
  fi
  if [ -r /proc/self/mounts ] && [ -e "/dev/disk/by-uuid/$wal_uuid_expected" ]; then
    wal_uuid_dev=$(awk -v p="$wal_uuid_dir" '$2 == p { print $1; exit }' /proc/self/mounts)
    wal_uuid_link=$(readlink -f "/dev/disk/by-uuid/$wal_uuid_expected" 2>/dev/null || true)
    wal_uuid_dev_link=$(readlink -f "$wal_uuid_dev" 2>/dev/null || printf '%s' "$wal_uuid_dev")
    if [ -n "$wal_uuid_dev" ] && [ -n "$wal_uuid_link" ] && [ "$wal_uuid_link" = "$wal_uuid_dev_link" ]; then
      printf '%s\n' "$wal_uuid_expected"
      return 0
    fi
  fi
  return 1
}

if [ "$#" -ne 2 ]; then
  usage
  wal_die 2 "expected exactly two arguments (%f and %p)."
fi

RESTORE_NAME=$1
WAL_TARGET=$2

case "$RESTORE_NAME" in
  ''|*/*|*..*|.*) wal_die 2 "invalid WAL filename." ;;
  *[!A-Za-z0-9._-]*) wal_die 2 "invalid WAL filename." ;;
esac

# PostgreSQL passes a temporary name (RECOVERYXLOG/RECOVERYHISTORY) as %p, not
# the final segment name. Accept only those names inside pg_wal, or an exact
# match for direct/manual invocations.
WAL_TARGET_BASE=$(basename "$WAL_TARGET")
WAL_TARGET_PARENT_BASE=$(basename "$(dirname "$WAL_TARGET")")
case "$WAL_TARGET_BASE" in
  "$RESTORE_NAME") : ;;
  RECOVERYXLOG|RECOVERYHISTORY)
    [ "$WAL_TARGET_PARENT_BASE" = pg_wal ] || wal_die 2 \
      "recovery temp path '$WAL_TARGET_BASE' is not inside pg_wal." ;;
  *) wal_die 2 \
       "target path basename '$WAL_TARGET_BASE' is not a valid recovery target." ;;
esac

WAL_ARCHIVE_DIR_RAW=${WAL_ARCHIVE_DIR:-${BACKUP_ROOT:-/mnt/clinic-backups}/wal-archive}
WAL_SEGMENT_SIZE=${WAL_SEGMENT_SIZE:-16777216}
WAL_ARCHIVE_SKIP_MOUNT_CHECK=${WAL_ARCHIVE_SKIP_MOUNT_CHECK:-0}
case "$WAL_SEGMENT_SIZE" in ''|*[!0-9]*) wal_die 2 "WAL_SEGMENT_SIZE must be a positive integer." ;; esac
case "$WAL_ARCHIVE_SKIP_MOUNT_CHECK" in 0|1) : ;; *) wal_die 2 "WAL_ARCHIVE_SKIP_MOUNT_CHECK must be 0 or 1." ;; esac

[ -d "$WAL_ARCHIVE_DIR_RAW" ] || wal_die 3 \
  "WAL archive directory does not exist: $WAL_ARCHIVE_DIR_RAW"
WAL_ARCHIVE_DIR=$(CDPATH= cd "$WAL_ARCHIVE_DIR_RAW" 2>/dev/null && pwd -P) || wal_die 3 \
  "could not resolve the WAL archive directory."
[ -r "$WAL_ARCHIVE_DIR" ] || wal_die 3 "WAL archive directory is not readable."

if [ "$WAL_ARCHIVE_SKIP_MOUNT_CHECK" != 1 ]; then
  wal_is_mountpoint "$WAL_ARCHIVE_DIR" || wal_die 3 \
    "WAL archive is not a mounted dedicated filesystem."
  if [ -n "${WAL_ARCHIVE_EXPECTED_FSTYPE:-}" ]; then
    wal_actual_fstype=$(wal_fstype "$WAL_ARCHIVE_DIR")
    [ -n "$wal_actual_fstype" ] || wal_die 3 \
      "could not determine WAL archive filesystem type."
    [ "$wal_actual_fstype" = "$WAL_ARCHIVE_EXPECTED_FSTYPE" ] || wal_die 3 \
      "WAL archive filesystem type does not match the approved value."
  fi
  if [ -n "${WAL_ARCHIVE_EXPECTED_UUID:-}" ]; then
    wal_actual_uuid=$(wal_uuid "$WAL_ARCHIVE_DIR" "$WAL_ARCHIVE_EXPECTED_UUID")
    [ -n "$wal_actual_uuid" ] || wal_die 3 \
      "could not verify the approved WAL archive filesystem UUID."
  fi
fi

WAL_SOURCE="$WAL_ARCHIVE_DIR/$RESTORE_NAME"
[ -f "$WAL_SOURCE" ] || wal_die 3 \
  "required WAL file is missing from the archive (restore would be incomplete)."
WAL_SIDECAR="$WAL_SOURCE.sha256"
[ -f "$WAL_SIDECAR" ] || wal_die 6 \
  "required WAL file has no checksum sidecar; corrupted or unmanaged archive."

WAL_SOURCE_BYTES=$(wal_file_bytes "$WAL_SOURCE")
case "$WAL_SOURCE_BYTES" in
  ''|*[!0-9]*) wal_die 4 "could not determine archived WAL size." ;;
  0) wal_die 6 "archived WAL file is empty." ;;
esac
if wal_is_segment "$RESTORE_NAME"; then
  [ "$WAL_SOURCE_BYTES" = "$WAL_SEGMENT_SIZE" ] || wal_die 6 \
    "archived WAL segment has wrong size: expected $WAL_SEGMENT_SIZE bytes, found $WAL_SOURCE_BYTES."
fi

WAL_ACTUAL_SHA=$(wal_sha256 "$WAL_SOURCE")
wal_is_sha256 "$WAL_ACTUAL_SHA" || wal_die 4 "could not checksum archived WAL file."
WAL_EXPECTED_LINE=$(tr -d '\r' < "$WAL_SIDECAR")
WAL_EXPECTED_SHA=${WAL_EXPECTED_LINE%% *}
wal_is_sha256 "$WAL_EXPECTED_SHA" || wal_die 6 "WAL checksum sidecar is malformed."
[ "$WAL_EXPECTED_LINE" = "$WAL_EXPECTED_SHA  $RESTORE_NAME" ] || wal_die 6 \
  "WAL checksum sidecar names a different file."
WAL_ACTUAL_LOWER=$(printf '%s' "$WAL_ACTUAL_SHA" | tr 'A-F' 'a-f')
WAL_EXPECTED_LOWER=$(printf '%s' "$WAL_EXPECTED_SHA" | tr 'A-F' 'a-f')
[ "$WAL_ACTUAL_LOWER" = "$WAL_EXPECTED_LOWER" ] || wal_die 6 \
  "corrupt WAL detected: archived file does not match its SHA-256 sidecar."

WAL_TARGET_DIR=$(dirname "$WAL_TARGET")
[ -d "$WAL_TARGET_DIR" ] || wal_die 3 \
  "PostgreSQL pg_wal target directory does not exist."
[ -w "$WAL_TARGET_DIR" ] || wal_die 3 \
  "PostgreSQL pg_wal target directory is not writable."

if [ -e "$WAL_TARGET" ]; then
  [ -f "$WAL_TARGET" ] || wal_die 6 "WAL target path is not a regular file."
  [ "$(wal_sha256 "$WAL_TARGET")" = "$WAL_ACTUAL_SHA" ] || wal_die 6 \
    "existing pg_wal file has different contents; refusing to overwrite it."
  WAL_RESTORE_RESULT=ok-idempotent
  wal_log "$WAL_RESTORE_RESULT"
  printf 'restored name=%s bytes=%s sha256=%s result=already-present\n' \
    "$RESTORE_NAME" "$WAL_SOURCE_BYTES" "$WAL_ACTUAL_SHA"
  exit 0
fi

WAL_TMP="$WAL_TARGET_DIR/.$RESTORE_NAME.$$.tmp"
wal_cleanup() { rm -f "$WAL_TMP"; }
trap wal_cleanup EXIT
trap 'wal_cleanup; exit 130' INT
trap 'wal_cleanup; exit 143' TERM

cp "$WAL_SOURCE" "$WAL_TMP" || wal_die 4 "failed to stage WAL file into pg_wal."
chmod 600 "$WAL_TMP" || wal_die 4 "failed to secure staged pg_wal file."
[ "$(wal_file_bytes "$WAL_TMP")" = "$WAL_SOURCE_BYTES" ] || wal_die 4 \
  "staged WAL file size differs from archive."
[ "$(wal_sha256 "$WAL_TMP")" = "$WAL_ACTUAL_SHA" ] || wal_die 4 \
  "staged WAL file checksum differs from archive."
ln "$WAL_TMP" "$WAL_TARGET" 2>/dev/null || wal_die 4 \
  "failed to publish WAL file into pg_wal atomically."

WAL_RESTORE_RESULT=ok
wal_log "$WAL_RESTORE_RESULT"
printf 'restored name=%s bytes=%s sha256=%s\n' \
  "$RESTORE_NAME" "$WAL_SOURCE_BYTES" "$WAL_ACTUAL_SHA"
exit 0
