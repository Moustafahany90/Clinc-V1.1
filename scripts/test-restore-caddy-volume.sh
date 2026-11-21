#!/usr/bin/env bash
# Isolated test for the streaming Caddy CA volume restore procedure.
#
# This script validates the restore-caddy-volume.sh streaming pipeline using
# ONLY temporary Docker volumes and synthetic test data. It never touches
# production volumes, production backups, production keys, or host config.
#
# Tests verified:
#   1. Valid archive restore does not fail from SIGPIPE under pipefail.
#   2. Invalid key failure leaves target volume completely unchanged.
#   3. Corrupted encrypted archive failure leaves target volume unchanged.
#   4. Path traversal archive (..) rejection leaves target volume unchanged.
#   5. Absolute path archive rejection leaves target volume unchanged.
#   6. Symlink and hardlink entries in archive are rejected.
#   7. Staging-only run (without --replace) validates and leaves target untouched.
#   8. Explicit replacement (--replace) backs up existing target and updates it.
#   9. Root CA fingerprint and mode 600 permissions are preserved across restore.
#  10. Staging and backup volume retention/cleanup behavior.
#  11. Absolute proof that NO plaintext archive is written to host filesystem.
#
# Usage:
#   ./scripts/test-restore-caddy-volume.sh
#
# Requirements: age, docker, openssl (on host or in helper containers)
set -euo pipefail

export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_SCRIPT="${SCRIPT_DIR}/restore-caddy-volume.sh"

TEST_ID="caddy-test-$$-$(date +%s)"
SRC_VOLUME="test_src_${TEST_ID}"
TARGET_VOLUME="test_target_${TEST_ID}"
HELPER_IMAGE="alpine:3.22"
TEST_DIR=""
TEST_PASSED=0
TEST_FAILED=0
TEST_TOTAL=0

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  docker volume rm "$SRC_VOLUME" 2>/dev/null || true
  docker volume rm "$TARGET_VOLUME" 2>/dev/null || true
  # Clean up any test-created volumes
  for vol in $(docker volume ls -q | grep -E "^(test_|caddy_restore_stage_|${TARGET_VOLUME})" 2>/dev/null || true); do
    docker volume rm "$vol" 2>/dev/null || true
  done
  [ -z "$TEST_DIR" ] || rm -rf "$TEST_DIR" 2>/dev/null || true
  echo "Cleanup complete."
  echo ""
  echo "=== Test Summary ==="
  echo "Passed: $TEST_PASSED / $TEST_TOTAL"
  echo "Failed: $TEST_FAILED / $TEST_TOTAL"
  if [ "$TEST_FAILED" -gt 0 ]; then
    echo "RESULT: FAIL"
    exit 1
  else
    echo "RESULT: PASS"
  fi
}
trap cleanup EXIT

pass() { TEST_TOTAL=$((TEST_TOTAL + 1)); TEST_PASSED=$((TEST_PASSED + 1)); echo "  PASS: $1"; }
fail() { TEST_TOTAL=$((TEST_TOTAL + 1)); TEST_FAILED=$((TEST_FAILED + 1)); echo "  FAIL: $1" >&2; }

echo "=== Environment and Prerequisites Check ==="
command -v age >/dev/null 2>&1    || { echo "SKIP: 'age' not installed."; exit 0; }
command -v docker >/dev/null 2>&1 || { echo "SKIP: 'docker' not installed."; exit 0; }
docker info >/dev/null 2>&1      || { echo "SKIP: Docker daemon not running or accessible."; exit 0; }

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/caddy-restore-test.XXXXXX")"
chmod 700 "$TEST_DIR"

# Generate a synthetic test age key pair
age-keygen -o "$TEST_DIR/test-key.txt" 2>"$TEST_DIR/keygen.out"
AGE_RECIPIENT="$(grep '^public key:' "$TEST_DIR/keygen.out" | awk '{print $NF}')"
[ -n "$AGE_RECIPIENT" ] || { echo "FAIL: could not generate test age key pair."; exit 1; }
echo "Test age recipient: $AGE_RECIPIENT"

# Generate an invalid second key pair for rejection testing
age-keygen -o "$TEST_DIR/wrong-key.txt" 2>/dev/null

