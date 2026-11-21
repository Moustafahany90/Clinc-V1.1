#!/usr/bin/env bash
# Phase 9.6/9.8 repository-side scheduling dispatcher.
#
# This script is CONFIGURATION ONLY. It is not installed, enabled or invoked on
# production by this phase. A named owner must approve and install the systemd
# units in deploy/ before any schedule runs.
#
# Usage:
#   backup-scheduler.sh <full|pitr-base|verify|retention|wal-prune> [options]
#
# Common options:
#   --dry-run            validate and print the plan; never mutate
#   --apply              allow mutation (retention/wal-prune only)
#   --confirm DELETE     explicit confirmation for destructive cleanup
#   -h|--help
#
# Job-specific options:
#   pitr-base      --pghost H --pgport P --pguser U [--pgdatabase D]
#                  [--wal-archive-dir DIR] [--backup-root DIR] [--tier T]
#                  [--label L] [--age-recipient KEY] [--skip-mount-check]
#   verify         [--root DIR]
#   retention      [--root DIR] [--keep-daily N] [--keep-weekly N]
#                  [--keep-monthly N]
#   wal-prune      [--wal-archive-dir DIR]
#   full           none (all configuration is environment-based)
#
# The four mandatory pitr-base values come from explicit flags or the protected
# environment file: PITR_PGHOST, PITR_PGPORT, PITR_PGUSER and WAL_ARCHIVE_DIR.
# All jobs share one non-blocking lock. Overlap skips become visible after
# SCHED_OVERLAP_SKIP_ALERT_AFTER consecutive skips and then exit non-zero.
# Every run logs start, completion and failure with exit codes to
# ${BACKUP_ROOT}/logs/schedule-<job>.log. No credentials are read or logged.
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "${SCRIPT_DIR}/.." && pwd)
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

JOB=${1:-}
[ "$#" -gt 0 ] && shift || true
DRY_RUN=0
APPLY=0
CONFIRM=""
SCHED_SKIP_MOUNT_CHECK="${SCHED_SKIP_MOUNT_CHECK:-0}"
OVERLAP_ALERT_AFTER="${SCHED_OVERLAP_SKIP_ALERT_AFTER:-3}"

OPT_ROOT=""
OPT_BACKUP_ROOT=""
OPT_WAL_ARCHIVE_DIR=""
OPT_PGHOST=""
OPT_PGPORT=""
OPT_PGUSER=""
OPT_PGDATABASE=""
OPT_TIER=""
OPT_LABEL=""
OPT_AGE_RECIPIENT=""
OPT_SKIP_MOUNT_CHECK=0
OPT_KEEP_DAILY=""
OPT_KEEP_WEEKLY=""
OPT_KEEP_MONTHLY=""

case "$SCHED_SKIP_MOUNT_CHECK" in
  0|1) : ;;
  *) echo "BACKUP ERROR: SCHED_SKIP_MOUNT_CHECK must be 0 or 1." >&2; exit 2 ;;
esac
case "$OVERLAP_ALERT_AFTER" in
  ''|*[!0-9]*) echo "BACKUP ERROR: SCHED_OVERLAP_SKIP_ALERT_AFTER must be a positive integer." >&2; exit 2 ;;
esac
[ "$OVERLAP_ALERT_AFTER" -ge 1 ] || {
  echo "BACKUP ERROR: SCHED_OVERLAP_SKIP_ALERT_AFTER must be a positive integer." >&2; exit 2
}

usage() {
  sed -n '2,30p' "$0"
}

need_value() {
  [ "$#" -ge 2 ] || { echo "BACKUP ERROR: $1 needs a value." >&2; exit 2; }
}

