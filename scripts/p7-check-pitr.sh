#!/usr/bin/env bash
# Phase 9.6 read-only PITR check for the local monitor.
# Monitors: newest WAL-linked PITR base backup age, completeness/validity of the
# WAL range it requires, and freshness of the newest archived WAL segment.
# No database connection, no deletion, no archiving, no external notification.
# Exit: 0=ok 1=warn 2=high 3=critical 4=unknown.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p7-common.sh
. "${SCRIPT_DIR}/p7-common.sh"

BACKUP_ROOT="${P7_BACKUP_ROOT:-${P7_BACKUP_MOUNT:-/mnt/clinic-backups}}"
WAL_ARCHIVE_DIR="${P7_WAL_ARCHIVE_DIR:-${BACKUP_ROOT}/wal-archive}"
MAX_AGE_WARN_H="${P7_PITR_AGE_WARN_HOURS:-72}"
MAX_AGE_HIGH_H="${P7_PITR_AGE_HIGH_HOURS:-168}"
MAX_AGE_CRIT_H="${P7_PITR_AGE_CRIT_HOURS:-336}"
FRESH_WARN="${P7_WAL_FRESHNESS_WARN_SECONDS:-600}"
FRESH_HIGH="${P7_WAL_FRESHNESS_HIGH_SECONDS:-1200}"
FRESH_CRIT="${P7_WAL_FRESHNESS_CRITICAL_SECONDS:-1800}"
now="$(p7_now)"

manifest_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2" 2>/dev/null | tr -d '\r'; }

# Increment a 24-hex-character PostgreSQL WAL segment name without numeric
# overflow (bash arithmetic is only 64-bit). Operates right-to-left with carry.
hex_inc_wal() {
  local s=$1 i c carry=1 out=""
  for (( i=${#s}-1; i>=0; i-- )); do
    c=${s:i:1}
    if [ "$carry" -eq 1 ]; then
      case "$c" in
        0) c=1; carry=0 ;; 1) c=2; carry=0 ;; 2) c=3; carry=0 ;; 3) c=4; carry=0 ;;
        4) c=5; carry=0 ;; 5) c=6; carry=0 ;; 6) c=7; carry=0 ;; 7) c=8; carry=0 ;;
        8) c=9; carry=0 ;; 9) c=A; carry=0 ;; A) c=B; carry=0 ;; B) c=C; carry=0 ;;
        C) c=D; carry=0 ;; D) c=E; carry=0 ;; E) c=F; carry=0 ;; F) c=0; carry=1 ;;
      esac
    fi
    out="${c}${out}"
  done
  printf '%s' "$out"
}

worst=0
rank_for_status() { case "$1" in unknown) printf '4' ;; critical) printf '3' ;; high) printf '2' ;; warn) printf '1' ;; ok) printf '0' ;; *) printf '1' ;; esac; }
note_worst() { local r; r=$(rank_for_status "$1"); [ "$r" -gt "$worst" ] && worst=$r; return 0; }

