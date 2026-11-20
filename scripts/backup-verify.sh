#!/usr/bin/env bash
# Read-only verification and inventory of backup sets.
#
#   ./scripts/backup-verify.sh [backup-directory]
#
# Defaults to BACKUP_DIR or ./backups. For every MANIFEST-<STAMP>.txt this
# checks that the declared artifacts exist, match their declared SHA-256 and
# size, and pass SHA256SUMS-<STAMP>.txt. It also reports orphan/incomplete
# artifacts, encryption state, set age, and total size.
#
# Set BACKUP_MAX_AGE_HOURS to fail when the newest set is older than the given
# number of hours (suitable for a monitoring cron/Timer job). Set
# BACKUP_VERIFY_REQUIRE_ENCRYPTION=1 to fail on plaintext sets.
#
# This script never writes to the backup directory, never decrypts anything,
# and never contacts the database.
set -euo pipefail

cd "$(dirname "$0")/.."

die() {
  echo "ERROR: $*" >&2
  exit 1
}

DIR="${1:-${BACKUP_DIR:-backups}}"
[ -d "$DIR" ] || die "backup directory '$DIR' does not exist."
DIR="$(cd "$DIR" && pwd)"

MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-}"
REQUIRE_ENCRYPTION="${BACKUP_VERIFY_REQUIRE_ENCRYPTION:-0}"

ERRORS=0
WARNINGS=0
SETS=0
TOTAL_BYTES=0
NEWEST_EPOCH=0
NEWEST_STAMP=""

error() {
  echo "ERROR: $*" >&2
  ERRORS=$((ERRORS + 1))
}

warn() {
  echo "WARNING: $*" >&2
  WARNINGS=$((WARNINGS + 1))
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_check_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  else
    shasum -a 256 -c "$1"
  fi
}

human_bytes() {
  awk -v b="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", u, " ");
    i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf "%.1f %s", b, u[i]
  }'
}

stamp_epoch() {
  stamp="$1"
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) printf '0'; return 0 ;;
  esac
  year="${stamp:0:4}"
  month="${stamp:4:2}"
  day="${stamp:6:2}"
  hour="${stamp:9:2}"
  minute="${stamp:11:2}"
  second="${stamp:13:2}"
  if date -u -d "${year}-${month}-${day}T${hour}:${minute}:${second}Z" +%s >/dev/null 2>&1; then
    date -u -d "${year}-${month}-${day}T${hour}:${minute}:${second}Z" +%s
    return 0
  fi
  if date -u -j -f "%Y%m%dT%H%M%SZ" "$stamp" +%s >/dev/null 2>&1; then
    date -u -j -f "%Y%m%dT%H%M%SZ" "$stamp" +%s
    return 0
  fi
  printf '0'
}

