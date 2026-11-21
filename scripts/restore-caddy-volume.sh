#!/usr/bin/env bash
# Secure streaming restoration of a Caddy CA volume from an age-encrypted backup.
#
# This script restores the Caddy data volume (which contains the internal CA
# private key) from an age-encrypted backup WITHOUT creating a plaintext archive
# on the host filesystem. Decryption is streamed through a pipe directly into
# Docker helper containers.
#
# Failure-Safe Architecture:
#   1. Pass 1: Stream-decrypt and validate archive entries and types.
#      - Consumes the entire stream to EOF (no premature pipe closure / no SIGPIPE).
#      - Rejects absolute paths, path traversal (..), symlinks, and hardlinks.
#      - Verifies required Caddy CA files are present.
#   2. Pass 2: Stream-decrypt directly into a temporary STAGING Docker volume.
#      - The existing target volume is NEVER touched during extraction.
#   3. Staging Verification:
#      - Inspects the staging volume for required files: root.crt, root.key.
#      - Enforces strict file permissions: root.key must be mode 600.
#      - Computes and displays the Root CA certificate SHA-256 fingerprint.
#   4. Explicit Replacement:
#      - If --replace is NOT specified, the staging volume is preserved and
#        the command to apply it is printed. The target volume remains untouched.
#      - If --replace IS specified, the existing target volume (if present)
#        is backed up to a timestamped backup volume before being replaced.
#      - The target volume is verified after replacement.
#
# Usage:
#   # Step 1: Validate and extract to staging volume (safe dry-run / staging)
#   ./scripts/restore-caddy-volume.sh \
#     --archive /mnt/clinic-backups/daily/clinic-daily-<STAMP>/ultrasound_clinic_caddy_data-<STAMP>.tar.gz.age \
#     --key-file /etc/clinic-backup/key.txt \
#     --volume ultrasound_clinic_caddy_data
#
#   # Step 2: Perform explicit replacement into target volume
#   ./scripts/restore-caddy-volume.sh \
#     --archive /mnt/clinic-backups/daily/clinic-daily-<STAMP>/ultrasound_clinic_caddy_data-<STAMP>.tar.gz.age \
#     --key-file /etc/clinic-backup/key.txt \
#     --volume ultrasound_clinic_caddy_data \
#     --replace
#
# Safety rules:
#   * No plaintext archive is ever written to host storage.
#   * No private key material is printed or written to logs.
#   * Full stream is consumed to prevent SIGPIPE under set -euo pipefail.
#   * Target volume is untouched if validation or extraction fails.
#   * Existing target volume is backed up prior to replacement.
#   * Staging volume is preserved until verified.
set -euo pipefail

export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

die() { echo "RESTORE ERROR: $*" >&2; exit 1; }
info() { echo "INFO: $*"; }
warn() { echo "WARNING: $*" >&2; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ARCHIVE=""
KEY_FILE=""
TARGET_VOLUME=""
EXPECTED_VOLUME="${CADDY_RESTORE_EXPECTED_VOLUME:-ultrasound_clinic_caddy_data}"
HELPER_IMAGE="${CADDY_RESTORE_IMAGE:-alpine:3.22}"
REPLACE=0
KEEP_STAGING=0

usage() {
  cat >&2 <<'EOF'
Usage: restore-caddy-volume.sh
  --archive <path>       Path to the age-encrypted .tar.gz.age archive
  --key-file <path>      Path to the age private key file
  --volume <name>        Target Docker volume name (must match expected)
  [--expected <name>]    Override expected volume name (default: ultrasound_clinic_caddy_data)
  [--image <image>]      Override helper image (default: alpine:3.22)
  [--replace]            Perform explicit replacement of target volume after staging passes
  [--keep-staging]       Retain staging volume even after replacement completes
  [--help]               Show this usage information
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive)      [ "$#" -ge 2 ] || die "--archive needs a value."; ARCHIVE="$2"; shift 2 ;;
    --key-file)     [ "$#" -ge 2 ] || die "--key-file needs a value."; KEY_FILE="$2"; shift 2 ;;
    --volume)       [ "$#" -ge 2 ] || die "--volume needs a value."; TARGET_VOLUME="$2"; shift 2 ;;
    --expected)     [ "$#" -ge 2 ] || die "--expected needs a value."; EXPECTED_VOLUME="$2"; shift 2 ;;
    --image)        [ "$#" -ge 2 ] || die "--image needs a value."; HELPER_IMAGE="$2"; shift 2 ;;
    --replace)      REPLACE=1; shift ;;
    --keep-staging) KEEP_STAGING=1; shift ;;
    --help|-h)      usage; exit 0 ;;
    *) usage; die "unknown argument '$1'." ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------
