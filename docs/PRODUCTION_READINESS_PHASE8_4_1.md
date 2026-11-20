# Production Readiness — Phase 8.4.1

**Repository:** Clinc-V1.1
**Branch:** `feature/clinic-quick-actions`
**Target:** `main`
**Reference:** `docs/PRODUCTION_READINESS_PHASE8_4.md`
**Date:** 2026-11-20
**Scope:** Repository-level security and Git-integrity blocker remediation; final merge-readiness preparation only. No merge, push, commit, staging, history rewrite, deployment, credential rotation, or production access was performed.

---

## 1. Executive summary

Phase 8.4.1 closed the two technical security gaps that blocked final merge review in Phase 8.4, and completed the evidence needed for owner decisions on the rest.

| Phase 8.4 blocker | Phase 8.4.1 outcome |
|---|---|
| UTF-16 secret scanner bypass | **Fixed.** `scripts/secret-scan.mjs` now decodes UTF-8, UTF-8 BOM, UTF-16LE/BE with and without BOM, and NUL-containing text; fails closed on malformed input; explicitly counts binary skips. 10/10 synthetic regression tests pass. |
| `backup.patch` unreviewed | **Classified.** Added only in one non-`main` commit; all four `EVOLUTION_API_KEY` lines are empty, placeholder, or prose — no live credential. Owner approval still required to remove it from the latest tree. |
| Historical `.env.example` candidate | **Independently reproduced.** Same 40-character fingerprint at line 94 in the six known commits; not in the current tree. Retained `ACTIONABLE / INCONCLUSIVE` — owner validation/rotation pending. |
| 20 modified / 21 untracked files | **Fully inventoried** (§6). All preserved; none staged, committed or discarded. 23 untracked at verification, 24 with this report. |
| Four High Prisma advisories | **Re-audited and documented** (§7). No safe Prisma 6.x patch exists; all 6.x releases remain inside the advisory range. Runtime image excludes the affected CLI packages. Owner acceptance pending. |
| GitHub Actions execution | **Statically ready, not executed.** Cannot run without push/PR. Exact owner steps in §8. |

All local mandatory checks pass, except the intentional historical scan failure (`--history`, exit 1), which was preserved and is explained in §9 and §11. **Production remains NO-GO; all 13 Phase 8.4 §12.2 production blockers are unchanged.**

Final decision: **B. READY WITH OWNER CONDITIONS** (§16).

---

## 2. `backup.patch` investigation and classification

### 2.1 Provenance

| Item | Finding |
|---|---|
| Introduced by | `eb00de6176411e4fde2b1319bb29302bb2da8e43` — message `backup`, 2026-11-20 18:33:32 +0200 |
| Modified by | No other commit. `--follow --all` returns this single commit. |
| Present in `main` | No. `git ls-tree main backup.patch` returns nothing. |
| Present in `HEAD` | Yes — blob `e31aa83e68fd94a76efcfcdad156521c286e6ce6`, mode 100644. |
| Size | 439,292 bytes, UTF-16LE unified diff. |
| Artifact SHA-256 | `4D7440E2813B7A51BE3B3439439071DFCD638EBDDB7F02C0E4893FB1E7690769` |

### 2.2 Referencing workflows

Repository-wide search for `backup.patch` found references only in Phase 8.2/8.3.1/8.4 preservation reports. It is **not** referenced by any build, deployment, backup, monitoring, or CI workflow, source file, or active runbook. It has no repository function.

### 2.3 Redacted content analysis

Decoded read-only as UTF-16LE. Exactly four `EVOLUTION_API_KEY=` assignment lines were found. No value is reproduced; only length, a 12-hex-character SHA-256 prefix, and token classifications are reported.

| Line | Length | SHA-256 prefix | Tokens (redacted) | Classification |
|---:|---:|---|---|---|
| 25 | 0 | `e3b0c44298fc` | none | Empty value — confirmed empty |
| 26 | 47 | `eb0174650baf` | `replace`, `with`, `a`, `long`, `random`, `...`, `evolution`, `api`, `key` | Placeholder instruction text — **CONFIRMED SYNTHETIC** |
| 1382 | 75 | `c98aea9cc99a` | prose: `shared`, `secret`, `service`, `authentication`, `must`, `equal`, `the`, `api`, `key`, `of` | Documentation prose, not a credential value |
| 1384 | 71 | `5c8097ddb302` | prose: `shared`, `secret`, `service`, `required`, `by`, `backend`, `used`, `the`, `and`, `api` | Documentation prose, not a credential value |

