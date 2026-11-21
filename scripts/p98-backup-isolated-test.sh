#!/usr/bin/env bash
# Phase 9.8 isolated, synthetic backup/scheduler proof.
# No database, no production path, no installed unit, no credential.
# Every disposable resource is named p98* and removed by the EXIT trap.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p98-backup-tests.XXXXXX")" || {
  printf 'BLOCKED: could not create disposable p98 temp directory\n' >&2; exit 1
}
[ -n "$TMP" ] && [ -d "$TMP" ] || {
  printf 'BLOCKED: disposable p98 temp directory is unusable\n' >&2; exit 1
}
INVARIANT_FILE="${REPO}/p98-invariant-probe.txt"
PASS_COUNT=0
FAIL_COUNT=0
P98_UUID="11111111-2222-3333-4444-555555555555"
P98_FSTYPE="p98fs"
P98_NOW_EPOCH="$(date -u -d '2026-11-21T00:05:00Z' +%s 2>/dev/null || printf '1763683500')"
SEG00="000000010000000000000000"
SEG01="000000010000000000000001"
SEG02="000000010000000000000002"
SEG03="000000010000000000000003"

cleanup() {
  if [ "${P98_KEEP_TEMP:-0}" = "1" ]; then
    printf 'DEBUG: retained synthetic p98 fixture %s\n' "$TMP" >&2
    return 0
  fi
  rm -rf -- "$TMP"
  [ -e "$INVARIANT_FILE" ] && rm -f -- "$INVARIANT_FILE"
}
trap cleanup EXIT

ok() { printf 'PASS  %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
check() { if [ "$1" -eq "$2" ]; then ok "$3 ($1)"; else bad "$3 (expected $2, got $1)"; fi; }

sha() { sha256sum "$1" | awk '{print $1}'; }
bytes() { wc -c < "$1" | tr -d ' '; }
write_sums() {
  local dir=$1; shift
  : >"$dir/SHA256SUMS"
  local name
  for name in "$@"; do printf '%s  %s\n' "$(sha "$dir/$name")" "$name" >>"$dir/SHA256SUMS"; done
}
make_root() {
  local root=$1 archive=$2
  mkdir -p "$root/daily" "$root/weekly" "$root/monthly" "$root/wal-archive" \
    "$root/manifests" "$root/quarantine" "$root/logs" "$archive"
}
make_fixtures() {
  local root=$1 archive=$2
  make_root "$root" "$archive"
  local logical="${root}/daily/clinic-daily-20261121T010000Z"
  mkdir -p "$logical"
  printf 'p98 synthetic database dump' >"${logical}/db-p98.age"
  printf 'p98 synthetic storage archive' >"${logical}/storage-p98.age"
  write_sums "$logical" db-p98.age storage-p98.age
  cat >"${logical}/MANIFEST.txt" <<EOF_MANIFEST
created_utc=20261121T010000Z
backup_tier=daily
set_directory=$(basename "$logical")
database_name=p98_db
database_dump=db-p98.age
database_sha256=$(sha "${logical}/db-p98.age")
database_bytes=$(bytes "${logical}/db-p98.age")
storage_archive=storage-p98.age
storage_sha256=$(sha "${logical}/storage-p98.age")
storage_bytes=$(bytes "${logical}/storage-p98.age")
checksums=SHA256SUMS
encryption=age
backup_format=4
backup_id=p98-logical-0001
manifest_version=4
encryption_status=encrypted
consistency_mode=p98-synthetic
quiesced_services=none
wal_lsn_before_quiesce=0/0
database_plain_sha256=p98
storage_plain_sha256=p98
storage_files_checksums=none
storage_files_checksums_sha256=none
storage_files_checksums_bytes=none
storage_files_checksums_plain_sha256=p98
storage_files_count=0
evolution_archive=none
caddy_archives=none
EOF_MANIFEST

  local seg base_artifact base_sha base_bytes
  for seg in "$SEG00" "$SEG01" "$SEG02" "$SEG03"; do
    printf 'p98 synthetic WAL %s' "$seg" >"${archive}/${seg}"
    printf '%s  %s\n' "$(sha "${archive}/${seg}")" "$seg" >"${archive}/${seg}.sha256"
  done
  touch -d "@${P98_NOW_EPOCH}" "${archive}/${SEG00}" "${archive}/${SEG01}" \
    "${archive}/${SEG02}" "${archive}/${SEG03}" 2>/dev/null || true

  local pitr="${root}/weekly/clinic-weekly-20261121T000000Z-pitr"
  mkdir -p "$pitr"
  base_artifact="base-p98.tar.gz"
  printf 'p98 synthetic PITR base artifact' >"${pitr}/${base_artifact}"
  base_sha="$(sha "${pitr}/${base_artifact}")"
  base_bytes="$(bytes "${pitr}/${base_artifact}")"
  write_sums "$pitr" "$base_artifact"
  cat >"${pitr}/MANIFEST.txt" <<EOF_MANIFEST
backup_format=pitr-base-1
manifest_version=1
set_directory=$(basename "$pitr")
created_utc=20261121T000000Z
base_archive=${base_artifact}
base_sha256=${base_sha}
base_bytes=${base_bytes}
checksums=SHA256SUMS
encryption=none
pitr_ready=true
wal_archive_dir=${archive}
required_wal_start=${SEG01}
required_wal_end=${SEG02}
required_wal_count=2
required_wal_files=${SEG01}
${SEG02}
wal.sha256.${SEG01}=$(sha "${archive}/${SEG01}")
wal.sha256.${SEG02}=$(sha "${archive}/${SEG02}")
EOF_MANIFEST
}

BIN="${TMP}/bin"
ROOT="${TMP}/p98-root"
ARCHIVE="${TMP}/p98-wal"
STATE="${TMP}/p98-state"
SCRIPTS="${TMP}/p98-scripts"
mkdir -p "$BIN" "$STATE" "$SCRIPTS"
cp "${REPO}/scripts/"*.sh "$SCRIPTS/"

cat >"${BIN}/mountpoint" <<'EOF_STUB'
#!/bin/sh
[ "${P98_MOUNT_STATE:-1}" = "1" ]
EOF_STUB
cat >"${BIN}/findmnt" <<'EOF_STUB'
#!/bin/sh
case "$*" in
  *UUID*) printf '%s\n' "${P98_UUID}" ;;
  *FSTYPE*) printf '%s\n' "${P98_FSTYPE}" ;;
  *) exit 1 ;;
