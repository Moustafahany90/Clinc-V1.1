# Phase 8.0 — Production Deployment Assessment & Execution Planning (Corrected)

**Project:** Ultrasound Clinic Management System (`Clinc-V1.1`)
**Document type:** Assessment and execution-planning report — documentation only
**Branch / HEAD at assessment:** `feature/clinic-quick-actions` @ `0d79b7d98962b204806e3e2cf2caf1ac381f1026` (repository-verified)
**Status:** **NO-GO for production deployment.** Stop gate active. No phase beyond 8.0 is authorized by this document.

> This is a corrected version of the proposed Phase 8.0 report. It incorporates owner-provided terminal evidence for Ubuntu backup-disk preparation that was previously under-represented. It does **not** change the deployment decision: production deployment, real backup/restore, WAL/PITR activation, monitoring installation, and scheduling remain unperformed and unapproved.

---

## 0. How to read this report — evidence classification

Historical owner-provided terminal output and current independent verification are **not** the same thing. Every material statement below carries one of these labels:

| Label | Meaning |
|---|---|
| **Previously verified** | Supported by earlier owner-provided terminal output, or by isolated test evidence recorded in prior phase reports. Historical evidence, not re-validated in this phase. |
| **Owner-reported** | Stated by the owner, but no independent verification output (hash comparison, recovery test, command transcript) is available in the material reviewed. |
| **Repository-verified** | Supported by files, scripts, Git state, or tests inspected directly during this phase. |
| **Not verified** | No sufficient evidence exists. Must not be assumed. |
| **Pending decision** | Requires an explicit owner choice before implementation. |
| **Requires explicit approval** | Operational action that is not authorized and must not be performed without written owner approval immediately beforehand. |

**Do not read "previously verified" as "currently verified on the host."** The Ubuntu host was not contacted during Phase 8.0.

---

## 1. Executive summary

