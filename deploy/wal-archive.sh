#!/bin/sh
# Phase 9.5 fail-closed WAL archiver for PostgreSQL archive_command.
#
# This file is intentionally POSIX sh and self-contained so it also runs in the
# minimal postgres:16-alpine container, which has no bash, mountpoint or
# findmnt. PostgreSQL calls it with two arguments:
#
#   archive_command = '/bin/sh /clinic/deploy/wal-archive.sh %p %f'
#
# It copies the completed server-side WAL file into a dedicated archive,
# publishes it atomically, writes a SHA-256 sidecar, and never overwrites a
# different valid file. Any failure returns non-zero so PostgreSQL keeps the
# WAL in pg_wal and retries. No database credentials are read or logged.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
ARCHIVE_NAME=""
START_EPOCH=$(date -u +%s)

wal_log() {
  printf '%s wal_archive name=%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ARCHIVE_NAME:-unknown}" "$1" >&2
}

wal_die() {
  wal_log fail
  printf 'BACKUP ERROR: %s\n' "$2" >&2
  exit "$1"
}

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: wal-archive.sh <postgresql-%p-source> <postgresql-%f-filename>
Environment (all non-secret):
  WAL_ARCHIVE_DIR                 dedicated archive directory (required)
  WAL_SEGMENT_SIZE                expected size of plain WAL segments
  WAL_ARCHIVE_MIN_FREE_MB         minimum free space required before publishing
  WAL_ARCHIVE_SKIP_MOUNT_CHECK    1 only for isolated tests; default 0 fail-closed
  WAL_ARCHIVE_EXPECTED_UUID       optional expected filesystem UUID
  WAL_ARCHIVE_EXPECTED_FSTYPE     optional expected filesystem type
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

# Prefer host tools when present; otherwise read the kernel mount tables, which
# exist inside minimal containers. Fail closed if neither source is available.
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
  wal_die 2 "expected exactly two arguments (%p and %f)."
fi

WAL_SOURCE=$1
ARCHIVE_NAME=$2

