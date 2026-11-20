#!/usr/bin/env bash
# Read-only backup check for the Phase 7 monitor.
# Emits one JSON status line and exits 0=ok 1=warn 2=high 3=critical 4=unknown.
# Never writes into the backup directory.
#
# Phase 8.3.1: validates the REAL mount (mountpoint + UUID + filesystem + tier
# structure + writability) and discovers manifests across the approved tier
# directories. A merely existing mount-point directory is not sufficient.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

BACKUP_ROOT="${P7_BACKUP_ROOT:-${P7_BACKUP_MOUNT:-/mnt/clinic-backups}}"
[ -z "${P7_BACKUP_UUID:-}" ] || BACKUP_EXPECTED_UUID="$P7_BACKUP_UUID"
[ -z "${P7_BACKUP_FSTYPE:-}" ] || BACKUP_EXPECTED_FSTYPE="$P7_BACKUP_FSTYPE"
MAX_AGE_HOURS="${P7_MAX_AGE_HOURS:-26}"
VERIFY_BIN="${P7_VERIFY_BIN:-${SCRIPT_DIR}/backup-verify.sh}"
SKIP_VERIFY="${P7_SKIP_VERIFY:-0}"
EXPECTED_UUID="$BACKUP_EXPECTED_UUID"
EXPECTED_FSTYPE="$BACKUP_EXPECTED_FSTYPE"

mount_ok=0
mount_note="not_checked"
actual_uuid="null"
actual_fstype="null"
if backup_check_storage "$BACKUP_ROOT"; then
  mount_ok=1
  mount_note="validated"
  actual_uuid="$BACKUP_MOUNT_UUID"
  actual_fstype="$BACKUP_MOUNT_FSTYPE"
else
  mount_note="$BACKUP_CHECK_REASON"
fi

newest_manifest=""
newest_manifest_rel=""
newest_stamp=""
if [ "$mount_ok" = "1" ]; then
  for set_dir in $(backup_list_set_dirs); do
    manifest="${set_dir}/MANIFEST.txt"
    [ -f "$manifest" ] || continue
    stamp="$(sed -n 's/^created_utc=//p' "$manifest" | head -n 1 | tr -d '\r')"
    stamp="$(printf '%s' "$stamp" | sed -n 's/^\([0-9]\{8\}T[0-9]\{6\}Z\)$/\1/p')"
    [ -n "$stamp" ] || continue
    if [ -z "$newest_stamp" ] || [ "$stamp" \> "$newest_stamp" ]; then
      newest_stamp="$stamp"
      newest_manifest="$manifest"
      newest_manifest_rel="${manifest#${BACKUP_ROOT}/}"
    fi
  done
fi

created_epoch=0
if [ -n "$newest_manifest" ] && [ -f "$newest_manifest" ]; then
  iso="${newest_stamp:0:4}-${newest_stamp:4:2}-${newest_stamp:6:2}T${newest_stamp:9:2}:${newest_stamp:11:2}:${newest_stamp:13:2}Z"
  created_epoch="$(date -u -d "$iso" +%s 2>/dev/null || printf '0')"
fi

now="$(p7_now)"
age_hours="null"
if [ "$created_epoch" -gt 0 ] 2>/dev/null; then
  age_hours="$(awk -v n="$now" -v c="$created_epoch" 'BEGIN { printf "%.2f", (n-c)/3600 }')"
fi

verify_exit="0"
verify_note="verification not run"
if [ "$SKIP_VERIFY" = "1" ]; then
  verify_exit="skipped"
  verify_note="verification skipped by P7_SKIP_VERIFY (test only)"
elif [ "$mount_ok" != "1" ]; then
  verify_exit="4"
  verify_note="storage validation failed; verifier not run"
elif [ ! -x "$VERIFY_BIN" ]; then
  verify_exit="4"
  verify_note="backup-verify script missing or not executable"
else
  verify_log="$(p7_state_dir)/backup-verify-last.log"
  BACKUP_ROOT="$BACKUP_ROOT" BACKUP_MAX_AGE_HOURS="" \
    BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 \
    "$VERIFY_BIN" "$BACKUP_ROOT" >"$verify_log" 2>&1 || verify_exit=$?
  if [ "$verify_exit" = "0" ]; then
    verify_note="backup-verify exit 0"
  else
    verify_note="backup-verify exit ${verify_exit}; see state dir log"
  fi
fi

status="ok"; severity="info"; message="backup set present and verified"
if [ "$mount_ok" != "1" ]; then
  status="critical"; severity="page"; message="backup mount is absent or invalid: $mount_note"
elif [ -z "$newest_manifest" ] || [ "$created_epoch" = "0" ]; then
  status="critical"; severity="page"; message="no complete backup manifest found in approved tier directories"
elif [ "$age_hours" != "null" ] && awk -v a="$age_hours" -v m="$MAX_AGE_HOURS" \
     'BEGIN { exit !(a>m) }' 2>/dev/null; then
  status="critical"; severity="page"; message="newest backup older than ${MAX_AGE_HOURS}h"
elif [ "$verify_exit" != "0" ] && [ "$verify_exit" != "skipped" ]; then
  status="high"; severity="warn"; message="backup verification failed"
elif [ "$verify_exit" = "skipped" ]; then
  status="warn"; severity="info"; message="backup verification was skipped"
fi

extra="\"backupRoot\":\"$(p7_json_escape "$BACKUP_ROOT")\",\"mount\":\"$(p7_json_escape "$BACKUP_ROOT")\",\"mountPresent\":${mount_ok},\"mountCheck\":\"$(p7_json_escape "$mount_note")\",\"expectedUuid\":\"$(p7_json_escape "$EXPECTED_UUID")\",\"actualUuid\":\"$(p7_json_escape "$actual_uuid")\",\"expectedFstype\":\"$(p7_json_escape "$EXPECTED_FSTYPE")\",\"actualFstype\":\"$(p7_json_escape "$actual_fstype")\",\"newestManifest\":\"$(p7_json_escape "$newest_manifest_rel")\",\"ageHours\":${age_hours},\"verifyExit\":\"${verify_exit}\",\"runbook\":\"docs/monitoring-runbook.md#backup\""
line="$(p7_emit backup "$status" "$severity" "$message" "$extra")"
printf '%s\n' "$line"
p7_alert "$line"
p7_exit_for "$status"