| Area | Corrected finding | Evidence |
|---|---|---|
| Deployment decision | **NO-GO — BLOCKERS REMAIN.** | Assessment |
| Repository state | 13 modified tracked + 11 untracked files; HEAD is an unrelated quick-actions commit. All Phase 6/7.1/7.2 work is uncommitted. | Repository-verified |
| `backup.patch` | Tracked and clean (439,292 bytes; worktree hash = HEAD hash `e31aa83…`). Preserved, not regenerated. | Repository-verified |
| Backup disk | A dedicated **internal SATA HDD** is prepared at `/dev/sda1`, ext4, label `clinic-backups`, UUID `0f21089c-c507-4903-96e5-daf637100d53`, mounted at `/mnt/clinic-backups`. | Previously verified (owner terminal output) |
| Persistent mount | UUID-based `/etc/fstab` entry supplied; `findmnt` previously reported ext4 read/write mounted; backup copy `/etc/fstab.before-clinic-backups` exists. | Previously verified (owner terminal output) |
| Directory structure | `daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, `logs` previously created under `/mnt/clinic-backups`, reported `root:root` mode `700`. | Previously verified (owner terminal output) |
| Preflight | `/usr/local/sbin/clinic-backup-preflight` previously produced `BACKUP PREFLIGHT PASSED`, checking mountpoint, UUID, ext4, directories, age recipient, and write access. | Previously verified (owner terminal output); not revalidated in Phase 8.0 |
| Encryption interoperability | Synthetic file encrypted on Ubuntu, transferred to Windows, decrypted successfully with matching content; temporary files cleaned. Public recipient `age1yamkh3stl86sxq5dq77865m57qjwzcp646f98trwru580hv2ysrs4sg3a0`. | Previously verified (synthetic data only) |
| Private-key escrow | Owner reports completion using a USB flash drive; no independent hash comparison or physical recovery-test output provided. | Owner-reported; independent verification pending |
| SMART | Overall PASSED, no reallocated/pending/uncorrectable sectors reported, ~34 °C, ~64,814 power-on hours. **No long-test completion output available.** | Previously verified (owner terminal output) |
| Backup engine | `scripts/backup.sh` + `scripts/backup-verify.sh` are the intended engine. `/usr/local/sbin/clinic-backup-create` is a temporary generic helper and **must not** be used as the production engine. | Repository-verified + owner-reported |
| Path mapping | Repo default `backups/`; prior docs `/mnt/clinic-backups/backups`; host has tiered directories. **No approved mapping.** | Repository-verified + previously verified (owner) |
| Host access | Remote agent SSH denied (`Permission denied (publickey,password)`). This does not invalidate owner-supplied evidence. | Repository-verified (attempt this phase) |
| Production backup/restore | No real application-aware encrypted backup or production restore drill on Ubuntu. | Not verified |
| WAL/PITR | Not enabled or validated on the target. | Not verified |
| Monitoring | Implemented in repository; not installed or activated in production. Real Telegram/heartbeat delivery not validated. | Repository-verified + not verified |
| Scheduling | No production systemd timer/cron activated. | Not verified |
| Off-site | No rclone/off-site provider configured. | Repository-verified + previously documented |

---

## 2. Initial repository status (repository-verified, current)

Current state matches the historical observations supplied for this correction. No corrective action was attempted.

| Check | Current value |
|---|---|
| Branch | `feature/clinic-quick-actions` (tracking `origin/feature/clinic-quick-actions`) |
| HEAD | `0d79b7d98962b204806e3e2cf2caf1ac381f1026` — `quick actions: add weekly revenue panel, weekly availability panel, and weekly appointments panel` |
| `git status --short` | **24 entries: 13 modified tracked + 11 untracked** |
| `backup.patch` | Present, 439,292 bytes, mtime 2026-11-20 18:30:12; tracked and clean; worktree blob = HEAD blob = `e31aa83e68fd94a76efcfcdad156521c286e6ce6` |
| `backups/` | Contains only `db-20261113T134414Z.dump` (198,449 bytes, 2026-11-13) |
| `.env` | Present, ignored (`.gitignore:12`), untracked, **not read** |
| `.github/` | Absent — no CI workflows |
| `docs/PRODUCTION_READINESS_PHASE8_0.md` | Did not exist before this correction; created as the sole change |

**Modified tracked (13):** `backend/src/lib/logger.ts`, `deploy/Caddyfile`, `docker-compose.monitoring.yml`, `docs/PRODUCTION_READINESS_BASELINE.md`, `docs/PRODUCTION_READINESS_PHASE6.md`, `docs/PRODUCTION_READINESS_PHASE6_1.md`, `docs/PRODUCTION_READINESS_PHASE7.md`, `docs/backup-restore.md`, `docs/monitoring-runbook.md`, `docs/operations.md`, `scripts/p7-common.sh`, `scripts/p7-monitor.sh`, `web/nginx.conf`.

**Untracked (11):** `backend/tests/p72-http-422.test.ts`, `backend/tests/p72-scrubber-regression.test.ts`, `backend/tests/phase7-route-redaction.test.ts`, `deploy/clinic-monitor.logrotate`, `deploy/monitor.env.example`, `docs/PRODUCTION_READINESS_PHASE7_1.md`, `docs/PRODUCTION_READINESS_PHASE7_2.md`, `scripts/p7-deliver-telegram.sh`, `scripts/p7-heartbeat-hook.sh`, `scripts/p72-nginx-privacy-test.sh`, `scripts/p72-phase7-regression.sh`.

No `reset`, `clean`, `checkout`, `restore`, `stash`, commit, push, rebase, or tag was performed. `backup.patch` and the legacy dump were not modified.

---

## 3. Corrected Ubuntu backup infrastructure evidence

This section replaces the earlier treatment that described these items as unknown or absent. The distinction is: the setup was **previously verified through owner-provided terminal output**, but **not independently revalidated during Phase 8.0**.

### 3.1 Backup disk — internal SATA, not USB

**Previously verified (owner terminal output):**

| Attribute | Value |
|---|---|
| Device | `/dev/sda`, partition `/dev/sda1` |
| Model | Seagate Pipeline HD 5900.2 |
| Model number | `ST3500312CS` |
| Capacity | 500 GB |
| Interface / role | **Internal SATA HDD; local backup destination** |
| Filesystem | ext4 |
| Label | `clinic-backups` |
| UUID | `0f21089c-c507-4903-96e5-daf637100d53` |
| Mountpoint | `/mnt/clinic-backups` |

**Previously verified:** the system disk is a separate device, `/dev/sdb` (Samsung SSD 870 EVO 500 GB). It must not be confused with the backup disk.

**Terminology rule for all subsequent phases:** `/dev/sda1` is the **internal SATA HDD** used for local backup storage. A separate **USB flash drive** is reserved solely for offline age private-key escrow. The 500 GB backup HDD must never be described as an external USB disk, and the USB flash drive must never be described as backup storage.

### 3.2 Persistent mount

**Previously verified (owner terminal output):**

```
UUID=0f21089c-c507-4903-96e5-daf637100d53 /mnt/clinic-backups ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2
```

- `findmnt` previously reported `/mnt/clinic-backups` mounted as ext4 with read/write access.
- A pre-change copy of the fstab file was saved as `/etc/fstab.before-clinic-backups`.

**Not verified in Phase 8.0:** current mount state, current fstab contents, or whether the mount survives reboot.

### 3.3 Backup directory structure

**Previously verified (owner terminal output):** the following directories exist under `/mnt/clinic-backups`, reported as `root:root`, mode `700`:

`daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, `logs`.

**Not verified in Phase 8.0:** current existence, ownership, permissions, or contents.

### 3.4 Preflight verification

**Previously verified through owner-provided terminal output; not independently revalidated during Phase 8.0.**

- Script: `/usr/local/sbin/clinic-backup-preflight`
- Successful output: `BACKUP PREFLIGHT PASSED`
- Checks reported: expected mountpoint, expected disk UUID, ext4 filesystem, required directory structure, age recipient configuration, and write access using a temporary test file.

