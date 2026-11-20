#!/usr/bin/env bash
# Read-only backup age / mount / verification check.
# Emits one JSON status line and exits 0=ok 1=warn 2=high 3=critical 4=unknown.
# Never writes into the backup directory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

BACKUP_DIR="${P7_BACKUP_DIR:-/mnt/clinic-backups/backups}"
BACKUP_MOUNT="${P7_BACKUP_MOUNT:-/mnt/clinic-backups}"
MAX_AGE_HOURS="${P7_MAX_AGE_HOURS:-26}"
REQUIRE_MOUNT="${P7_REQUIRE_MOUNT:-1}"
REQUIRE_ENCRYPTION="${P7_REQUIRE_ENCRYPTION:-1}"
VERIFY_BIN="${P7_VERIFY_BIN:-${SCRIPT_DIR}/backup-verify.sh}"
SKIP_VERIFY="${P7_SKIP_VERIFY:-0}"

mount_present=1
mount_note="not_required"
if [ "$REQUIRE_MOUNT" = "1" ]; then
  if [ -n "${P7_MOUNT_PRESENT:-}" ]; then
    mount_present="$P7_MOUNT_PRESENT"
    mount_note="override"
  elif command -v mountpoint >/dev/null 2>&1 && mountpoint -q "$BACKUP_MOUNT" 2>/dev/null; then
    mount_present=1
    mount_note="mountpoint"
  elif [ -d "$BACKUP_MOUNT" ]; then
    mount_present=1
    mount_note="directory_only"
  else
    mount_present=0
    mount_note="missing"
  fi
fi

newest_manifest=""
newest_stamp=""
if [ -d "$BACKUP_DIR" ]; then
  newest_line="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'MANIFEST-*.txt' -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n 1 || true)"
  if [ -n "$newest_line" ]; then
    newest_manifest="${newest_line#* }"
    newest_stamp="$(printf '%s' "$newest_manifest" | sed -n 's/^MANIFEST-\([0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z\)\.txt$/\1/p')"
  fi
fi

created_epoch=0
if [ -n "$newest_stamp" ] && [ -f "${BACKUP_DIR}/${newest_manifest}" ]; then
  declared="$(sed -n 's/^created_utc=//p' "${BACKUP_DIR}/${newest_manifest}" | head -n 1 || true)"
  if [ -n "$declared" ]; then newest_stamp="$declared"; fi
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
if [ "$SKIP_VERIFY" != "1" ] && [ -d "$BACKUP_DIR" ] && [ -x "$VERIFY_BIN" ]; then
  verify_log="$(p7_state_dir)/backup-verify-last.log"
  BACKUP_MAX_AGE_HOURS="" BACKUP_VERIFY_REQUIRE_ENCRYPTION="$REQUIRE_ENCRYPTION" \
    "$VERIFY_BIN" "$BACKUP_DIR" >"$verify_log" 2>&1 || verify_exit=$?
  if [ "$verify_exit" = "0" ]; then
    verify_note="backup-verify exit 0"
  else
    verify_note="backup-verify exit ${verify_exit}; see state dir log"
  fi
elif [ "$SKIP_VERIFY" = "1" ]; then
  verify_exit="skipped"
  verify_note="verification skipped by P7_SKIP_VERIFY (test only)"
else
  verify_exit=4
  verify_note="backup-verify script missing or not executable"
fi

status="ok"; severity="info"; message="backup set present and verified"
if [ "$mount_present" != "1" ]; then
  status="critical"; severity="page"; message="required backup mount is missing"
elif [ -z "$newest_manifest" ] || [ "$created_epoch" = "0" ]; then
  status="critical"; severity="page"; message="no complete backup manifest found"
elif [ "$age_hours" != "null" ] && awk -v a="$age_hours" -v m="$MAX_AGE_HOURS" 'BEGIN { exit !(a>m) }' 2>/dev/null; then
  status="critical"; severity="page"; message="newest backup older than ${MAX_AGE_HOURS}h"
elif [ "$verify_exit" != "0" ] && [ "$verify_exit" != "skipped" ]; then
  status="high"; severity="warn"; message="backup verification failed"
elif [ "$verify_exit" = "skipped" ]; then
  status="warn"; severity="info"; message="backup verification was skipped"
fi

extra="\"backupDir\":\"$(p7_json_escape "$BACKUP_DIR")\",\"mount\":\"$(p7_json_escape "$BACKUP_MOUNT")\",\"mountPresent\":${mount_present},\"mountCheck\":\"${mount_note}\",\"newestManifest\":\"$(p7_json_escape "$newest_manifest")\",\"ageHours\":${age_hours},\"verifyExit\":\"${verify_exit}\",\"runbook\":\"docs/monitoring-runbook.md#backup\""
line="$(p7_emit backup "$status" "$severity" "$message" "$extra")"
printf '%s\n' "$line"
p7_alert "$line"
p7_exit_for "$status"
