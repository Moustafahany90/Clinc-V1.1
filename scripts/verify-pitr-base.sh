#!/usr/bin/env bash
# Verify the newest pitr_ready base backup, its base artifact hash/size and
# every required WAL segment checksum. Read-only: no database, no deletion.
#
#   verify-pitr-base.sh [--root <backup-root>] [<MANIFEST.txt>]
#
# BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 is a TEST-ONLY override for disposable
# synthetic fixtures. Never set it in production.
set -euo pipefail
export MSYS_NO_PATHCONV=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-common.sh
. "${SCRIPT_DIR}/backup-common.sh"

manifest_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$2" 2>/dev/null | tr -d '\r'; }
is_number() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
is_plain_name() { case "${1:-}" in ''|*/*|*..*) return 1 ;; *) return 0 ;; esac; }

BACKUP_ROOT="${BACKUP_ROOT:-/mnt/clinic-backups}"
MANIFEST=""
SKIP_MOUNT_CHECK="${BACKUP_VERIFY_SKIP_MOUNT_CHECK:-0}"
error_count=0

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: verify-pitr-base.sh [--root <backup-root>] [<MANIFEST.txt>]
EOF_USAGE
}
error() { printf 'ERROR: %s\n' "$*" >&2; error_count=$((error_count + 1)); }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || { usage; exit "$BACKUP_EXIT_USAGE"; }; BACKUP_ROOT=$2; shift 2 ;;
    -h|--help) usage; exit "$BACKUP_EXIT_OK" ;;
    -*) usage; exit "$BACKUP_EXIT_USAGE" ;;
    *) [ -z "$MANIFEST" ] || { usage; exit "$BACKUP_EXIT_USAGE"; }; MANIFEST=$1; shift ;;
  esac
done

case "$SKIP_MOUNT_CHECK" in 0|1) : ;; *) echo "ERROR: invalid test override." >&2; exit "$BACKUP_EXIT_USAGE" ;; esac
[ -d "$BACKUP_ROOT" ] || backup_die "backup root '$BACKUP_ROOT' does not exist."
if [ -n "$MANIFEST" ]; then
  [ -f "$MANIFEST" ] || backup_die "manifest '$MANIFEST' does not exist."
else
  newest_stamp=""
  while IFS= read -r f; do
    [ "$(manifest_value backup_format "$f")" = "pitr-base-1" ] || continue
    [ "$(manifest_value pitr_ready "$f")" = "true" ] || continue
    stamp="$(manifest_value created_utc "$f")"
    case "$stamp" in ????????T??????Z) : ;; *) continue ;; esac
    if [ -z "$newest_stamp" ] || [ "$stamp" \> "$newest_stamp" ]; then
      newest_stamp=$stamp
      MANIFEST=$f
    fi
  done < <(find "$BACKUP_ROOT" -mindepth 3 -maxdepth 3 -type f -name MANIFEST.txt 2>/dev/null | sort)
fi
[ -n "$MANIFEST" ] || backup_die "no pitr_ready base backup manifest found under $BACKUP_ROOT."

BACKUP_ROOT="$(backup_canonical "$BACKUP_ROOT")" || backup_die "cannot resolve backup root."
if [ "$SKIP_MOUNT_CHECK" = "1" ]; then
  echo "WARNING: mount validation skipped by BACKUP_VERIFY_SKIP_MOUNT_CHECK (test only)."
else
  backup_require_storage "$BACKUP_ROOT" || backup_die "$BACKUP_CHECK_REASON"
fi

set_dir="$(dirname "$MANIFEST")"
base_name="$(basename "$set_dir")"
printf 'Verifying PITR base set %s ...\n' "$base_name"
[ "$(manifest_value set_directory "$MANIFEST")" = "$base_name" ] || \
  printf 'WARNING: manifest set_directory does not match directory name.\n'

fmt="$(manifest_value backup_format "$MANIFEST")"
[ "$fmt" = "pitr-base-1" ] || error "backup_format='$fmt' (expected pitr-base-1)."
[ "$(manifest_value pitr_ready "$MANIFEST")" = "true" ] || error "pitr_ready is not true."
checksums="$(manifest_value checksums "$MANIFEST")"
[ "$checksums" = "SHA256SUMS" ] || error "checksums='$checksums' (expected SHA256SUMS)."

base_archive="$(manifest_value base_archive "$MANIFEST")"
is_plain_name "$base_archive" || error "base_archive is missing or unsafe: '$base_archive'"
base_sha="$(manifest_value base_sha256 "$MANIFEST" | tr 'A-F' 'a-f')"
base_bytes="$(manifest_value base_bytes "$MANIFEST")"
is_hex64() { case "${1:-}" in *[!0-9a-f]*|'') return 1 ;; *) [ "${#1}" -eq 64 ] ;; esac; }
is_hex64 "$base_sha" || error "base_sha256 is missing or invalid."
is_number "$base_bytes" || error "base_bytes is not numeric."

if is_plain_name "$base_archive"; then
  artifact="${set_dir}/${base_archive}"
  [ -f "$artifact" ] || error "base artifact '$base_archive' is missing."
  if [ -f "$artifact" ] && is_hex64 "$base_sha"; then
    actual="$(backup_sha256 "$artifact")"
    [ "$actual" = "$base_sha" ] || error "base artifact SHA-256 mismatch (manifest $base_sha, actual $actual)."
    echo "  base artifact: SHA-256 verified"
  fi
  if [ -f "$artifact" ] && is_number "$base_bytes"; then
    actual_bytes="$(backup_file_bytes "$artifact")"
    [ "$actual_bytes" = "$base_bytes" ] || error "base artifact size mismatch (manifest $base_bytes B, actual $actual_bytes B)."
  fi
  sums="${set_dir}/SHA256SUMS"
  [ -f "$sums" ] || error "SHA256SUMS is missing."
  if [ -f "$sums" ] && is_hex64 "$base_sha"; then
    grep -Eq "^${base_sha} [ *]${base_archive}$" "$sums" || error "SHA256SUMS does not match the base artifact hash."
  fi
fi

start_file="$(manifest_value required_wal_start "$MANIFEST")"
end_file="$(manifest_value required_wal_end "$MANIFEST")"
wal_dir="$(manifest_value wal_archive_dir "$MANIFEST")"
backup_wal_is_segment "$start_file" || error "required_wal_start is invalid."
backup_wal_is_segment "$end_file" || error "required_wal_end is invalid."
case "$wal_dir" in /*) : ;; *) error "wal_archive_dir is missing or not absolute." ;; esac
[ -d "$wal_dir" ] || error "WAL archive directory does not exist: $wal_dir"

declared_count="$(manifest_value required_wal_count "$MANIFEST")"
is_number "$declared_count" || error "required_wal_count is not numeric."
checked=0
while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  backup_wal_is_segment "$seg" || { error "invalid required WAL segment name '$seg'."; continue; }
  checked=$((checked + 1))
  expected="$(manifest_value "wal.sha256.${seg}" "$MANIFEST" | tr 'A-F' 'a-f')"
  if ! is_hex64 "$expected"; then
    error "no valid wal.sha256.$seg in manifest."
    continue
  fi
  segment_path="${wal_dir}/${seg}"
  [ -f "$segment_path" ] || { error "required WAL segment '$seg' is missing."; continue; }
  actual="$(backup_sha256 "$segment_path")"
  [ "$actual" = "$expected" ] || error "WAL segment '$seg' SHA-256 mismatch (manifest $expected, actual $actual)."
  sidecar="${segment_path}.sha256"
  [ -f "$sidecar" ] || { error "WAL sidecar '$seg.sha256' is missing."; continue; }
  stored="$(awk 'NR == 1 { print $1 }' "$sidecar" 2>/dev/null | tr 'A-F' 'a-f')"
  [ "$stored" = "$expected" ] || error "WAL sidecar '$seg.sha256' disagrees with the manifest."
done <<<"$(manifest_values required_wal_files "$MANIFEST")"
if is_number "$declared_count"; then
  [ "$checked" -eq "$declared_count" ] || error "required WAL file count mismatch (declared $declared_count, found $checked)."
fi
echo "  required WAL segments checked: $checked"

if [ "$error_count" -gt 0 ]; then
  printf 'PITR BASE VERIFICATION FAILED: %d error(s)\n' "$error_count" >&2
  exit "$BACKUP_EXIT_VERIFY"
fi
printf 'PITR BASE VERIFICATION OK: %s\n' "$MANIFEST"
exit "$BACKUP_EXIT_OK"