This is host-side evidence. There is no corresponding preflight or UUID-pinning implementation in the repository [Repository-verified]. Revalidation is a Phase 8.2 item.

### 3.5 Encryption interoperability and key escrow

**Previously verified using synthetic data:**

1. A synthetic file was encrypted on Ubuntu.
2. The ciphertext was transferred to Windows.
3. It was decrypted successfully using the corresponding private key.
4. Decrypted content matched the original synthetic content.
5. Temporary test files were cleaned up.

Public recipient previously reported: `age1yamkh3stl86sxq5dq77865m57qjwzcp646f98trwru580hv2ysrs4sg3a0`. This is a public value; no private key material was provided, requested, or recorded.

**Classification:** encryption interoperability is **previously verified with synthetic data**. Production backup encryption and recovery remain **not verified**. A restore of a real application-aware encrypted backup has not been performed.

**Escrow:** the owner reported that private-key escrow was completed using a USB flash drive. No independent hash comparison or physical recovery-test output was provided. Classification: **owner-reported completion; independent verification pending.**

### 3.6 SMART health

**Previously verified (owner terminal output):**

| Attribute | Value |
|---|---|
| Overall SMART status | PASSED |
| Reallocated / pending / uncorrectable sectors | None reported |
| Temperature | approximately 34 °C |
| Power-on hours | approximately 64,814 hours |

This is an **aging HDD with substantial operating hours**. An overall `PASSED` result is a point-in-time health snapshot; it is not proof that the disk is suitable as the only recovery source. **No SMART long-test completion output is available**, so a long test must not be claimed as passed.

**Requirement for later phases:** establish an additional independent backup copy and/or approved replacement path. Local backup on a single ageing internal HDD is **not** off-site disaster recovery.

### 3.7 Host access status

**Required wording:** **Remote agent SSH access is currently unverified/denied. Previously supplied owner terminal outputs provide historical evidence for disk setup, mount configuration, encryption interoperability, and preflight success. Current host state has not been independently revalidated.**

The coding agent's BatchMode SSH attempts returned `Permission denied (publickey,password)`. This only proves that the agent could not access the host through that attempt; it does **not** invalidate the earlier owner-provided terminal evidence. No alternative SSH method was attempted, and no credentials or private keys were requested.

### 3.8 What the owner evidence does not prove

Even accepting all of the above as accurate historical evidence, it does **not** establish:

- a real application-aware encrypted backup of the clinic deployment;
- PostgreSQL dump consistency under real load, or a production restore;
- Evolution session or Caddy state recovery;
- WAL archiving or PITR;
- the production backup engine being installed, configured, or scheduled;
- monitoring installation, real alert delivery, or heartbeat operation;
- current host state at the time of Phase 8.0.

---

## 4. Phase 6 assessment — backup / DR

### 4.1 Two different backup implementations must not be confused

| Implementation | Location | Status / role |
|---|---|---|
| **Repository backup engine** | `scripts/backup.sh`, `scripts/backup-verify.sh`, `scripts/restore-drill.sh` | Intended production engine. Repository-verified. Isolated testing covered PostgreSQL logical dumps, storage-volume archives, optional Evolution/Caddy data, age encryption, checksums/manifests, fail-closed scenarios under test, and isolated restore/verification. **Not yet proven with a real backup and restore of the Ubuntu-hosted clinic deployment.** |
| **Temporary Ubuntu helper** | `/usr/local/sbin/clinic-backup-create` | Owner-reported helper on Ubuntu. Performs a generic directory archive and age-encryption workflow. **It is not the production backup engine** and does not provide application-aware PostgreSQL consistency, project storage, Evolution, Caddy, or recovery validation. **Do not use this helper as the production backup engine.** |

**Do not create another backup engine.** The repository scripts remain the intended implementation, subject to review and integration.

### 4.2 Repository engine — verified capability (condensed)

- Captures `pg_dump -Fc` logical DB dump, whole `ultrasound_clinic_storage` volume, optional Evolution session volume, optional Caddy `data`/`config` volumes, `SHA256SUMS`, and `MANIFEST`. No config/secrets files. [Repository-verified]
- Staged output in `.stage-<stamp>`; checksums verified before publication; manifest moved last. Per-file `mv`, not a whole-set atomic swap; no `fsync`. [Repository-verified]
- age encryption implemented but opt-in; fail-closed only when `BACKUP_REQUIRE_ENCRYPTION=1`. Default is plaintext with a warning. Checksums cover ciphertext. [Repository-verified]
- Optional writer quiesce (`BACKUP_QUIESCE_SERVICES`, default empty); no `pg_backup_start/stop` or physical base backup. The set is not a coordinated point-in-time snapshot unless quiesce is configured. [Repository-verified]
- Fail-closed mount check is conditional (`BACKUP_REQUIRE_MOUNT`, default `0`) and uses `mountpoint -q` plus destination containment; **no UUID verification in repository code**. `mkdir -p "$OUT_DIR"` runs before the mount check. [Repository-verified]
- `backup-verify.sh` is an integrity/inventory verifier: manifest fields, artifact existence/size/SHA-256, `SHA256SUMS` re-check, encryption-state consistency, set age and orphan detection. It cannot decrypt, validate the recipient/key, check WAL/PITR, verify Caddy payload checksums, or confirm restore success. [Repository-verified]
- `restore-drill.sh` rejects `.age` input, requires a disposable `_drill` DB, uses `--single-transaction --exit-on-error`, and reconciles counts/hashes and storage files. [Repository-verified]
- No retention deletion implemented; only `BACKUP_MIN_FREE_MB` guard and 70/85/95% monitoring alerts. Proposed 7 daily / 4 weekly / 3 monthly retention is documentation only. [Repository-verified + previously documented]