No `sk_live_`, `sk_test_`, GitHub, Slack, Google, Telegram, or private-key pattern was present after decoding. The hardened scanner now reads this file (no NUL skip) but emits no finding for it, because none of the four lines is a high-confidence credential-shaped value. That is correct behavior, not a bypass: §4.2 and test 9 prove a genuine credential-shaped string inside a UTF-16 `backup.patch` **is** detected.

### 2.4 Decision

**Artifact classification: `OBSOLETE — OWNER APPROVAL REQUIRED`.** Confidence: high for the four line classifications; the artifact has no legitimate repository purpose.

- Do **not** delete automatically. Recommend owner-approved removal from the current tree.
- Removing it from the latest tree **does not** remove it from Git history — commit `eb00de6` still contains the blob.
- Do **not** rewrite history. Any history cleanup requires separate, explicit owner approval.
- Deleting a file does not invalidate a previously exposed credential; no credential was found here, but that general rule is recorded.
- If the owner prefers retention, replace it with a credential-free text-format (UTF-8) note in documentation; do not keep a binary patch artifact in the repository.

---

## 3. UTF-16 scanner implementation

`scripts/secret-scan.mjs` was rewritten. Preserved behavior: the same seven rules, the same redacted identifier format (`prefix…(len=N) sha256:xxxxxxxxxxxx`), the same exact fixture allowlist, no marker-word exclusions, working `--history`, and no printing of matched values.

### 3.1 Encoding handling

| Input | Handling |
|---|---|
| UTF-8 | Decoded with fatal `TextDecoder`. |
| UTF-8 BOM (`EF BB BF`) | BOM stripped before scanning. |
| UTF-16LE BOM (`FF FE`) / no BOM | Detected via NUL parity at odd byte offsets; decoded as UTF-16LE. |
| UTF-16BE BOM (`FE FF`) / no BOM | Detected via NUL parity at even byte offsets; decoded as UTF-16BE. |
| NUL-containing text | NULs removed during canonicalisation; surrounding text still scanned. |
| Malformed / ambiguous bytes | `TextDecodeError` → actionable `undecodable-text` finding, non-zero exit. Never a clean scan. |
| Known binary extensions | Explicit `binarySkipped` counter and log line; bytes not decoded. No silent skip. |
| Unreadable file | Actionable `unreadable-file` finding; scanned via `git show` fallback where possible. |

- Decode helpers (`decodeBytes`, `git`, `fingerprint`, `scanText`, `isEnvPath`), `RULES`, `FIXTURE_ALLOWLIST`, and `TextDecodeError` are exported for tests.
- `--history` now enumerates reachable commits with `git ls-tree -r -z`, reads blobs with `git cat-file blob`, caches by blob hash, and runs every env-path blob through the same hardened decoder. Findings are attributed to each commit with a `(history)` marker; allowlist is deliberately not applied to history.
- Scanner errors set exit code 2; actionable findings set exit code 1.

### 3.2 Explicit allowlist unchanged

Only these two exact `rule | path | fingerprint` identities remain suppressed:

1. `stripe-live-key | backend/tests/p72-http-422.test.ts | sk_l…(len=26) sha256:034abe1ab554`
2. `stripe-live-key | backend/tests/phase7-route-redaction.test.ts | sk_l…(len=27) sha256:899f43f0bb06`

Copying either fingerprint to another path makes it actionable (proved by test 8). Words such as `test`, `example`, `fake`, `dummy` never suppress a finding (test 7).

---

## 4. Scanner regression test results

New file: `scripts/secret-scan-regression.test.mjs`. All values are constructed at runtime; no literal or real credential appears in the file.

| # | Test | Result |
|---:|---|---|
| 1 | UTF-8 credential detection | PASS |
| 2 | UTF-8 BOM normalisation | PASS |
| 3 | UTF-16LE with and without BOM | PASS |
| 4 | UTF-16BE with BOM | PASS |
| 5 | NUL-containing UTF-16 canonicalised and detected | PASS |
| 6 | Malformed/ambiguous input fails closed | PASS |
| 7 | `test`/`example` words remain actionable | PASS |
| 8 | Exact allowlist path+ fingerprint; copied fingerprint rejected | PASS |
| 9 | CLI detects synthetic credential in UTF-16LE `backup.patch` without printing it | PASS |
| 10 | CLI `--history` detects a credential present only in a prior commit | PASS |