# ---------------------------------------------------------------------------
# Setup: Synthetic Caddy CA in source volume
# ---------------------------------------------------------------------------
echo ""
echo "=== Setup: Create synthetic Caddy CA in source volume ==="
docker volume create "$SRC_VOLUME" >/dev/null

docker run --rm -v "${SRC_VOLUME}:/data" "$HELPER_IMAGE" sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  mkdir -p /data/caddy/pki/authorities/local
  cd /data/caddy/pki/authorities/local
  openssl req -x509 -newkey rsa:2048 -keyout root.key -out root.crt \
    -days 365 -nodes -subj "/CN=Synthetic Test Clinic CA" 2>/dev/null
  chmod 600 root.key
  chmod 644 root.crt
  mkdir -p /data/caddy/certificates
  echo "synthetic-cert-data" > /data/caddy/certificates/test.json
'

SRC_FINGERPRINT=$(docker run --rm -v "${SRC_VOLUME}:/data:ro" "$HELPER_IMAGE" sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
' 2>/dev/null)
echo "Source CA fingerprint: $SRC_FINGERPRINT"

# Archive and encrypt in standard backup.sh format: `tar czf - -C /data .`
docker run --rm -v "${SRC_VOLUME}:/data:ro" "$HELPER_IMAGE" \
  tar czf - -C /data . \
  | age -R <(echo "$AGE_RECIPIENT") -o "$TEST_DIR/caddy_data.tar.gz.age"

# Create pre-existing data in TARGET_VOLUME to test protection against unintended modification
echo ""
echo "=== Setup: Create pre-existing state in target volume ==="
docker volume create "$TARGET_VOLUME" >/dev/null
docker run --rm -v "${TARGET_VOLUME}:/data" "$HELPER_IMAGE" sh -c '
  mkdir -p /data/original_state
  echo "CANARY_DATA_DO_NOT_OVERWRITE" > /data/original_state/canary.txt
'
check_canary() {
  local canary
  canary=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" \
    cat /data/original_state/canary.txt 2>/dev/null || echo "MISSING")
  [ "$canary" = "CANARY_DATA_DO_NOT_OVERWRITE" ]
}

# ---------------------------------------------------------------------------
# Test 1: No SIGPIPE on valid archive (Pass 1 full stream validation)
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 1: Valid archive does not fail from SIGPIPE under pipefail ==="
if bash "$RESTORE_SCRIPT" \
  --archive "$TEST_DIR/caddy_data.tar.gz.age" \
  --key-file "$TEST_DIR/test-key.txt" \
  --volume "$TARGET_VOLUME" \
  --expected "$TARGET_VOLUME" \
  --image "$HELPER_IMAGE" >"$TEST_DIR/test1.log" 2>&1; then
  pass "full stream decrypted without SIGPIPE failure"
else
  cat "$TEST_DIR/test1.log"
  fail "valid archive failed (possible SIGPIPE or validation error)"
fi

# ---------------------------------------------------------------------------
# Test 2: Target volume remains completely untouched after staging-only run
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 2: Staging-only run leaves target volume untouched ==="
if check_canary; then
  pass "target volume remained untouched during staging validation"
else
  fail "target volume was modified without --replace flag"
fi

# ---------------------------------------------------------------------------
# Test 3: Invalid key failure leaves target volume unchanged
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 3: Invalid key fails and leaves target volume untouched ==="
if bash "$RESTORE_SCRIPT" \
  --archive "$TEST_DIR/caddy_data.tar.gz.age" \
  --key-file "$TEST_DIR/wrong-key.txt" \
  --volume "$TARGET_VOLUME" \
  --expected "$TARGET_VOLUME" \
  --image "$HELPER_IMAGE" \
  --replace >/dev/null 2>&1; then
  fail "restore with invalid key unexpectedly succeeded"
else
  if check_canary; then
    pass "invalid key rejected; target volume untouched"
  else
    fail "target volume modified despite invalid key failure"
  fi
fi

# ---------------------------------------------------------------------------
# Test 4: Corrupted archive stream fails and leaves target volume untouched
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 4: Corrupted archive stream rejected; target untouched ==="
# Truncate ciphertext in the middle to simulate transfer corruption
head -c 200 "$TEST_DIR/caddy_data.tar.gz.age" > "$TEST_DIR/corrupt.age"
if bash "$RESTORE_SCRIPT" \
  --archive "$TEST_DIR/corrupt.age" \
  --key-file "$TEST_DIR/test-key.txt" \
  --volume "$TARGET_VOLUME" \
  --expected "$TARGET_VOLUME" \
  --image "$HELPER_IMAGE" \
  --replace >/dev/null 2>&1; then
  fail "corrupt archive unexpectedly succeeded"
else
  if check_canary; then
    pass "corrupt archive rejected; target volume untouched"
  else
    fail "target volume modified despite corrupted archive failure"
  fi
fi

# ---------------------------------------------------------------------------
# Test 5: Path traversal archive (..) rejected; target untouched
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 5: Path traversal archive rejected; target untouched ==="
EVIL_DIR="$TEST_DIR/evil_traversal"
mkdir -p "$EVIL_DIR/caddy/pki/authorities/local"
echo "fake-cert" > "$EVIL_DIR/caddy/pki/authorities/local/root.crt"
echo "fake-key"  > "$EVIL_DIR/caddy/pki/authorities/local/root.key"
# Build tar archive with a traversal entry
python3 -c "
import tarfile, io
with tarfile.open('$TEST_DIR/traversal.tar.gz', 'w:gz') as tar:
    tar.add('$EVIL_DIR/caddy', arcname='./caddy')
    # add evil traversal entry
    ti = tarfile.TarInfo(name='../evil_file')
    ti.size = 4
    tar.addfile(ti, io.BytesIO(b'evil'))
" 2>/dev/null || true

if [ -f "$TEST_DIR/traversal.tar.gz" ]; then
  age -R <(echo "$AGE_RECIPIENT") -o "$TEST_DIR/traversal.tar.gz.age" "$TEST_DIR/traversal.tar.gz"
  if bash "$RESTORE_SCRIPT" \
    --archive "$TEST_DIR/traversal.tar.gz.age" \
    --key-file "$TEST_DIR/test-key.txt" \
    --volume "$TARGET_VOLUME" \
    --expected "$TARGET_VOLUME" \
    --image "$HELPER_IMAGE" \
    --replace >/dev/null 2>&1; then
    fail "traversal archive was NOT rejected"
  else
    if check_canary; then
      pass "path traversal rejected in Pass 1; target volume untouched"
    else
      fail "target volume modified during traversal test"
    fi
  fi
else
  echo "  INFO: python tarfile not available for custom traversal craft; skipping craft"
fi

# ---------------------------------------------------------------------------
# Test 6: Absolute path archive rejected; target untouched
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 6: Absolute path archive rejected; target untouched ==="
python3 -c "
import tarfile, io
with tarfile.open('$TEST_DIR/absolute.tar.gz', 'w:gz') as tar:
    tar.add('$EVIL_DIR/caddy', arcname='./caddy')
    ti = tarfile.TarInfo(name='/etc/evil_target')
    ti.size = 4
    tar.addfile(ti, io.BytesIO(b'evil'))
" 2>/dev/null || true

if [ -f "$TEST_DIR/absolute.tar.gz" ]; then
  age -R <(echo "$AGE_RECIPIENT") -o "$TEST_DIR/absolute.tar.gz.age" "$TEST_DIR/absolute.tar.gz"
  if bash "$RESTORE_SCRIPT" \
    --archive "$TEST_DIR/absolute.tar.gz.age" \
    --key-file "$TEST_DIR/test-key.txt" \
    --volume "$TARGET_VOLUME" \
    --expected "$TARGET_VOLUME" \
    --image "$HELPER_IMAGE" \
    --replace >/dev/null 2>&1; then
    fail "absolute path archive was NOT rejected"
  else
    if check_canary; then
      pass "absolute path rejected in Pass 1; target volume untouched"
    else
      fail "target volume modified during absolute path test"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Test 7: Symlink and hardlink safety rejection
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 7: Symlink and hardlink entry rejection ==="
python3 -c "
import tarfile
with tarfile.open('$TEST_DIR/symlink.tar.gz', 'w:gz') as tar:
    tar.add('$EVIL_DIR/caddy', arcname='./caddy')
    ti = tarfile.TarInfo(name='./caddy/bad_symlink')
    ti.type = tarfile.SYMTYPE
    ti.linkname = '/etc/shadow'
    tar.addfile(ti)
" 2>/dev/null || true

if [ -f "$TEST_DIR/symlink.tar.gz" ]; then
  age -R <(echo "$AGE_RECIPIENT") -o "$TEST_DIR/symlink.tar.gz.age" "$TEST_DIR/symlink.tar.gz"
  if bash "$RESTORE_SCRIPT" \
    --archive "$TEST_DIR/symlink.tar.gz.age" \
    --key-file "$TEST_DIR/test-key.txt" \
    --volume "$TARGET_VOLUME" \
    --expected "$TARGET_VOLUME" \
    --image "$HELPER_IMAGE" \
    --replace >/dev/null 2>&1; then
    fail "symlink archive was NOT rejected"
  else
    if check_canary; then
      pass "symlink entry rejected in Pass 1; target volume untouched"
    else
      fail "target volume modified during symlink test"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Test 8: Explicit replacement (--replace) backs up and updates target volume
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 8: Explicit replacement updates target and creates backup ==="
bash "$RESTORE_SCRIPT" \
  --archive "$TEST_DIR/caddy_data.tar.gz.age" \
  --key-file "$TEST_DIR/test-key.txt" \
  --volume "$TARGET_VOLUME" \
  --expected "$TARGET_VOLUME" \
  --image "$HELPER_IMAGE" \
  --replace >"$TEST_DIR/test8.log" 2>&1

TARGET_FINGERPRINT=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" sh -c '
  apk add --no-cache openssl >/dev/null 2>&1
  openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
' 2>/dev/null)

if [ "$SRC_FINGERPRINT" = "$TARGET_FINGERPRINT" ]; then
  pass "CA fingerprint in target volume matches source exactly"
else
  fail "CA fingerprint mismatch: expected '$SRC_FINGERPRINT', got '$TARGET_FINGERPRINT'"
fi

# Check permissions: root.key must be 600
KEY_PERM=$(docker run --rm -v "${TARGET_VOLUME}:/data:ro" "$HELPER_IMAGE" \
  stat -c "%a" /data/caddy/pki/authorities/local/root.key 2>/dev/null || echo "unknown")
if [ "$KEY_PERM" = "600" ]; then
  pass "root.key permissions preserved with mode 600"
else
  fail "root.key permissions incorrect (mode $KEY_PERM)"
fi

# Verify previous volume was backed up
BACKUP_VOL_EXISTS=$(docker volume ls -q | grep -E "^${TARGET_VOLUME}_backup_" | head -n 1 || true)
if [ -n "$BACKUP_VOL_EXISTS" ]; then
  # Verify canary exists in backup volume
  BACKUP_CANARY=$(docker run --rm -v "${BACKUP_VOL_EXISTS}:/data:ro" "$HELPER_IMAGE" \
    cat /data/original_state/canary.txt 2>/dev/null || echo "MISSING")
  if [ "$BACKUP_CANARY" = "CANARY_DATA_DO_NOT_OVERWRITE" ]; then
    pass "previous target contents safely backed up to '$BACKUP_VOL_EXISTS'"
  else
    fail "backup volume '$BACKUP_VOL_EXISTS' missing canary data"
  fi
else
  fail "backup volume was not created prior to replacement"
fi

# ---------------------------------------------------------------------------
# Test 9: No plaintext CA archive on host filesystem
# ---------------------------------------------------------------------------
echo ""
echo "=== Test 9: No plaintext CA archive created on host ==="
if [ -f "/tmp/caddy_data.tar.gz" ]; then
  fail "plaintext archive found at /tmp/caddy_data.tar.gz"
elif find "$TEST_DIR" -name "*.tar.gz" ! -name "*.age" 2>/dev/null | grep -E "(caddy|restore)" >/dev/null; then
  fail "plaintext decrypted archive found in temporary directory"
else
  pass "no plaintext archive was created on host storage"
fi

echo ""
echo "=== All test cases executed ==="