### 4.3 Unresolved path mismatch — pending decision

| Source | Destination |
|---|---|
| Repository script default (`backup.sh:30`, with `cd` to repo root at `:26`) | repository-root `backups/` |
| Prior documentation (`docs/backup-restore.md`, `docs/operations.md`) | `/mnt/clinic-backups/backups` |
| Existing Ubuntu disk structure (owner terminal output) | `/mnt/clinic-backups/daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, `logs` |

**No final integration mapping has been approved.** Do not silently choose a path or modify scripts to resolve this. It is a required decision in Phase 8.2.

### 4.4 Mount safety — integration requirement

Repository scripts use conditional mount checks and do not fully verify the expected disk UUID. Future implementation review must verify:

- exact mountpoint (`/mnt/clinic-backups`);
- expected UUID (`0f21089c-c507-4903-96e5-daf637100d53`);
- filesystem type (ext4);
- destination containment (`BACKUP_DIR` under the mount);
- fail-closed behaviour when the disk is absent.

**Do not hardcode the Ubuntu-specific UUID into portable repository code without an explicit design decision.** A host-side preflight/configuration mechanism (of the kind already evidenced on the host) may be preferable; this is for a future implementation review, not a change to be made in this documentation phase.

---

## 5. Phase 7 assessment — monitoring

Most findings are unchanged from the initial Phase 8.0 assessment; the conservative deployment status is retained.

1. **Implemented:** 7 read-only checks (`backup`, `capacity`, `containers`, `cert`, `wal`, `time`, `heartbeat`), JSON emit/exit mapping, orchestrator with dedup/recovery, JSONL sink with self-rotation, heartbeat file, Telegram adapter, external heartbeat hook, structured redacting backend logs, Nginx/Caddy log redaction, opt-in `monitoring` Compose overlay, and regression scripts. No Prometheus/Grafana/alertmanager/SMTP adapter or host-wide log cap. [Repository-verified]
2. **Templates only:** all `deploy/clinic-*.service/.timer`, `monitor.env.example`, `clinic-monitor.logrotate`, and the Compose overlay (disabled by default). [Repository-verified]
3. **Local mocks only:** Telegram and heartbeat validated with Python HTTP mocks, synthetic tokens, and disposable `p72*` resources. No real provider contacted. [Repository-verified]
4. **Ubuntu configuration required:** `/etc/clinic/monitor.env` (0600, `deploy:deploy`), `/var/lib/clinic-monitor` (0700), `/opt/clinic/Clinc-V1.1` working directory, and binaries `bash`, `curl`, `docker` CLI, `mountpoint`, `openssl`, `df`, `timedatectl`. Overlay lacks `P7_WAL_DIRS`, `P7_CERT_FILES`, `P7_PATHS`, and a `/mnt/clinic-backups` bind mount. [Repository-verified]
5. **Permissions:** script invocations use `bash`, so no `+x` required; systemd hardening is present in templates; `deploy` group/docker access is **not verified**. [Repository-verified + not verified]
6. **Rotation:** choose exactly one of built-in sink rotation (default, tested) or host `logrotate` (set `P7_SINK_MAX_BYTES=0` if chosen). Docker `json-file` `10m × 5` is separate and always retained. [Repository-verified]
7. **systemd units required:** `clinic-monitor.{service,timer}` (`*:0/5`), `clinic-heartbeat-check.{service,timer}` (`*:0/10`). All uninstalled. [Repository-verified]
8. **Heartbeat provider:** open — Healthchecks.io / Cronitor / self-hosted documented only; no account or URL. [Previously documented]
9. **Telegram:** open — bot, chat ID, token, 0600 env file, HTTPS egress; `P7_ALLOW_INSECURE_TEST=0` in production. [Previously documented]
10. **Sensitive values:** token and heartbeat URL written only into 0600 curl configs via `curl -K`, never argv; logger uses default-deny key allowlist, scrubbers, UUID tokenization, phone redaction, ID hashing, and route templates; test coverage exists. Residual: plaintext at rest in 0600 env file; no live-host argv audit. [Repository-verified]
11. **Nginx/Caddy:** syntax-validated in isolation, not rolled out; requires real domain/DNS and ports 80/443 or `tls internal`; `APP_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY` must be set. [Repository-verified]
12. **Post-rollout verification:** run all checks with no `unknown`; confirm one cycle and fresh heartbeat; exactly one external ping per completed cycle and silence on failure; real test alert with no PHI/token; failure escalation and recovery; rotation; file modes; proxy log replay; regression reruns; timer/overlay status. [Repository-verified]

**Production monitoring has not been installed or activated. Real Telegram and external heartbeat delivery have not been validated. No production scheduling has been activated.**

---

## 6. B1–B9 blocker matrix (corrected)

Status summary: **0 RESOLVED; 6 PARTIALLY RESOLVED (B1, B3, B6, B7, B8, B9); 3 OPEN (B2, B4, B5).** Corrections affect B3 and B7: historical owner evidence strengthens the *infrastructure preparation* picture, but does not close either blocker.

| ID | Blocker (baseline §2) | Corrected status | Current evidence | Missing evidence | Required action | Dependencies | Risk if ignored | Owner approval | Maintenance window |
|---|---|---|---|---|---|---|---|---|---|
| B1 | "2 failing backend tests (after-hours Quick Actions timing)" | PARTIAL | Test still uses `Date.now()+30_000`, 08:00–22:00 working hours, unguarded `appointments.length > 0`; green 152/152 run reported but "did not reproduce … not fixed". [Repository-verified + previously documented] | Clock-independent test; deliberate after-hours run. | Inject fixed clock / deterministic future date; condition or remove assertion; record dated run. | B2, B4 | Release green only in business hours. | No | No |
| B2 | Work uncommitted on feature branch | **OPEN** | 13 modified + 11 untracked; no tag. [Repository-verified] | Tag, logical commits, deploy-from-tag record. | Scan first (B6), commit, merge, tag. | B6; gates B4/B8/B9 | Unreviewed mix; unreliable rollback. | **Yes** | No |
| B3 | Backup/recovery unproven | PARTIAL (corrected) | **Owner evidence:** disk, UUID mount, tiered dirs, preflight PASSED, synthetic encryption round-trip [Previously verified]; escrow [Owner-reported]. **Repo:** staged sets, verifier, drill [Repository-verified]. **No real app-aware backup/restore on Ubuntu.** [Not verified] | Real application-aware encrypted backup; production restore; WAL/PITR; installed engine and schedule; host revalidation; escrow independent check. | Phase 8.2 integration, then real backup, restore drill, and (only if approved) WAL/PITR. | B7, B8, B9; host revalidation | PHI loss; unbounded RPO; false confidence from synthetic/host-prep evidence. | **Yes** | **Yes** |
| B4 | No CI | **OPEN** | `.github/` absent. [Repository-verified] | Any workflow/CI run. | Add CI; enforce on tag. | B1, B2, B5 | Regressions reach release. | No (config); Yes (branch protection) | No |
| B5 | Backend audit + image CVE not recorded | **OPEN** | Baseline says backend audit "Not recorded"; no CVE artifact. [Repository-verified] | Audit output; scanner version; 3-image results. | Run/record audit and scan; enforce in CI. | B4; scanner install approval | Unpatched runtime/image CVEs. | Partly | No |
| B6 | No full secret history scan | PARTIAL | `.env` ignored/untracked; targeted history check found token-shaped values in `.env.example` [Previously documented]; rotation status open. | Full all-branch scan; triage; rotation record. | Full scan before B2 commit/tag. | B2 | Historic credentials remain valid. | No (scan); Yes (rotation) | No |
| B7 | Target environment not defined/verified | PARTIAL (corrected) | **Owner evidence:** Ubuntu disk/mount/dirs/preflight/encryption now historically evidenced [Previously verified]. **Still:** domain and deploy owner blank in baseline; no current independent host revalidation; no deployment. [Repository-verified + Not verified] | Current host inventory; domain/TLS mode; named owner; disk revalidation. | Revalidate host read-only; record owner decisions. | Prerequisite for B3/B8/B9 | Stale host state assumed current; wrong platform assumptions. | **Yes** | Scheduled access only |
| B8 | No real deployment verification, monitoring, alerting | PARTIAL | Repo implementation exists; all validation isolated/local-mock; no rollout. [Repository-verified] | Production health, sink events, log shipping, real checks. | Deploy from tag, provision state, roll out after approval, Phase 12 exercise. | B7, B9, B3, B2 | Failures invisible. | **Yes** | **Yes** |
| B9 | Alert channel and scheduler not approved | PARTIAL | Telegram approved per later reports; adapter/hook local-mock only; no bot/chat/token/provider/scheduler. [Previously documented + Repository-verified] | Written approval artifact; real credentials; provider URL; installed timer; real test. | Record approval, create accounts, populate 0600 env, install after approval. | B7, B8, B3 | No external notification. | **Yes** | **Yes** |

---

## 7. Ubuntu target readiness (corrected)

**Do not describe every Ubuntu setup item as unknown.** The following split applies:

| Item | Classification |
|---|---|
| Backup disk identity, partition, filesystem, label, UUID, mountpoint | **Previously verified** (owner terminal output) |
| `/etc/fstab` UUID entry, `findmnt` rw mount, fstab backup copy | **Previously verified** (owner terminal output) |
| Tiered backup directories and reported `root:root` `700` modes | **Previously verified** (owner terminal output) |
| Preflight script existence and `BACKUP PREFLIGHT PASSED` output | **Previously verified** (owner terminal output); not revalidated in 8.0 |
| Synthetic cross-platform encryption round-trip; public recipient | **Previously verified** (synthetic data) |
| Private-key escrow on USB flash drive | **Owner-reported**; independent verification pending |
| SMART attributes (PASSED, no bad sectors reported, ~34 °C, ~64,814 h) | **Previously verified** (owner terminal output); no long-test output |
| OS/kernel version, CPU/RAM, current disk capacity, current mount/permissions, Docker/Compose versions, Git/`age` availability, project directory and Git state, systemd unit/timer status, container names/status | **Not verified** in Phase 8.0 |
| Domain/DNS, TLS mode, deploy owner, maintenance window | **Pending decision** |
| Agent SSH access | **Unverified/denied** this phase; does not invalidate owner evidence |

No read-only inventory commands were executed by the agent. Revalidation is a Phase 8.2 activity, to be performed by an authorized operator using strictly read-only commands, without reading `.env`, secrets, private keys, patient records, or databases.

---

## 8. Deployment architecture assessment

The architecture assessment is unchanged in substance: base services `db` → `migrate` → `backend` → `web`, mandatory internal-only `evolution`, optional `caddy` (public 80/443) and `clinic-monitor` (`monitoring` profile); named volumes `ultrasound_clinic_db_data`, `ultrasound_clinic_storage`, `ultrasound_clinic_evolution_instances`, plus `caddy_data`/`caddy_config` and `p7_monitor_state`; single flat `clinic_net`; loopback binds for `db` (`127.0.0.1:55432`) and `web` (`127.0.0.1:8080`), no host ports for `backend`/`evolution`; Compose-enforced `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `EVOLUTION_API_KEY` (plus `CLINIC_DOMAIN` in TLS overlay); no `env_file:`/`secrets:` directives; 7 Prisma migrations via one-shot `migrate`; no committed WAL settings; no CPU/memory limits and no documented vCPU/RAM minimum. [Repository-verified]