`node --test scripts/secret-scan-regression.test.mjs` → **10 tests, 10 pass, 0 fail, exit 0** (re-run twice).

Real working-tree verification: `node scripts/secret-scan.mjs` → 2 candidates (2 exact allowlisted fixtures, 0 actionable), **exit 0**. `node scripts/secret-scan.mjs --history` → 8 candidates (6 actionable historical, 2 allowlisted), **exit 1** — preserved intentionally.

---

## 5. Historical `.env.example` investigation

### 5.1 Independent reproduction

Read-only `git show <commit>:.env.example` with hashed, non-printing analysis reproduced the Phase 8.4 finding exactly:

| Commit | Line | Length | SHA-256 prefix | Shape |
|---|---:|---:|---|---|
| `71cf8a7915c8` | 94 | 40 | `47e7959a1b54` | `aaxaaaaxaaaa9aaaaaaaa999aa9a9aaaaaaaaaaa` |
| `8be0930b0e44` | 94 | 40 | `47e7959a1b54` | identical |
| `925e2cd90259` | 94 | 40 | `47e7959a1b54` | identical |
| `ccd35ff587e4` | 94 | 40 | `47e7959a1b54` | identical |
| `43c96191a8d9` | 94 | 40 | `47e7959a1b54` | identical |
| `ebcd2a42d063` | 94 | 40 | `47e7959a1b54` | identical |