[ -n "$ARCHIVE" ]       || die "--archive is required."
[ -f "$ARCHIVE" ]       || die "archive file '$ARCHIVE' does not exist."
[ -n "$KEY_FILE" ]      || die "--key-file is required."
[ -f "$KEY_FILE" ]      || die "key file '$KEY_FILE' does not exist."
[ -n "$TARGET_VOLUME" ] || die "--volume is required."
command -v age >/dev/null 2>&1    || die "'age' is not installed or not on PATH."
command -v docker >/dev/null 2>&1 || die "'docker' is not installed or not on PATH."

case "$ARCHIVE" in
  *.age) : ;;
  *) die "archive file '$ARCHIVE' does not have an .age extension; refusing to process." ;;
esac

if [ "$TARGET_VOLUME" != "$EXPECTED_VOLUME" ]; then
  die "target volume '$TARGET_VOLUME' does not match expected volume '$EXPECTED_VOLUME'. Refusing to touch an unexpected volume."
fi

case "$TARGET_VOLUME" in
  *[!A-Za-z0-9._-]*) die "target volume name '$TARGET_VOLUME' contains unsafe characters." ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING_VOLUME="caddy_restore_stage_${STAMP}_$$"

# Trap handler: clean up staging volume on error unless replacement succeeded or kept
STAGING_CREATED=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$STAGING_CREATED" -eq 1 ] && [ "$KEEP_STAGING" -eq 0 ]; then
    # If exit code was non-zero, preserve staging name for diagnostics
    if [ "$rc" -ne 0 ]; then
      warn "Restore failed. Staging volume '$STAGING_VOLUME' retained for inspection."
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pass 1: Stream-decrypt and validate archive entries and types
# ---------------------------------------------------------------------------
# Note: Pass 0 (head -c 1) has been completely removed to avoid SIGPIPE under
# pipefail. Pass 1 reads the full stream to EOF, proving both that the key is
# valid and that the archive stream is intact and safe.
info "Pass 1: Decrypting full archive stream and validating entries (no extraction)..."

VALIDATE_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/caddy-restore-val.XXXXXX") || \
  die "could not create temporary file for validation output."
DECRYPT_ERRORS=$(mktemp "${TMPDIR:-/tmp}/caddy-restore-dec.XXXXXX") || \
  die "could not create temporary file for decryption errors."
trap 'rm -f "$VALIDATE_OUTPUT" "$DECRYPT_ERRORS"' EXIT

# Use python3 if available for robust tar member inspection (handles spaces,
# unicode, link types without fragile string tokenization). Fall back to
# tar listing if python3 is unavailable.
validate_tar_stream() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import sys, tarfile

has_crt = False
has_key = False
errors = []

try:
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as tar:
        for member in tar:
            name = member.name
            # 1. Reject absolute paths
            if name.startswith("/") or name.startswith("\\"):
                errors.append(f"REJECT: absolute path: {name}")
            # 2. Reject path traversal components
            parts = [p for p in name.replace("\\", "/").split("/") if p]
            if ".." in parts:
                errors.append(f"REJECT: path traversal (..): {name}")
            # 3. Reject symlinks and hardlinks
            if member.issym() or member.islnk():
                errors.append(f"REJECT: link entry not permitted: {name} -> {member.linkname}")
            # 4. Reject device nodes or non-standard entry types
            if not (member.isfile() or member.isdir()):
                errors.append(f"REJECT: unsupported entry type: {name}")
            # 5. Track required CA files
            clean = name.lstrip("./")
            if clean == "caddy/pki/authorities/local/root.crt":
                has_crt = True
            elif clean == "caddy/pki/authorities/local/root.key":
                has_key = True
except Exception as e:
    errors.append(f"TAR STREAM CORRUPTION: {e}")

if not has_crt:
    errors.append("MISSING: caddy/pki/authorities/local/root.crt not found in archive")
if not has_key:
    errors.append("MISSING: caddy/pki/authorities/local/root.key not found in archive")

if errors:
    for err in errors:
        sys.stderr.write(err + "\n")
    sys.exit(1)
