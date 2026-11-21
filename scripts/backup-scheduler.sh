#!/usr/bin/env bash
# Phase 9.6 repository-side scheduling dispatcher.
#
# This script is CONFIGURATION ONLY. It is not installed, enabled or invoked on
# production by this phase. A named owner must approve and install the systemd
# units in deploy/ before any schedule runs.
#
# Usage:
#   backup-scheduler.sh <full|pitr-base|verify|retention|wal-prune> [options]
#
# Common options:
#   --dry-run            never mutate (default for retention and wal-prune)
#   --apply              allow mutation (retention/wal-prune still need --confirm DELETE)
#   --confirm DELETE     explicit confirmation for destructive cleanup
#   -h|--help
#
# All jobs share one non-blocking lock so two backup/PITR/cleanup jobs can never
# overlap. Every run logs start, completion and failure with exit codes to
# ${BACKUP_ROOT}/logs/schedule-<job>.log. Low disk space fails safe before any
# job touches data. No credentials are read or logged.
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "${SCRIPT_DIR}/.." && pwd)

JOB=${1:-}
[ "$#" -gt 0 ] && shift || true
DRY_RUN=0
APPLY=0
CONFIRM=""
PASS_THROUGH=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; PASS_THROUGH+=("$1") ;;
    --apply)          APPLY=1; PASS_THROUGH+=("$1") ;;
    --confirm)        [ "$#" -ge 2 ] || { echo "BACKUP ERROR: --confirm needs a value." >&2; exit 2; }
                      CONFIRM=$2; PASS_THROUGH+=("$1" "$2"); shift ;;
    -h|--help)        sed -n '2,20p' "$0"; exit 0 ;;
    *)                PASS_THROUGH+=("$1") ;;
  esac
  shift
done

case "$JOB" in
  full|pitr-base|verify|retention|wal-prune) : ;;
  *) echo "BACKUP ERROR: unknown job '$JOB'. Use full|pitr-base|verify|retention|wal-prune." >&2; exit 2 ;;
esac

BACKUP_ROOT=${BACKUP_ROOT:-/mnt/clinic-backups}
LOG_DIR="${BACKUP_ROOT}/logs"
LOCK_FILE=${SCHED_LOCK_FILE:-/run/lock/clinic-backup.lock}
LOCK_FD=${SCHED_LOCK_FD:-9}
MIN_FREE_MB=${SCHED_MIN_FREE_MB:-1024}
case "$MIN_FREE_MB" in ''|*[!0-9]*) echo "BACKUP ERROR: SCHED_MIN_FREE_MB must be a non-negative integer." >&2; exit 2 ;; esac

mkdir -p "$LOG_DIR" 2>/dev/null || { echo "BACKUP ERROR: cannot create log directory $LOG_DIR." >&2; exit 3; }
LOG_FILE="${LOG_DIR}/schedule-${JOB}.log"

log_line() {
  printf '%s job=%s event=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$JOB" "$1" "${2:-}" >> "$LOG_FILE"
}

# Non-blocking global lock: a second scheduler exits 0 without starting work so
# overlapping timers never stack or race on manifests/WAL files.
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
eval "exec ${LOCK_FD}>\"\$LOCK_FILE\""
if ! flock -n "$LOCK_FD"; then
  log_line skipped "reason=another-job-holds-lock"
  printf 'scheduler job=%s skipped: another backup job holds the lock\n' "$JOB"
  exit 0
fi

RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
log_line start "run_id=${RUN_ID} apply=${APPLY} dry_run=${DRY_RUN}"

finish() {
  _rc=$?
  trap - EXIT
  log_line completed "run_id=${RUN_ID} exit_code=${_rc}"
  exit "$_rc"
}
trap finish EXIT

fail() { echo "BACKUP ERROR: $*" >&2; return 3; }

# Disk preflight on the backup root and on the WAL archive (if present).
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

WAL_ARCHIVE_DIR=${WAL_ARCHIVE_DIR:-${BACKUP_ROOT}/wal-archive}
if [ -d "$WAL_ARCHIVE_DIR" ]; then preflight_disk "$WAL_ARCHIVE_DIR" wal-archive; fi