allow() {
  # allow <job-list> <flag>
  case " $1 " in
    *" $JOB "*) : ;;
    *) echo "BACKUP ERROR: $2 is not supported by job '$JOB'." >&2; exit 2 ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)           DRY_RUN=1; shift ;;
    --apply)             APPLY=1; shift ;;
    --confirm)           need_value "$@"; CONFIRM=$2; shift 2 ;;
    -h|--help)           usage; exit 0 ;;
    --root)              need_value "$@"; allow 'verify retention' "$1"; OPT_ROOT=$2; shift 2 ;;
    --backup-root)       need_value "$@"; allow 'pitr-base' "$1"; OPT_BACKUP_ROOT=$2; shift 2 ;;
    --wal-archive-dir)   need_value "$@"; allow 'pitr-base wal-prune' "$1"; OPT_WAL_ARCHIVE_DIR=$2; shift 2 ;;
    --pghost)            need_value "$@"; allow 'pitr-base' "$1"; OPT_PGHOST=$2; shift 2 ;;
    --pgport)            need_value "$@"; allow 'pitr-base' "$1"; OPT_PGPORT=$2; shift 2 ;;
    --pguser)            need_value "$@"; allow 'pitr-base' "$1"; OPT_PGUSER=$2; shift 2 ;;
    --pgdatabase)        need_value "$@"; allow 'pitr-base' "$1"; OPT_PGDATABASE=$2; shift 2 ;;
    --tier)              need_value "$@"; allow 'pitr-base' "$1"; OPT_TIER=$2; shift 2 ;;
    --label)             need_value "$@"; allow 'pitr-base' "$1"; OPT_LABEL=$2; shift 2 ;;
    --age-recipient)     need_value "$@"; allow 'pitr-base' "$1"; OPT_AGE_RECIPIENT=$2; shift 2 ;;
    --skip-mount-check)  allow 'pitr-base' "$1"; OPT_SKIP_MOUNT_CHECK=1; shift ;;
    --keep-daily)        need_value "$@"; allow 'retention' "$1"; OPT_KEEP_DAILY=$2; shift 2 ;;
    --keep-weekly)       need_value "$@"; allow 'retention' "$1"; OPT_KEEP_WEEKLY=$2; shift 2 ;;
    --keep-monthly)      need_value "$@"; allow 'retention' "$1"; OPT_KEEP_MONTHLY=$2; shift 2 ;;
    *) echo "BACKUP ERROR: unknown argument '$1' for job '$JOB'." >&2; exit 2 ;;
  esac
done

case "$JOB" in
  full|pitr-base|verify|retention|wal-prune) : ;;
  *) echo "BACKUP ERROR: unknown job '$JOB'. Use full|pitr-base|verify|retention|wal-prune." >&2; exit 2 ;;
esac

case "$JOB" in
  retention|wal-prune) : ;;
  *)
    [ "$APPLY" -eq 0 ] || { echo "BACKUP ERROR: --apply is only valid for retention and wal-prune." >&2; exit 2; }
    [ -z "$CONFIRM" ] || { echo "BACKUP ERROR: --confirm is only valid for retention and wal-prune." >&2; exit 2; }
    ;;
esac
[ "$DRY_RUN" -eq 0 ] || [ "$APPLY" -eq 0 ] || {
  echo "BACKUP ERROR: --dry-run and --apply are mutually exclusive." >&2; exit 2
}
if [ "$APPLY" -eq 1 ] && [ "$CONFIRM" != "DELETE" ]; then
  echo "BACKUP ERROR: --apply requires --confirm DELETE." >&2; exit 2
fi
for limit in "$OPT_KEEP_DAILY" "$OPT_KEEP_WEEKLY" "$OPT_KEEP_MONTHLY"; do
  [ -z "$limit" ] || case "$limit" in
    ''|*[!0-9]*) echo "BACKUP ERROR: retention limits must be whole numbers." >&2; exit 2 ;;
  esac
done

BACKUP_ROOT="${OPT_BACKUP_ROOT:-${OPT_ROOT:-${BACKUP_ROOT:-/mnt/clinic-backups}}}"
WAL_ARCHIVE_DIR="${OPT_WAL_ARCHIVE_DIR:-${WAL_ARCHIVE_DIR:-${BACKUP_ROOT}/wal-archive}}"
LOG_DIR="${BACKUP_ROOT}/logs"
LOCK_FILE=${SCHED_LOCK_FILE:-/run/lock/clinic-backup.lock}
LOCK_FD=${SCHED_LOCK_FD:-9}
MIN_FREE_MB=${SCHED_MIN_FREE_MB:-1024}
case "$LOCK_FD" in ''|*[!0-9]*) echo "BACKUP ERROR: SCHED_LOCK_FD must be an integer." >&2; exit 2 ;; esac
case "$MIN_FREE_MB" in ''|*[!0-9]*) echo "BACKUP ERROR: SCHED_MIN_FREE_MB must be a non-negative integer." >&2; exit 2 ;; esac

