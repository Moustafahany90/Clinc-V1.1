# Pre-Phase 5 — Frontend Dependency Security Remediation (2026-11-17)

## 1. Scope and outcome

Narrowly scoped investigation of the **5 high-severity npm audit findings** reported in `web/` during Production Readiness Phase 4. Work was confined to `web/` investigation and documentation; **no dependency, lockfile, source, backend, or application-behavior change was applied**.

**Outcome: no safe remediation exists at this time, so no fix was applied.** All five findings trace to a single upstream advisory (CVE-2026-112366 / GHSA-fc5q-39xc-vjpf, "picomatch ReDoS through single-branch repeated extglobs") for which the GitHub Advisory Database explicitly reports **"Patched versions: None"** and npm's registry shows no release above the installed `picomatch@4.0.7`. The only fix npm proposes is a **semver-major downgrade** of the build/test toolchain (`npm audit fix --force` → `vitest@3.1.4`, with `vite@6.2.7` for the vite finding), which is explicitly out of scope ("do not run `npm audit fix --force`", "do not perform blanket dependency upgrades", "if resolving any finding requires a breaking upgrade, stop and report before applying"). Per instructions it is **reported, not applied**, and documented as an unresolved risk in §7.

**Production exposure is zero:** `npm audit --omit=dev` reports **0 vulnerabilities**, and `npm ls picomatch --omit=dev` is empty — none of the affected packages ship in the built frontend.

## 2. Original vulnerability inventory

Commands run (in `web/`): `npm audit --json`, `npm audit --omit=dev --json`, `npm ls` (plus `npm ls picomatch fdir tinyglobby vite vitest --all` and `npm ls picomatch --omit=dev --all` to map chains).

All five advisories are the same root cause. Summary:

| Package | Installed | Direct? | Severity | Advisory | Affected range | Fix npm suggests | Semver | Prod? |
|---|---|---|---|---|---|---|---|---|
| `picomatch` | 4.0.7 | transitive | High (CVSS 3.1 7.5 / CVSS 4.0 8.7) | CVE-2026-112366 / GHSA-fc5q-39xc-vjpf | `<= 4.0.7` | **none available** (latest = 4.0.7) | n/a | No |
| `fdir` | 6.5.0 | transitive | High (via picomatch) | same (inherited) | `>= 5.2.1` | `vite@6.2.7` | major | No |
| `tinyglobby` | 0.2.17 | transitive | High (via fdir + picomatch) | same (inherited) | `*` | `vitest@3.1.4` | major | No |
| `vite` | 7.3.7 | **direct** (`^7.3.7`) | High (via fdir, picomatch, tinyglobby) | same (inherited) | `>= 6.3.0-beta.0` | `vite@6.2.7` | major (a downgrade) | No |
| `vitest` | 5.1.0 | **direct** (`^5.1.0`) | High (via picomatch, tinyglobby, vite) | same (inherited) | `>= 3.1.2` | `vitest@3.1.4` | major (a downgrade) | No |

Counts: `npm audit` → 5 high / 0 critical; `npm audit --omit=dev` → 0. Dependency totals from audit metadata: prod 90, dev 217, optional 82, peer 10 (306 total).

### Root advisory detail (from GitHub Advisory Database)

