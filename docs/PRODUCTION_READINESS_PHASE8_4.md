# Phase 8.4 — GitHub CI, Branch Audit & Main Merge Readiness

**Project:** Ultrasound Clinic Management System (`Clinc-V1.1`)
**Branch under audit:** `feature/clinic-quick-actions`
**Target branch:** `main`
**HEAD at audit:** `0d79b7d98962b204806e3e2cf2caf1ac381f1026`
**Date:** 2026-11-20
**Phase type:** Repository-level audit only. **Not a deployment phase.**

> No merge, push, commit, staging, branch deletion, history rewrite, production SSH/Docker/database access, real backup/restore, credential rotation, or operational activation was performed. Existing uncommitted work was preserved.

---

## 1. Executive summary

The committed branch is technically mergeable into `main`: it is 18 commits ahead, 0 behind, `main` is its ancestor, and `git merge-tree` produced a clean result. Locally executed equivalents of the CI checks all passed: typecheck, backend and frontend builds, 42/42 frontend tests, 156/156 backend tests against an isolated synthetic PostgreSQL database, root/web production audits with 0 vulnerabilities, and the documented four-High backend advisory classifier (warning, exit 0). The Phase 8.3.1 isolated backup suite passed **16/16 on Linux**; the claimed result was independently reproduced.

However, the branch is **not ready to merge in its current state** because the audited repository content is not the content that would be merged:

1. **All CI configuration, both audit scripts, the shared backup library, the 16-test isolated backup suite, the new regression tests, monitoring templates and Phase 7/8 reports are untracked.** A merge of `HEAD` would omit them entirely. This makes the mergeable state uncertain.
2. A historical credential-shaped value in `.env.example` remains in six reachable commits; it is classified `ACTIONABLE / INCONCLUSIVE` by the preceding phase and has no owner validation or rotation evidence.
3. A committed 439 KB UTF-16 patch artifact (`backup.patch`) contains `EVOLUTION_API_KEY` assignments and is silently bypassed by the current secret scanner's NUL guard.
4. Four High dependency advisories remain; they are owner-accepted only under a documented temporary exception and require explicit owner acceptance before merge.
5. GitHub Actions has not executed; no CI pass can be claimed.

All 13 known production/operational blockers remain open. **Production Decision: NO-GO** is unchanged.

---

## 2. Git branch and commit information

| Item | Evidence |
|---|---|
| Current branch | `feature/clinic-quick-actions` |
| HEAD | `0d79b7d98962b204806e3e2cf2caf1ac381f1026` — `quick actions: add weekly revenue panel, weekly availability panel, and weekly appointments panel` (2026-11-20T18:34:21+02:00) |
| Local `main` | `1e6d36d20d2a9c43097e0ef37f0163bf10b55bf8` |
| Remote `origin/main` | `1e6d36d20d2a9c43097e0ef37f0163bf10b55bf8` |
| Remote `origin/feature/clinic-quick-actions` | `0d79b7d98962b204806e3e2cf2caf1ac381f1026` (matches local HEAD) |
| Remote verification | `git ls-remote --heads origin` returned `main`, the feature branch and `cleanup/remove-email-meta`; local and remote refs agree. No fetch was needed to establish this. |
| Ahead / behind | `git rev-list --left-right --count main...HEAD` → `0 18` (18 ahead, 0 behind) |
| Merge base | `1e6d36d20d2a9c43097e0ef37f0163bf10b55bf8` (equal to `main`) |
| Ancestry | `git merge-base --is-ancestor main HEAD` → exit 0 |
| Other local branch | `cleanup/remove-email-meta` @ `0df148d`; not part of this audit |

---

## 3. Working tree status