Differences relevant to this correction:

- The manual Ubuntu installation paths in monitoring templates (`/opt/clinic/Clinc-V1.1`) differ from runbook assumptions (`/opt/clinic`) — reconcile before rollout. [Repository-verified]
- The monitoring overlay has no bind mount for `/mnt/clinic-backups` and no `P7_WAL_DIRS`/`P7_CERT_FILES`/`P7_PATHS`; the host-systemd monitoring path is currently the workable design. [Repository-verified]
- The repository has no committed WAL/PITR overlay; the prepared PITR artifacts are outside the repo and are historical. [Repository-verified + previously documented]

**Windows Docker Desktop is a separate environment** from the Ubuntu target. The protected containers `ultrasound-clinic-backend-1`, `ultrasound-clinic-db-1`, `ultrasound-clinic-evolution-1`, and `ultrasound-clinic-web-1` belong to that separate environment; none was inspected, entered, restarted, stopped, or modified. Their existence says nothing about Ubuntu deployment status.

---

## 9. Risk register (corrected)

Severity: C Critical / H High / M Medium / L Low. Likelihood: H High / M Medium / L Low.

| # | Risk | Sev | Lik | Mitigation | Verification | Owner approval |
|---|---|---|---|---|---|---|
| R1 | No real application-aware encrypted backup on Ubuntu | C | H | Phase 8.2 integration, then first controlled real backup | Manifest + verifier pass on host | Yes |
| R2 | **Ageing internal SATA HDD as sole recovery source** (~64,814 power-on hours; PASSED snapshot only; no long-test output) | C | M | SMART long test and read scan; additional independent copy; replacement/second-copy decision | Long-test log; capacity trend; second-copy evidence | Yes |
| R3 | Wrong or lost mount — current host state not revalidated despite historical evidence | H | M | Revalidate mount, UUID, ext4, dirs, preflight in 8.2 | `findmnt`, `blkid`, preflight rerun (read-only) | No for inspection |
| R4 | Database inconsistency — logical dump, no quiesce by default | H | H | Set quiesce in window; record drift | Manifest timestamps; smoke test | Yes |
| R5 | Missing encryption key / bad recipient | C | M | Require encryption; independent escrow recovery test; record recipient fingerprint | Isolated decrypt test; escrow attestation | Yes |
| R6 | Mount safety in repo code — `mountpoint -q` only, `mkdir` before check, no UUID pinning | C | M | Host-side preflight/config preferred; do not hardcode UUID without design decision | Negative test with wrong UUID | Yes (for changes) |
| R7 | WAL archive failure / no PITR | H | H | Design and approve overlay; mount+UUID-checked command; monitor archiver; no RPO claim until isolated PITR | `pg_stat_archiver`, isolated PITR | **Yes** |
| R8 | DNS/TLS problems — domain undecided | H | M | Decide domain/TLS mode; pre-check DNS/ports | DNS/ACME check | Yes |
| R9 | Telegram configuration failure | M | H | Real bot/chat, 0600 env, egress check, insecure flag off | One controlled test alert | **Yes** |
| R10 | Monitoring false positives from unconfigured checks | M | H | Fill all env keys; disable unconfigured checks; tune thresholds | No `unknown` results | No |
| R11 | Heartbeat provider failure / silence semantics | H | M | Choose provider; independent checker; test silence | Single ping per cycle | Yes |
| R12 | Evolution session recovery unproven | H | M | Volume backed up; owner-supervised re-pair | Re-pair test | Yes |
| R13 | Caddy state recovery | M | M | Inventory volumes; reissue certs if needed | Volume/cert check | No |
| R14 | Port conflicts | M | M | Read-only port survey before deploy | `ss -ltnp` | No |
| R15 | Storage exhaustion — unbounded backup/WAL growth | H | M | MIN_FREE_MB, 70/85/95 alerts, measure growth, retention decision | `df`, dry-run report | Yes (retention) |
| R16 | Permission mismatches / path mismatch (`/opt/clinic` vs `/opt/clinic/Clinc-V1.1`; destination mapping) | H | M | Align paths and modes; host preflight alignment | `stat`, dry run | Yes |
| R17 | Rollback failure — no tag | C | H | Tag before deploy; documented rollback preserving volumes | Tag verification | Yes |
| R18 | RTO/RPO uncertainty — synthetic drill only | H | H | Real-host isolated drill; publish only measured values | Timed drill report | Yes |
| R19 | Temporary Ubuntu helper mistaken for production engine | H | M | Explicitly prohibit; use repo scripts only | Documented decision | No |
| R20 | Historical owner evidence treated as current state | M | M | Revalidate read-only in 8.2 before reliance | Fresh inventory | No |

