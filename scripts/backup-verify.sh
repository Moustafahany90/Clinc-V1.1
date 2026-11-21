#!/usr/bin/env bash
# Read-only verification and inventory of backup sets on the approved disk.
#
#   ./scripts/backup-verify.sh [backup-root]
#
# Defaults to BACKUP_ROOT (/mnt/clinic-backups). Sets are discovered across the
# approved tiers: <root>/<tier>/clinic-<tier>-<STAMP>[-<label>]/ containing
# encrypted artifacts, SHA256SUMS and MANIFEST.txt.
#
# Checks: mount/UUID/filesystem/directory/writability assumptions, encryption,
# checksums, manifest consistency, missing artifacts, orphan artifacts, age and
# directory/file permissions. This script never writes to the backup
# directory, never decrypts anything and never contacts the database.
#
# BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 is a TEST-ONLY override for isolated
# synthetic fixtures. Never set it in production.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

if [ "$#" -gt 0 ]; then
  [ "$#" -eq 1 ] || backup_die "usage: $0 [backup-root]"
  BACKUP_ROOT="$1"
fi
[ -d "$BACKUP_ROOT" ] || backup_die "backup root '$BACKUP_ROOT' does not exist."
BACKUP_ROOT="$(backup_canonical "$BACKUP_ROOT")" || backup_die "cannot resolve backup root."

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-}"
REQUIRE_ENCRYPTION="${BACKUP_VERIFY_REQUIRE_ENCRYPTION:-1}"
SKIP_MOUNT_CHECK="${BACKUP_VERIFY_SKIP_MOUNT_CHECK:-0}"

ERRORS=0
WARNINGS=0
SETS=0
TOTAL_BYTES=0
NEWEST_EPOCH=0
NEWEST_STAMP=""

error() { echo "ERROR: $*" >&2; ERRORS=$((ERRORS + 1)); }
warn() { echo "WARNING: $*" >&2; WARNINGS=$((WARNINGS + 1)); }

file_bytes() { wc -c < "$1" | tr -d ' '; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
sha256_check_file() {
  if command -v sha256sum >/dev/null 2>&1; then ( cd "$1" && sha256sum -c SHA256SUMS )
  else ( cd "$1" && shasum -a 256 -c SHA256SUMS ); fi
}
human_bytes() {
  awk -v b="$1" 'BEGIN { split("B KiB MiB GiB TiB", u, " "); i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ } printf "%.1f %s", b, u[i] }'
}
stamp_epoch() {
  stamp="$1"
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) printf '0'; return 0 ;;
  esac
  iso="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
  if date -u -d "$iso" +%s >/dev/null 2>&1; then date -u -d "$iso" +%s; return 0; fi
  if date -u -j -f "%Y%m%dT%H%M%SZ" "$stamp" +%s >/dev/null 2>&1; then
    date -u -j -f "%Y%m%dT%H%M%SZ" "$stamp" +%s; return 0
  fi
  printf '0'
}
check_mode() {
  path="$1" want="$2" label="$3"
  case "$(uname -s 2>/dev/null || echo unknown)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  mode="$(stat -c %a "$path" 2>/dev/null || printf '')"
  [ -n "$mode" ] || return 0
  if [ "$((0$mode & 077))" -ne 0 ]; then
    warn "$label '$path' has mode $mode; expected $want (no group/other access)."
  fi
}

echo "Verifying backup sets under $BACKUP_ROOT ..."

if [ "$SKIP_MOUNT_CHECK" = "1" ]; then
  warn "mount validation skipped by BACKUP_VERIFY_SKIP_MOUNT_CHECK (test only)."
elif ! backup_check_storage "$BACKUP_ROOT"; then
  error "storage validation failed: $BACKUP_CHECK_REASON"
else
  echo "Storage: $BACKUP_MOUNT_UUID / $BACKUP_MOUNT_FSTYPE at $BACKUP_ROOT (validated)"
fi

# Detect the legacy flat layout at tier roots or above; it is not the approved
# convention and must not be mistaken for a complete set.
for tier in $BACKUP_TIERS; do
  for stray in "$BACKUP_ROOT/$tier"/db-* "$BACKUP_ROOT/$tier"/storage-* \
               "$BACKUP_ROOT/$tier"/MANIFEST-* "$BACKUP_ROOT/$tier"/SHA256SUMS-*; do
    [ -e "$stray" ] || continue
    error "orphan flat-layout artifact '$stray'; sets must live in clinic-<tier>-<STAMP> directories."
  done
done

