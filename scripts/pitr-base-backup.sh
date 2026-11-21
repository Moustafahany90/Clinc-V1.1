#!/usr/bin/env bash
# Create a PostgreSQL physical base backup that is explicitly linked to the
# WAL archive required for point-in-time recovery. SYNTHETIC/ISOLATED USE ONLY
# until separately authorised for a real target.
#
#   pitr-base-backup.sh \
#     --pghost 127.0.0.1 --pgport 55436 --pguser clinic \
#     --pgdatabase postgres \
#     --wal-archive-dir /secure/wal-archive \
#     --backup-root /secure/backups --tier daily \
#     [--age-recipient age1...] [--skip-mount-check]
#
# The set is only published when every required WAL segment is present, has the
# expected size, and matches its SHA-256 sidecar. A set with missing WAL is
# never written and therefore is never reported as PITR-ready.
set -euo pipefail

export MSYS_NO_PATHCONV=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

umask 077
START_EPOCH="$(date -u +%s)"

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: pitr-base-backup.sh --pghost <host> --pgport <port> --pguser <user>
       --wal-archive-dir <dedicated-dir> [--backup-root <dir>]
       [--tier daily|weekly|monthly] [--pgdatabase <db>] [--label <suffix>]
       [--age-recipient <age-public-key>] [--skip-mount-check]
EOF_USAGE
}

die() { backup_die "$@"; }

PGHOST_ARG=""
PGPORT_ARG=""
PGUSER_ARG=""
PGDATABASE_ARG="postgres"
WAL_ARCHIVE_DIR=""
BACKUP_ROOT_ARG="${BACKUP_ROOT:-/mnt/clinic-backups}"
TIER="daily"
LABEL=""
AGE_RECIPIENT="${PITR_AGE_RECIPIENT:-}"
SKIP_MOUNT_CHECK=0
WAL_WAIT_SECONDS="${PITR_WAL_WAIT_SECONDS:-330}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pghost)           [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pghost needs a value."; PGHOST_ARG="$2"; shift 2 ;;
    --pgport)           [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pgport needs a value."; PGPORT_ARG="$2"; shift 2 ;;
    --pguser)           [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pguser needs a value."; PGUSER_ARG="$2"; shift 2 ;;
    --pgdatabase)       [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--pgdatabase needs a value."; PGDATABASE_ARG="$2"; shift 2 ;;
    --wal-archive-dir)  [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--wal-archive-dir needs a value."; WAL_ARCHIVE_DIR="$2"; shift 2 ;;
    --backup-root)      [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--backup-root needs a value."; BACKUP_ROOT_ARG="$2"; shift 2 ;;
    --tier)             [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--tier needs a value."; TIER="$2"; shift 2 ;;
    --label)            [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--label needs a value."; LABEL="$2"; shift 2 ;;
    --age-recipient)    [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--age-recipient needs a value."; AGE_RECIPIENT="$2"; shift 2 ;;
    --skip-mount-check) SKIP_MOUNT_CHECK=1; shift ;;
    --help|-h)          usage; exit "$BACKUP_EXIT_OK" ;;
    *) usage; die "$BACKUP_EXIT_USAGE" "unknown argument '$1'." ;;
  esac
done

[ -n "$PGHOST_ARG" ] && [ -n "$PGPORT_ARG" ] && [ -n "$PGUSER_ARG" ] || {
  usage; die "$BACKUP_EXIT_USAGE" "--pghost, --pgport and --pguser are mandatory."
}
[ -n "$WAL_ARCHIVE_DIR" ] || die "$BACKUP_EXIT_USAGE" "--wal-archive-dir is mandatory."
case "$TIER" in daily|weekly|monthly) : ;; *) die "$BACKUP_EXIT_USAGE" "invalid tier '$TIER'." ;; esac
case "$WAL_WAIT_SECONDS" in ''|*[!0-9]*) die "$BACKUP_EXIT_USAGE" "PITR_WAL_WAIT_SECONDS must be an integer." ;; esac
case "$SKIP_MOUNT_CHECK" in 0|1) : ;; *) die "$BACKUP_EXIT_USAGE" "invalid skip-mount-check state." ;; esac