# --- newest retained PITR base backup ---------------------------------------
newest_manifest="" newest_stamp=""
for set_dir in "${BACKUP_ROOT}"/*/*; do
  [ -f "${set_dir}/MANIFEST.txt" ] || continue
  m="${set_dir}/MANIFEST.txt"
  [ "$(manifest_value backup_format "$m")" = "pitr-base-1" ] || continue
  [ "$(manifest_value pitr_ready "$m")" = "true" ] || continue
  stamp="$(manifest_value created_utc "$m")"
  case "$stamp" in ????????T??????Z) : ;; *) continue ;; esac
  if [ -z "$newest_stamp" ] || [ "$stamp" \> "$newest_stamp" ]; then
    newest_stamp=$stamp; newest_manifest=$m
  fi
done

if [ -z "$newest_manifest" ]; then
  line="$(p7_emit pitr.base critical page 'no pitr_ready base backup found in the approved backup root' "\"backupRoot\":\"$(p7_json_escape "$BACKUP_ROOT")\",\"runbook\":\"docs/backup-restore.md#pitr\"")"
  printf '%s\n' "$line"; note_worst critical
else
  iso="${newest_stamp:0:4}-${newest_stamp:4:2}-${newest_stamp:6:2}T${newest_stamp:9:2}:${newest_stamp:11:2}:${newest_stamp:13:2}Z"
  created_epoch="$(date -u -d "$iso" +%s 2>/dev/null || printf '0')"
  age_h=$(( (now - created_epoch) / 3600 ))
  [ "$age_h" -lt 0 ] && age_h=0
  status=ok; severity=info; message="PITR base backup is current"
  if [ "$age_h" -ge "$MAX_AGE_CRIT_H" ]; then
    status=critical; severity=page; message="PITR base backup older than ${MAX_AGE_CRIT_H}h"
  elif [ "$age_h" -ge "$MAX_AGE_HIGH_H" ]; then
    status=high; severity=warn; message="PITR base backup older than ${MAX_AGE_HIGH_H}h"
  elif [ "$age_h" -ge "$MAX_AGE_WARN_H" ]; then
    status=warn; severity=info; message="PITR base backup older than ${MAX_AGE_WARN_H}h"
  fi
  extra="\"manifest\":\"$(p7_json_escape "${newest_manifest#${BACKUP_ROOT}/}")\",\"ageHours\":${age_h},\"thresholdsHours\":[${MAX_AGE_WARN_H},${MAX_AGE_HIGH_H},${MAX_AGE_CRIT_H}],\"runbook\":\"docs/backup-restore.md#pitr\""
  line="$(p7_emit pitr.base "$status" "$severity" "$message" "$extra")"
  printf '%s\n' "$line"; note_worst "$status"

  # --- required WAL range completeness and sidecar validity ------------------
  start_file="$(manifest_value required_wal_start "$newest_manifest")"
  end_file="$(manifest_value required_wal_end "$newest_manifest")"
  missing=0 invalid=0 checked=0
  if [ -z "$start_file" ] || [ -z "$end_file" ]; then
    line="$(p7_emit pitr.wal critical page 'newest PITR manifest lacks its required WAL range' "\"runbook\":\"docs/backup-restore.md#pitr\"")"
    printf '%s\n' "$line"; note_worst critical
  else
    case "$start_file" in ????????????????????????) : ;; *)
      line="$(p7_emit pitr.wal critical page 'newest PITR manifest has an invalid WAL start segment' "\"runbook\":\"docs/backup-restore.md#pitr\"")"
      printf '%s\n' "$line"; note_worst critical ;;
    esac
    seg=$start_file
    while [ -n "$seg" ]; do
      checked=$((checked + 1))
      f="${WAL_ARCHIVE_DIR}/${seg}"
      if [ ! -f "$f" ] || [ ! -f "${f}.sha256" ]; then
        missing=$((missing + 1))
      else
        actual="$(sha256sum "$f" 2>/dev/null | awk '{print $1}')"
        expected="$(awk '{print $1}' "${f}.sha256" 2>/dev/null | tr 'A-F' 'a-f')"
        [ -n "$actual" ] && [ "$actual" = "$expected" ] || invalid=$((invalid + 1))
      fi
      [ "$seg" = "$end_file" ] && break
      # Stop defensively: a corrupt/manipulated manifest must not loop forever.
      [ "$checked" -ge 100000 ] && break
      seg="$(hex_inc_wal "$seg")"
    done
    if [ "$missing" -gt 0 ] || [ "$invalid" -gt 0 ]; then
      line="$(p7_emit pitr.wal critical page 'PITR WAL range is incomplete or invalid; recovery would fail' "\"checked\":${checked},\"missing\":${missing},\"invalid\":${invalid},\"start\":\"$(p7_json_escape "$start_file")\",\"end\":\"$(p7_json_escape "$end_file")\",\"runbook\":\"docs/backup-restore.md#pitr\"")"
      printf '%s\n' "$line"; note_worst critical
    else
      line="$(p7_emit pitr.wal ok info "PITR WAL range verified (${checked} segments)" "\"checked\":${checked},\"runbook\":\"docs/backup-restore.md#pitr\"")"
      printf '%s\n' "$line"
    fi
  fi
fi

# --- archive freshness (newest segment, not the oldest) ----------------------
newest_wal_epoch=0
if [ -d "$WAL_ARCHIVE_DIR" ]; then
  newest_wal_epoch="$(find "$WAL_ARCHIVE_DIR" -maxdepth 1 -type f -name '????????????????????????' -printf '%T@\n' 2>/dev/null | sort -nr | head -1 | awk -F. '{print $1}')"
  [ -n "$newest_wal_epoch" ] || newest_wal_epoch=0
fi
if [ "$newest_wal_epoch" -eq 0 ]; then
  line="$(p7_emit pitr.wal.freshness unknown unknown 'no archived WAL segment found' "\"walArchive\":\"$(p7_json_escape "$WAL_ARCHIVE_DIR")\",\"runbook\":\"docs/backup-restore.md#pitr\"")"
  printf '%s\n' "$line"; note_worst unknown
else
  fresh_age=$((now - newest_wal_epoch)); [ "$fresh_age" -lt 0 ] && fresh_age=0
  status=ok; severity=info; message="WAL archive is fresh"
  if [ "$fresh_age" -ge "$FRESH_CRIT" ]; then
    status=critical; severity=page; message="newest archived WAL is older than ${FRESH_CRIT}s"
  elif [ "$fresh_age" -ge "$FRESH_HIGH" ]; then
    status=high; severity=warn; message="newest archived WAL is older than ${FRESH_HIGH}s"
  elif [ "$fresh_age" -ge "$FRESH_WARN" ]; then
    status=warn; severity=info; message="newest archived WAL is older than ${FRESH_WARN}s"
  fi
  line="$(p7_emit pitr.wal.freshness "$status" "$severity" "$message" "\"ageSeconds\":${fresh_age},\"thresholdsSeconds\":[${FRESH_WARN},${FRESH_HIGH},${FRESH_CRIT}],\"runbook\":\"docs/backup-restore.md#pitr\"")"
  printf '%s\n' "$line"; note_worst "$status"
fi

case "$worst" in
  4) worst_status=unknown ;; 3) worst_status=critical ;; 2) worst_status=high ;; 1) worst_status=warn ;; *) worst_status=ok ;;
esac
printf '%s\n' "$(p7_emit pitr "$worst_status" "$worst_status" 'PITR readiness summary' "\"worst\":\"$(p7_json_escape "$worst_status")\",\"runbook\":\"docs/backup-restore.md#pitr\"")"
p7_exit_for "$worst_status"