- Variable: `EVOLUTION_API_KEY` (the value matched the scanner's Stripe-prefixed rule because of its `sk_live_` prefix; the token itself was never printed or copied).
- Current working tree: **not present** (`.env.example` at line 94 no longer contains the candidate; working-tree scan is 0 actionable).
- Reachable history: `--history` finds the same fingerprint at exactly these six commits and nowhere else.
- No external provider was contacted; no authentication was attempted; no value was printed, exported, or transmitted.

### 5.2 Classification

**`ACTIONABLE / INCONCLUSIVE`** (unchanged).

Evidence is insufficient to confirm synthetic: the value has no placeholder-word tokens and has a credential-like shape. Evidence is also insufficient to confirm it was ever live. Per the phase rules, absence from `.env.example` is not evidence of harmlessness. Owner must validate through the provider's official process and rotate if it was ever valid. Git history still contains the value; do not rewrite history without separate approval.

---

## 6. Complete modified/untracked file inventory

Git state at verification: HEAD `0d79b7d98962b204806e3e2cf2caf1ac381f1026`; 18 commits ahead of `main`, 0 behind; **0 staged**; **20 modified tracked**; **23 untracked** (21 reported in Phase 8.4 + `docs/PRODUCTION_READINESS_PHASE8_4.md` created at the end of that phase + new `scripts/secret-scan-regression.test.mjs`). This report adds one more untracked file → **24** at completion. All preserved.

### 6.1 Modified tracked files (already in HEAD, corrected in working tree)

| Path | Purpose | Merge | Sensitive | Dependencies | Classification |
|---|---|---|---|---|---|
| `backend/Dockerfile` | Removes Prisma CLI/vulnerable transitive packages from runtime image | REQUIRED | No | package-lock, migrate stage | REQUIRED FOR MERGE |
| `backend/src/lib/logger.ts` | UUID-safe log scrubbing | REQUIRED | Handles sensitive input, stores none | p72 redaction tests | REQUIRED FOR MERGE |
| `backend/tests/quick-actions-appointments.test.ts` | Deterministic after-hours appointment fixture | REQUIRED | Synthetic only | appointments module | REQUIRED FOR MERGE |
| `deploy/Caddyfile` | Log redaction directives | REQUIRED | No | deploy templates | REQUIRED FOR MERGE |
| `deploy/clinic-heartbeat-check.service` | Monitor service account correction | REQUIRED | No | monitor scripts | REQUIRED FOR MERGE |
| `deploy/clinic-monitor.service` | Monitor service account correction | REQUIRED | No | monitor scripts | REQUIRED FOR MERGE |
| `docker-compose.monitoring.yml` | Tier-based monitoring profiles | REQUIRED | No | base compose | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_BASELINE.md` | Baseline report correction | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE6.md` | Phase 6 report correction | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE6_1.md` | Phase 6.1 report correction | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE7.md` | Phase 7 report correction | Optional (doc) | No | — | OPTIONAL |
| `docs/backup-restore.md` | Backup storage wording correction | Required for doc consistency | No | backup scripts | REQUIRED FOR MERGE |
| `docs/monitoring-runbook.md` | Monitoring wording correction | Required for doc consistency | No | monitor templates | REQUIRED FOR MERGE |
| `docs/operations.md` | Operations wording correction | Optional (doc) | No | — | OPTIONAL |
| `scripts/backup-verify.sh` | Fail-closed backup verifier | REQUIRED | No (reads backups) | backup-common.sh | REQUIRED FOR MERGE |
| `scripts/backup.sh` | Fail-closed backup producer | REQUIRED | Handles age keys via env only | backup-common.sh | REQUIRED FOR MERGE |
| `scripts/p7-check-backup.sh` | Storage/mount validator | REQUIRED | No | backup-common.sh | REQUIRED FOR MERGE |
| `scripts/p7-common.sh` | Shared Phase 7 functions | REQUIRED | No | all p7 scripts | REQUIRED FOR MERGE |
| `scripts/p7-monitor.sh` | Monitor with UUID/ encryption checks | REQUIRED | No | p7-common.sh | REQUIRED FOR MERGE |
| `web/nginx.conf` | Log redaction directives | REQUIRED | No | Caddyfile counterpart | REQUIRED FOR MERGE |

### 6.2 Untracked files (NOT in HEAD — omitted if HEAD is merged alone)

| Path | Purpose | Merge | Sensitive | Dependencies | Classification |
|---|---|---|---|---|---|
| `.github/workflows/ci.yml` | CI: scan, regression tests, audits, typecheck, build, tests (3 jobs) | REQUIRED | No secrets; synthetic CI values | scanner, regression test, audit classifier, all test scripts | REQUIRED FOR MERGE |
| `backend/tests/p72-http-422.test.ts` | HTTP 422 regression; exact allowlisted synthetic fixture | REQUIRED | Synthetic fixture only (allowlisted) | backend app | REQUIRED FOR MERGE |
| `backend/tests/p72-scrubber-regression.test.ts` | Log scrubber regression | REQUIRED | Synthetic test values only | logger.ts | REQUIRED FOR MERGE |
| `backend/tests/phase7-route-redaction.test.ts` | Route redaction; exact allowlisted synthetic fixture | REQUIRED | Synthetic fixture only (allowlisted) | logger.ts | REQUIRED FOR MERGE |
| `backend/tests/quick-actions-timing.test.ts` | Deterministic Quick Actions timing tests | REQUIRED | Synthetic only | appointments module | REQUIRED FOR MERGE |
| `deploy/clinic-monitor.logrotate` | Logrotate template (`root:root` corrected) | REQUIRED | No | monitor service | REQUIRED FOR MERGE |
| `deploy/monitor.env.example` | Monitoring env template (secret fields blank) | REQUIRED | Template only; no committed values | monitor scripts | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_PHASE7_1.md` | Phase 7.1 report | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE7_2.md` | Phase 7.2 report | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE8_0.md` | Phase 8.0 report | Optional (doc) | No | — | OPTIONAL |
| `docs/PRODUCTION_READINESS_PHASE8_1.md` | Phase 8.1 dependency/advisory evidence | Required context for accepted risk | No | package-lock | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_PHASE8_2.md` | Phase 8.2 historical secret classification | Required context for owner decision | Redacted fingerprints only | scanner history | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_PHASE8_3_1.md` | Phase 8.3.1 backup validation evidence | Required context for backup review | Redacted fingerprints only | backup scripts | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_PHASE8_4.md` | Reference report for this phase | Required context | Redacted fingerprints only | all above | REQUIRED FOR MERGE |
| `scripts/backup-common.sh` | Shared fail-closed backup library | REQUIRED | No | backup/verify/validator | REQUIRED FOR MERGE |
| `scripts/dependency-audit.mjs` | Fail-closed advisory classifier | REQUIRED | No | npm audit JSON | REQUIRED FOR MERGE |
| `scripts/p7-deliver-telegram.sh` | Telegram notification delivery | REQUIRED (monitoring) | Reads env token; none committed | p7-common.sh | REQUIRED FOR MERGE |
| `scripts/p7-heartbeat-hook.sh` | Heartbeat hook | REQUIRED (monitoring) | No | p7-common.sh | REQUIRED FOR MERGE |
| `scripts/p72-nginx-privacy-test.sh` | nginx privacy regression | REQUIRED | No | web/nginx.conf | REQUIRED FOR MERGE |
| `scripts/p72-phase7-regression.sh` | Phase 7 regression suite | REQUIRED | No | p7 scripts | REQUIRED FOR MERGE |
| `scripts/p831-backup-isolated-test.sh` | 16-test isolated backup suite | REQUIRED | Synthetic only | backup scripts | REQUIRED FOR MERGE |
| `scripts/secret-scan-regression.test.mjs` | **New in 8.4.1** — 10 synthetic scanner tests | REQUIRED | Synthetic values only | scanner | REQUIRED FOR MERGE |
| `scripts/secret-scan.mjs` | **Hardened in 8.4.1** — UTF-8/UTF-16 scanner | REQUIRED | Prints redacted fingerprints only | CI workflow, regression test | REQUIRED FOR MERGE |
| `docs/PRODUCTION_READINESS_PHASE8_4_1.md` | This report (created at completion) | Required deliverable | Redacted fingerprints only | all above | REQUIRED FOR MERGE |

### 6.3 Committed artifact outside the inventory

| Path | Status | Purpose | Merge | Sensitive | Classification |
|---|---|---|---|---|---|
| `backup.patch` | Committed in `HEAD` (commit `eb00de6`), not in `main` | None — obsolete preservation artifact | Should be excluded | All four decoded assignments classified non-secret (§2) | OBSOLETE — OWNER APPROVAL REQUIRED |

### 6.4 Merge-tree distinction

- **Already in `HEAD`:** all 18 branch commits, including `backup.patch`, Quick Actions code, migrations, docs and scripts as committed.
- **Working tree only:** the 20 corrections above and all 24 untracked files.
- **If the owner merges current `HEAD` without incorporating working-tree files:** the CI workflow, secret scanner, scanner regression tests, audit classifier, backup library, isolated backup suite, backend/web regression tests, monitoring templates and Phase 7/8 reports would be **omitted**, and the 20 tracked corrections would revert to their older committed versions. The merge would therefore be technically green but operationally and security-wise incomplete.

No unexpected or unrelated untracked file was found; every entry maps to Phase 7/8/Quick Actions work or this phase.

---

## 7. Dependency advisory analysis

### 7.1 Re-audit result

`npm audit --omit=dev --json` in `backend/`, classified by `scripts/dependency-audit.mjs`:

`::warning:: ... documented Prisma 6.x advisory cluster (4 high)` — `dependency-audit: 4 known advisory assignment(s) accepted temporarily; no unexpected findings` — **exit 0**. Metadata: 4 high, 0 critical, 0 moderate, 0 low.

### 7.2 Exact advisories

| Package | Installed | Severity | Vulnerable range | Advisory IDs | Fix offered |
|---|---|---|---|---|---|
| `prisma` | 6.18.0 | High | `6.13.0-dev.1 – 7.10.0`, `8.0.0-rc.3 – 8.1.0-dev.4` | (CLI assignment; no single GHSA in audit payload) | `prisma@7.10.1` — **semver major** |
| `@prisma/config` | 6.18.0 | High | `6.13.0-dev.1 – 7.10.0`, `8.1.0-dev.1 – 8.1.0-dev.4` | (CLI transitive assignment) | `prisma@7.10.1` — semver major |
| `deepmerge-ts` | 7.1.5 | High | `<8.0.0` | GHSA-ggr8-5vv4-36mx — stack exhaustion on recursive object graphs | `prisma@7.10.1` — semver major |
| `effect` | 3.18.4 | High | `<=3.22.0` | GHSA-38f7-945m-qr2g (AsyncLocalStorage context loss/contamination under concurrent RPC load); GHSA-7589-6fvf-x4pw (ReDoS in `Schema.TemplateLiteral`) | `prisma@7.10.1` — semver major |

Dependency paths: `node_modules/prisma`, `node_modules/@prisma/config`, `node_modules/deepmerge-ts`, `node_modules/effect` — all pulled in by the pinned `prisma@6.18.0` CLI in `backend/package.json` / lockfile.

### 7.3 Safe 6.x patch check

`npm view prisma@6 version --json` shows the latest 6.x release is **6.19.3**. However, the advisory ranges cover `6.13.0-dev.1 – 7.10.0` in full, so **every 6.x release — including 6.19.3 — remains vulnerable**. No safe Prisma 6.x patch exists in the current lockfile context. No package version or lockfile was changed. Prisma 7 upgrade is out of scope for this phase.

### 7.4 Runtime exposure and classifier behavior

- `backend/Dockerfile` runtime stage removes `node_modules/prisma`, `@prisma/config`, `deepmerge-ts`, `effect` (and other CLI-only transitive packages). No runtime source imports `effect`, `deepmerge-ts`, or `@prisma/config` (source search: no matches). Vulnerable packages are therefore **absent from the serving image**; they remain in the build stage and the trusted `migrate` service.
- The classifier hard-fails on any package set, count, or severity other than the exact documented four-High cluster; it emits a warning and exits 0 only for that cluster. Any new or changed advisory is not suppressed. Verified: exit 0 with warning for the current exact cluster.
- Practical exposure: low at runtime, but the advisories remain open in the lockfile and in the build/migrate image. Owner acceptance is required, plus a separate compatibility-tested Prisma 7 migration project. No severity was downgraded and no advisory was suppressed without the documented exception.

---

## 8. GitHub Actions readiness

`.github/workflows/ci.yml` exists only in the working tree (untracked), not in `HEAD`.

| Requirement | Finding |
|---|---|
| Least privilege | `permissions: contents: read`; no `pull_request_target`; no write scopes — PASS |
| Pinned actions | `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2), `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0) — PASS |
| Production secrets | None referenced; all CI values synthetic — PASS |
| Deployment | No deploy job, SSH, cloud credentials, or production Docker context — PASS |
| PostgreSQL | `postgres:16.4-alpine`, `clinic`/`clinic`/`clinic_test`, `pg_isready` health check; isolated from production — PASS |
| Secret scanning | Working-tree scan + new mandatory `node --test scripts/secret-scan-regression.test.mjs` step — PASS |
| Historical scanning | Intentionally **not** in CI; documented as a manual owner gate because the unresolved `.env.example` finding would fail CI — PASS (documented) |
| Dependency audit | Fail-closed classifier consumed by `dependency-audit` job — PASS |
| Required files present in intended state | Scanner, regression test, classifier, backup library, isolated suite, tests and templates all exist in the working tree and are inventoried in §6 — PASS |