check_artifact() {
  label="$1"
  name="$2"
  want_sha="$3"
  want_bytes="$4"

  if [ -z "$name" ] || [ "$name" = "none" ]; then
    warn "$label is not included in this backup set."
    return 0
  fi
  case "$name" in
    */*|*..*)
      error "$label path '$name' is not a plain filename; refusing to trust the manifest."
      return 0
      ;;
  esac

  path="$DIR/$name"
  if [ ! -f "$path" ]; then
    error "$label artifact '$name' is missing."
    return 0
  fi
  actual_bytes="$(file_bytes "$path")"
  TOTAL_BYTES=$((TOTAL_BYTES + actual_bytes))
  if [ "$actual_bytes" -eq 0 ]; then
    error "$label artifact '$name' is empty."
  fi
  if [ -n "$want_bytes" ] && [ "$want_bytes" != "0" ]; then
    case "$want_bytes" in
      *[!0-9]*) warn "$label manifest size '$want_bytes' is not numeric." ;;
      *)
        if [ "$actual_bytes" != "$want_bytes" ]; then
          error "$label size mismatch for '$name': manifest $want_bytes B, actual $actual_bytes B."
        fi
        ;;
    esac
  fi
  if [ -n "$want_sha" ] && [ "$want_sha" != "none" ]; then
    actual_sha="$(sha256_of "$path")"
    if [ "$actual_sha" != "$want_sha" ]; then
      error "$label SHA-256 mismatch for '$name'."
    fi
  fi
  echo "  $label: $name ($(human_bytes "$actual_bytes"))"
}

echo "Verifying backup sets in $DIR ..."

MANIFESTS=0
for manifest in "$DIR"/MANIFEST-*.txt; do
  [ -e "$manifest" ] || continue
  MANIFESTS=$((MANIFESTS + 1))
  base="$(basename "$manifest")"
  stamp="${base#MANIFEST-}"
  stamp="${stamp%.txt}"
  echo
  echo "== $stamp =="

  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) error "manifest '$base' has an invalid timestamp; expected MANIFEST-YYYYMMDDTHHMMSSZ.txt." ;;
  esac

  declare -A M=()
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    value="${value%$'\r'}"
    M["$key"]="$value"
  done < "$manifest"

  for required in created_utc database_name database_dump database_sha256 database_bytes \
                  storage_archive storage_sha256 storage_bytes checksums encryption; do
    [ -n "${M[$required]:-}" ] || error "manifest '$base' is missing required field '$required'."
  done

  fmt="${M[backup_format]:-}"
  if [ "$fmt" != "2" ]; then
    warn "manifest '$base' has backup_format='${fmt:-missing}' (expected 2); the set has limited metadata."
  fi

  check_artifact "database" "${M[database_dump]:-}" "${M[database_sha256]:-}" "${M[database_bytes]:-}"
  check_artifact "storage" "${M[storage_archive]:-}" "${M[storage_sha256]:-}" "${M[storage_bytes]:-}"
  check_artifact "evolution" "${M[evolution_archive]:-}" "${M[evolution_sha256]:-}" "${M[evolution_bytes]:-}"

  caddy="${M[caddy_archives]:-}"
  if [ -z "$caddy" ] || [ "$caddy" = "none" ]; then
    warn "Caddy TLS state is not included in this backup set."
  else
    for archive in $caddy; do
      case "$archive" in
        */*|*..*) error "Caddy archive path '$archive' is not a plain filename." ;;
        *)
          if [ ! -f "$DIR/$archive" ]; then
            error "Caddy archive '$archive' is missing."
          else
            bytes="$(file_bytes "$DIR/$archive")"
            TOTAL_BYTES=$((TOTAL_BYTES + bytes))
            echo "  caddy: $archive ($(human_bytes "$bytes"))"
          fi
          ;;
      esac
    done
  fi

  encryption="${M[encryption]:-}"
  case "${M[database_dump]:-}" in
    *.age) actual_encryption="age" ;;
    *) actual_encryption="none" ;;
  esac
  if [ "$encryption" != "$actual_encryption" ]; then
    error "manifest encryption='$encryption' does not match artifact name (found '$actual_encryption')."
  fi
  if [ "$actual_encryption" = "none" ]; then
    if [ "$REQUIRE_ENCRYPTION" = "1" ]; then
      error "backup set is unencrypted and BACKUP_VERIFY_REQUIRE_ENCRYPTION=1."
    else
      warn "backup set is unencrypted and contains PHI; encrypt before off-site copy."
    fi
    echo "  encryption: none (PLAINTEXT)"
  else
    echo "  encryption: age"
  fi

  sums="${M[checksums]:-}"
  if [ -z "$sums" ]; then
    error "manifest does not name a checksum file."
  elif [ ! -f "$DIR/$sums" ]; then
    error "checksum file '$sums' is missing."
  else
    if ( cd "$DIR" && sha256_check_file "$sums" >/dev/null ); then
      echo "  checksums: verified ($sums)"
    else
      error "checksum verification failed for '$sums'."
    fi
  fi

  epoch="$(stamp_epoch "$stamp")"
  if [ "$epoch" = "0" ] && command -v stat >/dev/null 2>&1; then
    epoch="$(stat -c %Y "$manifest" 2>/dev/null || stat -f %m "$manifest" 2>/dev/null || printf '0')"
  fi
  if [ "$epoch" != "0" ]; then
    now="$(date -u +%s)"
    age_hours=$(( (now - epoch) / 3600 ))
    [ "$age_hours" -ge 0 ] || age_hours=0
    echo "  age: ${age_hours}h"
    if [ "$epoch" -gt "$NEWEST_EPOCH" ]; then
      NEWEST_EPOCH="$epoch"
      NEWEST_STAMP="$stamp"
    fi
  fi

  SETS=$((SETS + 1))
