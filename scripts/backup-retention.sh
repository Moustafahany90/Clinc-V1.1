#!/usr/bin/env bash
# Conservative, configurable retention for completed backup sets.
#
#   ./scripts/backup-retention.sh --root /mnt/clinic-backups          # dry run
#   ./scripts/backup-retention.sh --root /mnt/clinic-backups \
#       --apply --confirm DELETE --keep-daily 7 --keep-weekly 4 --keep-monthly 12
#
# Only VERIFIED complete sets beyond the configured limits are removed. Invalid
# or incomplete sets are never deleted; they must be investigated/quarantined by
# an operator. The newest valid set in each tier is always retained (limits are
# clamped to at least 1). Dry-run is the default and performs no writes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

ROOT="$BACKUP_ROOT"
APPLY=0
CONFIRM=""
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=12
SKIP_MOUNT_CHECK="${BACKUP_VERIFY_SKIP_MOUNT_CHECK:-0}"

die() { backup_die "$@"; }
warn() { echo "WARNING: $*" >&2; }

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: backup-retention.sh [--root <dir>] [--apply --confirm DELETE]
       [--keep-daily N] [--keep-weekly N] [--keep-monthly N]
EOF_USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--root needs a value."; ROOT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --confirm) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--confirm needs a value."; CONFIRM="$2"; shift 2 ;;
    --keep-daily) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--keep-daily needs a value."; KEEP_DAILY="$2"; shift 2 ;;
    --keep-weekly) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--keep-weekly needs a value."; KEEP_WEEKLY="$2"; shift 2 ;;
    --keep-monthly) [ "$#" -ge 2 ] || die "$BACKUP_EXIT_USAGE" "--keep-monthly needs a value."; KEEP_MONTHLY="$2"; shift 2 ;;
    --help|-h) usage; exit "$BACKUP_EXIT_OK" ;;
    *) usage; die "$BACKUP_EXIT_USAGE" "unknown argument '$1'." ;;
  esac
done

for limit in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY"; do
  case "$limit" in
    ''|*[!0-9]*) die "$BACKUP_EXIT_USAGE" \
      "retention limits must be whole numbers (got '$limit')." ;;
  esac
done
# Never remove every valid backup, even when an operator configures 0.
[ "$KEEP_DAILY" -ge 1 ] || KEEP_DAILY=1
[ "$KEEP_WEEKLY" -ge 1 ] || KEEP_WEEKLY=1
[ "$KEEP_MONTHLY" -ge 1 ] || KEEP_MONTHLY=1

if [ "$APPLY" = "1" ]; then
  [ "$CONFIRM" = "DELETE" ] || die "$BACKUP_EXIT_USAGE" \
    "retention deletion requires --apply --confirm DELETE; nothing was deleted."
fi

[ -d "$ROOT" ] || die "$BACKUP_EXIT_PRECHECK" "backup root '$ROOT' does not exist."
BACKUP_ROOT="$(backup_canonical "$ROOT")" || die "$BACKUP_EXIT_PRECHECK" \
  "cannot resolve backup root '$ROOT'."
if [ "$SKIP_MOUNT_CHECK" = "1" ]; then
  warn "mount validation skipped by BACKUP_VERIFY_SKIP_MOUNT_CHECK (test only)."
else
  backup_require_storage "$BACKUP_ROOT" || die "$BACKUP_EXIT_PRECHECK" \
    "$BACKUP_CHECK_REASON"
fi

file_bytes() { wc -c < "$1" | tr -d ' '; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Returns 0 only for a complete, checksum-clean set. Never writes.
set_is_valid() {
  local dir="$1" manifest sums fmt base declared name path want bytes rc
  manifest="${dir}/MANIFEST.txt"
  sums="${dir}/SHA256SUMS"
  [ -f "$manifest" ] && [ -f "$sums" ] || return 1
  declare -A M=()
  backup_manifest_load "$manifest" M || return 1
  fmt="${M[backup_format]:-}"
  case "$fmt" in 3|4) : ;; *) return 1 ;; esac
  base="$(basename "$dir")"
  [ "${M[set_directory]:-}" = "$base" ] || return 1
  [ "${M[checksums]:-}" = "SHA256SUMS" ] || return 1
  [ "${M[encryption]:-}" = "age" ] || return 1
  [ -n "${M[database_dump]:-}" ] && [ -n "${M[storage_archive]:-}" ] || return 1

  declared=""
  # pairs: <filename field> <sha field> <bytes field>
  pairs="database_dump database_sha256 database_bytes