**CI was not executed.** GitHub Actions cannot be run without pushing or opening a PR, which is prohibited in this phase. **No CI pass is claimed.**

Exact owner steps for a later run:

1. Include the 24 untracked files and 20 tracked corrections in an owner-approved commit (this phase staged/committed nothing).
2. Push the branch or open/update a PR to `main` with those files included.
3. Ensure Actions are enabled; approve the first run if GitHub requests it.
4. Trigger `push`, `pull_request`, or `workflow_dispatch`.
5. Wait for all three jobs: `static`, `backend-tests`, `dependency-audit`.
6. Confirm logs: 0 actionable secret-scan candidates; regression tests 10/10; root/web audits 0 vulnerabilities; typecheck/build/frontend tests pass; backend 156/156 against synthetic `clinic_test`; dependency audit emits the documented four-High warning and exits 0.
7. Only then consider making these checks required in branch protection.

---

## 9. All validation results

Checks run **after** the Phase 8.4.1 changes. All values synthetic; no production system touched.

| Check | Command | Result | Exit |
|---|---|---|---:|
| Working-tree secret scan | `node scripts/secret-scan.mjs` | 2 candidates, 2 exact allowlisted fixtures, 0 actionable | 0 |
| Historical secret scan | `node scripts/secret-scan.mjs --history` | 6 actionable historical + 2 allowlisted — **preserved failure** | **1** |
| Scanner regression tests | `node --test scripts/secret-scan-regression.test.mjs` | 10/10 pass, 0 fail | 0 |
| Backend dependency audit | `npm audit --omit=dev --json` + `scripts/dependency-audit.mjs` | Exactly 4 known High advisories; warning; no unexpected findings | 0 |
| Root production audit | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities | 0 |
| Web production audit | `npm --prefix web audit --omit=dev --audit-level=high` | 0 vulnerabilities | 0 |
| Phase 8.3.1 backup suite (WSL Ubuntu) | `wsl -d Ubuntu -- bash -lc 'bash scripts/p831-backup-isolated-test.sh'` | **16 passed, 0 failed, 16 total** | 0 |
| Frontend tests | `npm --prefix web run test:run -- --reporter=dot` | 7 files, **42/42 passed** | 0 |
| Backend tests | `npm test` (isolated `postgres:16-alpine`, port 55433, 7 migrations applied) | **156 passed, 0 failed, 0 skipped** | 0 |
| Typecheck | `npm run typecheck` (backend + web) | PASS | 0 |
| Build | `npm run build` (backend + web, Vite 1,782 modules) | PASS | 0 |
| Compose base config | `docker compose -f docker-compose.yml config --quiet` | PASS | 0 |
| Compose + monitoring config | `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml config --quiet` | PASS | 0 |
| Shell syntax | `bash -n` over `scripts/*.sh` | 18 files, 0 failures | 0 |
| Node syntax | `node --check` on 3 scanner/audit `.mjs` files | 3 files, 0 failures | 0 |
| Git diff check | `git diff --check` / `git diff --cached --check` | PASS (only core.autocrlf warnings) | 0 / 0 |
| Git staging check | `git diff --cached --stat` | Empty — 0 staged | — |

