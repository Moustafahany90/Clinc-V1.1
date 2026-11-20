# Production Readiness — Phase 8.5

**Repository:** Clinc-V1.1
**Branch:** `feature/clinic-quick-actions`
**HEAD at start:** `49767e1a282574aa7b951446189b3345c46f57a6` (`production phase 8`); origin aligned, 19 ahead / 0 behind `main`, clean tree
**Date:** 2026-11-20
**Reference:** `docs/PRODUCTION_READINESS_PHASE8_4.md`, `docs/PRODUCTION_READINESS_PHASE8_4_1.md`
**Scope:** Diagnose and fix the real CI-only backend-test failure and the Node 20 action deprecation warnings. Isolated local validation only. No commit, push, deploy, production access, or application-source change.

---

## 1. Executive summary

The GitHub Actions failure was **not** a timezone bug, an application bug, or a flaky test. The real CI log shows the Playwright PDF-rendering test failing because the runner had **no Chromium headless-shell browser installed** for the repo-pinned Playwright version. The same failure was reproduced locally by pointing Playwright at an empty browser directory: 156 tests, 155 pass, 1 fail.

The fix is at the workflow layer: an explicit, version-pinned Playwright Chromium install step in the backend-tests job, using the already-installed `backend/node_modules` Playwright. No test was skipped, reordered, retried, or weakened; no `TZ` pin, no application patch, and no Prisma advisory handling change.

The Node 20 warnings are cleared by moving `actions/checkout` and `actions/setup-node` to their current Node 24-based releases, pinned by full commit SHA.

**GitHub Actions has NOT been re-run by me.** No CI pass is claimed until the owner commits, pushes, and inspects a real run.

---

## 2. Real failure evidence (from the CI log)

Source: run `44813405885`, job `136555471706` — "Backend tests (synthetic PostgreSQL)", step "Backend tests", `feature/clinic-quick-actions` @ `49767e1`. `gh` was unavailable and the public logs API returned 403; the log was read read-only through the owner's signed-in browser. No credential values were printed or stored; log values were synthetic JWT/PostgreSQL test fixtures and UUIDs.

Redacted/quoted failure block:

```text
not ok 37 - block templates validate field shapes, render one safe HTML pipeline and US Letter PDFs
  duration_ms: 502.344665
  location: 'backend/tests/phase3-clinical-workflow.test.ts:1:13529'
  failureType: 'testCodeFailure'
  error: |-
    browserType.launch: Executable doesn't exist at
    /home/runner/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell
    ║ Looks like Playwright was just installed or updated.       ║
    ║ Please run the following command to download new browsers: ║
    ║     npx playwright install                                 ║
  code: 'ERR_TEST_FAILURE'
  stack: |-
    <anonymous> (.../backend/src/lib/htmlPdf.ts:8:16)

# tests 156
# pass 155
# fail 1
# skipped 0
# duration_ms 50336.803053
Error: Process completed with exit code 1.
```

All other steps in the job (checkout, Node setup, installs, Prisma generate, `prisma migrate deploy`) succeeded. The frontend test file `backend/tests/phase3-clinical-workflow.test.ts:501` calls the PDF renderer; `backend/src/lib/htmlPdf.ts:7-8` launches `chromium` from `playwright`.

### 2.1 Root-cause classification

| Classification | Verdict | Evidence |
|---|---|---|
| Missing runtime dependency | **Confirmed — sole root cause** | Runner lacks `chromium_headless_shell-1248`; local empty-cache run reproduces the identical test, error, and counts. Local cache has `chromium-1248` + `chromium_headless_shell-1248`, which is why the suite passed locally. |
| Timezone / clock dependence | **Not supported** | 3 runs each under `TZ=UTC`, `TZ=Africa/Cairo`, `TZ=America/Los_Angeles`: all 156/156. Failure text is a launch error, not an assertion on dates. |
| Environment / config mismatch | **Not supported** | Synthetic env values and PostgreSQL 16.4-alpine match the workflow; setup and migration steps succeeded; only the browser executable is absent. |
| Test isolation / order / concurrency | **Not supported** | The suite already uses `--test-concurrency=1`; 9 consecutive runs had identical counts and no flakiness. |
| Real application bug | **Not found** | No application behaviour was wrong; the browser binary was missing. `backend/src/` was not modified. |

---

## 3. Local reproduction (before the fix)