set_count=0
for set_dir in $(backup_list_set_dirs); do
  set_count=$((set_count + 1))
  base="$(basename "$set_dir")"
  echo
  echo "== $base =="
  check_mode "$set_dir" 700 "set directory"

  manifest="${set_dir}/MANIFEST.txt"
  sums="${set_dir}/SHA256SUMS"

  tier="$(printf '%s' "$base" | sed -n 's/^clinic-\(daily\|weekly\|monthly\)-.*/\1/p')"
  [ -n "$tier" ] || error "set directory '$base' does not start with clinic-<tier>-<STAMP>."
  stamp="$(printf '%s' "$base" | sed -n 's/^clinic-[a-z]*-\([0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z\).*/\1/p')"
  [ -n "$stamp" ] || error "set directory '$base' has no valid UTC stamp."

  if [ ! -f "$manifest" ]; then
    error "set directory '$base' has no MANIFEST.txt (incomplete run)."
    continue
  fi
  if [ ! -f "$sums" ]; then
    error "set directory '$base' has no SHA256SUMS."
  else
    check_mode "$sums" 600 "checksum file"
  fi
  check_mode "$manifest" 600 "manifest"

  unset M; declare -A M=()
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    value="${value%$'\r'}"
    M["$key"]="$value"
  done < "$manifest"

  for required in created_utc backup_tier set_directory database_name database_dump \
                  database_sha256 database_bytes storage_archive storage_sha256 \
                  storage_bytes checksums encryption; do
    [ -n "${M[$required]:-}" ] || error "manifest '$base' is missing required field '$required'."
  done

  [ "${M[set_directory]:-}" = "$base" ] || error \
    "manifest set_directory='${M[set_directory]:-}' does not match directory '$base'."
  [ "${M[backup_tier]:-}" = "$tier" ] || error \
    "manifest backup_tier='${M[backup_tier]:-}' does not match directory tier '$tier'."
  [ "${M[created_utc]:-}" = "$stamp" ] || error \
    "manifest created_utc='${M[created_utc]:-}' does not match directory stamp '$stamp'."
  [ "${M[checksums]:-}" = "SHA256SUMS" ] || error \
    "manifest checksums='${M[checksums]:-}' is not 'SHA256SUMS'."

  fmt="${M[backup_format]:-}"
  case "$fmt" in
    3|4) ;;
    *) error "manifest backup_format='${fmt:-missing}' (expected 3 or 4)." ;;
  esac

  if [ "$fmt" = "4" ]; then
    [ -n "${M[backup_id]:-}" ] || error "manifest '$base' is missing required field 'backup_id'."
    [ "${M[manifest_version]:-}" = "4" ] || error \
      "manifest '$base' has manifest_version='${M[manifest_version]:-}' (expected 4)."
    [ "${M[encryption_status]:-}" = "encrypted" ] || error \
      "manifest '$base' has encryption_status='${M[encryption_status]:-}' (expected encrypted)."
    [ -n "${M[consistency_mode]:-}" ] || error \
      "manifest '$base' is missing required field 'consistency_mode'."
  fi

  encryption="${M[encryption]:-}"
  if [ "$encryption" != "age" ]; then
    error "manifest encryption='$encryption'; plaintext backup sets are not permitted (BACKUP_VERIFY_REQUIRE_ENCRYPTION=$REQUIRE_ENCRYPTION)."
  fi

  DECLARED=""
  check_artifact() {
    label="$1" name="$2" want_sha="$3" want_bytes="$4"
    if [ -z "$name" ] || [ "$name" = "none" ]; then
      [ "$label" = "evolution" ] && warn "evolution session state is not in this set."
      [ "$label" = "caddy" ] && warn "Caddy TLS state is not in this set."
      return 0
    fi
    case "$name" in */*|*..*) error "$label path '$name' is not a plain filename."; return 0 ;; esac
    case "$name" in *.age) ;; *) error "$label artifact '$name' is not age-encrypted."; ;; esac
    DECLARED="${DECLARED} ${name}"
    path="$set_dir/$name"
    if [ ! -f "$path" ]; then error "$label artifact '$name' is missing."; return 0; fi
    check_mode "$path" 600 "artifact"
    actual_bytes="$(file_bytes "$path")"
    TOTAL_BYTES=$((TOTAL_BYTES + actual_bytes))
    [ "$actual_bytes" -gt 0 ] || error "$label artifact '$name' is empty."
    case "$want_bytes" in
      ''|none|0) ;;
      *[!0-9]*) warn "$label manifest size '$want_bytes' is not numeric." ;;
      *) [ "$actual_bytes" = "$want_bytes" ] || error \
           "$label size mismatch for '$name': manifest $want_bytes B, actual $actual_bytes B." ;;
    esac
    if [ -n "$want_sha" ] && [ "$want_sha" != "none" ]; then
      [ "$(sha256_of "$path")" = "$want_sha" ] || error "$label SHA-256 mismatch for '$name'."
    fi
    echo "  $label: $name ($(human_bytes "$actual_bytes"))"
  }

  check_artifact "database" "${M[database_dump]:-}" "${M[database_sha256]:-}" "${M[database_bytes]:-}"
  check_artifact "storage" "${M[storage_archive]:-}" "${M[storage_sha256]:-}" "${M[storage_bytes]:-}"
  if [ "$fmt" = "4" ]; then
    check_artifact "storage-file-checksums" "${M[storage_files_checksums]:-}" \
      "${M[storage_files_checksums_sha256]:-}" "${M[storage_files_checksums_bytes]:-}"
    [ -n "${M[storage_files_checksums_plain_sha256]:-}" ] || error \
      "manifest '$base' is missing storage_files_checksums_plain_sha256."
    case "${M[storage_files_count]:-}" in
      ''|*[!0-9]*) error "manifest storage_files_count='${M[storage_files_count]:-}' is not numeric." ;;
    esac
    [ -n "${M[database_plain_sha256]:-}" ] || error "manifest '$base' is missing database_plain_sha256."
    [ -n "${M[storage_plain_sha256]:-}" ] || error "manifest '$base' is missing storage_plain_sha256."
  fi
  check_artifact "evolution" "${M[evolution_archive]:-}" "${M[evolution_sha256]:-}" "${M[evolution_bytes]:-}"
  for archive in ${M[caddy_archives]:-}; do
    [ "$archive" = "none" ] && continue
    check_artifact "caddy" "$archive" "" ""
  done

  if [ -f "$sums" ]; then
    # sha256sum -c exits 0 when some lines are valid and others are malformed;
    # enforce a strict line format so a damaged checksum file cannot pass.
    malformed=0
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      if ! printf '%s\n' "$line" | grep -Eq '^[0-9a-f]{64} ( |\*).+$'; then
        error "SHA256SUMS in '$base' has a malformed line."
        malformed=1
        break
      fi
    done < "$sums"
    if [ "$malformed" -eq 0 ] && sha256_check_file "$set_dir" >/dev/null 2>&1; then
      echo "  checksums: verified (SHA256SUMS)"
    else
      error "checksum verification failed for '$base/SHA256SUMS'."
    fi
    while read -r _sha listed; do
      [ -n "$listed" ] || continue
      case " $DECLARED " in *" $listed "*) ;; *) error \
        "SHA256SUMS lists '$listed' which is not declared in MANIFEST.txt." ;; esac
    done < "$sums"
    for name in $DECLARED; do
      grep -q " ${name}\$" "$sums" || error "SHA256SUMS is missing '$name'."
    done
  fi

  # Orphan detection inside the set: any extra file is unmanaged output.
  for path in "$set_dir"/* "$set_dir"/.[!.]*; do
    [ -f "$path" ] || continue
    name="$(basename "$path")"
    case "$name" in MANIFEST.txt|SHA256SUMS) continue ;; esac
    case " $DECLARED " in *" $name "*) continue ;; esac
    error "orphan artifact '$base/$name' is not declared in MANIFEST.txt."
  done

  epoch="$(stamp_epoch "$stamp")"
  if [ "$epoch" = "0" ] && command -v stat >/dev/null 2>&1; then
    epoch="$(stat -c %Y "$manifest" 2>/dev/null || stat -f %m "$manifest" 2>/dev/null || printf '0')"
  fi
  if [ "$epoch" != "0" ]; then
    age_hours=$(( ($(date -u +%s) - epoch) / 3600 ))
    [ "$age_hours" -ge 0 ] || age_hours=0
    echo "  age: ${age_hours}h"
    if [ "$epoch" -gt "$NEWEST_EPOCH" ]; then NEWEST_EPOCH="$epoch"; NEWEST_STAMP="$base"; fi
  fi
  SETS=$((SETS + 1))
done

[ "$set_count" -gt 0 ] || error "no clinic-<tier>-<STAMP> set directories found under '$BACKUP_ROOT'."

if [ -n "$MAX_AGE_HOURS" ]; then
  case "$MAX_AGE_HOURS" in
    ''|*[!0-9]*) error "BACKUP_MAX_AGE_HOURS='$MAX_AGE_HOURS' is not a whole number of hours." ;;
    *)
      if [ "$NEWEST_EPOCH" -eq 0 ]; then error "cannot determine the age of any backup set."
      else
        newest_age=$(( ($(date -u +%s) - NEWEST_EPOCH) / 3600 ))
        [ "$newest_age" -ge 0 ] || newest_age=0
        if [ "$newest_age" -gt "$MAX_AGE_HOURS" ]; then
          error "newest backup set ($NEWEST_STAMP) is ${newest_age}h old; limit is ${MAX_AGE_HOURS}h."
        else
          echo; echo "Newest set: $NEWEST_STAMP (${newest_age}h old)."
        fi
      fi
      ;;
  esac
fi

echo
echo "Summary: $SETS set(s), $(human_bytes "$TOTAL_BYTES") accounted for, $WARNINGS warning(s), $ERRORS error(s)."
if [ "$ERRORS" -gt 0 ]; then echo "Backup verification FAILED." >&2; exit 1; fi
echo "Backup verification passed."