The temporary PostgreSQL container `p841-audit-postgres` was created solely for synthetic backend tests and removed afterwards; existing containers were untouched. Generated `dist/` and Prisma client files are ignored build artifacts. Lint was not run (no lint script/config exists). Image CVE scanning was not performed.

---

## 10. Files modified during Phase 8.4.1

| File | Change |
|---|---|
| `scripts/secret-scan.mjs` | Rewritten: multi-encoding decoding, fail-closed undecodable/binary handling, exported testable helpers, exact allowlist preserved, hardened `--history`. |
| `scripts/secret-scan-regression.test.mjs` | Created: 10 synthetic-only regression tests covering all required encoding and allowlist cases. |
| `.github/workflows/ci.yml` | Added mandatory `Secret scanner encoding regression tests` step; documented intentional omission of `--history`. |
| `docs/PRODUCTION_READINESS_PHASE8_4_1.md` | Created (this report). |

No other repository file was modified by this phase. No commit, staging operation, history rewrite, branch operation, push, deployment, rotation, or deletion was performed. Temporary analysis scripts and the audit JSON were written only to the approved local temp directory.

---

## 11. Remaining security and merge blockers

1. **Historical `.env.example` candidate (`ACTIONABLE / INCONCLUSIVE`)** in six commits — owner validation/rotation required; `--history` intentionally exits 1.
2. **`backup.patch` remains in the current `HEAD` tree** — owner approval required to remove it from the latest tree; history still retains the blob; no history rewrite performed.
3. **Four High Prisma advisories** — documented temporary exception; explicit owner acceptance and a separate Prisma 7 migration project required.
4. **24 untracked files / 20 modified tracked files are not committed** — merging `HEAD` alone omits merge-critical CI and security files (§6.4).
5. **GitHub Actions has not run** — CI success is unverified; owner must push/PR and inspect all three jobs.
6. **All 13 Phase 8.4 §12.2 production blockers remain open** — no Ubuntu deployment, `/opt/clinic` check, storage permissions, backup account, age-key escrow verification, restore drill, monitoring deployment, `rclone`, WAL/PITR, schedule/retention, or host-version reconciliation was performed. **Production Decision: NO-GO.**