# PB-27: validate the approved mount BEFORE creating any directory or lock file.
# SCHED_SKIP_MOUNT_CHECK=1 exists only for disposable synthetic fixtures and is
# rejected by the repository preflight when it appears in shipped config.
if [ "$SCHED_SKIP_MOUNT_CHECK" = "1" ] || [ "$OPT_SKIP_MOUNT_CHECK" = "1" ]; then
  printf 'WARNING: SCHED_SKIP_MOUNT_CHECK is enabled (TEST ONLY); mount validation skipped.\n' >&2
else
  if ! backup_check_storage "$BACKUP_ROOT"; then
    echo "BACKUP ERROR: $BACKUP_CHECK_REASON" >&2
    exit 3
  fi
fi

# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"
STATE_DIR="$(p7_state_dir)"
mkdir -p "$LOG_DIR" 2>/dev/null || { echo "BACKUP ERROR: cannot create log directory $LOG_DIR." >&2; exit 3; }
LOG_FILE="${LOG_DIR}/schedule-${JOB}.log"

log_line() {
  printf '%s job=%s event=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$JOB" "$1" "${2:-}" >> "$LOG_FILE"
}

scheduler_alert() {
  local line
  line="$(p7_emit backup.scheduler "$1" "$2" "$3" "$4")"
  printf '%s\n' "$line" >&2
  p7_alert "$line"
}

# Non-blocking global lock. Repeated contention is visible and eventually fails.
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
eval "exec ${LOCK_FD}>\"\$LOCK_FILE\""
if ! flock -n "$LOCK_FD"; then
  skip_file="${STATE_DIR}/clinic-backup-overlap-skips-${JOB}"
  skips=$(cat "$skip_file" 2>/dev/null || printf '0')
  case "$skips" in ''|*[!0-9]*) skips=0 ;; esac
  skips=$((skips + 1))
  printf '%s' "$skips" > "$skip_file"
  log_line skipped "reason=another-job-holds-lock consecutive_skips=${skips}"
  if [ "$skips" -ge "$OVERLAP_ALERT_AFTER" ]; then
    scheduler_alert high warn "backup job ${JOB} was skipped ${skips} consecutive times because the lock was held" \
      "\"job\":\"$(p7_json_escape "$JOB")\",\"skips\":${skips},\"runbook\":\"docs/monitoring-runbook.md#backup-scheduling\""
    printf 'scheduler job=%s FAILED: lock contention after %s consecutive skips\n' "$JOB" "$skips" >&2
    exit 75
  fi
  printf 'scheduler job=%s skipped: another backup job holds the lock (%s/%s)\n' "$JOB" "$skips" "$OVERLAP_ALERT_AFTER"
  exit 0
fi
rm -f "${STATE_DIR}/clinic-backup-overlap-skips-${JOB}"

RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
log_line start "run_id=${RUN_ID} apply=${APPLY} dry_run=${DRY_RUN}"

finish() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    log_line failed "run_id=${RUN_ID} exit_code=${rc}"
    scheduler_alert high warn "backup job ${JOB} failed with exit code ${rc}" \
      "\"job\":\"$(p7_json_escape "$JOB")\",\"exitCode\":${rc},\"runId\":\"$(p7_json_escape "$RUN_ID")\",\"runbook\":\"docs/monitoring-runbook.md#backup-scheduling\""
  else
    log_line completed "run_id=${RUN_ID} exit_code=0"
  fi
  exit "$rc"
}
trap finish EXIT

fail() { echo "BACKUP ERROR: $*" >&2; return 3; }