for tool in psql pg_basebackup tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" "'$tool' is not installed or not on PATH."
done
if [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "age is required when --age-recipient is supplied."
  case "$AGE_RECIPIENT" in
    age1*) : ;;
    *) die "$BACKUP_EXIT_USAGE" "--age-recipient must be an age1 public recipient." ;;
  esac
fi

if [ "$SKIP_MOUNT_CHECK" = "0" ]; then
  BACKUP_ROOT="$BACKUP_ROOT_ARG"
  backup_require_storage "${BACKUP_ROOT_ARG}/${TIER}" || die "$BACKUP_EXIT_PRECHECK" "$BACKUP_CHECK_REASON"
else
  BACKUP_ROOT="$BACKUP_ROOT_ARG"
fi
[ -d "${BACKUP_ROOT_ARG}/${TIER}" ] || die "$BACKUP_EXIT_PRECHECK" \
  "backup tier directory '${BACKUP_ROOT_ARG}/${TIER}' does not exist."
[ -w "${BACKUP_ROOT_ARG}/${TIER}" ] || die "$BACKUP_EXIT_PRECHECK" \
  "backup tier directory '${BACKUP_ROOT_ARG}/${TIER}' is not writable."

# Phase 9.6: a physical base backup can be large. Fail safely before staging
# instead of filling the disk mid-copy. Override via PITR_BASE_MIN_FREE_MB.
PITR_BASE_MIN_FREE_MB=${PITR_BASE_MIN_FREE_MB:-512}
case "$PITR_BASE_MIN_FREE_MB" in
  ''|*[!0-9]*) die "$BACKUP_EXIT_USAGE" "PITR_BASE_MIN_FREE_MB must be a non-negative integer." ;;
esac
PITR_BASE_AVAILABLE_KB=$(df -Pk "${BACKUP_ROOT_ARG}/${TIER}" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$PITR_BASE_AVAILABLE_KB" in
  ''|*[!0-9]*) die "$BACKUP_EXIT_PRECHECK" "could not determine free space for the PITR base backup destination." ;;
esac
PITR_BASE_NEEDED_KB=$((PITR_BASE_MIN_FREE_MB * 1024))
[ "$PITR_BASE_AVAILABLE_KB" -ge "$PITR_BASE_NEEDED_KB" ] || die "$BACKUP_EXIT_PRECHECK" \
  "insufficient free space for PITR base backup (have ${PITR_BASE_AVAILABLE_KB} KiB, need at least ${PITR_BASE_NEEDED_KB} KiB)."