---

## 12. Owner decisions required

1. **Credential validation:** validate the historical `EVOLUTION_API_KEY` candidate (fingerprint `47e7959a1b54`, six commits) through the provider's official process; rotate if it was ever live. This phase did not test or rotate it.
2. **Artifact removal:** approve removal of `backup.patch` from the latest tree; explicitly decide whether any history cleanup is desired as a separate, later project.
3. **Dependency acceptance:** explicitly accept the four High advisories under the documented exception and authorize a separately validated Prisma 7 migration project. No 6.x patch exists.
4. **Working-tree inclusion:** approve which of the 24 untracked files and 20 tracked corrections enter the intended merge commit; explicitly exclude any not intended. None was staged here.
5. **CI execution:** push/PR and inspect all three GitHub Actions jobs using the steps in §8 before treating the branch as CI-verified.

---

## 13. Commands executed

```text
git status --short --branch
git status --porcelain=v1
git log -1 --format='HEAD %H %s'
git log --all --oneline --follow -- backup.patch
git log --all --diff-filter=A --format='%H %ad %s' --date=iso -- backup.patch
git ls-tree HEAD backup.patch; git ls-tree main backup.patch
git rev-list --left-right --count main...HEAD
git cat-file -e HEAD:.github/workflows/ci.yml        # exit 128 (not in HEAD)
git cat-file -e HEAD:scripts/secret-scan.mjs         # exit 128 (not in HEAD)
git ls-files --others --exclude-standard             # 23 untracked
git diff --stat                                      # 20 files, +868/-595
git diff --cached --stat                             # empty
git diff --check; git diff --cached --check          # exit 0 / 0
grep -R 'backup.patch' docs scripts deploy web .github
node --check scripts/secret-scan.mjs
node --check scripts/secret-scan-regression.test.mjs
node --check scripts/dependency-audit.mjs
node scripts/secret-scan.mjs                          # 0 actionable, exit 0
node scripts/secret-scan.mjs --history                # 6 actionable historical, exit 1
node --test scripts/secret-scan-regression.test.mjs  # 10/10, exit 0
npm audit --omit=dev --json --prefix backend > <temp>/p841-audit.json
node scripts/dependency-audit.mjs <temp>/p841-audit.json   # warning, exit 0
npm view prisma@6 version --json                      # latest 6.19.3; still vulnerable
npm audit --omit=dev --audit-level=high               # 0 vulnerabilities
npm --prefix web audit --omit=dev --audit-level=high  # 0 vulnerabilities
wsl -d Ubuntu -- bash -lc 'bash scripts/p831-backup-isolated-test.sh'  # 16/16
npm --prefix web run test:run -- --reporter=dot       # 42/42
docker run -d --name p841-audit-postgres ... postgres:16-alpine
docker exec p841-audit-postgres pg_isready -U clinic -d clinic_test
npm --prefix backend run prisma:generate
npm --prefix backend run prisma:deploy                # 7 migrations applied
npm --prefix backend test                             # 156/156
docker rm -f p841-audit-postgres
npm run typecheck                                     # exit 0
npm run build                                         # exit 0
docker compose -f docker-compose.yml config --quiet                              # exit 0
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml config --quiet  # exit 0
bash -n scripts/*.sh                                  # 18 files, 0 failures
```