sys.exit(0)
'
  else
    # Fallback: tar -tzvf validation
    local has_crt=0 has_key=0
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      # Check entry type (first char: - = file, d = dir, l = symlink, h = hardlink)
      case "$line" in
        l*|h*) echo "REJECT: link entry not permitted: $line" >&2; return 1 ;;
        [!-d]*) echo "REJECT: unsupported entry type: $line" >&2; return 1 ;;
      esac
      # Extract path from end of line (handling potential spaces)
      # In tar -tvf, path starts at field 6 (or after date/time)
      local path
      path="$(echo "$line" | awk "{for(i=6;i<=NF;++i) printf \"%s%s\", (i>6?\" \":\"\"), \$i}")"
      [ -n "$path" ] || path="$line"
      # Absolute path check
      case "$path" in
        /*|\\*) echo "REJECT: absolute path: $path" >&2; return 1 ;;
      esac
      # Path traversal check
      case "$path" in
        ..|../*|*/../*|*/..) echo "REJECT: path traversal (..): $path" >&2; return 1 ;;
      esac
      case "$path" in
        *caddy/pki/authorities/local/root.crt*) has_crt=1 ;;
        *caddy/pki/authorities/local/root.key*) has_key=1 ;;
      esac
    done
    if [ "$has_crt" -ne 1 ] || [ "$has_key" -ne 1 ]; then
      echo "MISSING: required root.crt or root.key not found in archive" >&2
      return 1
    fi
    return 0
  fi
}

set +e
age -d -i "$KEY_FILE" "$ARCHIVE" 2>"$DECRYPT_ERRORS" \
  | validate_tar_stream >"$VALIDATE_OUTPUT" 2>&1
PIPES=("${PIPESTATUS[@]}")
set -e

if [ "${PIPES[0]}" -ne 0 ]; then
  cat "$DECRYPT_ERRORS" >&2
  die "Decryption failed (exit code ${PIPES[0]}). Invalid key file or corrupted age ciphertext. Target volume was NOT touched."
fi

if [ "${PIPES[1]}" -ne 0 ]; then
  cat "$VALIDATE_OUTPUT" >&2
  die "Archive validation failed (exit code ${PIPES[1]}). Target volume was NOT touched."
fi

info "Pass 1 complete: archive decrypted and validated successfully (safe entries, required CA files present)."

# ---------------------------------------------------------------------------
# Pass 2: Stream-decrypt directly into newly created STAGING Docker volume
# ---------------------------------------------------------------------------
info "Creating temporary staging volume '$STAGING_VOLUME'..."
docker volume create "$STAGING_VOLUME" >/dev/null
STAGING_CREATED=1

info "Pass 2: Streaming decrypted archive into staging volume '$STAGING_VOLUME'..."
set +e
age -d -i "$KEY_FILE" "$ARCHIVE" 2>/dev/null \
  | docker run --rm -i \
      -v "${STAGING_VOLUME}:/data" \
      "$HELPER_IMAGE" \
      tar xzpf - -C /data
EXTRACT_PIPES=("${PIPESTATUS[@]}")
set -e

if [ "${EXTRACT_PIPES[0]}" -ne 0 ] || [ "${EXTRACT_PIPES[1]}" -ne 0 ]; then
  die "Pass 2 extraction failed (age exit: ${EXTRACT_PIPES[0]}, tar exit: ${EXTRACT_PIPES[1]}). Target volume was NOT touched."
fi
info "Pass 2 complete: archive extracted into staging volume."

# ---------------------------------------------------------------------------
# Staging Verification: Verify files, permissions, and fingerprint
# ---------------------------------------------------------------------------
info "Verifying staging volume contents and file permissions..."

VERIFY_RESULT=$(docker run --rm -v "${STAGING_VOLUME}:/data:ro" "$HELPER_IMAGE" sh -c '
  errors=""
  # 1. Directory presence
  if [ ! -d "/data/caddy/pki/authorities/local" ]; then
    errors="${errors}MISSING: /data/caddy/pki/authorities/local directory\n"
  fi
  # 2. root.crt presence and non-empty
  if [ ! -s "/data/caddy/pki/authorities/local/root.crt" ]; then
    errors="${errors}MISSING_OR_EMPTY: root.crt\n"
  fi
  # 3. root.key presence and non-empty
  if [ ! -s "/data/caddy/pki/authorities/local/root.key" ]; then
    errors="${errors}MISSING_OR_EMPTY: root.key\n"
  fi
  # 4. root.key permissions (must be mode 600)
  key_mode=$(stat -c "%a" /data/caddy/pki/authorities/local/root.key 2>/dev/null || echo "unknown")
  if [ "$key_mode" != "600" ]; then
    errors="${errors}INSECURE_PERMS: root.key has mode $key_mode (expected 600)\n"
  fi
  if [ -n "$errors" ]; then
    printf "%b" "$errors"
    exit 1
  fi
  echo "OK"
')

case "$VERIFY_RESULT" in
  OK*) info "Staging volume integrity and permissions verified (root.key mode 600 confirmed)." ;;
  *)
    echo "--- Staging verification failures ---" >&2
    echo "$VERIFY_RESULT" >&2
    die "Staging volume verification failed. Target volume was NOT touched."
    ;;