esac
EOF_STUB
cat >"${SCRIPTS}/pitr-base-backup.sh" <<'EOF_STUB'
#!/usr/bin/env bash
# p98-only generator stub: proves the dispatcher supplies the mandatory args.
set -euo pipefail
expected=(--pghost --pgport --pguser --wal-archive-dir --backup-root --tier)
i=0
while [ "$#" -gt 0 ]; do
  [ "$i" -lt "${#expected[@]}" ] || { echo 'p98 stub: too many arguments' >&2; exit 2; }
  [ "$1" = "${expected[$i]}" ] || { echo "p98 stub: expected ${expected[$i]}, got $1" >&2; exit 2; }
  [ "$#" -ge 2 ] || { echo "p98 stub: $1 has no value" >&2; exit 2; }
  printf 'p98-stub %s=%s\n' "$1" "$2"
  shift 2
  i=$((i + 1))
done
printf 'PITR BASE BACKUP SUCCESS (p98 stub)\n'
EOF_STUB
chmod +x "$BIN/mountpoint" "$BIN/findmnt" "$SCRIPTS/pitr-base-backup.sh"

run_scheduler() {
  local root=$1 archive=$2; shift 2
  env PATH="${BIN}:${PATH}" \
    BACKUP_ROOT="$root" WAL_ARCHIVE_DIR="$archive" \
    BACKUP_EXPECTED_UUID="$P98_UUID" BACKUP_EXPECTED_FSTYPE="$P98_FSTYPE" \
    P98_UUID="$P98_UUID" P98_FSTYPE="$P98_FSTYPE" \
    P98_MOUNT_STATE="${P98_MOUNT_STATE:-1}" \
    P7_STATE_DIR="$STATE" P7_ALERT_SINK="${P7_ALERT_SINK:-${STATE}/alerts.jsonl}" \
    P7_NOW_EPOCH="$P98_NOW_EPOCH" \
    SCHED_LOCK_FILE="${P98_LOCK_FILE:-${TMP}/p98.lock}" SCHED_LOCK_FD=9 \
    SCHED_MIN_FREE_MB=0 SCHED_SKIP_MOUNT_CHECK=0 \
    SCHED_OVERLAP_SKIP_ALERT_AFTER="${P98_OVERLAP_AFTER:-3}" \
    PITR_PGHOST="${P98_PGHOST-p98host}" PITR_PGPORT="${P98_PGPORT-55432}" \
    PITR_PGUSER="${P98_PGUSER-p98user}" PITR_PGDATABASE=postgres \
    PITR_TIER=weekly \
    bash "${SCRIPTS}/backup-scheduler.sh" "$@"
}