| Category | Count | Detail |
|---|---:|---|
| Modified tracked files | 20 | `backend/Dockerfile`, `backend/src/lib/logger.ts`, `backend/tests/quick-actions-appointments.test.ts`, `deploy/Caddyfile`, `deploy/clinic-heartbeat-check.service`, `deploy/clinic-monitor.service`, `docker-compose.monitoring.yml`, 5 docs files, 7 script files, `web/nginx.conf` |
| Untracked files | 21 | `.github/workflows/ci.yml`; 4 backend test files; `deploy/clinic-monitor.logrotate`; `deploy/monitor.env.example`; 6 Phase 7/8 reports; `scripts/backup-common.sh`; `scripts/dependency-audit.mjs`; `scripts/p7-deliver-telegram.sh`; `scripts/p7-heartbeat-hook.sh`; `scripts/p72-nginx-privacy-test.sh`; `scripts/p72-phase7-regression.sh`; `scripts/p831-backup-isolated-test.sh`; `scripts/secret-scan.mjs` |
| Staged changes | 0 | `git diff --cached --stat` empty; `git diff --cached --check` exit 0 |
| Stashes | 0 | `git stash list` empty |

No untracked file was discarded, staged or committed. `git diff --check` on the unstaged diff returned exit 0 (only CRLF/LF conversion warnings from `core.autocrlf` on Windows; `.gitattributes` declares LF for these paths).

---

## 4. Changed-file audit

### 4.1 Committed diff (`main...HEAD`)

- **130 files changed, 16,642 insertions, 1,777 deletions.**
- Scope includes: Quick Actions backend modules and tests, appointments/financial/payment/report/settings/users route changes, Prisma migration `20261113135000_remove_email_delivery`, frontend Quick Actions pages/components/hooks/tests, Phase 3–8 documentation, backup/monitoring scripts and templates, and a committed `backup.patch` artifact.
- The full changed-file list was reviewed via `git diff --name-only main...HEAD`; it is not limited to the latest commit.

### 4.2 Uncommitted diff (working tree vs `HEAD`)

- **20 modified tracked files, 868 insertions, 595 deletions** (unstaged).
- Principal corrections: `scripts/backup-common.sh`-driven fail-closed storage validation in `backup.sh`, `backup-verify.sh`, `p7-check-backup.sh`; monitor service account changes; tier-based Compose monitoring configuration; nginx/Caddy log redaction; UUID-safe log scrubbing; after-hours deterministic Quick Actions appointment fixture.
- **21 untracked files** are material to the audit and are listed in §3.

### 4.3 Notable artifacts

- `backup.patch` is a **439,292-byte UTF-16LE unified diff** committed on this branch. It contains `EVOLUTION_API_KEY` assignment lines (values not reproduced here). It is not a source file and should be classified/removed by the owner before merge.
- `backend/Dockerfile` removes `@prisma/config`, `deepmerge-ts`, `effect` and other CLI-only packages from the runtime image; no runtime source imports them. This does not clear the advisories.

---

## 5. Merge conflict assessment

| Check | Result |
|---|---|
| `git merge-tree --write-tree main HEAD` | Exit 0; tree `cc20337969cbe1c616ee34d4329d929a962a2a95`. **No committed merge conflicts.** |
| Overlapping changes | `main` is the merge base, so all 18 commits are linear ahead of it. No conflicting file was identified. |
| Schema / migrations | One migration added on the branch (`20261113135000_remove_email_delivery`); applied cleanly to an empty synthetic database. No competing migration exists on `main`. |
| Package / lockfiles | `npm ci --dry-run --ignore-scripts` succeeded in root, `backend/` and `web/`; package.json and lockfiles are consistent. |
| Compose compatibility | `docker compose -f docker-compose.yml config --quiet` and the base + `docker-compose.monitoring.yml` combination both returned exit 0. Monitoring remains behind the opt-in `monitoring` profile. |
| Environment variables | New `P7_*` names and `P7_BACKUP_ROOT`/`UUID`/`FSTYPE` replace legacy `P7_BACKUP_DIR`/`P7_BACKUP_MOUNT`. No production value is committed; `deploy/monitor.env.example` keeps secrets blank. |
| Docs consistency | Phase 7.2/8.0/8.3.1 supersession notes correct earlier “external USB HDD” wording; active docs describe the internal SATA HDD as local backup storage and a separate USB flash drive as age-key escrow only. |
| Uncommitted work | The `merge-tree` check covers committed `HEAD` only. The 20 modified and 21 untracked files were **not** part of that check. They are the reason the mergeable state is uncertain. |