esac

# Calculate and display CA fingerprint
CA_FINGERPRINT=$(docker run --rm -v "${STAGING_VOLUME}:/data:ro" "$HELPER_IMAGE" sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
' 2>/dev/null || echo "Fingerprint calculation requires openssl")

info "============================================================"
info "Staging CA Certificate Fingerprint:"
info "  $CA_FINGERPRINT"
info "============================================================"

# ---------------------------------------------------------------------------
# Replacement Phase (Target volume modification only if explicitly requested)
# ---------------------------------------------------------------------------
if [ "$REPLACE" -ne 1 ]; then
  info ""
  info "SUCCESS: Staging volume '$STAGING_VOLUME' is ready and verified."
  info "NOTICE: Target volume '$TARGET_VOLUME' was NOT modified (dry-run/staging mode)."
  info ""
  info "To execute replacement into '$TARGET_VOLUME', run:"
  info "  $0 --archive \"$ARCHIVE\" --key-file \"$KEY_FILE\" --volume \"$TARGET_VOLUME\" --replace"
  info ""
  # Clean up staging volume unless explicitly asked to keep it
  if [ "$KEEP_STAGING" -eq 0 ]; then
    docker volume rm "$STAGING_VOLUME" >/dev/null 2>&1 || true
    STAGING_CREATED=0
  else
    info "Staging volume retained: $STAGING_VOLUME"
  fi
  exit 0
fi

info ""
info "Executing target volume replacement into '$TARGET_VOLUME'..."

# Step A: Check if target volume exists and backup existing contents if present
BACKUP_VOLUME=""
if docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1; then
  FILE_COUNT=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" \
    sh -c 'find /data -mindepth 1 -maxdepth 1 -print -quit | wc -l' 2>/dev/null || echo "0")
  FILE_COUNT="$(echo "$FILE_COUNT" | tr -d '[:space:]')"

  if [ "$FILE_COUNT" != "0" ]; then
    BACKUP_VOLUME="${TARGET_VOLUME}_backup_${STAMP}"
    info "Target volume contains existing files. Creating backup volume '$BACKUP_VOLUME'..."
    docker volume create "$BACKUP_VOLUME" >/dev/null
    docker run --rm \
      -v "${TARGET_VOLUME}:/src:ro" \
      -v "${BACKUP_VOLUME}:/dst" \
      "$HELPER_IMAGE" \
      cp -a /src/. /dst/
    info "Previous target volume contents backed up to '$BACKUP_VOLUME'."
  fi
else
  info "Target volume '$TARGET_VOLUME' does not exist yet. Creating it..."
  docker volume create "$TARGET_VOLUME" >/dev/null
fi

# Step B: Copy validated contents from STAGING_VOLUME to TARGET_VOLUME
info "Copying verified contents from staging volume to '$TARGET_VOLUME'..."
docker run --rm \
  -v "${STAGING_VOLUME}:/src:ro" \
  -v "${TARGET_VOLUME}:/dst" \
  "$HELPER_IMAGE" \
  sh -c 'rm -rf /dst/* /dst/.[!.]* /dst/..?* 2>/dev/null || true; cp -a /src/. /dst/'

# Step C: Verify TARGET_VOLUME
TARGET_FINGERPRINT=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
' 2>/dev/null || echo "Fingerprint calculation requires openssl")

TARGET_KEY_MODE=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" \
  stat -c "%a" /data/caddy/pki/authorities/local/root.key 2>/dev/null || echo "unknown")

if [ "$TARGET_KEY_MODE" != "600" ]; then
  die "Target volume root.key has invalid permissions ($TARGET_KEY_MODE)! Backup retained at '$BACKUP_VOLUME'."
fi

if [ "$TARGET_FINGERPRINT" != "$CA_FINGERPRINT" ]; then
  die "Target volume CA fingerprint mismatch after replacement! Backup retained at '$BACKUP_VOLUME'."
fi

info "Target volume '$TARGET_VOLUME' replacement verified successfully."
info "CA Fingerprint: $TARGET_FINGERPRINT"
if [ -n "$BACKUP_VOLUME" ]; then
  info "Previous volume preserved at: $BACKUP_VOLUME"
fi

if [ "$KEEP_STAGING" -eq 1 ]; then
  info "Staging volume retained at: $STAGING_VOLUME"
else
  docker volume rm "$STAGING_VOLUME" >/dev/null 2>&1 || true
  STAGING_CREATED=0
fi

info ""
info "Restoration complete. No plaintext archive was created on host storage."
info "Verify fingerprint against clinic records before starting the application stack."