preflight_disk() {
  local dir=$1 label=$2 avail needed
  [ -d "$dir" ] || fail "preflight directory does not exist: $dir"
  avail=$(df -Pk "$dir" 2>/dev/null | awk 'NR == 2 { print $4 }')
  case "$avail" in ''|*[!0-9]*) fail "could not determine free space for $label ($dir)." ;; esac
  needed=$((MIN_FREE_MB * 1024))
  if [ "$avail" -lt "$needed" ]; then
    fail "insufficient free space on $label (have ${avail} KiB, need ${needed} KiB)."
  fi
  log_line preflight "target=${label} available_kib=${avail} required_kib=${needed}"
}

preflight_disk "$BACKUP_ROOT" backup-root
case "$JOB" in
  pitr-base|wal-prune)
    [ -d "$WAL_ARCHIVE_DIR" ] || fail "wal archive directory does not exist: $WAL_ARCHIVE_DIR"
    preflight_disk "$WAL_ARCHIVE_DIR" wal-archive
    ;;
  *)
    if [ -d "$WAL_ARCHIVE_DIR" ]; then preflight_disk "$WAL_ARCHIVE_DIR" wal-archive; fi
    ;;
esac

manifest_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2" 2>/dev/null | tr -d '\r'; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
file_bytes() { wc -c < "$1" | tr -d ' '; }

newest_logical_manifest() {
  local found="" f fmt
  while IFS= read -r f; do
    fmt=$(manifest_value backup_format "$f" || true)
    case "$fmt" in 3|4) found=$f ;; esac
  done < <(find "$BACKUP_ROOT" -mindepth 3 -maxdepth 3 -type f -name MANIFEST.txt 2>/dev/null | sort)
  printf '%s' "$found"
}