No conflict resolution was attempted and no side's changes were discarded.

---

## 6. CI configuration review

`.github/workflows/ci.yml` was reviewed. It exists **only in the working tree (untracked)**; it is not present in `HEAD`.

| Requirement | Finding |
|---|---|
| Least privilege | `permissions: contents: read` at workflow level; no `pull_request_target`; no write scopes. |
| Pinned actions | `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0) are pinned to commit SHAs. |
| Static checks | `static` job runs secret scan, root audit, frontend production audit, root typecheck, root build and frontend tests. Node pinned to `22.14.0`; all three lockfiles used for npm cache. |
| Backend tests | `backend-tests` job uses `postgres:16.4-alpine` with `clinic`/`clinic`/`clinic_test`, health check via `pg_isready`, synthetic JWT/API env values, `prisma generate`, then `prisma migrate deploy` against `DATABASE_URL=.../clinic_test`. |
| Dependency audit | `dependency-audit` job captures `npm audit --omit=dev --json` and classifies it with `scripts/dependency-audit.mjs`. The classifier hard-fails on any package set, count or severity other than the exact documented four-High Prisma cluster; that cluster emits a warning and exits 0. |
| Secret scanning | Included as `node scripts/secret-scan.mjs`, but that script is untracked. |
| Production secrets | None required or referenced; all CI values are synthetic. |
| Deployment | No deploy job, no SSH, no cloud credentials, no production Docker context, no `pull_request_target`. No workflow step can deploy to production. |

Statically the workflow is coherent and safe. It has **not** been executed by GitHub Actions.

---

## 7. CI execution results

GitHub Actions cannot be executed from this environment; **no CI pass is claimed**. Locally available CI-equivalent commands were run and results are recorded in §8 and §9.

Required owner steps to trigger and inspect real CI:

1. Include `.github/workflows/ci.yml`, `scripts/secret-scan.mjs`, `scripts/dependency-audit.mjs` and all other intended Phase 7/8 files in an owner-approved commit (this phase did not stage or commit anything).
2. Push the branch (or open/update a pull request to `main`) with those files included.
3. Ensure Actions are enabled for the repository. If this is the first workflow run or the author is not trusted, approve the run when GitHub requests it.
4. Trigger `push`, `pull_request`, or `workflow_dispatch` manually after the workflow exists on GitHub.
5. Wait for the three jobs: `static`, `backend-tests`, `dependency-audit`.
6. Confirm each job's log: secret scan reports 0 actionable candidates; root/web audits report 0 vulnerabilities; typecheck/build/frontend tests pass; backend tests pass against the synthetic `clinic_test` service; dependency audit emits the documented four-High warning and exits 0.
7. Only then consider making these checks required in branch protection.

---

## 8. Frontend/backend test results

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` (root → backend + web) | **PASS** | `tsc --noEmit` / `tsc -b --pretty false`, exit 0. |
| `npm run build` (backend + web) | **PASS** | Backend `tsc -p`; web `tsc -b && vite build`, 1,782 modules, exit 0. |
| Frontend tests `npm --prefix web run test:run -- --reporter=dot` | **PASS** | 7 files, **42/42 tests passed**, exit 0. Includes Quick Actions page/panel, auth guards, appointments/finance, patient management, reports/print and accessibility tests. |
| Backend tests `npm --prefix backend test` | **PASS** | **156/156 passed, 0 failed, 0 skipped**, exit 0. Ran with an isolated temporary PostgreSQL 16 container (`clinic_test`, synthetic credentials, port 55433) after `prisma generate` and `prisma migrate deploy`. Existing local containers were not touched; the temporary container was removed afterwards. |
| Lint | **NOT RUN** | No lint script is defined in root/backend/web `package.json`; no lint configuration was added in this phase. |
| Secret scan (working tree) | **PASS** | 2 candidates, both exact allowlisted fixtures, 0 actionable, exit 0. |
| Secret scan (`--history`) | **FAIL** | 8 candidates: 2 allowlisted fixtures, 6 actionable historical findings (details in §10), exit 1. |
| Root/web production audits | **PASS** | `npm audit --omit=dev --audit-level=high` → 0 vulnerabilities in both. |
| Backend audit classifier | **PASS with warning** | Exactly 4 known High advisories; documented exception accepted, exit 0. |
| Phase 8.3.1 isolated backup suite (Linux/WSL Ubuntu) | **PASS** | **16 passed, 0 failed, 16 total** — independently reproduced. |
| Phase 8.3.1 isolated backup suite (Windows Git Bash) | **14/16** | Tests 8 and 12 failed only because Git Bash `sha256sum` writes `hash *file` (binary marker) while the verifier expects Linux text-format `hash  file`. On the target Ubuntu platform the suite is 16/16; no production code change was made for this Windows-only artifact. |