Credential-shaped values were inspected only through redacted length/shape/fingerprint analysis; no value was printed, copied, or transmitted. No production secret, private key, database, host, or deployment was accessed.

---

## 14. Limitations and unverified assumptions

- GitHub Actions was not executed; CI success is not claimed. Only local equivalents were run.
- No Ubuntu/SSH access, production database, production Docker daemon, backup disk, age key, or escrow USB was accessed.
- No real backup, encryption/decryption, restore, or PITR drill was performed; only the synthetic 16-test isolated suite.
- Monitoring templates were reviewed statically; no systemd unit/timer, profile, env file, or alert channel was activated or tested with real notifications.
- The 20 modified and 24 untracked files were preserved but not committed; no `merge-tree` check was repeated here, and prior merge checks covered committed `HEAD` only.
- The historical candidate's live status cannot be determined from repository evidence alone; no provider contact was made.
- `backup.patch` line classifications rely on decoded token shape and placeholder wording at four specific lines; no value was read into a report or copied elsewhere.
- No safe Prisma 6.x patch exists in the current advisory ranges; the 6.19.3 release was checked for availability only, not installed or tested.
- No lint configuration exists, so linting could not be run. Image CVE scanning was not performed.
- Windows `core.autocrlf` produced LF/CRLF warnings in `git diff --check`; `.gitattributes` declares LF for affected paths. No line-ending normalization was performed.
- The exact-fixture allowlist and rule set were intentionally preserved; generic `EVOLUTION_API_KEY=` assignment lines are not high-confidence rules, so the non-credential `backup.patch` lines produce no finding even though the file is now decoded.

---

## 15. Final Decision

**B. READY WITH OWNER CONDITIONS**

All technical fixes for Phase 8.4.1 are complete and locally validated: the UTF-16 bypass is fixed with 10/10 synthetic regression tests, `backup.patch` is safely classified, every working-tree file is accounted for, the dependency advisories are fully documented with a verified absence of any 6.x patch, and CI is statically ready. Explicit owner conditions remain before any final merge review: validate/rotate the historical candidate (§12.1), approve `backup.patch` removal (§12.2), accept the four High advisories and authorize a Prisma 7 migration project (§12.3), include or exclude the inventoried working-tree files (§12.4), and execute and inspect GitHub Actions (§12.5). The historical `--history` failure is intentionally preserved. All 13 production blockers remain open.

**Production Decision: NO-GO**