case "$ARCHIVE_NAME" in
  ''|*/*|*..*|.*) wal_die 2 "invalid WAL filename." ;;
  *[!A-Za-z0-9._-]*) wal_die 2 "invalid WAL filename." ;;
esac

WAL_ARCHIVE_DIR_RAW=${WAL_ARCHIVE_DIR:-${BACKUP_ROOT:-/mnt/clinic-backups}/wal-archive}
WAL_SEGMENT_SIZE=${WAL_SEGMENT_SIZE:-16777216}
WAL_ARCHIVE_MIN_FREE_MB=${WAL_ARCHIVE_MIN_FREE_MB:-512}
WAL_ARCHIVE_SKIP_MOUNT_CHECK=${WAL_ARCHIVE_SKIP_MOUNT_CHECK:-0}

case "$WAL_SEGMENT_SIZE" in ''|*[!0-9]*) wal_die 2 "WAL_SEGMENT_SIZE must be a positive integer." ;; esac
case "$WAL_ARCHIVE_MIN_FREE_MB" in ''|*[!0-9]*) wal_die 2 "WAL_ARCHIVE_MIN_FREE_MB must be a non-negative integer." ;; esac
case "$WAL_ARCHIVE_SKIP_MOUNT_CHECK" in 0|1) : ;; *) wal_die 2 "WAL_ARCHIVE_SKIP_MOUNT_CHECK must be 0 or 1." ;; esac

[ -d "$WAL_ARCHIVE_DIR_RAW" ] || wal_die 3 \
  "WAL archive directory does not exist: create and permission it before starting PostgreSQL."
WAL_ARCHIVE_DIR=$(CDPATH= cd "$WAL_ARCHIVE_DIR_RAW" 2>/dev/null && pwd -P) || wal_die 3 \
  "could not resolve the WAL archive directory."
[ -w "$WAL_ARCHIVE_DIR" ] || wal_die 3 \
  "WAL archive directory is not writable by the PostgreSQL runtime user."

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

[ -f "$WAL_SOURCE" ] || wal_die 3 "source WAL file does not exist."
WAL_SOURCE_BYTES=$(wal_file_bytes "$WAL_SOURCE")
case "$WAL_SOURCE_BYTES" in
  ''|*[!0-9]*) wal_die 4 "could not determine source WAL size." ;;
  0) wal_die 3 "source WAL file is empty." ;;
esac

if wal_is_segment "$ARCHIVE_NAME"; then
  [ "$WAL_SOURCE_BYTES" = "$WAL_SEGMENT_SIZE" ] || wal_die 6 \
    "source WAL segment size $WAL_SOURCE_BYTES does not match expected $WAL_SEGMENT_SIZE."
else
  case "$ARCHIVE_NAME" in
    *.history|*.backup|*.partial) : ;;
    *) wal_die 2 "unrecognised WAL archive filename type." ;;
  esac
fi

WAL_AVAILABLE_KB=$(df -Pk "$WAL_ARCHIVE_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$WAL_AVAILABLE_KB" in
  ''|*[!0-9]*) wal_die 3 "could not determine free space in the WAL archive." ;;
esac
WAL_NEEDED_KB=$(( (WAL_SOURCE_BYTES / 1024) + 2 + (WAL_ARCHIVE_MIN_FREE_MB * 1024) ))
[ "$WAL_AVAILABLE_KB" -ge "$WAL_NEEDED_KB" ] || wal_die 3 \
  "insufficient free space in WAL archive (have ${WAL_AVAILABLE_KB} KiB, need ${WAL_NEEDED_KB} KiB)."

WAL_TARGET="$WAL_ARCHIVE_DIR/$ARCHIVE_NAME"
WAL_TMP="$WAL_ARCHIVE_DIR/.$ARCHIVE_NAME.$$.tmp"
WAL_TMP_SIDECAR="$WAL_TMP.sha256"
wal_cleanup() { rm -f "$WAL_TMP" "$WAL_TMP_SIDECAR"; }
trap wal_cleanup EXIT
trap 'wal_cleanup; exit 130' INT
trap 'wal_cleanup; exit 143' TERM

cp "$WAL_SOURCE" "$WAL_TMP" || wal_die 4 "failed to copy WAL file into the archive staging path."
chmod 600 "$WAL_TMP" || wal_die 4 "failed to secure WAL archive staging file."
if command -v sync >/dev/null 2>&1; then
  sync -f "$WAL_TMP" 2>/dev/null || sync >/dev/null 2>&1 || true
fi
WAL_TMP_SHA=$(wal_sha256 "$WAL_TMP")
wal_is_sha256 "$WAL_TMP_SHA" || wal_die 4 "failed to checksum staged WAL file."
[ "$(wal_file_bytes "$WAL_TMP")" = "$WAL_SOURCE_BYTES" ] || wal_die 4 \
  "staged WAL file size differs from source."
printf '%s  %s\n' "$WAL_TMP_SHA" "$ARCHIVE_NAME" > "$WAL_TMP_SIDECAR" || wal_die 4 \
  "failed to write WAL checksum sidecar."
chmod 600 "$WAL_TMP_SIDECAR" || wal_die 4 "failed to secure WAL checksum sidecar."

if ln "$WAL_TMP" "$WAL_TARGET" 2>/dev/null; then
  :
elif [ -f "$WAL_TARGET" ]; then
  WAL_EXISTING_SHA=$(wal_sha256 "$WAL_TARGET")
  [ "$WAL_EXISTING_SHA" = "$WAL_TMP_SHA" ] || wal_die 6 \
    "archive conflict: an existing WAL file with this name has different contents."
else
  wal_die 4 "failed to publish WAL file atomically."
fi

WAL_TARGET_SIDECAR="$WAL_TARGET.sha256"
if ln "$WAL_TMP_SIDECAR" "$WAL_TARGET_SIDECAR" 2>/dev/null; then
  :
elif [ -f "$WAL_TARGET_SIDECAR" ]; then
  WAL_EXISTING_SIDECAR=$(tr -d '\r' < "$WAL_TARGET_SIDECAR")
  [ "$WAL_EXISTING_SIDECAR" = "$WAL_TMP_SHA  $ARCHIVE_NAME" ] || wal_die 6 \
    "archive conflict: an existing WAL checksum sidecar has different contents."
else
  wal_die 4 "failed to publish WAL checksum sidecar atomically."
fi

wal_log ok
printf 'archived name=%s bytes=%s sha256=%s duration_seconds=%s\n' \
  "$ARCHIVE_NAME" "$WAL_SOURCE_BYTES" "$WAL_TMP_SHA" "$(( $(date -u +%s) - START_EPOCH ))"
exit 0