printf 'Phase 9.8 isolated backup/scheduler proof (synthetic p98 fixtures)\n'
make_fixtures "$ROOT" "$ARCHIVE"

# PB-25/PB-28: every job accepts only documented flags; pitr-base gets its four
# mandatory values from the protected environment contract.
run_scheduler "$ROOT" "$ARCHIVE" full --dry-run >"${TMP}/full.out" 2>&1
check $? 0 'full --dry-run has no usage error'
run_scheduler "$ROOT" "$ARCHIVE" pitr-base --dry-run >"${TMP}/pitr.out" 2>&1
check $? 0 'pitr-base --dry-run derives mandatory arguments from PITR_* env'
grep -q 'host=p98host port=55432 user=p98user' "${TMP}/pitr.out"
check $? 0 'pitr-base plan includes host/port/user'
run_scheduler "$ROOT" "$ARCHIVE" verify --dry-run >"${TMP}/verify.out" 2>&1
check $? 0 'verify --dry-run verifies logical and PITR sets'
grep -q 'PITR BASE VERIFICATION OK' "${TMP}/verify.out"
check $? 0 'verify job reports PITR base verification OK'
run_scheduler "$ROOT" "$ARCHIVE" retention --dry-run --keep-daily 2 >"${TMP}/retention.out" 2>&1
check $? 0 'retention --dry-run --keep-daily has no usage error'
run_scheduler "$ROOT" "$ARCHIVE" wal-prune --dry-run >"${TMP}/prune.out" 2>&1
check $? 0 'wal-prune --dry-run has no usage error'
grep -q 'plan_sha256=' "${TMP}/prune.out"
check $? 0 'wal-prune emits a deterministic plan hash'
grep -q 'candidates=1' "${TMP}/prune.out"
check $? 0 'wal-prune identifies exactly one synthetic candidate'

P98_PGUSER='' run_scheduler "$ROOT" "$ARCHIVE" pitr-base --dry-run >"${TMP}/no-user.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'pitr-base fails closed when a mandatory argument is absent'

# PB-30: the PITR monitor validates the newest base artifact as well as WAL.
env P7_BACKUP_ROOT="$ROOT" P7_WAL_ARCHIVE_DIR="$ARCHIVE" P7_NOW_EPOCH="$P98_NOW_EPOCH" \
  P7_STATE_DIR="$STATE" P7_ALERT_SINK='' \
  bash "${SCRIPTS}/p7-check-pitr.sh" >"${TMP}/pitrcheck.out" 2>&1
check $? 0 'p7-check-pitr reports OK for a synthetic valid PITR base'
grep -q 'pitr.base.artifact' "${TMP}/pitrcheck.out"
check $? 0 'p7-check-pitr emits base-artifact status'

# PB-27: unmounted disk refuses before creating a log or deleting anything.
ROOT_UNMOUNTED="${TMP}/p98-unmounted"
make_root "$ROOT_UNMOUNTED" "${TMP}/p98-unmounted-wal"
P98_MOUNT_STATE=0 run_scheduler "$ROOT_UNMOUNTED" "${TMP}/p98-unmounted-wal" wal-prune --dry-run \
  >"${TMP}/unmounted.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'unmounted backup disk makes wal-prune exit non-zero'
[ ! -e "${ROOT_UNMOUNTED}/logs/schedule-wal-prune.log" ]
check $? 0 'unmounted backup disk creates no scheduler log directory/file'

# PB-27: no validated base, invalid base hash, or missing confirmation all refuse.
ROOT_NOBASE="${TMP}/p98-nobase"
ARCHIVE_NOBASE="${TMP}/p98-nobase-wal"
make_fixtures "$ROOT_NOBASE" "$ARCHIVE_NOBASE"
rm -f "${ROOT_NOBASE}/weekly/clinic-weekly-20261121T000000Z-pitr/MANIFEST.txt"
run_scheduler "$ROOT_NOBASE" "$ARCHIVE_NOBASE" wal-prune --dry-run >"${TMP}/nobase.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'wal-prune refuses when no validated pitr_ready base exists'
[ -f "${ARCHIVE_NOBASE}/${SEG00}" ]
check $? 0 'wal-prune deletes nothing when no validated base exists'