done

if [ "$MANIFESTS" -eq 0 ]; then
  error "no MANIFEST-*.txt found in '$DIR'; there is no complete, identifiable backup set."
fi

# Detect artifacts that look like backups but have no manifest (a failed or
# interrupted run, or a hand-copied single dump).
for artifact in "$DIR"/db-*.dump "$DIR"/db-*.dump.age \
                "$DIR"/storage-*.tar.gz "$DIR"/storage-*.tar.gz.age; do
  [ -e "$artifact" ] || continue
  name="$(basename "$artifact")"
  case "$name" in
    db-*) candidate="${name#db-}" ;;
    storage-*) candidate="${name#storage-}" ;;
  esac
  candidate="$(printf '%s' "$candidate" | sed -e 's/\.dump\.age$//' -e 's/\.dump$//' -e 's/\.tar\.gz\.age$//' -e 's/\.tar\.gz$//')"
  if [ ! -f "$DIR/MANIFEST-$candidate.txt" ]; then
    error "orphan artifact '$name' has no MANIFEST-$candidate.txt; it is not a complete backup set."
  fi
done

for artifact in "$DIR"/SHA256SUMS-*.txt; do
  [ -e "$artifact" ] || continue
  name="$(basename "$artifact")"
  candidate="${name#SHA256SUMS-}"
  candidate="${candidate%.txt}"
  if [ ! -f "$DIR/MANIFEST-$candidate.txt" ]; then
    warn "checksum file '$name' has no matching manifest."
  fi
done

if [ -n "$MAX_AGE_HOURS" ]; then
  case "$MAX_AGE_HOURS" in
    ''|*[!0-9]*) error "BACKUP_MAX_AGE_HOURS='$MAX_AGE_HOURS' is not a whole number of hours." ;;
    *)
      if [ "$NEWEST_EPOCH" -eq 0 ]; then
        error "cannot determine the age of any backup set."
      else
        now="$(date -u +%s)"
        newest_age=$(( (now - NEWEST_EPOCH) / 3600 ))
        [ "$newest_age" -ge 0 ] || newest_age=0
        if [ "$newest_age" -gt "$MAX_AGE_HOURS" ]; then
          error "newest backup set ($NEWEST_STAMP) is ${newest_age}h old; limit is ${MAX_AGE_HOURS}h."
        else
          echo
          echo "Newest set: $NEWEST_STAMP (${newest_age}h old)."
        fi
      fi
      ;;
  esac
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    if command -v stat >/dev/null 2>&1; then
      mode="$(stat -c %a "$DIR" 2>/dev/null || printf '')"
      if [ -n "$mode" ]; then
        if [ $((0$mode & 077)) -ne 0 ]; then
          warn "backup directory '$DIR' has mode $mode; restrict it to the deploy account (0700)."
        fi
      fi
    fi
    ;;
esac

echo
echo "Summary: $SETS set(s), $MANIFESTS manifest(s), $(human_bytes "$TOTAL_BYTES") accounted for, $WARNINGS warning(s), $ERRORS error(s)."
if [ "$ERRORS" -gt 0 ]; then
  echo "Backup verification FAILED." >&2
  exit 1
fi
echo "Backup verification passed."