- **ID:** CVE-2026-112366 / GHSA-fc5q-39xc-vjpf — "picomatch vulnerable to ReDoS through single-branch repeated extglobs", CWE-1333, CVSS 4.0 `AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H` (8.7); npm reports CVSS 3.1 7.5. EPSS 0.335% (27th percentile). Published 2026-10-19, updated 2026-11-17.
- **Mechanism:** picomatch through 4.0.7 can be blocked by supplying single-branch repeated extglob patterns such as `+(*)` or `+(*a)`; `analyzeRepeatedExtglob` skips them, causing exponential backtracking against short crafted strings (availability-only impact; no confidentiality/integrity impact).
- **Affected versions:** `<= 4.0.7`. **Patched versions: None.** Upstream issue/PRs (#175, #194, #191) remain open; multiple downstream projects are tracking or temporarily accepting this advisory in dev tooling pending a fixed release.

## 3. Dependency chains

Installed tree (`npm ls picomatch fdir tinyglobby vite vitest --all`):

```
@tailwindcss/vite@4.3.3 ── vite@7.3.7 (deduped)
@vitejs/plugin-react@4.7.0 ── vite@7.3.7 (deduped)
vite@7.3.7
├── fdir@6.5.0 ────────────── picomatch@4.0.7
├── picomatch@4.0.7           (direct to vite)
└── tinyglobby@0.2.17
    ├── fdir@6.5.0 (deduped)
    └── picomatch@4.0.7 (deduped)
vitest@5.1.0
├── @vitest/mocker@5.1.0 ──── vite@7.3.7 (deduped)
├── picomatch@4.0.7 (deduped)
├── tinyglobby@0.2.17 (deduped)
└── vite@7.3.7 (deduped)
```

All chains converge on `picomatch@4.0.7`. `fdir`, `tinyglobby`, `vite` and `vitest` are flagged only because they depend on it (directly or transitively); there is no separate vulnerable code path in those packages.

## 4. Production vs development classification and reachability

- **All 5 findings are development tooling only.** `npm audit --omit=dev` = 0 vulnerabilities; `npm ls picomatch --omit=dev --all` is empty. Vite (dev server/build) and Vitest (test runner) are `devDependencies` in `web/package.json` and are not part of the deployed `dist/` bundle. The Phase 4 browser smoke test confirmed the shipped assets are only the app/vendor chunks (`index`, `react`, `radix`, `router`, `http`, `icons`) plus lazy route chunks — no picomatch.
- **Reachability of the ReDoS trigger:** exploitation requires an attacker to supply a malicious glob pattern to picomatch's pattern parser. In this application's usage:
  - `vite` uses picomatch (via `fdir`/`tinyglobby`) for **file globbing during dev/build** — patterns come from Vite/plugin config and internal constants, not from HTTP requests or user input.
  - `vitest` uses it for **test-file include/exclude matching** — likewise config-driven.
  - No application code path passes patient/user/request data to picomatch.
  - The vulnerable packages are not present in the production runtime at all.
  - Therefore there is **no reachable untrusted-input path** in this project, in either production or the normal dev/build workflow; the practical risk is very low (consistent with the 0.335% EPSS), but the advisory is real and unpatched upstream.

## 5. Remediation plan and decision

1. **Smallest safe fix examined:** an npm `overrides` entry forcing `picomatch` to a patched `4.x` would resolve all five findings at once without touching vite/vitest. **Not possible** — the registry has no version above 4.0.7 (`dist-tags.latest = 4.0.7`, 35 published versions), and the advisory lists no patched version. Pinning to an older line is not a fix: downstream reports confirm picomatch 2.3.2 is also affected, and the advisory range is `<= 4.0.7`.
2. **Compatibility check of npm's suggested path:** `vite@6.2.7` and `vitest@3.1.4` are **major downgrades** from the installed `vite@7.3.7` / `vitest@5.1.0`. They would rework the toolchain that Phase 4 validated (Vitest 5 config in `vite.config.ts`, Vite 7 `manualChunks`, Vite 7 plugin versions), risk peer-dependency conflicts with `@vitejs/plugin-react@4.7.0` / `@tailwindcss/vite@4.3.3`, and are not guaranteed to clear this specific advisory (which spans all picomatch `<= 4.0.7`). This is a breaking change, so per the task constraints it is **reported for approval and not applied**.
3. **Blast-radius check for a downgrade:** even if approved, it would change only dev tooling, but would require re-running the full Phase 4 verification and re-establishing the bundle baseline (230.40 kB entry). It cannot improve the zero production exposure, since the affected code is not shipped.

**Conclusion:** no minimal, semver-compatible, non-breaking fix exists. No dependency file was modified. The finding is recorded as an accepted, low-practical-risk, dev-only unresolved risk with a recheck trigger (§7).

## 6. Before / after audit results and verification

Because no dependency change was applied, before = after:

| Check | Before | After | Result |
|---|---|---|---|
| `npm audit` | 5 high | 5 high | unchanged (all picomatch-chain, dev-only) |
| `npm audit --omit=dev` | 0 | 0 | clean |
| `npm ls` | vite 7.3.7 / vitest 5.1.0 / picomatch 4.0.7 | identical | unchanged |

Required verification (all passing on the unchanged dependency set):

| Command | Result |
|---|---|
| `npm audit` | 5 high (dev-only; see §2) |
| `npm audit --omit=dev` | **found 0 vulnerabilities** |
| `npm run typecheck` | PASS (`tsc -b --pretty false`, exit 0) |
| `npm run test:run` | PASS — **7 files, 42 tests, 0 failed** (5.75 s) |
| `npm run build` | PASS — 1782 modules, 3.17 s, **no chunk-size warning** |

**Bundle / chunk integrity:** main app entry `index-....js` = **230.40 kB** (gzip 59.16 kB) — identical to the Phase 4 baseline. Vendor chunks unchanged (`react` 165.21 kB, `radix` 78.96 kB, `http` 51.44 kB, `router` 39.13 kB, `icons` 22.64 kB) and all route-level lazy chunks still emitted (e.g. `SettingsPage` 55.16 kB, `ReportEditorPage` 17.14 kB, `VisitDetailPage` 14.40 kB). No new Vite size warning.

**Production browser smoke test** (`npx vite preview --port 4173` + real browser): the login page rendered fully; all 6 JS chunks + CSS loaded (`index`, `react`, `http`, `icons`, `radix`, `router`, `index.css`) with no `loadFailed` and no chunk/module errors in the console. The only console message was the expected offline backend API 500 (`/api/v1/auth/refresh` / `/api/v1/setup/status`, `ECONNREFUSED` with no backend running). Lazy loading and vendor chunking remain intact; report iframe sandbox and all application behavior are unchanged (no source files touched).

**No runtime dependency was moved to devDependencies** — `web/package.json` `dependencies` vs `devDependencies` are unchanged from Phase 4.

## 7. Unresolved vulnerabilities and residual risk

- **All 5 findings remain open** because there is no patched picomatch release. Risk is limited to dev/build tooling, with no untrusted-input reachability and no production exposure ([`npm audit --omit=dev` = 0]). Availability-only impact (CWE-1333 ReDoS); no confidentiality/integrity impact; EPSS 0.335%.
- **Proposed breaking change (requires explicit approval, NOT applied):** `npm audit fix --force` would downgrade to `vitest@3.1.4` (and `vite@6.2.7` via the vite finding). Do not run it without a reviewed decision; it is a semver-major toolchain downgrade that would require re-baselining Phase 4 and is not guaranteed to clear an advisory spanning all picomatch `<= 4.0.7`.
- **Recheck trigger:** re-run `npm audit` when picomatch publishes a version `> 4.0.7` (or vite/vitest release with a non-vulnerable picomatch). A minimal `overrides` bump of `picomatch` to that fixed version would then be the preferred small fix; alternatively a reviewed, tested bump of the Vite/Vitest toolchain.
- **Compatibility limitation:** npm's audit "fixAvailable" metadata is advisory-only here; it suggests downgrades without accounting for this project's Vite 7 / Vitest 5 configuration or the fact that the advisory covers all released picomatch versions. No peer-dependency conflict was introduced because nothing was changed.

## 8. Files and preservation

- **New:** `docs/PRODUCTION_READINESS_DEPENDENCY_REMEDIATION.md` (this file).
- **Modified:** `docs/PRODUCTION_READINESS_BASELINE.md` (reference link only).
- **Not modified:** `web/package.json`, `web/package-lock.json`, any `web/src/**` file, any backend file, any report/template/block/auth/API file. No lockfile regeneration or deletion. No destructive Git command, commit, or deployment.

`git status --short` was reviewed: every pre-existing modified and untracked file from Phases 0–4 (including all React/test/a11y changes, `backend/src/lib/htmlPdf.ts`, and the Phase 3/4 reports) remains present and untouched by this task. All work remains uncommitted.

*Status: investigation and documentation complete for review. Awaiting explicit approval before any breaking downgrade. No Phase 5, CI/CD, deployment, or unrelated refactoring was started.*