pitr_base_is_valid() {
  local manifest=$1 dir base sha bytes actual count seg expected sidecar stored
  dir="$(dirname "$manifest")"
  [ "$(manifest_value backup_format "$manifest")" = "pitr-base-1" ] || return 1
  [ "$(manifest_value pitr_ready "$manifest")" = "true" ] || return 1
  base="$(manifest_value base_archive "$manifest")"
  case "$base" in ''|*/*|*..*) return 1 ;; esac
  [ -f "${dir}/${base}" ] || return 1
  sha="$(manifest_value base_sha256 "$manifest" | tr 'A-F' 'a-f')"
  bytes="$(manifest_value base_bytes "$manifest")"
  case "$sha" in *[!0-9a-f]*|'') return 1 ;; esac
  [ "${#sha}" -eq 64 ] || return 1
  case "$bytes" in ''|*[!0-9]*) return 1 ;; esac
  [ "$(sha256_of "${dir}/${base}")" = "$sha" ] || return 1
  [ "$(file_bytes "${dir}/${base}")" = "$bytes" ] || return 1
  grep -Eq "^${sha} [ *]${base}$" "${dir}/SHA256SUMS" 2>/dev/null || return 1
  start_file="$(manifest_value required_wal_start "$manifest")"
  end_file="$(manifest_value required_wal_end "$manifest")"
  backup_wal_is_segment "$start_file" || return 1
  backup_wal_is_segment "$end_file" || return 1
  count="$(manifest_value required_wal_count "$manifest")"
  case "$count" in ''|*[!0-9]*) return 1 ;; esac
  local seen=0
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    backup_wal_is_segment "$seg" || return 1
    seen=$((seen + 1))
    expected="$(manifest_value "wal.sha256.${seg}" "$manifest" | tr 'A-F' 'a-f')"
    case "$expected" in *[!0-9a-f]*|'') return 1 ;; esac
    [ "${#expected}" -eq 64 ] || return 1
    [ -f "${WAL_ARCHIVE_DIR}/${seg}" ] || return 1
    [ "$(sha256_of "${WAL_ARCHIVE_DIR}/${seg}")" = "$expected" ] || return 1
    sidecar="${WAL_ARCHIVE_DIR}/${seg}.sha256"
    [ -f "$sidecar" ] || return 1
    stored="$(awk 'NR == 1 { print $1 }' "$sidecar" 2>/dev/null | tr 'A-F' 'a-f')"
    [ "$stored" = "$expected" ] || return 1
  done <<<"$(manifest_values required_wal_files "$manifest")"
  [ "$seen" -eq "$count" ] || return 1
  return 0
}

prune_wal() {
  local f manifest floor="" valid_count=0 start newest="" seg deleted=0
  local -A required=() start_by_manifest=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$(manifest_value backup_format "$f")" = "pitr-base-1" ] || continue
    [ "$(manifest_value pitr_ready "$f")" = "true" ] || continue
    if ! pitr_base_is_valid "$f"; then
      fail "retained PITR base failed validation; refusing to prune: $f"
    fi
    valid_count=$((valid_count + 1))
    start="$(manifest_value required_wal_start "$f")"
    start_by_manifest["$f"]="$start"
    if [ -z "$floor" ] || [ "$start" \< "$floor" ]; then floor=$start; fi
  done < <(find "$BACKUP_ROOT" -mindepth 3 -maxdepth 3 -type f -name MANIFEST.txt 2>/dev/null | sort)
  [ "$valid_count" -gt 0 ] || fail "no validated pitr_ready base backup; refusing to prune WAL"
  [ -n "$floor" ] || fail "could not determine a WAL floor; refusing to prune"

  for f in "${!start_by_manifest[@]}"; do
    [ "${start_by_manifest[$f]}" \< "$floor" ] && fail "WAL floor is above a retained base requirement: $f"
    while IFS= read -r seg; do
      [ -n "$seg" ] || continue
      required["$seg"]=1
    done <<<"$(manifest_values required_wal_files "$f")"
  done

  local -a candidates=() final=()
  local required_protected=0 retained=0
  for f in "$WAL_ARCHIVE_DIR"/????????????????????????; do
    [ -f "$f" ] || continue
    seg="$(basename "$f")"
    backup_wal_is_segment "$seg" || continue
    if [ -z "$newest" ] || [ "$seg" \> "$newest" ]; then newest=$seg; fi
    if [ -n "${required[$seg]:-}" ]; then
      required_protected=$((required_protected + 1))
      continue
    fi
    [ "$seg" \< "$floor" ] || { retained=$((retained + 1)); continue; }
    candidates+=("$seg")
  done
  [ -n "$newest" ] || fail "no archived WAL segment found; refusing to prune"
  for seg in "${candidates[@]}"; do
    [ "$seg" = "$newest" ] && continue
    final+=("$seg")
  done
  candidates=("${final[@]}")

  local plan_hash
  if [ "${#candidates[@]}" -eq 0 ]; then
    plan_hash="$(printf '' | sha256sum 2>/dev/null | awk '{print $1}')"
  else
    plan_hash="$(printf '%s\n' "${candidates[@]}" | sha256sum 2>/dev/null | awk '{print $1}')"
  fi
  printf 'wal-prune PLAN version=1 root=%s floor=%s candidates=%d protected_required=%d newest=%s plan_sha256=%s\n' \
    "$WAL_ARCHIVE_DIR" "$floor" "${#candidates[@]}" "$required_protected" "$newest" "$plan_hash"
  for seg in "${candidates[@]}"; do printf 'wal-prune CANDIDATE %s\n' "$seg"; done
  log_line wal_plan "floor=${floor} candidates=${#candidates[@]} protected_required=${required_protected} newest=${newest} plan_sha256=${plan_hash}"

  if [ "$APPLY" -eq 0 ] || [ "$DRY_RUN" -eq 1 ] || [ "$CONFIRM" != "DELETE" ]; then
    printf 'wal-prune DRY-RUN: %d candidate segment(s); nothing deleted\n' "${#candidates[@]}"
    log_line wal_prune "result=dry-run deleted=0 retained=${retained} dry_run=1"
    return 0
  fi

  for seg in "${candidates[@]}"; do
    rm -f -- "${WAL_ARCHIVE_DIR}/${seg}" "${WAL_ARCHIVE_DIR}/${seg}.sha256"
    deleted=$((deleted + 1))
    log_line wal_prune_delete "segment=${seg}"
  done
  printf 'wal-prune APPLIED: floor=%s deleted=%d retained=%d plan_sha256=%s\n' \
    "$floor" "$deleted" "$retained" "$plan_hash"
  log_line wal_prune "floor=${floor} deleted=${deleted} retained=${retained} dry_run=0"
}

case "$JOB" in
  full)
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'full DRY-RUN: configuration validated; no backup started\n'
    else
      BACKUP_ROOT="$BACKUP_ROOT" bash "${SCRIPT_DIR}/backup.sh"
    fi
    ;;
  pitr-base)
    pghost="${OPT_PGHOST:-${PITR_PGHOST:-}}"
    pgport="${OPT_PGPORT:-${PITR_PGPORT:-}}"
    pguser="${OPT_PGUSER:-${PITR_PGUSER:-}}"
    pgtier="${OPT_TIER:-${PITR_TIER:-weekly}}"
    [ -n "$pghost" ] || fail "pitr-base requires --pghost or PITR_PGHOST."
    [ -n "$pgport" ] || fail "pitr-base requires --pgport or PITR_PGPORT."
    case "$pgport" in ''|*[!0-9]*) fail "pitr-base pgport must be numeric." ;; esac
    [ -n "$pguser" ] || fail "pitr-base requires --pguser or PITR_PGUSER."
    [ -n "$WAL_ARCHIVE_DIR" ] || fail "pitr-base requires --wal-archive-dir or WAL_ARCHIVE_DIR."
    case "$pgtier" in daily|weekly|monthly) : ;; *) fail "invalid PITR tier '$pgtier'." ;; esac
    pitr_args=(--pghost "$pghost" --pgport "$pgport" --pguser "$pguser"
               --wal-archive-dir "$WAL_ARCHIVE_DIR" --backup-root "$BACKUP_ROOT"
               --tier "$pgtier")
    [ -z "${OPT_PGDATABASE:-${PITR_PGDATABASE:-}}" ] || pitr_args+=(--pgdatabase "${OPT_PGDATABASE:-${PITR_PGDATABASE:-}}")
    [ -z "$OPT_LABEL" ] || pitr_args+=(--label "$OPT_LABEL")
    [ -z "${OPT_AGE_RECIPIENT:-${PITR_AGE_RECIPIENT:-}}" ] || pitr_args+=(--age-recipient "${OPT_AGE_RECIPIENT:-${PITR_AGE_RECIPIENT:-}}")
    if [ "$SCHED_SKIP_MOUNT_CHECK" = "1" ] || [ "$OPT_SKIP_MOUNT_CHECK" = "1" ]; then
      pitr_args+=(--skip-mount-check)
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'pitr-base DRY-RUN: host=%s port=%s user=%s wal=%s tier=%s\n' \
        "$pghost" "$pgport" "$pguser" "$WAL_ARCHIVE_DIR" "$pgtier"
    else
      log_line pitr_base "host=${pghost} port=${pgport} user=${pguser} wal=${WAL_ARCHIVE_DIR} tier=${pgtier}"
      bash "${SCRIPT_DIR}/pitr-base-backup.sh" "${pitr_args[@]}"
    fi
    ;;
  verify)
    logical=$(newest_logical_manifest)
    [ -n "$logical" ] || fail "no format 3/4 logical backup manifest found to verify."
    log_line verify "newest_logical=${logical}"
    bash "${SCRIPT_DIR}/backup-verify.sh" "$BACKUP_ROOT"
    bash "${SCRIPT_DIR}/verify-pitr-base.sh" --root "$BACKUP_ROOT"
    ;;
  retention)
    retention_args=(--root "$BACKUP_ROOT")
    [ -z "$OPT_KEEP_DAILY" ] || retention_args+=(--keep-daily "$OPT_KEEP_DAILY")
    [ -z "$OPT_KEEP_WEEKLY" ] || retention_args+=(--keep-weekly "$OPT_KEEP_WEEKLY")
    [ -z "$OPT_KEEP_MONTHLY" ] || retention_args+=(--keep-monthly "$OPT_KEEP_MONTHLY")
    if [ "$APPLY" -eq 1 ]; then
      retention_args+=(--apply --confirm DELETE)
    fi
    bash "${SCRIPT_DIR}/backup-retention.sh" "${retention_args[@]}"
    ;;
  wal-prune)
    prune_wal
    ;;
esac