### Quick Actions regression review

- All Quick Actions routes apply `authenticate` plus `requirePermission` (`APPOINTMENTS_READ`, `QUEUE_READ`, `PATIENTS_READ`); no unauthenticated route was introduced.
- `scopedDoctorId()` forces a `DOCTOR` caller to their own ID; administrators/receptionists may select an active doctor or all doctors. Patient identities are returned only when `hasPermission(me, 'PATIENTS_READ')`.
- Added deterministic timing tests use injected `now` and fixed clinic-local dates; they cover after-hours empty grids, slot anchoring, the exact-`now` boundary, occupied-slot conflicts, Saturday-start week ranges and DST day/month boundaries. Backend suite includes these and the 939-line appointments characterization suite.
- Existing appointment, authorization/IDOR, report, patient and finance tests all passed in the 156-test backend run and the 42-test frontend run. No real patient data was used.

---

## 9. Backup regression review

Reviewed `scripts/backup-common.sh`, `backup.sh`, `backup-verify.sh`, `p7-check-backup.sh`, `scripts/p831-backup-isolated-test.sh`, monitoring templates and Phase 7.2/8.0/8.3.1 documentation.

| Requirement | Finding |
|---|---|
| `backup_die()` defined and used | **PASS.** Defined in `backup-common.sh`; producer, verifier and validator call it. Isolated tests 6, 7 and 16 confirm precise fatal messages with no undefined-command errors. |
| Mountpoint validation fails closed | **PASS.** `backup_check_storage()` requires `mountpoint -q`, `findmnt`, UUID, filesystem, required directories, containment and writability; test 2 confirms missing mount is rejected. |
| UUID matches intended disk | **PASS.** Expected `0f21089c-c507-4903-96e5-daf637100d53`; tests 3 and 14 reject a wrong UUID in producer and monitor. |
| Filesystem must be ext4 | **PASS.** Test 4 rejects `xfs`. |
| Required directories validated | **PASS.** `daily weekly monthly wal-archive manifests quarantine logs` all required before any write. |
| Age encryption mandatory | **PASS.** `BACKUP_AGE_RECIPIENT` required, recipient prefix checked, `age` binary required, `BACKUP_REQUIRE_ENCRYPTION` cannot be disabled; tests 6 and 7. |
| Tier-based output structure | **PASS.** `<root>/<tier>/clinic-<tier>-<STAMP>[-<label>]/`; test 12 discovers daily/weekly/monthly sets. |
| Manifest and SHA256SUMS consistency | **PASS.** Checksums computed before publish, verified, manifest published last; verifier checks declared artifacts, SHA-256, sizes, orphan artifacts and flat-layout leftovers; tests 8–11. |
| Verification supports actual layout | **PASS.** Linux suite 16/16; no real dump, decrypt or restore was performed. |
| Monitoring validates real mount/UUID/filesystem | **PASS.** `p7-check-backup.sh` calls the shared validator; tests 13 and 14 confirm critical status on absent mount/invalid UUID. |
| No stale USB-backup assumptions | **PASS in active files.** Supersession notes correct historical wording; USB flash drive is key escrow only. |
| No prior backup functionality removed | **PASS.** Quiesce, disk precheck, Evolution/Caddy archives, optional rclone copy/check and restore-drill hooks remain. |
| Real backup/restore | **NOT PERFORMED.** No real backup, encryption/decryption drill or restore was executed in this phase. |