Disposable resource: container **`p85-ci-postgres`**, image `postgres:16.4-alpine`, port **55434**, database **`clinic_test`**, synthetic credentials. Workflow sequence applied: `npm ci` → `prisma generate` → `prisma migrate deploy` → `npm test`, with the workflow's `NODE_ENV`, `DATABASE_URL`, JWT, origin, cookie, proxy, log, and Evolution env values. To emulate the runner, `PLAYWRIGHT_BROWSERS_PATH` was set to a fresh empty directory (`p85-empty-browsers`) instead of deleting anything from the real cache.

```text
=== REPRO RUN (empty browser cache) ===
not ok 37 - block templates validate field shapes, render one safe HTML pipeline and US Letter PDFs
    browserType.launch: Executable doesn't exist at
    ...\p85-empty-browsers\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe
# tests 156
# pass 155
# fail 1
# skipped 0
repro-exit=1
```

This reproduces the CI failure exactly (same test, same missing revision `1248`, same counts). The only expected difference is the OS path suffix (`linux64` on the runner, `win64` locally).

---

## 4. Change made (correct layer)

`.github/workflows/ci.yml` only:

```yaml
# Required for Playwright-based PDF rendering tests (htmlPdf.ts/chromium).
# Uses the repo-pinned Playwright version from backend node_modules.
- name: Install Playwright Chromium
  working-directory: backend
  run: npx --no-install playwright install --with-deps chromium
```

Placed after "Install backend dependencies" and before Prisma generate/tests in the backend-tests job. `npx --no-install` prevents fetching a different Playwright version; the browser revision comes from the lockfile-pinned `playwright@1.64.1`. Verified locally that `npx --no-install playwright --version` resolves to `Version 1.64.1` from `backend/node_modules`. System libraries are installed with `--with-deps`, matching the GitHub-hosted Ubuntu runner.

**Not changed:** any test assertion, `skip`/`todo`/retry, test order, workflow `TZ`, application source, Prisma advisory handling, `scripts/dependency-audit.mjs`, migrations, or production config.

---

## 5. Node 24 action upgrade

| Action | Old pin | New tag / full SHA | Verification |
|---|---|---|---|
| `actions/checkout` | `11bd7190…` (`v4.2.2`) | `v7.0.1` / `3d3c42e5aac5ba805825da76410c181273ba90b1` | GitHub API `git/ref/tags/v7.0.1` → commit SHA; commit API shows "prep v7.0.1 release", verified signature; raw `action.yml` uses `node24`. |
| `actions/setup-node` | `49933ea5…` (`v4.4.0`) | `v7.1.0` / `949feb2413d6458794dcd2491c4babbbce0c15c1` | GitHub API `git/ref/tags/v7.1.0` → commit SHA; commit API shows the 7.1.0 release bump; raw `action.yml` uses `node24`. |

All six `uses:` entries (three jobs × two actions) were updated, each with a trailing `# vX.Y.Z` comment. No floating tags or branch refs. Application Node stays `22.14.0`; `permissions: contents: read` and every existing step remain intact. No secrets are referenced.

---

## 6. After-fix validation

### 6.1 Backend suite — same disposable PostgreSQL, real local browser cache

| Timezone | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `TZ=UTC` | exit 0 — 156/156/0 | exit 0 — 156/156/0 | exit 0 — 156/156/0 |
| `TZ=Africa/Cairo` | exit 0 — 156/156/0 | exit 0 — 156/156/0 | exit 0 — 156/156/0 |
| `TZ=America/Los_Angeles` | exit 0 — 156/156/0 | exit 0 — 156/156/0 | exit 0 — 156/156/0 |

Overall exit 0. Counts are `tests / pass / fail`; `skipped 0` in every run. Before-fix comparison: CI 155/156 with 1 fail; local empty-cache reproduction 155/156 with 1 fail.

### 6.2 Other CI-equivalent checks (once each)

