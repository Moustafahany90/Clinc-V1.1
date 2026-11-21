#!/usr/bin/env bash
# Restore a validated PITR base set into a NEW, EXPLICITLY CONFIRMED isolated
# PostgreSQL instance. Never touches an existing data directory or port 5432.
#
#   pitr-restore.sh \
#     --set /secure/backups/daily/clinic-daily-<STAMP>-pitr \
#     --target-time '2026-11-21 12:34:56+00' \
#     --target-dir /secure/restore/pitr_before_restore \
#     --confirm-target-dir /secure/restore/pitr_before_restore \
#     --pgport 55437 --pguser clinic [--key-file <age-private-key>]
#
# All manifest, checksum and WAL validation happens before --target-dir exists.
# On failure the target directory is removed; on success the recovered instance
# is left paused at the recovery target for verification.
set -euo pipefail

export MSYS_NO_PATHCONV=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

umask 077
START_MS="$(date +%s%3N 2>/dev/null || printf '%s' "$(( $(date -u +%s) * 1000 ))")"
SUCCESS=0
STARTED=0
TARGET_DIR=""
TARGET_PGDATA=""
TARGET_PORT=""

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: pitr-restore.sh --set <pitr-set-dir> --target-time <timestamp>
       --target-dir <new-isolated-dir> --confirm-target-dir <same-path>
       --pgport <isolated-port> [--pguser <user>] [--key-file <age-private-key>]
       [--through-wal-file <24-hex-segment>] [--skip-mount-check]
EOF_USAGE
}

die() { backup_die "$@"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

SET_DIR=""
TARGET_TIME=""
CONFIRM_DIR=""
PGPORT_ARG=""
PGUSER_ARG="clinic"
KEY_FILE=""
THROUGH_WAL=""
SKIP_MOUNT_CHECK=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --set)                [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--set needs a value."; SET_DIR="$2"; shift 2 ;;
    --target-time)        [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--target-time needs a value."; TARGET_TIME="$2"; shift 2 ;;
    --target-dir)         [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--target-dir needs a value."; TARGET_DIR="$2"; shift 2 ;;
    --confirm-target-dir) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--confirm-target-dir needs a value."; CONFIRM_DIR="$2"; shift 2 ;;
    --pgport)             [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pgport needs a value."; PGPORT_ARG="$2"; shift 2 ;;
    --pguser)             [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pguser needs a value."; PGUSER_ARG="$2"; shift 2 ;;
    --key-file)           [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--key-file needs a value."; KEY_FILE="$2"; shift 2 ;;
    --through-wal-file)   [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--through-wal-file needs a value."; THROUGH_WAL="$2"; shift 2 ;;
    --skip-mount-check)   SKIP_MOUNT_CHECK=1; shift ;;
    --help|-h)            usage; exit "$BACKUP_EXIT_OK" ;;
    *) usage; die "$BACKUP_EXIT_USAGE" "unknown argument '$1'." ;;
  esac
done

[ -n "$SET_DIR" ] && [ -d "$SET_DIR" ] || die "$BACKUP_EXIT_USAGE" "--set must be an existing PITR base set."
[ -n "$TARGET_TIME" ] || die "$BACKUP_EXIT_USAGE" "--target-time is required."
case "$TARGET_TIME" in
  *\'*) die "$BACKUP_EXIT_USAGE" "--target-time contains an invalid character." ;;
esac
if ! printf '%s' "$TARGET_TIME" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:[0-9]{2})?)?$'; then
  die "$BACKUP_EXIT_USAGE" "--target-time must be an ISO-8601 timestamp."
fi
[ -n "$TARGET_DIR" ] && [ "$TARGET_DIR" = "$CONFIRM_DIR" ] || die "$BACKUP_EXIT_USAGE" \
  "--target-dir and --confirm-target-dir must be present and exactly equal."