One repository-level inconsistency was corrected during Phase 8.4: `deploy/clinic-monitor.logrotate` still used `su deploy deploy` / `create 0640 deploy deploy` although no `deploy` account exists. It now uses `root:root` and remains an inactive, not-installed template.

---

## 10. Security and secret-scanning findings

- **Current working tree:** `node scripts/secret-scan.mjs` found 2 candidates, both exact allowlisted fixtures in `backend/tests/p72-http-422.test.ts` and `backend/tests/phase7-route-redaction.test.ts`; 0 actionable, exit 0. No credential values are reproduced here.
- **Fixture allowlist:** two entries keyed by `rule | exact file path | redacted full-value fingerprint`. Marker words such as “test” are not an allowlist signal, so a synthetic fixture cannot suppress a real credential with a different value or path.
- **History:** `node scripts/secret-scan.mjs --history` found 6 actionable candidates, all the same redacted fingerprint (`len=40`, sha256 prefix `47e7959a1b54`) in `.env.example` at commits `71cf8a79`, `8be0930b`, `925e2cd9`, `ccd35ff5`, `43c96191` and `ebcd2a42`. Phase 8.2 classified this `ACTIONABLE / INCONCLUSIVE`; no owner validation or rotation evidence is available. The current tree no longer contains the candidate.
- **UTF-16 bypass:** `scripts/secret-scan.mjs` skips any file whose decoded text contains NUL. The committed `backup.patch` is UTF-16LE and therefore bypasses the scan. It contains `EVOLUTION_API_KEY` assignment lines (three distinct values; values not printed). No `sk_live_`, GitHub, Slack, Google or private-key pattern was found after manual UTF-16 decoding, but the values were not classified as real or synthetic. Owner review/removal of the artifact and scanner hardening for UTF-16 are required.
- **Log redaction:** UUID tokenisation in `backend/src/lib/logger.ts` protects correlation IDs from the phone scrubber; nginx and Caddy changes are logging-only. Existing route-redaction, scrubber and HTTP 422 regression tests passed.
- **Secret exposure:** No `.env` value, private key or detected credential was read, printed or copied into this report.

---

## 11. Dependency audit results

- `node scripts/dependency-audit.mjs /tmp/p84-backend-audit.json` (from `npm audit --omit=dev --json` in `backend/`) → exit 0 with the documented warning: exactly 4 High advisories, no unexpected findings.
- Exact packages (per `docs/PRODUCTION_READINESS_PHASE8_1.md` and local audit):
  - `prisma` 6.18.0 — High, direct devDependency / optional peer pulled into the production tree.
  - `@prisma/config` 6.18.0 — High, transitive via Prisma CLI.
  - `deepmerge-ts` 7.1.5 — High, transitive via `@prisma/config`.
  - `effect` 3.18.4 — High, transitive via Prisma CLI.