| Check | Result |
|---|---|
| `node scripts/secret-scan.mjs` | exit 0 — 0 actionable, 2 allowlisted fixtures (values redacted) |
| `node --test scripts/secret-scan-regression.test.mjs` | exit 0 — 10/10 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm --prefix web run test:run -- --reporter=dot` | exit 0 — 7 files, 42 tests passed |
| `npm --prefix backend audit --omit=dev --json` → `node scripts/dependency-audit.mjs` | raw audit exit 1 (expected 4 High); wrapper exit 0 with the documented Prisma 6.x warning, no unexpected findings |
| `docker compose -f docker-compose.yml config --quiet` | exit 0 |
| `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml config --quiet` | exit 0 |

### 6.3 Workflow file validation

- YAML parses (`yaml@2.8.1` parser installed in a temp directory only): jobs `static`, `backend-tests`, `dependency-audit`.
- All 6 `uses:` refs are 40-hex SHA pins with tag comments; no floating tags.
- `permissions: contents: read` unchanged; no `${{ secrets.* }}` references.
- `actionlint`: **Not tested** — not installed locally and no local actionlint image; no unpinned tool/container was pulled for it.

---

## 7. Findings by classification

| Class | Finding |
|---|---|
| **Verified** | Real failing test/step and error quoted above; sole root cause = missing Playwright Chromium headless shell; exact local reproduction; 9/9 post-fix suite runs 156/156 across 3 timezones; all other CI-equivalent checks; action tag→SHA→Node 24 mapping; workflow YAML/structure; p85 container cleanup. |
| **Partially verified** | The workflow change is proven locally under CI-equivalent conditions, but the actual GitHub Actions job has not been re-run. The `--with-deps` install itself was not executed on a GitHub-hosted Ubuntu runner. |
| **Not tested** | GitHub Actions run after the fix; `actionlint`; real production environment; Phase 9–12 items. |
| **Recommended** | Commit the three allowlisted files together, push, and verify the new Actions run (§9). Keep the documented Prisma 4-High exception unchanged. |
| **Requires approval** | None for Phase 8.5 code changes. Owner decision remains required for the previously documented `backup.patch`, historical `.env.example` finding, and Prisma 7 upgrade; they are untouched here. |

---

## 8. Files changed

| File | Reason |
|---|---|
| `.github/workflows/ci.yml` | Added the explicit Playwright Chromium install; upgraded both actions to Node 24 releases pinned by verified full SHAs. |
| `docs/PRODUCTION_READINESS_PHASE8_5.md` (new) | This report. |
| `docs/PRODUCTION_READINESS_BASELINE.md` | Short Phase 8.5 status, blocker-register and changelog update. |

Final `git status --short`: ` M .github/workflows/ci.yml`, ` M docs/PRODUCTION_READINESS_BASELINE.md`, `?? docs/PRODUCTION_READINESS_PHASE8_5.md`. Final `git diff --stat` (tracked files only): `.github/workflows/ci.yml | 18 ++++++++++++------`, `docs/PRODUCTION_READINESS_BASELINE.md | 8 +++++---`, `2 files changed, 17 insertions(+), 9 deletions(-)`; the new report is untracked and therefore absent from that stat. Staged diff is empty. `git diff --name-only -- backend/src` and `-- backend/tests` are both empty. Git printed LF→CRLF normalization warnings for the two edited files; the diffs show only the intended lines. No other files were modified; no files were staged or committed.

---

## 9. Exact next manual steps for the owner

1. Review `git diff` and the three changed files; confirm no application/test changes.
2. Commit only:
   - `.github/workflows/ci.yml`
   - `docs/PRODUCTION_READINESS_PHASE8_5.md`
   - `docs/PRODUCTION_READINESS_BASELINE.md`
3. Push `feature/clinic-quick-actions` to `origin` (no PR merge or deploy in this phase).
4. In Actions, inspect the new run:
   - "Backend tests (synthetic PostgreSQL)" must show the "Install Playwright Chromium" step succeeding and "Backend tests" reporting `# tests 156`, `# pass 156`, `# fail 0`, exit 0.
   - "Secret scan, typecheck, build, unit tests" and "Backend dependency audit" must remain green; the 4-High Prisma warning is expected and unchanged.
   - Confirm the Node 20 deprecation notices are gone.
5. If the run is still red, paste the failing step/log lines for diagnosis; do not merge on a local-only pass.

Stop after this review; do not start Phase 9 or deploy.

---

## 10. Safety confirmation

- **Production:** untouched — no host, database, credential, schedule, deployment, or configuration access.
- **Existing Docker resources:** untouched — no existing container, volume, network, or image was modified or removed.
- **Created and deleted:** container `p85-ci-postgres` (image `postgres:16.4-alpine`, port 55434, DB `clinic_test`) — created once for reproduction and once for validation; removed by the scripts' exit trap both times. Verified: no `p85` containers, volumes, or networks remain.
- **Image pulled:** `postgres:16.4-alpine` (new local image only; retained, not a container).
- **Temporary workspace:** helper scripts, the empty browser directory and a pinned YAML-parser install were created only under `C:\Users\Moustafa\AppData\Local\Temp\opencode\p85-*` and removed after validation; no `p85` temp paths remain. Nothing in the repository outside the three allowlisted files was written.
- **Git:** no commit, push, staging, reset, clean, history rewrite, branch operation, or PR action.