case "$TARGET_DIR" in
  /*) : ;;
  *) die "$BACKUP_EXIT_USAGE" "--target-dir must be an absolute path." ;;
esac
case "$TARGET_DIR" in
  */../*|*/..|../*) die "$BACKUP_EXIT_USAGE" "--target-dir must not contain '..' path segments." ;;
esac
TARGET_BASE="$(basename "$TARGET_DIR")"
case "$TARGET_BASE" in
  *_restore|*_drill|*_test) : ;;
  *) die "$BACKUP_EXIT_USAGE" \
       "target directory '$TARGET_BASE' must end in _restore, _drill or _test." ;;
esac
LOWER_TARGET="$(printf '%s' "$TARGET_DIR" | tr '[:upper:]' '[:lower:]')"
case "$LOWER_TARGET" in
  *production*|*prod*|*/db|/db|*clinic-backups*|*/var/lib/postgresql/*|*/etc/postgresql/*)
    die "$BACKUP_EXIT_USAGE" "target path '$TARGET_DIR' is production-like or inside a protected path." ;;
esac
[ ! -e "$TARGET_DIR" ] || die "$BACKUP_EXIT_USAGE" \
  "target directory '$TARGET_DIR' already exists; refusing to overwrite any data."
[ -d "$(dirname "$TARGET_DIR")" ] || die "$BACKUP_EXIT_USAGE" \
  "parent of --target-dir does not exist."
[ -w "$(dirname "$TARGET_DIR")" ] || die "$BACKUP_EXIT_USAGE" \
  "parent of --target-dir is not writable."
case "$PGPORT_ARG" in
  ''|*[!0-9]*) die "$BACKUP_EXIT_USAGE" "--pgport must be numeric." ;;
esac
[ "$PGPORT_ARG" -gt 1024 ] || die "$BACKUP_EXIT_USAGE" "--pgport must be above 1024."
[ "$PGPORT_ARG" != 5432 ] && [ "$PGPORT_ARG" != 55432 ] || die "$BACKUP_EXIT_USAGE" \
  "port $PGPORT_ARG is a production/default PostgreSQL port; choose an isolated port."
if [ -n "$THROUGH_WAL" ]; then
  backup_wal_is_segment "$THROUGH_WAL" || die "$BACKUP_EXIT_USAGE" \
    "--through-wal-file must be a 24-character hexadecimal WAL segment name."
fi
case "$SKIP_MOUNT_CHECK" in 0|1) : ;; *) die "$BACKUP_EXIT_USAGE" "invalid skip-mount-check state." ;; esac

for tool in pg_ctl psql tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" "'$tool' is not installed or not on PATH."
done

# ---------------------------------------------------------------------------
# Read-only validation of the backup set and WAL archive BEFORE target creation.
# ---------------------------------------------------------------------------
MANIFEST="${SET_DIR}/MANIFEST.txt"
SUMS="${SET_DIR}/SHA256SUMS"
[ -f "$MANIFEST" ] || die "$BACKUP_EXIT_VERIFY" "PITR set has no MANIFEST.txt."
[ -f "$SUMS" ] || die "$BACKUP_EXIT_VERIFY" "PITR set has no SHA256SUMS."

declare -A M=()
backup_manifest_load "$MANIFEST" M
[ "${M[backup_format]:-}" = "pitr-base-1" ] || die "$BACKUP_EXIT_VERIFY" \
  "unsupported backup_format='${M[backup_format]:-}' (expected pitr-base-1)."
[ "${M[pitr_ready]:-}" = "true" ] || die "$BACKUP_EXIT_VERIFY" \
  "backup set is not marked pitr_ready; missing WAL makes it unsuitable for PITR."
[ "${M[checksums]:-}" = "SHA256SUMS" ] || die "$BACKUP_EXIT_VERIFY" "manifest checksums are not SHA256SUMS."
for key in backup_id pg_version created_utc start_lsn stop_lsn timeline wal_segment_size \
           wal_archive_dir required_wal_start required_wal_end required_wal_count \
           required_wal_files base_archive base_sha256 base_bytes base_plain_sha256 \
           base_plain_bytes encryption; do
  [ -n "${M[$key]:-}" ] || die "$BACKUP_EXIT_VERIFY" "manifest has no '$key'."
done
case "${M[encryption]}" in
  age) [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ] || die "$BACKUP_EXIT_USAGE" \
         "--key-file is required for this age-encrypted base set." ;;
  none) : ;;
  *) die "$BACKUP_EXIT_VERIFY" "unsupported base backup encryption '${M[encryption]}'." ;;
esac
if [ "${M[encryption]}" = "age" ]; then
  command -v age >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" "age is not installed or not on PATH."
fi

BASE_ARTIFACT="${M[base_archive]}"
case "$BASE_ARTIFACT" in
  ''|*/*|*..*) die "$BACKUP_EXIT_VERIFY" "base_archive is not a plain filename." ;;
esac
BASE_PATH="${SET_DIR}/${BASE_ARTIFACT}"
[ -f "$BASE_PATH" ] || die "$BACKUP_EXIT_VERIFY" "base artifact '$BASE_ARTIFACT' is missing."
[ "$(backup_file_bytes "$BASE_PATH")" = "${M[base_bytes]}" ] || die "$BACKUP_EXIT_VERIFY" \
  "base artifact size does not match the manifest."