[ -d "$WAL_ARCHIVE_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
  "WAL archive directory does not exist: $WAL_ARCHIVE_DIR"
[ -w "$WAL_ARCHIVE_DIR" ] || die "$BACKUP_EXIT_PRECHECK" \
  "WAL archive directory is not readable/writable: $WAL_ARCHIVE_DIR"
WAL_ARCHIVE_CANON="$(backup_canonical "$WAL_ARCHIVE_DIR")" || die "$BACKUP_EXIT_PRECHECK" \
  "could not resolve WAL archive directory."
WAL_ARCHIVE_DIR="$WAL_ARCHIVE_CANON"

if [ "$SKIP_MOUNT_CHECK" = "0" ]; then
  command -v mountpoint >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
    "mountpoint utility is required for fail-closed archive validation."
  mountpoint -q "$WAL_ARCHIVE_DIR" 2>/dev/null || die "$BACKUP_EXIT_PRECHECK" \
    "WAL archive is not a mounted dedicated filesystem."
  if [ -n "${WAL_ARCHIVE_EXPECTED_UUID:-}" ] || [ -n "${WAL_ARCHIVE_EXPECTED_FSTYPE:-}" ]; then
    command -v findmnt >/dev/null 2>&1 || die "$BACKUP_EXIT_PRECHECK" \
      "findmnt utility is required for WAL archive validation."
    actual_uuid="$(findmnt -n -o UUID -M "$WAL_ARCHIVE_DIR" 2>/dev/null | head -n 1)"
    actual_fstype="$(findmnt -n -o FSTYPE -M "$WAL_ARCHIVE_DIR" 2>/dev/null | head -n 1)"
    [ -n "$actual_uuid" ] && [ -n "$actual_fstype" ] || die "$BACKUP_EXIT_PRECHECK" \
      "could not determine WAL archive filesystem metadata."
    [ -z "${WAL_ARCHIVE_EXPECTED_UUID:-}" ] || [ "$actual_uuid" = "$WAL_ARCHIVE_EXPECTED_UUID" ] || \
      die "$BACKUP_EXIT_PRECHECK" "WAL archive filesystem UUID does not match the approved value."
    [ -z "${WAL_ARCHIVE_EXPECTED_FSTYPE:-}" ] || [ "$actual_fstype" = "$WAL_ARCHIVE_EXPECTED_FSTYPE" ] || \
      die "$BACKUP_EXIT_PRECHECK" "WAL archive filesystem type does not match the approved value."
  fi
fi

psql_q() {
  PGHOST="$PGHOST_ARG" PGPORT="$PGPORT_ARG" PGUSER="$PGUSER_ARG" PGDATABASE="$PGDATABASE_ARG" \
    psql -v ON_ERROR_STOP=1 -Atq -c "$1"
}

WAL_LEVEL="$(psql_q "show wal_level")" || die "$BACKUP_EXIT_PRECHECK" "could not read wal_level from source."
ARCHIVE_MODE="$(psql_q "show archive_mode")" || die "$BACKUP_EXIT_PRECHECK" "could not read archive_mode from source."
ARCHIVE_COMMAND="$(psql_q "show archive_command")" || die "$BACKUP_EXIT_PRECHECK" "could not read archive_command from source."
ARCHIVE_TIMEOUT="$(psql_q "show archive_timeout")" || die "$BACKUP_EXIT_PRECHECK" "could not read archive_timeout from source."
PG_VERSION="$(psql_q "show server_version")" || die "$BACKUP_EXIT_PRECHECK" "could not read server version from source."
WAL_SEGMENT_SIZE="$(psql_q "select setting from pg_settings where name = 'wal_segment_size'")" || \
  die "$BACKUP_EXIT_PRECHECK" "could not read wal_segment_size from source."
ARCHIVER_FAILED_COUNT="$(psql_q "select failed_count::text from pg_stat_archiver")" || \
  die "$BACKUP_EXIT_PRECHECK" "could not read pg_stat_archiver from source."
ARCHIVER_LAST_SUCCESS="$(psql_q "select coalesce(last_archived_wal, 'none') from pg_stat_archiver")" || \
  die "$BACKUP_EXIT_PRECHECK" "could not read archiver status from source."
ARCHIVER_LAST_FAILURE="$(psql_q "select coalesce(last_failed_wal, 'none') from pg_stat_archiver")" || \
  die "$BACKUP_EXIT_PRECHECK" "could not read archiver status from source."

case "$WAL_LEVEL" in replica|logical) : ;; *) die "$BACKUP_EXIT_PRECHECK" \
  "source wal_level='$WAL_LEVEL'; replica or logical is required for PITR." ;; esac
case "$ARCHIVE_MODE" in on|always) : ;; *) die "$BACKUP_EXIT_PRECHECK" \
  "source archive_mode='$ARCHIVE_MODE'; continuous archiving is not enabled." ;; esac
[ -n "$ARCHIVE_COMMAND" ] && [ "$ARCHIVE_COMMAND" != "(disabled)" ] || die "$BACKUP_EXIT_PRECHECK" \
  "source archive_command is empty; WAL would not be archived."
