#!/usr/bin/env bash
# Shared backup destination convention and fail-closed storage validation.
#
# Sourced by scripts/backup.sh, scripts/backup-verify.sh and
# scripts/p7-check-backup.sh. This file performs NO writes and creates NO
# directories. It only defines paths, validates the mounted backup disk and
# lists backup sets.
#
# Verified against the Ubuntu host in Phase 8.3.1:
#   device            /dev/sda1 (internal SATA HDD, ST3500312CS)
#   filesystem        ext4, label clinic-backups
#   UUID              0f21089c-c507-4903-96e5-daf637100d53
#   mount point       /mnt/clinic-backups  (fstab line 15, rw,relatime)
#   tier directories  daily weekly monthly
#   support dirs      wal-archive manifests quarantine logs
#
# A complete set is a directory named clinic-<tier>-<STAMP>[-<label>] inside
# its tier directory, containing encrypted artifacts, SHA256SUMS and a final
# MANIFEST.txt. This matches the on-host artifact observed on 2026-11-20.

BACKUP_ROOT="${BACKUP_ROOT:-/mnt/clinic-backups}"
BACKUP_EXPECTED_UUID="${BACKUP_EXPECTED_UUID:-0f21089c-c507-4903-96e5-daf637100d53}"
BACKUP_EXPECTED_FSTYPE="${BACKUP_EXPECTED_FSTYPE:-ext4}"
BACKUP_TIER="${BACKUP_TIER:-daily}"
BACKUP_TIERS="daily weekly monthly"
BACKUP_REQUIRED_DIRS="daily weekly monthly wal-archive manifests quarantine logs"

# Set by backup_check_storage() so callers can report a precise reason.
BACKUP_CHECK_REASON=""

# Fatal error helper used by every caller of this library. Defined here so the
# producer, verifier and storage validator all fail closed with a precise,
# human-readable reason instead of an undefined-command error.
backup_die() {
  echo "BACKUP ERROR: $*" >&2
  exit 1
}

backup_canonical() {
  local path="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath -e "$path" 2>/dev/null && return 0
  fi
  ( cd "$path" 2>/dev/null && pwd -P )
}

backup_set_dir() {
  local tier="$1" stamp="$2"
  printf '%s/%s/clinic-%s-%s' "$BACKUP_ROOT" "$tier" "$tier" "$stamp"
}

backup_manifest_path() {
  printf '%s/MANIFEST.txt' "$1"
}

backup_sums_path() {
  printf '%s/SHA256SUMS' "$1"
}

# Enumerate every complete/incomplete set directory across the approved tiers.
backup_list_set_dirs() {
  local tier path
  for tier in $BACKUP_TIERS; do
    for path in "$BACKUP_ROOT/$tier"/clinic-*; do
      [ -d "$path" ] || continue
      printf '%s\n' "$path"
    done
  done
}

# Fail-closed validation of the mounted backup disk and destination.
# Returns 0 on success; on failure sets BACKUP_CHECK_REASON and returns 1.
# Arguments:
#   $1 destination directory that must already exist inside the mount
#      (defaults to BACKUP_ROOT). Nothing is created here.
backup_check_storage() {
  local dest="${1:-$BACKUP_ROOT}"
  local actual_uuid actual_fstype root_c dest_c dir

  BACKUP_CHECK_REASON=""
  [ -n "$BACKUP_ROOT" ] || { BACKUP_CHECK_REASON="BACKUP_ROOT is empty"; return 1; }

  command -v mountpoint >/dev/null 2>&1 || {
    BACKUP_CHECK_REASON="mountpoint utility is not installed"
    return 1
  }
  if ! mountpoint -q "$BACKUP_ROOT" 2>/dev/null; then
    BACKUP_CHECK_REASON="backup mount '$BACKUP_ROOT' is not mounted"
    return 1
  fi

  command -v findmnt >/dev/null 2>&1 || {
    BACKUP_CHECK_REASON="findmnt utility is not installed"
    return 1
  }
  actual_uuid="$(findmnt -n -o UUID -M "$BACKUP_ROOT" 2>/dev/null | head -n 1)"
  actual_fstype="$(findmnt -n -o FSTYPE -M "$BACKUP_ROOT" 2>/dev/null | head -n 1)"
  [ -n "$actual_uuid" ] || {
    BACKUP_CHECK_REASON="could not determine the UUID of '$BACKUP_ROOT'"
    return 1
  }
  [ -n "$actual_fstype" ] || {
    BACKUP_CHECK_REASON="could not determine the filesystem type of '$BACKUP_ROOT'"
    return 1
  }
  if [ "$actual_uuid" != "$BACKUP_EXPECTED_UUID" ]; then
    BACKUP_CHECK_REASON="backup disk UUID '$actual_uuid' does not match approved UUID '$BACKUP_EXPECTED_UUID'"
    return 1
  fi
  if [ "$actual_fstype" != "$BACKUP_EXPECTED_FSTYPE" ]; then
    BACKUP_CHECK_REASON="filesystem '$actual_fstype' does not match approved '$BACKUP_EXPECTED_FSTYPE'"
    return 1
  fi

  for dir in $BACKUP_REQUIRED_DIRS; do
    if [ ! -d "$BACKUP_ROOT/$dir" ]; then
      BACKUP_CHECK_REASON="required backup directory '$BACKUP_ROOT/$dir' is missing"
      return 1
    fi
  done

  root_c="$(backup_canonical "$BACKUP_ROOT")" || {
    BACKUP_CHECK_REASON="could not resolve backup mount '$BACKUP_ROOT'"
    return 1
  }
  dest_c="$(backup_canonical "$dest")" || {
    BACKUP_CHECK_REASON="backup destination '$dest' does not exist inside the mount"
    return 1
  }
  case "${dest_c}/" in
    "${root_c}/"*) : ;;
    *)
      BACKUP_CHECK_REASON="backup destination '$dest_c' resolves outside approved mount '$root_c'"
      return 1
      ;;
  esac

  if [ ! -w "$dest_c" ]; then
    BACKUP_CHECK_REASON="backup destination '$dest_c' is not writable by the backup account"
    return 1
  fi

  BACKUP_MOUNT_UUID="$actual_uuid"
  BACKUP_MOUNT_FSTYPE="$actual_fstype"
  return 0
}

backup_require_storage() {
  if ! backup_check_storage "$@"; then
    backup_die "$BACKUP_CHECK_REASON"
  fi
}