[ "$(backup_sha256 "$BASE_PATH")" = "${M[base_sha256]}" ] || die "$BACKUP_EXIT_VERIFY" \
  "base artifact SHA-256 does not match the manifest."
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  printf '%s\n' "$line" | grep -Eq '^[0-9a-f]{64} ( |\*).+$' || die "$BACKUP_EXIT_VERIFY" \
    "SHA256SUMS contains a malformed line."
done < "$SUMS"
grep -q " ${BASE_ARTIFACT}\$" "$SUMS" || die "$BACKUP_EXIT_VERIFY" \
  "SHA256SUMS does not list '$BASE_ARTIFACT'."

WAL_ARCHIVE_DIR="${M[wal_archive_dir]}"
case "$WAL_ARCHIVE_DIR" in
  /*) : ;;
  *) die "$BACKUP_EXIT_VERIFY" "manifest wal_archive_dir is not an absolute path." ;;
esac
[ -d "$WAL_ARCHIVE_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
  "WAL archive '${WAL_ARCHIVE_DIR}' from the manifest is not available on this host."
[ -r "$WAL_ARCHIVE_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
  "WAL archive '${WAL_ARCHIVE_DIR}' from the manifest is not readable."
WAL_SEGMENT_SIZE="${M[wal_segment_size]}"
case "$WAL_SEGMENT_SIZE" in ''|*[!0-9]*) die "$BACKUP_EXIT_VERIFY" \
  "manifest wal_segment_size is not numeric." ;; esac

if [ "$SKIP_MOUNT_CHECK" = "0" ]; then
  command -v mountpoint >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "mountpoint utility is required for fail-closed archive validation."
  mountpoint -q "$WAL_ARCHIVE_DIR" 2>/dev/null || die "$BACKUP_EXIT_PRECHECK" \
    "WAL archive from the manifest is not a mounted dedicated filesystem."
fi

REQUIRED_FILES="${M[required_wal_files]}"
REQUIRED_COUNT="$(printf '%s\n' "$REQUIRED_FILES" | wc -w | tr -d '[:space:]')"
[ "$REQUIRED_COUNT" = "${M[required_wal_count]}" ] || die "$BACKUP_EXIT_VERIFY" \
  "required WAL count in manifest does not match the file list."
[ "$REQUIRED_COUNT" -gt 0 ] || die "$BACKUP_EXIT_VERIFY" \
  "base set has no required WAL file list."

VALIDATED_FILES="$REQUIRED_FILES"
if [ -n "$THROUGH_WAL" ]; then
  END_FILE="${M[required_wal_end]}"
  backup_wal_is_segment "$END_FILE" || die "$BACKUP_EXIT_VERIFY" "invalid required_wal_end in manifest."
  if [ "$THROUGH_WAL" \> "$END_FILE" ]; then
    EXTRA_FILES="$(backup_wal_range "$(backup_wal_next "$END_FILE")" "$THROUGH_WAL")" || \
      die "$BACKUP_EXIT_VERIFY" "invalid --through-wal-file range."
    VALIDATED_FILES="${VALIDATED_FILES}
${EXTRA_FILES}"
  elif [ "$THROUGH_WAL" != "$END_FILE" ]; then
    die "$BACKUP_EXIT_USAGE" "--through-wal-file precedes the base backup WAL range."
  fi
fi

echo "Validating WAL archive for target time ${TARGET_TIME} ..."
VALIDATED_COUNT=0
while IFS= read -r wal_file; do
  [ -n "$wal_file" ] || continue
  backup_wal_is_segment "$wal_file" || die "$BACKUP_EXIT_VERIFY" \
    "invalid WAL segment name '$wal_file' in required sequence."
  wal_path="${WAL_ARCHIVE_DIR}/${wal_file}"
  [ -f "$wal_path" ] || die "$BACKUP_EXIT_PRECHECK" \
    "missing WAL segment '$wal_file'; recovery cannot reach the requested target."
  [ "$(backup_file_bytes "$wal_path")" = "$WAL_SEGMENT_SIZE" ] || die "$BACKUP_EXIT_VERIFY" \
    "WAL segment '$wal_file' has an invalid size."
  sidecar_line="$(tr -d '\r' < "${wal_path}.sha256" 2>/dev/null)" || die "$BACKUP_EXIT_VERIFY" \
    "missing SHA-256 sidecar for WAL segment '$wal_file'."
  declared_sha="${sidecar_line%% *}"
  backup_is_sha256 "$declared_sha" || die "$BACKUP_EXIT_VERIFY" \
    "malformed SHA-256 sidecar for WAL segment '$wal_file'."
  [ "$sidecar_line" = "$declared_sha  $wal_file" ] || die "$BACKUP_EXIT_VERIFY" \
    "SHA-256 sidecar for '$wal_file' names a different segment."
  actual_sha="$(backup_sha256 "$wal_path")"
  [ "$(printf '%s' "$actual_sha" | tr 'A-F' 'a-f')" = "$(printf '%s' "$declared_sha" | tr 'A-F' 'a-f')" ] || \
    die "$BACKUP_EXIT_VERIFY" "corrupt WAL segment '$wal_file' does not match its SHA-256 sidecar."
  manifest_sha="${M[wal.sha256.${wal_file}]:-}"
  if [ -n "$manifest_sha" ]; then
    [ "$(printf '%s' "$actual_sha" | tr 'A-F' 'a-f')" = "$(printf '%s' "$manifest_sha" | tr 'A-F' 'a-f')" ] || \
      die "$BACKUP_EXIT_VERIFY" \
        "WAL segment '$wal_file' does not match the checksum recorded in the base backup."
  fi
  VALIDATED_COUNT=$((VALIDATED_COUNT + 1))
done <<< "$VALIDATED_FILES"
echo "Validated $VALIDATED_COUNT WAL segment(s) before touching the target."

RESTORE_HELPER="${SCRIPT_DIR}/../deploy/wal-restore.sh"
[ -f "$RESTORE_HELPER" ] || die "$BACKUP_EXIT_PRECHECK" \
  "deploy/wal-restore.sh is missing; restore_command cannot be configured."
RESTORE_HELPER_CANON="$(backup_canonical "$RESTORE_HELPER")" || die "$BACKUP_EXIT_PRECHECK" \
  "could not resolve deploy/wal-restore.sh."
case "$RESTORE_HELPER_CANON" in
  *\'*) die "$BACKUP_EXIT_PRECHECK" "restore helper path contains a single quote." ;;
esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pitr-restore.XXXXXX")" || die "$BACKUP_EXIT_IO" \
  "could not create temporary restore directory."
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "${SUCCESS}" != "1" ] && [ "${STARTED}" = "1" ] && [ -n "${TARGET_PGDATA}" ]; then
    pg_ctl -D "$TARGET_PGDATA" stop -m immediate >/dev/null 2>&1 || true
  fi
  if [ "${SUCCESS}" != "1" ] && [ -n "${TARGET_DIR}" ] && [ -e "${TARGET_DIR}" ]; then
    rm -rf -- "$TARGET_DIR"
  fi
  rm -rf -- "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PLAIN_BASE="${TMP_DIR}/base.tar.gz"
if [ "${M[encryption]}" = "age" ]; then
  age -d -i "$KEY_FILE" -o "$PLAIN_BASE" "$BASE_PATH" || die "$BACKUP_EXIT_ENCRYPTION" \
    "could not decrypt the base backup; check the age private key."
else
  cp -- "$BASE_PATH" "$PLAIN_BASE" || die "$BACKUP_EXIT_IO" "could not stage the base backup."
fi
[ "$(backup_sha256 "$PLAIN_BASE")" = "${M[base_plain_sha256]}" ] || die "$BACKUP_EXIT_VERIFY" \
  "decrypted base backup checksum does not match the manifest."
[ "$(backup_file_bytes "$PLAIN_BASE")" = "${M[base_plain_bytes]}" ] || die "$BACKUP_EXIT_VERIFY" \
  "decrypted base backup size does not match the manifest."
if tar tzf "$PLAIN_BASE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die "$BACKUP_EXIT_VERIFY" "base backup tar contains absolute or parent-traversal paths."
fi

echo "Creating isolated recovery target '$TARGET_DIR' ..."
mkdir -p "$TARGET_DIR" || die "$BACKUP_EXIT_IO" "could not create target directory."
mkdir -p "${TARGET_DIR}/data" "${TARGET_DIR}/socket" || die "$BACKUP_EXIT_IO" \
  "could not create target data/socket directories."
TARGET_PGDATA="${TARGET_DIR}/data"
TARGET_PORT="$PGPORT_ARG"
tar -C "$TARGET_PGDATA" -xzf "$PLAIN_BASE" || die "$BACKUP_EXIT_IO" \
  "could not extract the base backup into the target."
rm -f "${TARGET_PGDATA}/postmaster.pid" "${TARGET_PGDATA}/standby.signal" || true
: > "${TARGET_PGDATA}/recovery.signal" || die "$BACKUP_EXIT_IO" \
  "could not create recovery.signal."

# PostgreSQL single-quoted config strings escape a literal quote as ''.
RESTORE_CMD="sh ''${RESTORE_HELPER_CANON}'' %f \"%p\""
# PostgreSQL's recovery_target_time accepts SQL timestamps, not a trailing Z.
CONFIG_TARGET_TIME="${TARGET_TIME/T/ }"
case "$CONFIG_TARGET_TIME" in
  *Z) CONFIG_TARGET_TIME="${CONFIG_TARGET_TIME%Z}+00" ;;
esac
cat > "${TARGET_PGDATA}/postgresql.auto.conf" <<EOF_AUTO || die "$BACKUP_EXIT_IO" "could not write recovery configuration."
# Written by scripts/pitr-restore.sh for an isolated PITR drill only.
restore_command = '${RESTORE_CMD}'
recovery_target_time = '${CONFIG_TARGET_TIME}'
recovery_target_action = 'pause'
recovery_target_inclusive = 'on'
archive_mode = 'off'
archive_command = ''
listen_addresses = '127.0.0.1'
unix_socket_directories = '${TARGET_DIR}/socket'
port = ${PGPORT_ARG}
EOF_AUTO

export WAL_ARCHIVE_DIR="$WAL_ARCHIVE_DIR"
export WAL_SEGMENT_SIZE="$WAL_SEGMENT_SIZE"
export WAL_ARCHIVE_SKIP_MOUNT_CHECK="$SKIP_MOUNT_CHECK"
if [ -n "${WAL_ARCHIVE_EXPECTED_UUID:-}" ]; then export WAL_ARCHIVE_EXPECTED_UUID; fi
if [ -n "${WAL_ARCHIVE_EXPECTED_FSTYPE:-}" ]; then export WAL_ARCHIVE_EXPECTED_FSTYPE; fi

echo "Starting isolated PostgreSQL on port ${PGPORT_ARG} and recovering to target ..."
pg_ctl -D "$TARGET_PGDATA" -l "${TARGET_DIR}/postgres.log" -w \
  -o "-p ${PGPORT_ARG} -k ${TARGET_DIR}/socket -h 127.0.0.1" start > "${TARGET_DIR}/pgctl-start.log" 2>&1 || {
  tail -n 50 "${TARGET_DIR}/postgres.log" >&2 || true
  cat "${TARGET_DIR}/pgctl-start.log" >&2 || true
  die "$BACKUP_EXIT_RESTORE" "isolated PostgreSQL failed to start or complete archive recovery."
}
STARTED=1

in_recovery="$(psql -h 127.0.0.1 -p "$PGPORT_ARG" -U "$PGUSER_ARG" -d postgres -Atq \
  -c 'select pg_is_in_recovery()' 2>/dev/null)" || {
  tail -n 50 "${TARGET_DIR}/postgres.log" >&2 || true
  die "$BACKUP_EXIT_RESTORE" "could not connect to the recovered isolated instance."
}
[ "$in_recovery" = "t" ] || die "$BACKUP_EXIT_RESTORE" \
  "recovered instance is not paused in recovery; target verification failed."
replay_ts="$(psql -h 127.0.0.1 -p "$PGPORT_ARG" -U "$PGUSER_ARG" -d postgres -Atq \
  -c 'select coalesce(pg_last_xact_replay_timestamp()::text, '\''none (no post-backup transaction before target)'\'')' 2>/dev/null)" || \
  die "$BACKUP_EXIT_RESTORE" "could not read replay timestamp."
# A target immediately after the base backup can legitimately replay no new
# transaction, so the authoritative target-reached proof is PostgreSQL's log.
grep -Eq 'recovery stopping before|reached recovery target|recovery target reached' \
  "${TARGET_DIR}/postgres.log" || {
  tail -n 50 "${TARGET_DIR}/postgres.log" >&2
  die "$BACKUP_EXIT_RESTORE" "PostgreSQL log does not confirm that the recovery target was reached."
}

END_MS="$(date +%s%3N 2>/dev/null || printf '%s' "$(( $(date -u +%s) * 1000 ))")"
SUCCESS=1
printf 'PITR RESTORE SUCCESS\n'
printf '  backup_id: %s\n' "${M[backup_id]}"
printf '  target_time: %s\n' "$TARGET_TIME"
printf '  target_dir: %s\n' "$TARGET_DIR"
printf '  target_port: %s\n' "$TARGET_PORT"
printf '  wal_files_validated: %s\n' "$VALIDATED_COUNT"
printf '  last_replayed_at: %s\n' "$replay_ts"
printf '  recovery_duration_ms: %s\n' "$((END_MS - START_MS))"
exit "$BACKUP_EXIT_OK"