case "$WAL_SEGMENT_SIZE" in ''|*[!0-9]*) die "$BACKUP_EXIT_PRECHECK" \
  "invalid wal_segment_size '$WAL_SEGMENT_SIZE'." ;; esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pitr-base.XXXXXX")" || die "$BACKUP_EXIT_IO" \
  "could not create temporary base-backup directory."
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  rm -rf -- "$TMP_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Creating physical base backup of ${PGHOST_ARG}:${PGPORT_ARG} ..."
PGDATABASE="$PGDATABASE_ARG" pg_basebackup -h "$PGHOST_ARG" -p "$PGPORT_ARG" -U "$PGUSER_ARG" \
  -D "${TMP_DIR}/base" -Fp -X stream > "${TMP_DIR}/pg_basebackup.log" 2>&1 || {
  tail -n 30 "${TMP_DIR}/pg_basebackup.log" >&2
  die "$BACKUP_EXIT_BACKUP" "pg_basebackup failed."
}

MANIFEST_JSON="${TMP_DIR}/base/backup_manifest"
BACKUP_LABEL="${TMP_DIR}/base/backup_label"
[ -f "$MANIFEST_JSON" ] || die "$BACKUP_EXIT_VERIFY" \
  "pg_basebackup did not produce backup_manifest."
[ -f "$BACKUP_LABEL" ] || die "$BACKUP_EXIT_VERIFY" \
  "pg_basebackup did not produce backup_label."

START_LSN="$(grep -o '"Start-LSN"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST_JSON" | \
  head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
STOP_LSN="$(grep -o '"End-LSN"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST_JSON" | \
  tail -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
TIMELINE="$(grep -o '"Timeline"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$MANIFEST_JSON" | \
  head -n 1 | grep -o '[0-9][0-9]*$')"
if [ -z "$START_LSN" ]; then
  START_LSN="$(sed -n 's/^START WAL LOCATION: \([^ ]*\) .*/\1/p' "$BACKUP_LABEL" | head -n 1)"
fi
if [ -z "$TIMELINE" ]; then
  TIMELINE="$(sed -n 's/^START TIMELINE:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$BACKUP_LABEL" | head -n 1)"
fi
[ -n "$START_LSN" ] && [ -n "$STOP_LSN" ] && [ -n "$TIMELINE" ] || die "$BACKUP_EXIT_VERIFY" \
  "could not extract WAL range or timeline from pg_basebackup manifest."

START_FILE="$(psql_q "select pg_walfile_name('${START_LSN}'::pg_lsn)")" || die "$BACKUP_EXIT_VERIFY" \
  "could not map start LSN to a WAL filename."
END_FILE="$(psql_q "select pg_walfile_name(('${STOP_LSN}'::pg_lsn - 1))")" || die "$BACKUP_EXIT_VERIFY" \
  "could not map stop LSN to a WAL filename."
backup_wal_is_segment "$START_FILE" || die "$BACKUP_EXIT_VERIFY" "invalid start WAL filename '$START_FILE'."
backup_wal_is_segment "$END_FILE" || die "$BACKUP_EXIT_VERIFY" "invalid end WAL filename '$END_FILE'."
REQUIRED_FILES="$(backup_wal_range "$START_FILE" "$END_FILE")" || die "$BACKUP_EXIT_VERIFY" \
  "WAL range from $START_FILE to $END_FILE is invalid or too large."
REQUIRED_COUNT="$(printf '%s\n' "$REQUIRED_FILES" | wc -l | tr -d '[:space:]')"