manifest_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2"; }

newest_logical_manifest() {
  # Only format 3/4 logical sets; PITR base sets are validated by their own job.
  local found="" f fmt
  while IFS= read -r f; do
    fmt=$(manifest_value backup_format "$f" || true)
    case "$fmt" in 3|4) found=$f ;; esac
  done < <(find "$BACKUP_ROOT" -mindepth 3 -maxdepth 3 -type f -name MANIFEST.txt 2>/dev/null | sort)
  printf '%s' "$found"
}

prune_wal() {
  local floor="" f start ready
  for f in $(find "$BACKUP_ROOT" -mindepth 3 -maxdepth 3 -type f -name MANIFEST.txt 2>/dev/null | sort); do
    [ "$(manifest_value backup_format "$f")" = "pitr-base-1" ] || continue
    [ "$(manifest_value pitr_ready "$f")" = "true" ] || continue
    start=$(manifest_value required_wal_start "$f")
    case "$start" in
      ????????????????????????) : ;;
      *) fail "retained PITR manifest has an invalid required_wal_start: $f" ;;
    esac
    if [ -z "$floor" ] || [ "$start" \< "$floor" ]; then floor=$start; fi
  done
  if [ -z "$floor" ]; then
    log_line wal_prune "result=no-retained-pitr-base; no WAL eligible for pruning"
    printf 'wal-prune: no retained PITR base backup; nothing pruned\n'
    return 0
  fi

  local newest="" seg deleted=0 skipped=0
  for f in "$WAL_ARCHIVE_DIR"/????????????????????????; do
    [ -f "$f" ] || continue
    seg=$(basename "$f")
    [ "$seg" \< "$floor" ] || { skipped=$((skipped + 1)); continue; }
    # Never delete the newest archived segment, even if a manifest is stale.
    if [ -z "$newest" ] || [ "$seg" \> "$newest" ]; then newest=$seg; fi
  done
  # Delete only segments strictly below the floor that are not the newest.
  for f in "$WAL_ARCHIVE_DIR"/????????????????????????; do
    [ -f "$f" ] || continue
    seg=$(basename "$f")
    [ "$seg" \< "$floor" ] || continue
    [ "$seg" = "$newest" ] && continue
    if [ "$DRY_RUN" -eq 1 ] || [ "$APPLY" -eq 0 ] || [ "$CONFIRM" != "DELETE" ]; then
      printf 'wal-prune DRY-RUN would delete %s and %s.sha256\n' "$seg" "$seg"
    else
      rm -f -- "$f" "$WAL_ARCHIVE_DIR/${seg}.sha256"
      deleted=$((deleted + 1))
      log_line wal_prune_delete "segment=${seg}"
    fi
  done
  log_line wal_prune "floor=${floor} deleted=${deleted} retained=${skipped} dry_run=${DRY_RUN}"
  printf 'wal-prune: floor=%s deleted=%s retained=%s dry_run=%s\n' "$floor" "$deleted" "$skipped" "$DRY_RUN"
}

case "$JOB" in
  full)
    bash "${SCRIPT_DIR}/backup.sh" "${PASS_THROUGH[@]}"
    ;;
  pitr-base)
    bash "${SCRIPT_DIR}/pitr-base-backup.sh" "${PASS_THROUGH[@]}"
    ;;
  verify)
    target=$(newest_logical_manifest)
    [ -n "$target" ] || fail "no format 3/4 logical backup manifest found to verify."
    log_line verify "manifest=${target}"
    bash "${SCRIPT_DIR}/backup-verify.sh" "$(dirname "$target")"
    ;;
  retention)
    if [ "$APPLY" -eq 1 ] && [ "$CONFIRM" = "DELETE" ]; then
      bash "${SCRIPT_DIR}/backup-retention.sh" --apply --confirm DELETE "${PASS_THROUGH[@]}"
    else
      bash "${SCRIPT_DIR}/backup-retention.sh" --dry-run "${PASS_THROUGH[@]}"
    fi
    ;;
  wal-prune)
    prune_wal
    ;;
esac

log_line success "job=${JOB} finished"