ROOT_BADBASE="${TMP}/p98-badbase"
ARCHIVE_BADBASE="${TMP}/p98-badbase-wal"
make_fixtures "$ROOT_BADBASE" "$ARCHIVE_BADBASE"
printf 'tamper' >>"${ROOT_BADBASE}/weekly/clinic-weekly-20261121T000000Z-pitr/base-p98.tar.gz"
run_scheduler "$ROOT_BADBASE" "$ARCHIVE_BADBASE" wal-prune --dry-run >"${TMP}/badbase.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'wal-prune refuses a tampered retained base artifact'
[ -f "${ARCHIVE_BADBASE}/${SEG00}" ]
check $? 0 'wal-prune deletes nothing for a tampered base'

# The scheduled verify job must detect the same tampering before any pruning.
env BACKUP_VERIFY_SKIP_MOUNT_CHECK=1 \
  bash "${SCRIPTS}/verify-pitr-base.sh" --root "$ROOT_BADBASE" \
  >"${TMP}/badbase-verify.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'scheduled PITR verifier fails on a tampered base artifact'
grep -q 'SHA-256 mismatch' "${TMP}/badbase-verify.out"
check $? 0 'scheduled PITR verifier names the base hash mismatch'

run_scheduler "$ROOT" "$ARCHIVE" wal-prune --apply >"${TMP}/noconfirm.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'wal-prune --apply refuses without --confirm DELETE'
[ -f "${ARCHIVE}/${SEG00}" ]
check $? 0 'wal-prune --apply without confirmation deletes nothing'

# Same-invocation dry-run plan hash is reused for the applied run.
dry_hash="$(sed -n 's/.*plan_sha256=\([0-9a-f]*\).*/\1/p' "${TMP}/prune.out" | head -n 1)"
run_scheduler "$ROOT" "$ARCHIVE" wal-prune --apply --confirm DELETE >"${TMP}/apply.out" 2>&1
check $? 0 'wal-prune --apply --confirm DELETE succeeds'
apply_hash="$(sed -n 's/.*plan_sha256=\([0-9a-f]*\).*/\1/p' "${TMP}/apply.out" | head -n 1)"
[ -n "$dry_hash" ] && [ "$dry_hash" = "$apply_hash" ]
check $? 0 'dry-run and apply use the same plan hash'
[ ! -e "${ARCHIVE}/${SEG00}" ]
check $? 0 'expired candidate segment was deleted'
[ -f "${ARCHIVE}/${SEG01}" ] && [ -f "${ARCHIVE}/${SEG02}" ] && [ -f "${ARCHIVE}/${SEG03}" ]
check $? 0 'required WAL and newest segment were never candidates'

# PB-31: repeated lock contention is visible and eventually fails.
P98_LOCK_FILE="${TMP}/p98-contention.lock"
( flock 9; sleep 3 ) 9>"$P98_LOCK_FILE" &
holder=$!
sleep 1
P98_LOCK_FILE="$P98_LOCK_FILE" P98_OVERLAP_AFTER=1 \
  run_scheduler "$ROOT" "$ARCHIVE" wal-prune --dry-run >"${TMP}/lock.out" 2>&1
lock_rc=$?
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
check "$lock_rc" 75 'repeated lock contention exits non-zero'
grep -q '"check":"backup.scheduler"' "${STATE}/alerts.jsonl"
check $? 0 'lock contention emits a structured monitor alert'

# PB-11/PB-31 repository invariants are fail-closed.
printf '%s\n' "DELETE FROM \"_prisma_mig""rations\"" >"$INVARIANT_FILE"
bash "${REPO}/scripts/p97-readiness-preflight.sh" >"${TMP}/invariant.out" 2>&1
[ "$?" -ne 0 ]
check $? 0 'preflight fails on a reintroduced unsafe ledger command'
grep -q 'unsafe migration-ledger guidance' "${TMP}/invariant.out"
check $? 0 'preflight names the unsafe guidance failure'
rm -f -- "$INVARIANT_FILE"

if [ "$FAIL_COUNT" -gt 0 ] && [ "${P98_DEBUG:-0}" = "1" ]; then
  for out_file in "$TMP"/*.out; do
    [ -f "$out_file" ] || continue
    printf 'DEBUG === %s ===\n' "$(basename "$out_file")"
    cat "$out_file"
  done
fi

printf 'RESULT  p98-backup: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