storage_archive storage_sha256 storage_bytes
storage_files_checksums storage_files_checksums_sha256 storage_files_checksums_bytes
evolution_archive evolution_sha256 evolution_bytes"
  while read -r name_key sha_key bytes_key; do
    [ -n "${name_key:-}" ] || continue
    name="${M[$name_key]:-}"
    [ -n "$name" ] && [ "$name" != "none" ] || continue
    case "$name" in */*|*..*) return 1 ;; esac
    path="${dir}/${name}"
    [ -f "$path" ] && [ -s "$path" ] || return 1
    bytes="$(file_bytes "$path")"
    case "${M[$sha_key]:-}" in
      ''|none) : ;;
      *) [ "$(sha256_of "$path")" = "${M[$sha_key]}" ] || return 1 ;;
    esac
    case "${M[$bytes_key]:-}" in
      ''|none|0) : ;;
      *[!0-9]*) return 1 ;;
      *) [ "$bytes" = "${M[$bytes_key]}" ] || return 1 ;;
    esac
    declared="${declared} ${name}"
  done <<EOF_PAIRS
$pairs
EOF_PAIRS
  for name in ${M[caddy_archives]:-}; do
    [ "$name" = "none" ] && continue
    [ -f "${dir}/${name}" ] || return 1
    declared="${declared} ${name}"
  done

  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    printf '%s\n' "$line" | grep -Eq '^[0-9a-f]{64} ( |\*).+$' || return 1
  done < "$sums"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum -c SHA256SUMS ) >/dev/null 2>&1 || return 1
  else
    ( cd "$dir" && shasum -a 256 -c SHA256SUMS ) >/dev/null 2>&1 || return 1
  fi
  while read -r _sha listed; do
    [ -n "$listed" ] || continue
    case " $declared " in *" $listed "*) : ;; *) return 1 ;; esac
  done < "$sums"
  rc=0
  return "$rc"
}

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/clinic-retention.XXXXXX")" || die "$BACKUP_EXIT_IO" \
  "could not create a temporary retention plan."
trap 'rm -f "$PLAN_FILE"' EXIT

DELETED=0
KEPT=0
INVALID=0
for tier in $BACKUP_TIERS; do
  case "$tier" in
    daily) limit="$KEEP_DAILY" ;;
    weekly) limit="$KEEP_WEEKLY" ;;
    monthly) limit="$KEEP_MONTHLY" ;;
  esac
  [ -d "${BACKUP_ROOT}/${tier}" ] || continue
  count=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if ! set_is_valid "$dir"; then
      warn "keeping unverifiable set '$dir'; operator review required."
      INVALID=$((INVALID + 1))
      continue
    fi
    count=$((count + 1))
    if [ "$count" -le "$limit" ]; then
      KEPT=$((KEPT + 1))
    else
      printf '%s\n' "$dir" >> "$PLAN_FILE"
      DELETED=$((DELETED + 1))
    fi
  done < <(find "${BACKUP_ROOT}/${tier}" -maxdepth 1 -mindepth 1 -type d -name 'clinic-*' -print | LC_ALL=C sort -r)
done

echo "Retention plan: keep $KEPT verified set(s), delete $DELETED verified set(s), $INVALID unverifiable set(s) left untouched."
if [ -s "$PLAN_FILE" ]; then
  echo "Sets selected for deletion:"
  sed 's#^#  #' "$PLAN_FILE"
else
  echo "No sets selected for deletion."
fi

if [ "$APPLY" != "1" ]; then
  echo "Dry run: no files were deleted. Re-run with --apply --confirm DELETE to apply."
  exit "$BACKUP_EXIT_OK"
fi

while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  case "$dir" in
    "${BACKUP_ROOT}/"*/clinic-*) : ;;
    *) die "$BACKUP_EXIT_PRECHECK" "refusing to delete path outside the backup root: '$dir'." ;;
  esac
  rm -rf "$dir" || die "$BACKUP_EXIT_IO" "could not delete '$dir'."
  echo "Deleted: $dir"
done < "$PLAN_FILE"
echo "Retention applied."