---

## 10. Correction log

| # | Inaccurate or incomplete statement in the original proposed report | Correction made |
|---|---|---|
| 1 | Backup disk and mount described as completely unknown; UUID described as "absent from repo" without host context. | Added owner-provided disk details (internal SATA `/dev/sda1`, ST3500312CS, 500 GB, ext4, label, UUID, mount) as **previously verified**; distinguished from repository absence. |
| 2 | 500 GB HDD referred to in historical terms as external USB. | Corrected terminology everywhere: internal SATA HDD = local backup storage; USB flash drive = age private-key escrow only. |
| 3 | Persistent `/etc/fstab` mount, `findmnt` rw result, and `/etc/fstab.before-clinic-backups` not represented. | Added as previously verified owner evidence; current state still not independently revalidated. |
| 4 | Tiered directories (`daily`, `weekly`, `monthly`, `wal-archive`, `manifests`, `quarantine`, `logs`) described as absent. | Added as previously created on host; repo flat-path mismatch documented as pending decision rather than "absent". |
| 5 | Preflight described as absent / only an out-of-repo unnamed wrapper. | Added `/usr/local/sbin/clinic-backup-preflight` and `BACKUP PREFLIGHT PASSED` output with checks, classified as previously verified owner output, not revalidated in 8.0. |
| 6 | Encryption interoperability implied unproven. | Added synthetic encrypt→transfer→decrypt→match→cleanup sequence and public recipient; classified as previously verified with synthetic data only; production backup/recovery still not proven. |
| 7 | Private-key escrow described as unknown/pending without owner report. | Recorded owner-reported USB flash drive escrow; independent hash/recovery verification pending; no key material exposed. |
| 8 | SMART described generically; risk note only. | Added PASSED, no sectors reported, ~34 °C, ~64,814 power-on hours; explicitly no long-test claim; strengthened ageing-disk/second-copy recommendation. |
| 9 | SSH denial presented as invalidating host evidence. | Replaced with required wording: agent access unverified/denied; owner outputs remain historical evidence; current state not revalidated. No alternative access attempted. |
| 10 | Two backup implementations not distinguished. | Explicitly separated repository engine from `/usr/local/sbin/clinic-backup-create`; stated helper must not be used as production engine; no second engine to be created. |
| 11 | Path mismatch not framed as a decision. | Documented repo `backups/` vs `/mnt/clinic-backups/backups` vs host tiered directories as an unresolved Phase 8.2 decision. |
| 12 | Gate plan did not reflect completed disk preparation. | Replaced with Phase 8.0–8.6 sequence starting from repository stabilization, then backup integration/revalidation. |
| 13 | Report existed only in chat, not in repository. | Created `docs/PRODUCTION_READINESS_PHASE8_0.md` as the sole file change, per this documentation task. |