wait_for_wal() {
  local file="$1" deadline=$(( $(date -u +%s) + WAL_WAIT_SECONDS ))
  while :; do
    if [ -f "${WAL_ARCHIVE_DIR}/${file}" ] && [ -f "${WAL_ARCHIVE_DIR}/${file}.sha256" ]; then
      return 0
    fi
    [ "$(date -u +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

echo "Validating $REQUIRED_COUNT required WAL file(s) in the dedicated archive ..."
declare -A WAL_SHA=()
while IFS= read -r wal_file; do
  [ -n "$wal_file" ] || continue
  wait_for_wal "$wal_file" || die "$BACKUP_EXIT_VERIFY" \
    "required WAL file '$wal_file' was not archived within ${WAL_WAIT_SECONDS}s; base backup will not be marked PITR-ready."
  wal_path="${WAL_ARCHIVE_DIR}/${wal_file}"
  wal_size="$(backup_file_bytes "$wal_path")"
  [ "$wal_size" = "$WAL_SEGMENT_SIZE" ] || die "$BACKUP_EXIT_VERIFY" \
    "required WAL file '$wal_file' has size $wal_size; expected $WAL_SEGMENT_SIZE."
  sidecar_line="$(tr -d '\r' < "${wal_path}.sha256")"
  declared_sha="${sidecar_line%% *}"
  backup_is_sha256 "$declared_sha" || die "$BACKUP_EXIT_VERIFY" \
    "required WAL file '$wal_file' has a malformed checksum sidecar."
  [ "$sidecar_line" = "$declared_sha  $wal_file" ] || die "$BACKUP_EXIT_VERIFY" \
    "WAL checksum sidecar for '$wal_file' names a different file."
  actual_sha="$(backup_sha256 "$wal_path")"
  [ "$(printf '%s' "$actual_sha" | tr 'A-F' 'a-f')" = "$(printf '%s' "$declared_sha" | tr 'A-F' 'a-f')" ] || \
    die "$BACKUP_EXIT_VERIFY" "corrupt WAL detected: '$wal_file' does not match its SHA-256 sidecar."
  WAL_SHA["$wal_file"]="$actual_sha"
done <<< "$REQUIRED_FILES"

echo "Packaging verified base backup ..."
tar -C "${TMP_DIR}/base" -czf "${TMP_DIR}/base.tar.gz" . || die "$BACKUP_EXIT_IO" \
  "failed to create base backup tar archive."
tar tzf "${TMP_DIR}/base.tar.gz" >/dev/null 2>&1 || die "$BACKUP_EXIT_VERIFY" \
  "base backup tar archive failed integrity check."
PLAIN_SHA="$(backup_sha256 "${TMP_DIR}/base.tar.gz")"
PLAIN_BYTES="$(backup_file_bytes "${TMP_DIR}/base.tar.gz")"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ID="$(backup_new_id)"
SUFFIX="pitr"
[ -z "$LABEL" ] || SUFFIX="pitr-${LABEL}"
SET_DIR="${BACKUP_ROOT_ARG}/${TIER}/clinic-${TIER}-${STAMP}-${SUFFIX}"
[ ! -e "$SET_DIR" ] || die "$BACKUP_EXIT_IO" "backup set directory already exists: $SET_DIR"
mkdir -p "$SET_DIR" || die "$BACKUP_EXIT_IO" "could not create backup set directory."

if [ -n "$AGE_RECIPIENT" ]; then
  BASE_ARTIFACT="base-${STAMP}.tar.gz.age"
  printf '%s\n' "$AGE_RECIPIENT" > "${TMP_DIR}/recipient.txt" || die "$BACKUP_EXIT_IO" \
    "could not stage the age recipient."
  age -R "${TMP_DIR}/recipient.txt" -o "${TMP_DIR}/${BASE_ARTIFACT}" "${TMP_DIR}/base.tar.gz" || \
    die "$BACKUP_EXIT_ENCRYPTION" "age encryption of the base backup failed."
  ENCRYPTION="age"
else
  BASE_ARTIFACT="base-${STAMP}.tar.gz"
  cp -- "${TMP_DIR}/base.tar.gz" "${TMP_DIR}/${BASE_ARTIFACT}" || die "$BACKUP_EXIT_IO" \
    "failed to stage unencrypted base artifact."
  ENCRYPTION="none"
fi
BASE_SHA="$(backup_sha256 "${TMP_DIR}/${BASE_ARTIFACT}")"
BASE_BYTES="$(backup_file_bytes "${TMP_DIR}/${BASE_ARTIFACT}")"
cp -- "${TMP_DIR}/${BASE_ARTIFACT}" "${SET_DIR}/${BASE_ARTIFACT}" || die "$BACKUP_EXIT_IO" \
  "failed to publish base artifact."
printf '%s  %s\n' "$BASE_SHA" "$BASE_ARTIFACT" > "${SET_DIR}/SHA256SUMS" || die "$BACKUP_EXIT_IO" \
  "failed to write SHA256SUMS."

CREATED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MANIFEST="${SET_DIR}/MANIFEST.txt"
{
  printf 'backup_id=%s\n' "$BACKUP_ID"
  printf 'backup_format=pitr-base-1\n'
  printf 'manifest_version=1\n'
  printf 'pg_version=%s\n' "$PG_VERSION"
  printf 'created_utc=%s\n' "$CREATED_UTC"
  printf 'start_lsn=%s\n' "$START_LSN"
  printf 'stop_lsn=%s\n' "$STOP_LSN"
  printf 'timeline=%s\n' "$TIMELINE"
  printf 'wal_segment_size=%s\n' "$WAL_SEGMENT_SIZE"
  printf 'wal_archive_dir=%s\n' "$WAL_ARCHIVE_DIR"
  printf 'wal_archive_mount_checked=%s\n' "$((1 - SKIP_MOUNT_CHECK))"
  printf 'archive_mode=%s\n' "$ARCHIVE_MODE"
  printf 'archive_timeout=%s\n' "$ARCHIVE_TIMEOUT"
  printf 'archiver_last_archived_wal=%s\n' "$ARCHIVER_LAST_SUCCESS"
  printf 'archiver_last_failed_wal=%s\n' "$ARCHIVER_LAST_FAILURE"
  printf 'archiver_failed_count=%s\n' "$ARCHIVER_FAILED_COUNT"
  printf 'required_wal_start=%s\n' "$START_FILE"
  printf 'required_wal_end=%s\n' "$END_FILE"
  printf 'required_wal_count=%s\n' "$REQUIRED_COUNT"
  printf 'required_wal_files=%s\n' "$REQUIRED_FILES"
  while IFS= read -r wal_file; do
    [ -n "$wal_file" ] || continue
    printf 'wal.sha256.%s=%s\n' "$wal_file" "${WAL_SHA[$wal_file]}"
  done <<< "$REQUIRED_FILES"
  printf 'base_archive=%s\n' "$BASE_ARTIFACT"
  printf 'base_sha256=%s\n' "$BASE_SHA"
  printf 'base_bytes=%s\n' "$BASE_BYTES"
  printf 'base_plain_sha256=%s\n' "$PLAIN_SHA"
  printf 'base_plain_bytes=%s\n' "$PLAIN_BYTES"
  printf 'checksums=SHA256SUMS\n'
  printf 'encryption=%s\n' "$ENCRYPTION"
  printf 'pitr_ready=true\n'
} > "$MANIFEST" || die "$BACKUP_EXIT_IO" "failed to write backup manifest."

chmod 600 "$MANIFEST" "${SET_DIR}/SHA256SUMS" "${SET_DIR}/${BASE_ARTIFACT}" || \
  die "$BACKUP_EXIT_IO" "failed to secure backup set files."

printf 'PITR BASE BACKUP SUCCESS\n'
printf '  set: %s\n' "$SET_DIR"
printf '  backup_id: %s\n' "$BACKUP_ID"
printf '  backup_format: pitr-base-1\n'
printf '  pg_version: %s\n' "$PG_VERSION"
printf '  lsn_range: %s .. %s (timeline %s)\n' "$START_LSN" "$STOP_LSN" "$TIMELINE"
printf '  required_wal_files: %s (%s .. %s)\n' "$REQUIRED_COUNT" "$START_FILE" "$END_FILE"
printf '  wal_archive_dir: %s\n' "$WAL_ARCHIVE_DIR"
printf '  pitr_ready: true\n'
printf '  duration_seconds: %s\n' "$(( $(date -u +%s) - START_EPOCH ))"
exit "$BACKUP_EXIT_OK"