- No 6.x patch exists; remediation is a Prisma 7 breaking major upgrade, explicitly **not** performed here. Removing `effect` from the runtime Docker image reduces runtime surface but does not clear any advisory.
- Root and web `--omit=dev --audit-level=high` audits returned 0 vulnerabilities. Frontend dev-tooling advisories documented in `PRODUCTION_READINESS_DEPENDENCY_REMEDIATION.md` remain unpatched upstream and were not changed.
- The classifier is fail-closed: any added/removed package, changed count or unexpected severity fails the job. No advisory was suppressed, downgraded or misclassified in this phase.

---

## 12. Remaining blockers

### 12.1 Merge blockers (must be resolved before merge)

1. **Untracked merge-critical files.** Commit/push is forbidden in this phase, so `.github/workflows/ci.yml`, `scripts/secret-scan.mjs`, `scripts/dependency-audit.mjs`, `scripts/backup-common.sh`, `scripts/p831-backup-isolated-test.sh`, the new backend/web regression tests, monitoring templates and Phase 7/8 reports remain untracked. Merging `HEAD` now would omit them. The owner must include or explicitly exclude them.
2. **Historical secret candidate unresolved.** Six commits contain a credential-shaped `.env.example` value classified `ACTIONABLE / INCONCLUSIVE`. Owner must validate whether it was ever live and rotate if so.
3. **UTF-16 scanning gap and `backup.patch`.** The committed 439 KB patch artifact bypasses the secret scanner and contains `EVOLUTION_API_KEY` lines. Owner must classify/remove it and harden the scanner for UTF-16 inputs.
4. **Four High advisories remain.** They are accepted only under a documented temporary exception; explicit owner acceptance is required before merge, plus a separately validated Prisma 7 migration afterwards.
5. **GitHub Actions has not run.** CI success is unverified; owner must complete §7 steps and inspect logs.

### 12.2 Production blockers (unchanged — NO-GO)

1. Corrected repository backup scripts have not been deployed to Ubuntu.
2. `/opt/clinic` was reported missing on the host.
3. Backup storage is root-owned with `0700` permissions.
4. No dedicated backup execution account has been approved.
5. Age private-key recovery from USB escrow has not been independently verified.
6. A real synthetic encryption/decryption/restore drill has not been completed.
7. GitHub Actions has not yet been confirmed successful.
8. Four High dependency advisories remain.
9. Monitoring has not been deployed or tested with real notifications.
10. `rclone` is absent.
11. WAL/PITR is disabled.
12. No approved automatic backup schedule or retention policy is active.
13. The actual Ubuntu host reports 26.04.1, while some older documentation assumes 24.04.

None of these was marked resolved in Phase 8.4. Merge readiness is not production readiness.

---

## 13. Files changed during Phase 8.4

| File | Change |
|---|---|
| `deploy/clinic-monitor.logrotate` | Corrected stale `deploy:deploy` ownership to `root:root`, with a comment recording the Phase 8.3.1 account finding. Template remains inactive/not installed. |
| `docs/PRODUCTION_READINESS_PHASE8_4.md` | Created (this report). |

No other repository file was modified by this phase. No commit, staging operation, Git history rewrite, branch operation, or push was performed. A temporary Docker container `p84-audit-postgres` was created solely for synthetic backend tests and removed afterwards; existing containers were untouched. Generated `dist/` and Prisma client files are ignored build artifacts.

---

## 14. Commands executed

Representative commands and verified outcomes:

```text
git status --short --branch
git branch -vv --all
git remote -v
git ls-remote --heads origin
git rev-list --left-right --count main...HEAD
git merge-base main HEAD
git merge-base --is-ancestor main HEAD
git merge-tree --write-tree main HEAD          # exit 0
git diff --stat main...HEAD                    # 130 files, +16642/-1777
git diff --stat                                # 20 files, +868/-595
git diff --cached --stat                       # empty
git diff --check                               # exit 0
git stash list                                 # empty
node scripts/secret-scan.mjs                   # 0 actionable, exit 0
node scripts/secret-scan.mjs --history         # 6 actionable historical, exit 1
npm audit --omit=dev --json --prefix backend > /tmp/p84-backend-audit.json
node scripts/dependency-audit.mjs /tmp/p84-backend-audit.json   # warning, exit 0
npm audit --omit=dev --audit-level=high        # 0 vulnerabilities
npm --prefix web audit --omit=dev --audit-level=high            # 0 vulnerabilities
npm run typecheck                              # exit 0
npm run build                                  # exit 0
npm --prefix web run test:run -- --reporter=dot # 42/42 passed
npm --prefix backend run prisma:generate       # exit 0
npm --prefix backend run prisma:deploy         # 7 migrations applied to clinic_test
npm --prefix backend test                      # 156/156 passed
docker run -d --name p84-audit-postgres ... postgres:16-alpine
docker exec p84-audit-postgres pg_isready -U clinic -d clinic_test
docker rm -f p84-audit-postgres
wsl -d Ubuntu -- bash -lc 'bash scripts/p831-backup-isolated-test.sh'  # PASS 16/16
bash scripts/p831-backup-isolated-test.sh (Git Bash)                  # 14/16, sha256sum format artifact
for f in scripts/*.sh: bash -n "$f"            # 18 files, 0 syntax failures
node --check scripts/secret-scan.mjs            # exit 0
node --check scripts/dependency-audit.mjs       # exit 0
npm ci --dry-run --ignore-scripts --no-audit --no-fund  # root/backend/web all exit 0
docker compose -f docker-compose.yml config --quiet                   # exit 0
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml config --quiet  # exit 0
```

Credential-shaped values were inspected only through redacted count/length/fingerprint checks; no value was printed.

---

## 15. Limitations and unverified assumptions

- GitHub Actions was not executed; CI success is not claimed. Only local equivalents were run.
- No Ubuntu/SSH access, production database, production Docker daemon, backup disk, age key or escrow USB was accessed.
- No real backup, encryption/decryption, restore or PITR drill was performed; only synthetic isolated tests.
- Monitor templates were reviewed statically; no systemd unit/timer, profile, env file or alert channel was activated or tested with real notifications.
- The 20 modified and 21 untracked files were preserved but not committed; `merge-tree` covered committed `HEAD` only.
- The Git Bash 14/16 backup-suite result is a `sha256sum` output-format artifact of that Windows toolchain; Linux/Ubuntu reproduced 16/16. No code change was made for it.
- No lint configuration exists, so linting could not be run.
- Image CVE scanning was not performed; no image vulnerability claim is made.
- Historical `ACTIONABLE / INCONCLUSIVE` secret candidate and UTF-16 `backup.patch` values were not classified as real or synthetic; owner decision is required.
- Windows `core.autocrlf` produced LF/CRLF warnings; `.gitattributes` declares LF for affected paths. No line-ending normalization was performed.

---

## Final Decision

**C. NOT READY FOR MERGE**

Exact blockers:

1. Merge-critical CI workflow, audit scripts, backup library, isolated tests, regression tests and templates are untracked; merging `HEAD` would omit them.
2. Historical `.env.example` credential candidate remains `ACTIONABLE / INCONCLUSIVE` in six commits.
3. Committed UTF-16 `backup.patch` bypasses secret scanning and contains unreviewed `EVOLUTION_API_KEY` lines.
4. Four High dependency advisories remain under a temporary, owner-accepted exception.
5. GitHub Actions has not run; CI success is unverified.

Recommended fixes: include the intended uncommitted files in an owner-approved commit, classify/rotate the historical candidate if warranted, remove or classify `backup.patch` and harden the scanner for UTF-16, record explicit acceptance of the four advisories with a separate Prisma 7 migration plan, then trigger and inspect all three GitHub Actions jobs before reconsidering merge.

**Production Decision: NO-GO**