---

## 11. Remaining blockers (short list)

1. **B2 / no release artifact** — work uncommitted; no tag; rollback unreliable. *(Requires approval)*
2. **B4 / B5** — no CI; no backend `npm audit --omit=dev` record; no image CVE scan.
3. **B6** — no full git-history secret scan or rotation triage.
4. **B1** — after-hours Quick Actions timing dependency still in test code.
5. **Backup integration** — no approved destination path mapping; repository engine not integrated with prepared disk; no second backup engine to be created. *(Pending decision)*
6. **No real application-aware encrypted backup or restore on Ubuntu** — owner evidence covers infrastructure and synthetic encryption only.
7. **No WAL/PITR** on target; RPO unbounded. *(Requires design and explicit approval)*
8. **Monitoring not installed/activated** — no real Telegram/heartbeat delivery, no scheduler. *(Requires approval)*
9. **B7 environment decisions** — domain/DNS, TLS mode, deploy owner, maintenance window unresolved. *(Pending decision)*
10. **Host revalidation** — current disk/mount/preflight state not independently rechecked; escrow recovery not independently verified.
11. **Ageing HDD** — ~64,814 power-on hours; no long-test output; no independent second copy. *(Requires decision)*

---

## 12. Revised phase plan (8.0 → 8.6)

No phase beyond 8.0 is authorized by this task. Each later phase requires its own explicit approval.

### Phase 8.0 — Assessment correction *(this document)*
- Correct historical/owner evidence and classify it explicitly.
- Distinguish owner-provided terminal evidence from current verification.
- Preserve `backup.patch`, legacy dump, and all uncommitted work.
- Preserve the **NO-GO** deployment decision.
- **Status: complete.**

### Phase 8.1 — Repository stabilization *(repository-only; separate approval)*
- Preserve uncommitted work; investigate B1 timing issue; complete B6 secret scan and triage; add CI (B4); run backend dependency/security audit and container image vulnerability assessment (B5); preserve `backup.patch`.
- Class A only. No host access.

### Phase 8.2 — Backup integration *(requires approval)*
- Revalidate the existing backup disk, mount, directories, and preflight using read-only commands.
- Review repository backup scripts; resolve destination path mapping; verify UUID/mount safety and fail-closed behaviour.
- Integrate the existing engine with the prepared disk; do **not** create another backup engine; do **not** use `/usr/local/sbin/clinic-backup-create` as the production engine.
- Perform controlled synthetic tests before production data is involved.
- Independent escrow recovery verification and SMART long test / second-copy decision.

### Phase 8.3 — Deployment preparation *(requires approval)*
- Confirm target architecture, DNS/domain, and TLS mode; review environment-variable requirements without exposing secret values; review ports, firewall, resource requirements, and rollback plan.

### Phase 8.4 — Controlled deployment *(separate explicit owner approval)*
- Deploy from the reviewed tag; migrations; key rotation; preserve Evolution session volume; health verification. Class D.

### Phase 8.5 — Recovery validation *(requires approval)*
- Real encrypted backup; decryption verification; application-aware restore; PostgreSQL recovery; storage and Evolution/Caddy recovery where applicable; WAL/PITR only if explicitly designed and approved; measure RTO/RPO.

### Phase 8.6 — Monitoring rollout *(requires approval)*
- Install only after validation and approval; verify host monitoring, real Telegram and heartbeat integrations with authorized configuration; verify alert deduplication and recovery notifications; activate scheduling only after approval.

---

## 13. Approval boundaries

| Class | Definition | Phase 8.0 handling |
|---|---|---|
| A — Repository-only | Code/docs changes with no production access | Only this report changed; no code/config changed |
| B — Read-only infrastructure inspection | Inspect host without state change | No SSH/inspection performed; deferred to 8.2 |
| C — Reversible operational changes | Config files, non-destructive services | Not performed |
| D — High-impact operations | Deployment, migrations, credential rotation, external notifications, scheduling, WAL/PITR, retention deletion, production restore | Not performed; requires explicit owner approval immediately before any execution |

---

## 14. Genuine open decisions (blocking)

1. Backup destination mapping: repository `backups/` vs `/mnt/clinic-backups/backups` vs host tiered directories.
2. Domain/DNS and TLS mode (public ACME vs `tls internal`).
3. Named deploy owner/operator and maintenance window.
4. Additional independent backup copy and/or HDD replacement strategy, including SMART long-test execution.
5. Independent private-key escrow recovery verification method.
6. Heartbeat provider and Telegram bot/chat ownership (Phase 8.6).

---

## 15. Final status

# **NO-GO for production deployment.**

The corrected owner evidence materially improves the **infrastructure preparation** picture — internal SATA disk, UUID mount, tiered directories, preflight success, and synthetic encryption interoperability are historically evidenced. It does **not** establish production deployment, application-aware backup/restore, WAL/PITR, monitoring, scheduling, or real alert delivery. Combined with B2, B4, B5, B6 and B1 remaining open, the deployment decision is unchanged.

**Stop condition:** Phase 8.0 is complete. Do not start Phase 8.1. Do not execute any operational command. Do not commit or push. Recommended next step: request separate approval for repository-only Phase 8.1.
