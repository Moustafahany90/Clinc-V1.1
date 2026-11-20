# Production Readiness — Phase 5: Docker, Deployment & Infrastructure Security (2026-11-17)

## 1. Executive summary

**Overall status: COMPLETE FOR REVIEW — local audit and isolated runtime validation passed. No repository infrastructure change was required or applied. No production environment was touched.**

Phase 5 performed a production-focused infrastructure/deployment security audit of the Ultrasound Clinic Management System, followed by a **local, isolated** image build and runtime verification. The existing Docker/Compose/TLS architecture was found to be well-hardened from earlier phases: non-root backend runtime, loopback-only binds for all internal services, enforced production config guards, no secrets in build contexts or images, persistent named volumes, dependency-ordered health checks, and a valid Caddy TLS front door with automatic HTTP→HTTPS redirect. The later mandatory-core Evolution work and final refinement in §18 made Evolution an internal-only default stack service while deliberately decoupling backend startup from its health.

**Critical/High findings: none.** No unsafe port exposure, no secret leakage, no missing health checks on critical services, and no missing mandatory-variable validation were found.

All verification gates passed:
- Compose config valid for base, TLS overlay, mandatory Evolution, and combined configurations (exit 0), including the final decoupled-startup check in §18.
- All three production images built locally (exit 0); image inspection confirmed correct entrypoints/user/ports and no dev tooling or secrets in runtime layers.
- Isolated stack started cleanly (db healthy → migrate exit 0 → backend healthy → web healthy); SPA rendered; `/api` proxy, backend readiness and DB connectivity verified; a full synthetic setup→login workflow succeeded; persistence across restarts verified; 19 KB of logs scanned with **no secret leakage**.
- Caddyfile validation passed with `Valid configuration` (auto TLS + HTTP→HTTPS redirect confirmed).

**Original Phase 5 changes to the repository: NONE** (other than this report and the baseline reference). Later Evolution-core work and the final refinement in §18 changed `docker-compose.yml` and operations documentation, but no production deployment was performed. Findings that would require approval are documented in §14 as unresolved/recommended hardening; none were applied. Image-level CVE scanning was **not performed** because no scanner is installed (§11). Deployment is **not** marked verified — no authorized production deployment occurred.

## 2. Initial infrastructure architecture

Baseline captured before any action: branch `feature/clinic-quick-actions`, last commit `fd128f5 feat(quick-actions-ui): add statistics actions (10-13) and final UI polish`. All pre-existing modified/untracked files from Phases 0–4 were present and were preserved.

Deployment topology (from `docs/operations.md` and Compose files):

```
Browser --HTTPS(443)--> Caddy --HTTP--> web/nginx:80 --/api/v1--> backend:4000 --> Postgres:5432
```

**Container inventory (base stack):** `db` (postgres:16-alpine), `migrate` (build target `build`, one-shot `prisma migrate deploy`), `backend` (Node 22 bookworm-slim, runtime stage), `web` (nginx:1.30-alpine serving Vite `dist`), and mandatory `evolution` (evoapicloud/evolution-api:v2.3.7, no profile). TLS overlay adds `caddy` (caddy:2.11-alpine).

**Network boundaries:** single user-defined bridge network `clinic_net` (all services). Internal services use container DNS; only Caddy is intended to be publicly reachable (TLS overlay only).

**Persistent storage:** named volumes `ultrasound_clinic_db_data` (Postgres), `ultrasound_clinic_storage` (uploads/generated files, mounted at `/app/storage`), `ultrasound_clinic_evolution_instances` (WhatsApp session); TLS overlay adds `caddy_data` / `caddy_config`. All pinned to explicit names.

**Published ports (rendered config; updated for mandatory-core task):** `db` → `127.0.0.1:55432:5432`; `web` → `127.0.0.1:8080:80`; `backend` → none; `evolution` → none (internal `clinic_net` only, mandatory core service); `caddy` → `0.0.0.0:80` and `0.0.0.0:443` (only in TLS overlay). **No unexpected public bindings.**

**Existing security controls observed (not assumed secure — individually verified below):** loopback binds, non-root backend, `.dockerignore` secret exclusions, production env guards in `backend/src/config/env.ts`, internal-only API-key-authenticated Evolution (mandatory core), json-file log capping, health checks, security headers in nginx, HSTS in Caddyfile.

**Operational limitations noted:** single flat network (no edge/data segmentation), no resource limits, no `no-new-privileges`, digest-less base image tags, backup encryption is manual/off-script (Phase 6 scope), no CI enforcement.

## 3. Dockerfile audit

| Check | Backend (`backend/Dockerfile`) | Web (`web/Dockerfile`) | Migrate (build target) |
|---|---|---|---|
| Base images | `node:22-bookworm-slim` (glibc for Playwright/Chromium); official, maintained, major pinned | `node:22-alpine` build → `nginx:1.30-alpine` runtime; official, major/minor pinned | same as backend base |
| Floating `latest` | none | none | none |
| Multi-stage | yes (`base`→`build`→`runtime`) | yes (`build`→`runtime`) | uses `build` stage |
| Dev tooling in runtime | none — `npm ci --omit=dev`; Prisma CLI packages removed; verified `vitest`/`vite`/`prisma` absent in image | none — only `/app/dist` copied; no package.json/src in served root | n/a (dev tooling expected, one-shot, not published) |
| `.env` / secrets in layers | no — `backend/.dockerignore` excludes `.env`, `.env.*`; `find /app -name '.env*'` empty in image | no — `web/.dockerignore` excludes `.env`, `.env.*`; only static assets served | no |
| Non-root | **yes** — `USER node`; `/app/storage` `chown -R node:node`, mode 755 (verified) | nginx workers run as `user nginx;` (verified in `/etc/nginx/nginx.conf`); master root is standard for binding port 80 (internal) | root (one-shot, not published) |
| Writable dirs | `/app/storage` (+ uploads/tmp), owned by node — intentional, backed by persistent volume | none required (static) | none |
| Runtime deps present | Prisma Client generated files present; Chromium `chromium-1248` present at `/ms-playwright`; `dist/index.js` present | 20 static asset files incl. all vendor/lazy chunks | Prisma CLI present (intended) |
| HEALTHCHECK in image | no (Compose healthcheck used) | yes (`wget .../healthz`) | no (one-shot) |
| Privileged / caps | none | none | none |

Image digests built locally (before cleanup): web `sha256:61e91cc…`, backend `sha256:64d2c33c…`, migrate `sha256:61142265…`. Sizes: web 93.8 MB, backend 2.31 GB (Chrome/toolchain), migrate 1.25 GB.

`docker history` scan found no `.env`/secret/blanket-install patterns. The only "env" match was the stock nginx base file `15-local-resolvers.envsh`, which is a DNS resolver config, not a secret.

## 4. Compose security audit

Per-service summary from rendered config:

| Service | Image/build | Ports | Volumes | Health | Restart | User | Secopt / limits | Depends on |
|---|---|---|---|---|---|---|---|---|
| db | `postgres:16-alpine` | `127.0.0.1:55432` | `db_data` | yes (pg_isready) | unless-stopped | image default (postgres) | none | — |
| migrate | build `backend` target `build` | none | none | no (one-shot) | `"no"` | root | none | db (healthy) |
| backend | build `backend` runtime | none (internal only) | `clinic_storage` | yes (`/healthz`) | unless-stopped | node (Dockerfile) | none | db (healthy), migrate (completed); Evolution intentionally not a startup dependency (§18) |
| web | build `web` runtime (+`VITE_API_URL`) | `127.0.0.1:8080` | none | yes (`/healthz`) | unless-stopped | nginx workers | none | backend (healthy) |
| evolution | `evoapicloud/evolution-api:v2.3.7` | none (internal) | `evolution_instances` | yes (`GET /manager/` → 200) | unless-stopped | image default | none | db (healthy) |
| caddy (TLS overlay) | `caddy:2.11-alpine` | `0.0.0.0:80`, `0.0.0.0:443` | Caddyfile `:ro`, `caddy_data`, `caddy_config` | no | unless-stopped | image default | none | web (healthy) |

- **Network isolation:** Postgres is not public (loopback), backend has no published port, all internal traffic stays on `clinic_net`; Evolution is mandatory core, starts by default, is internal-only with no host port, and has API-key auth; no Redis service (Evolution local cache used).
- **Startup ordering:** strict condition chain for DB/migrations (`db healthy` → `migrate completed` → `backend healthy` → `web healthy` → `caddy`). Evolution starts in parallel as a mandatory service but is intentionally not a backend startup dependency; final verification in §18 proves backend/web become healthy while Evolution is unhealthy.
- **Restart behavior:** `unless-stopped` on long-running services; migrations never re-run automatically as a service loop. Host-reboot recovery was exercised when Docker Desktop crashed and restarted: all isolated containers auto-restarted and returned healthy.
- **Resource protection:** no CPU/memory limits configured anywhere (deliberate — arbitrary limits risk breaking Chromium/PDF, DB, and report generation). Documented as a residual/capacity decision in §14.

## 5. Network and port exposure inventory

| Port | Service | Bind | Exposure | Notes |
|---|---|---|---|---|
| 443/tcp | caddy | `0.0.0.0` | **public (intended)** | TLS termination; only in TLS overlay |
| 80/tcp | caddy | `0.0.0.0` | public (intended) | HTTP→HTTPS redirect; only in TLS overlay |
| 8080/tcp | web/nginx | `127.0.0.1` | loopback only | base stack; TLS path reaches container `web:80` internally |
| 55432/tcp | db | `127.0.0.1` | loopback only | non-standard host port |
| (none) | evolution | container only | internal | no host publish; mandatory core service on `clinic_net` |
| 4000/tcp | backend | container only | internal | no host publish |

**Conclusion:** no internal service or management port is published to public interfaces. Evolution management UI/API, Postgres, and backend are never internet-reachable in the shipped configuration; Evolution now has no host port at all.

## 6. Persistent volume and data safety audit

- `ultrasound_clinic_db_data` → Postgres data directory — persistent, named, versioned by `migrate` service.
- `ultrasound_clinic_storage` → `/app/storage` in backend — uploads and generated files; explicitly identified writable path, owned by `node`. Not statically served by nginx (files stream only through authorized API endpoints).
- `ultrasound_clinic_evolution_instances` → WhatsApp session; backed up alongside DB per `docs/operations.md`.
- `caddy_data` / `caddy_config` → certificates and Caddy config (TLS overlay).
- No volume is shared between unrelated services; container recreation does not remove data.

**Verification (isolated):** wrote marker `/app/storage/.phase5_marker`, restarted backend → marker persisted; restarted db → 7 migrations still present, setup data intact, `/healthz` returned `database: reachable`; setup workflow wrote a user row that persisted (count = 1). **No `docker compose down -v`, no volume deletion, no destructive Docker operations were performed.** The two synthetic test volumes (`phase5audit_db_data`, `phase5audit_storage`) were intentionally retained after cleanup.

## 7. Reverse proxy and TLS findings

**Caddy (`deploy/Caddyfile`, `docker-compose.tls.yml`):**
- `{$CLINIC_DOMAIN}` site block; Caddy obtains/renews public certificates automatically. Validation output explicitly confirmed "adding one to enable TLS" and "enabling automatic HTTP->HTTPS redirects" — HTTPS is on and HTTP redirects.
- HSTS `max-age=31536000; includeSubDomains` present (no `preload`, acceptable).
- `encode zstd gzip`; `reverse_proxy web:80` with `header_up X-Real-IP {remote_host}` (correct client-IP handling for `TRUST_PROXY=1`).
- No self-signed dev cert in production config; LAN-only `tls internal` is documented as an explicit opt-in.
- `caddy validate --config /etc/caddy/Caddyfile` (image `caddy:2.11-alpine`): **Valid configuration**, exit 0.
- No Caddy healthcheck (Low, §14).

**nginx (`web/nginx.conf`):**
- `/api/` proxies to `http://backend:4000` with HTTP/1.1, forwarded headers, 120 s read/send timeouts, buffering off for uploads/blobs — verified working end-to-end.
- `client_max_body_size 32m` (aligned with `MAX_UPLOAD_MB=25` + multipart overhead).
- Response headers on all paths (verified live): `Cache-Control: no-store, must-revalidate` (API/HTML), immutable caching for `/assets/`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and CSP with `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Report iframe sandbox left **unchanged**: `sandbox="allow-same-origin allow-modals"` with `srcDoc` and no `allow-scripts` (verified in `web/src/components/ReportDocumentFrame.tsx`, `ReportTemplatesCard.tsx`, `ReportPrintPage.tsx`). The `frame-ancestors 'none'` header does not block `srcDoc` frames, so printing remains functional. No header was weakened.
- Sensitive endpoints: backend metrics/health (`/healthz`, `/api/v1/readyz`) expose only status, uptime, DB reachability, and audit failure counters — **no secrets** (verified in `backend/src/app.ts` and live output). Postgres/Evolution/backend management interfaces are not public.

## 8. Environment/secrets audit

Inventory built from `.env.example`, Compose environment declarations, and `backend/src/config/env.ts` (values of real `.env`/`backend/.env` were **never printed**; only names and placeholder/configured status were classified).

Required secrets: `POSTGRES_PASSWORD` (Compose `:?` guard), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (Compose `:?` guards + schema min 32 chars), `CLINIC_DOMAIN` (TLS overlay `:?` guard). `DATABASE_URL` is required by the backend schema and is constructed by Compose from `POSTGRES_*` (never stale).

Production guards verified in code (`backend/src/config/env.ts`, `superRefine`, `process.exit(1)` on failure): `APP_ORIGIN` must be absolute and `https://` in production; `COOKIE_SECURE` must be true; `TRUST_PROXY` ≥ 1; access/refresh secrets distinct and ≥ 32 chars; placeholder regex `/(change[-_ ]?me|replace[-_ ]?me|example|development|test-only|insecure)/i` rejects placeholder JWT/Evolution secrets; Evolution enabled requires URL + key + instance name; invalid config exits 1. **Missing/unsafe mandatory production variables cause startup failure — confirmed.**

- `.env.example` contains placeholders only; `EVOLUTION_API_ENABLED=false` default (working-tree change from earlier phase, preserved). The real `.env` values are configured (non-placeholder) — not displayed.
- `VITE_API_URL` is the **only** `VITE_*` variable in the frontend (`web/src/lib/api.ts`), and it is intentionally non-secret (empty → same-origin `/api/v1`). No secret is exposed to the browser bundle.
- No secret files are copied into images (verified in image filesystem and history). No secret appears in image `Env` (backend keys: `PATH, NODE_VERSION, YARN_VERSION, NODE_ENV, PLAYWRIGHT_BROWSERS_PATH`; web: stock nginx keys only).
- No credential rotation was performed.

## 9. Production image build results

Commands: `docker compose -p phase5audit --env-file <synthetic.env> -f docker-compose.yml -f <isolated.override.yml> build --progress plain` → **BUILD_EXIT=0**.

- `phase5audit-migrate:latest` built (1.25 GB), `phase5audit-backend:latest` (2.31 GB), `phase5audit-web:latest` (93.8 MB).
- Backend build ran `npm ci --omit=dev`, removed Prisma CLI packages, `playwright install --with-deps chromium`, created/chowned storage, `USER node`.
- Web build ran `npm ci` + `vite build`: 1782 modules, main entry `index-D5zX1uUf.js` = **230.41 kB** (gzip 59.16 kB), matching the Phase 4 baseline of 230.40 kB; all vendor chunks (`react` 165.21 kB, `radix` 78.96 kB, `http` 51.44 kB, `router` 39.13 kB, `icons` 22.64 kB) and all lazy route chunks present; **no chunk-size warning**.
- No images were pushed to any registry. Pre-existing `ultrasound-clinic-*:latest` image IDs were unchanged (web `4925a4c949cd`, backend `fb34d609826b`, migrate `2a8db541c0d5`).

## 10. Runtime verification results

**Method:** fully isolated Compose project `phase5audit`, distinct network `phase5audit_net`, distinct volumes, host ports `127.0.0.1:8081`/`127.0.0.1:55433`, synthetic DB/secrets (`clinic_audit`/`audit_user`, generated JWT secrets), `EVOLUTION_API_ENABLED=false`, no production credentials, no WhatsApp, no real patients.

| # | Check | Result |
|---|---|---|
| 1 | Containers start | PASS — db healthy → migrate exited 0 → backend healthy → web healthy |
| 2 | Health checks healthy | PASS — db/backend/web all `healthy` |
| 3 | Frontend serves login/setup page | PASS — real browser rendered "A clean start for your clinic records" setup wizard from Docker-served SPA |
| 4 | Frontend `/api` proxy | PASS — `/api/v1/setup/status` and `/api/v1/readyz` returned 200 through nginx → backend |
| 5 | Backend readiness | PASS — `/healthz` and `/api/v1/readyz` returned `status: ok`, `database: reachable`, HTTP 200 |
| 6 | Database connectivity | PASS — `prisma.$queryRaw SELECT 1` succeeded; setup write persisted (1 user) |
| 7 | Synthetic basic workflow | PASS — `POST /api/v1/setup/` → HTTP 201 (admin + clinic created, setup locked), then `POST /api/v1/auth/login` → HTTP 200 with access token (token value redacted from logs/report) |
| 8 | PDF/Chromium | PASS (launch-level) — Playwright Chromium launched successfully in backend container (`chromium.launch({args:['--no-sandbox']})`, page created, browser closed cleanly). Full report PDF generation with synthetic clinical data was not executed (would require seeded reports; out of scope). |
| 9 | Restart persistence | PASS — storage marker + 7 migrations + setup data survived db/backend restarts; containers also auto-recovered healthy after a local Docker Desktop crash |
| 10 | Logs no secrets | PASS — 19,115 bytes scanned across 4 containers; synthetic DB password, both JWT secrets, DB URL, admin password, and JWT token patterns all absent |

The only browser console error was the expected `POST /api/v1/auth/refresh` 500 on first load with no refresh cookie (logged as a structured `request.failed` event, no secrets). During a deliberate db restart the backend logged transient Prisma connection errors but did not crash, then re-listened — matching the documented "transient DB outage must not prevent API from starting" behavior. Graceful `SIGTERM` shutdown was observed.

**Cleanup:** `docker compose ... down` **without `-v`** removed isolated containers + network; isolated images removed; synthetic volumes retained (no volume deletion). Pre-existing containers/images untouched.

## 11. Image vulnerability scan results

**Not performed — explicit limitation.** No image vulnerability scanner is installed (`trivy`, `grype`, `dockle`, `hadolint` all absent). Per constraints, no scanner was installed globally. Therefore images are **not** claimed vulnerability-free, and OS/Node package CVE counts, fixed versions, and runtime-layer exploitability were not assessed.

Recommended command for a later approved run (after rebuilding images locally):

```bash
trivy image --severity CRITICAL,HIGH,MEDIUM,LOW \
  ultrasound-clinic-backend:latest \
  ultrasound-clinic-web:latest \
  ultrasound-clinic-migrate:latest
```

Note: base images were resolved to digests during build (BuildKit output, e.g. `node:22-bookworm-slim@sha256:e9f565…`, `nginx:1.30-alpine@sha256:901e59…`, `node:22-alpine@sha256:1314fb…`), which are suitable inputs for a digest-pinned scan.

The previously documented 5 dev-only `picomatch` ReDoS findings (`npm audit`) remain an **accepted residual risk** with zero production exposure (`npm audit --omit=dev` = 0); no Vite/Vitest downgrade was applied (see `PRODUCTION_READINESS_DEPENDENCY_REMEDIATION.md`).

## 12. Reliability findings

- **Graceful shutdown:** backend handles `SIGTERM`/`SIGINT` → `server.close()`, `prisma.$disconnect()`, 5 s exit fallback (`backend/src/index.ts`); observed in logs.
- **DB readiness/ordering:** condition-based `depends_on` prevents the API starting before migrations complete; verified live.
- **Startup after reboot:** `unless-stopped` policies auto-restarted isolated containers to healthy after a Docker Desktop crash.
- **Transient DB outage tolerance:** startup `getClinicSettings().catch(() => undefined)` prevented a crash during DB restart; recovery confirmed.
- **Logging/rotation:** json-file driver capped at 10 MB × 5 files on every service; no secrets logged (§10).
- **Storage permissions:** `/app/storage` owned `node:node` mode 755; writable path is explicit and volume-backed.
- **Chromium cleanup:** `htmlPdf.ts` launches with `--no-sandbox` and closes the browser in `finally` (`browser?.isConnected()` check), limiting orphan processes.
- **Manual dependencies (documented, not implemented):** first-run setup wizard; backup script (`scripts/backup.sh`) is manual and does not encrypt — off-host encryption/retention and quarterly restore drills (`scripts/restore-drill.sh`) are operational responsibilities; no backup/restore implementation was done in this phase (Phase 6 scope).

## 13. Changes applied and justification

**Original Phase 5 audit changed no infrastructure, application, or dependency file.** The audit found the existing configuration already met the security requirements, so the only "safe fix" decision was to avoid unnecessary changes. No fix requiring approval was applied.

Files created/updated by the original phase (documentation only):
- **Created:** `docs/PRODUCTION_READINESS_PHASE5.md` (this report).
- **Updated:** `docs/PRODUCTION_READINESS_BASELINE.md` (Phase 5 reference + remaining infra risks only).

Subsequent uncommitted Evolution-core work changed `docker-compose.yml`, `.env.example`, `SECURITY.md`, `docs/operations.md`, `backend/src/lib/whatsapp.ts`, and the baseline/report docs; §18 documents the final refinement. No Caddyfile, nginx config, lockfile, commit, or push was produced by this work.

## 14. Unresolved risks

Classified per the required categories. **None were changed in this phase.**

| # | Finding | Severity | Classification |
|---|---|---|---|
| 1 | Image-level CVE scanning not performed (no scanner installed) | — | **Not tested** — limitation; exact command in §11 |
| 2 | 5 dev-only `picomatch` ReDoS audit findings; no upstream patch exists | High (dev only) | **Accepted residual risk** — 0 prod exposure; do not downgrade Vite/Vitest |
| 3 | No CPU/memory limits on any service | Medium | **Unresolved — requires approval** — limits need capacity planning to avoid breaking Chromium/PDF/DB |
| 4 | No `security_opt: no-new-privileges: true` on services | Medium/Low | **Accepted residual risk / recommended hardening** — not applied speculatively; would need runtime re-verification |
| 5 | Base images pinned to tags, not SHA digests | Low/Medium | **Unresolved — requires approval** — digest pinning is an architectural/supply-chain change |
| 6 | Single flat `clinic_net` (no edge/data network segmentation) | Low/Medium | **Accepted residual risk (architectural)** — no exposure path observed; segmentation is a redesign |
| 7 | Caddy service has no healthcheck | Low | **Accepted residual risk** — Caddy is a simple proxy; web upstream health is already gated |
| 8 | Web nginx master runs as root (workers non-root) | Low | **Accepted residual risk** — standard nginx pattern; port 80 is internal only |
| 9 | Evolution `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "true"` exposes key via its API to authenticated callers | Low | **Accepted residual risk** — now internal-only with API-key auth; changing it risks breaking integration, needs approval |
| 10 | `read_only` root filesystem not enabled | Low | **Accepted residual risk** — app writes `/app/storage` and Chromium needs temp; requires tmpfs design |
| 11 | Backups not encrypted by script; manual off-host encryption/retention | Medium (operational) | **Accepted residual risk / Phase 6 scope** — integration requirements recorded in §7/§12 |
| 12 | Local Docker Desktop crashed once during testing (recovered automatically) | Info (local env) | **Accepted residual risk** — local environment instability, not a deployment finding |
| 13 | Transient Prisma connection errors in logs during DB restart | Info | **Accepted residual risk** — no secrets, graceful recovery observed |
| 14 | `EVOLUTION_API_KEY` unset warning during earlier isolated config render | Info | **Superseded** — the key is now required by Compose for Evolution's API-key auth; synthetic values used in isolation |

**No Critical or High infrastructure findings** were identified in the shipped configuration.

## 15. Commands executed and actual results

| Command / check | Result |
|---|---|
| `git status --short`, `git branch --show-current`, `git log -1 --oneline` | Branch `feature/clinic-quick-actions`; last commit `fd128f5…`; all pre-existing modified/untracked files present and preserved |
| `docker version` / `docker compose version` | Client 29.9.3, API 1.56, daemon initially unavailable → started local Docker Desktop → Server 29.9.3; Compose v5.7.0 |
| `docker compose config --quiet` (base) | exit 0 |
| `docker compose -f docker-compose.yml -f docker-compose.tls.yml config --quiet` | exit 0 |
| `docker compose config --quiet` (Evolution now included by default; no profile) | exit 0 |
| base + tls combined `config --quiet` | exit 0 |
| Rendered port/volume/network/env-name inventory | db/web loopback, backend internal, caddy public only; volumes/network correctly isolated in test override |
| Secret-classified `.env` / `backend/.env` inspection | names + placeholder status only; no values printed |
| `docker compose ... build --progress plain` | **exit 0**, 3 images built (digests/sizes in §9) |
| `docker image inspect` (Config only, env keys not values) | backend user `node`, Cmd `node dist/index.js`, port 4000; web `nginx -g daemon off;`, port 80, healthcheck; no secret env |
| Filesystem checks inside images | Prisma client + Chromium + `dist/index.js` present; vitest/vite/prisma CLI absent; no `.env`; storage `node:node 755`; web serves 20 static assets only |
| `docker history` (no-trunc, filtered) | no secret/blanket-install patterns |
| Isolated `docker compose ... up -d` | db healthy → migrate exit 0 → backend healthy → web healthy |
| curl frontend `/`, `/healthz`, `/api/v1/readyz`, `/api/v1/setup/status` | SPA shell served; `ok` (200); backend JSON `status: ok, database: reachable` (200); setup JSON (200) |
| Browser render of Docker-served SPA | setup wizard rendered; only expected no-token `/auth/refresh` 500 |
| Playwright Chromium launch in backend container | `CHROMIUM_OK` |
| Synthetic `POST /api/v1/setup/` and `/api/v1/auth/login` | 201 (admin+clinic created, DB row persisted), 200 (token issued) |
| Restart persistence (marker + migration count + data) | marker persisted; 7 migrations; setup data intact; health restored |
| Log secret scan (`docker logs` × 4) | 19,115 bytes scanned; no secrets/tokens found |
| `docker inspect` HostConfig (runtime containers) | no privileged, no added caps, no read-only rootfs, no resource limits (as configured) |
| `caddy validate --config /etc/caddy/Caddyfile` (caddy:2.11-alpine) | `Valid configuration`, exit 0; auto TLS + HTTP→HTTPS redirect confirmed |
| `trivy` / `grype` / `dockle` / `hadolint` availability | all not installed → image CVE scan not performed |
| Pre-existing image ID check after tests | unchanged (web `4925a4c949cd`, backend `fb34d609826b`, migrate `2a8db541c0d5`) |
| Final `git status --short` | only the two documentation files added/updated by this phase; all prior work preserved |

## 16. Files changed

- **Created:** `docs/PRODUCTION_READINESS_PHASE5.md`
- **Updated:** `docs/PRODUCTION_READINESS_BASELINE.md` (Phase 5 reference + remaining infra risks; later Evolution-core wording updated)
- **Later uncommitted work:** `docker-compose.yml`, `docs/operations.md`, and this report's §18 (final refinement); the earlier Evolution-core task also updated `.env.example`, `SECURITY.md`, and `backend/src/lib/whatsapp.ts`.

Temporary verification artifacts were created **outside the repository** in `C:\Users\Moustafa\AppData\Local\Temp\opencode\phase5\` and `...\evoaudit\` (synthetic env, isolated overrides, test logs, fixed-clock diagnostic, build log). They contain only synthetic data and are not part of the project.

## 17. Production actions explicitly not performed

- No connection to or modification of any production database; no reset/migrate/seed/truncate/delete of production data (all migration/setup work used an isolated synthetic DB and volumes).
- No modification of production credentials/secrets; no credential rotation.
- No deployment, restart, stop, or reconfiguration of any live production service.
- No DNS, firewall, router, or public TLS setting change; no public infrastructure change; no new externally reachable listener (test ports were loopback-only; the public Caddy ports were examined only as static config).
- No real WhatsApp message sent and no real patient contacted. All WhatsApp behavior was verified with mocked provider traffic or read-only status calls against an isolated synthetic Evolution instance.
- No internal service/management port exposed to a public network.
- No `docker compose down -v`, no volume deletion, no destructive Docker operation.
- No destructive Git command (`reset --hard`, `clean`, stash, checkout-based discard), no commit, no push.
- No application business logic, report template/block, clinical/financial workflow, auth logic, or frontend UX change; no report iframe sandbox change; no CI/CD or backup/restore implementation (Phase 6 not started).

## 18. Final refinement — Evolution availability and test verification (2026-11-17)

### 18.1 Final startup dependency behavior

Task 1 changed only the backend's Compose startup dependency. `docker-compose.yml` still defines `evolution` as a mandatory service in the default stack with `restart: unless-stopped`, its `/manager/` healthcheck, and internal-only `clinic_net` networking (no host port). The backend now waits only for `db: service_healthy` and `migrate: service_completed_successfully`; the previous `evolution: condition: service_healthy` dependency was removed. A slow or unhealthy Evolution container therefore cannot delay or block the clinic backend, web app, or core workflows.

The bounded retry/error policy in `backend/src/lib/whatsapp.ts` was preserved: three attempts with 250/500 ms backoff for safe connection-level failures and idempotent GET timeouts, no replay of timed-out non-idempotent sends, and clear `WHATSAPP_*` errors after exhaustion.

Compose validation after the change:

| Check | Result |
|---|---|
| `docker compose config --quiet` (base, mandatory Evolution, synthetic values) | exit 0 |
| `docker compose -f docker-compose.yml -f docker-compose.tls.yml config --quiet` (synthetic `CLINIC_DOMAIN`) | exit 0 |
| Isolated images (`evoaudit-backend`, `evoaudit-migrate`, `evoaudit-web`) built from current working tree | exit 0 |

### 18.2 Evidence — backend starts while Evolution is unhealthy

Validation used project `evoaudit`, synthetic credentials, isolated volumes/network/ports, and an extra **temporary override outside the repository** that forces Evolution's healthcheck to fail (`test: ["CMD-SHELL", "exit 1"]`). No production Compose file, container, volume, credential, or service was touched.

`docker compose ... up -d` progressed `db healthy` → `migrate exited 0` → `backend started` → `backend healthy` → `web healthy`, while Evolution was `Up (unhealthy)` throughout. Stable state:

```
evoaudit-backend-1    Up (healthy)
evoaudit-db-1         Up (healthy)
evoaudit-evolution-1  Up (unhealthy)   # forced by isolated test override
evoaudit-web-1        Up (healthy)
```

Core endpoint checks through the isolated web proxy while Evolution was unhealthy:

| Request | Result |
|---|---|
| `GET /healthz` | `200 ok` |
| `GET /api/v1/readyz` | `200 {"status":"ok","database":"reachable",...}` |
| `GET /api/v1/setup/status` | `200` with expected clinic defaults |
| Synthetic `POST /api/v1/setup/` | `201` |
| Synthetic `POST /api/v1/auth/login` | `200`, token issued |

This confirms that DB-backed setup/login/readiness and the web front door remained operational without Evolution health.

### 18.3 Evidence — WhatsApp fails gracefully and recovers

Using the synthetic admin token from the isolated stack, the read-only `GET /api/v1/settings/whatsapp` call was exercised (no report send, no real WhatsApp message):

| Evolution state | Result |
|---|---|
| Isolated Evolution container stopped | `502` with `{"error":{"code":"WHATSAPP_NETWORK_ERROR","message":"WhatsApp service could not be reached after bounded retries."}}` |
| Core endpoints during that outage | `/healthz`, `/api/v1/readyz`, `/api/v1/setup/status` all still `200` |
| Isolated Evolution container started again | First probe `502`, then `200 {"configured":true,"state":"close","instanceName":"evoaudit_clinic"}` |

The forced healthcheck override remained unhealthy during the successful recovery probe, demonstrating that application-level recovery follows provider reachability rather than the Compose health label. No full phone number, QR payload, message, or real patient data was involved.

### 18.4 Investigation — `quick-actions-appointments: patient names are gated by PATIENTS_READ`

The test was run independently against the isolated synthetic `_test` database (`clinic_evoaudit_test`), with no assertions changed and no Quick Actions code modified.

| Run | Cairo time | Result |
|---|---|---|
| Independent run 1 | 2026-11-17 22:28:30 | `# tests 14`, `# pass 12`, `# fail 2`, `# skipped 0` |
| Independent run 2 | 2026-11-17 22:28:59 | identical: 12 pass / 2 fail |
| Diagnostic with external fixed-clock preload (12:00 Cairo) | same source/assertions, no repository change | `# tests 14`, `# pass 14`, `# fail 0`, `# skipped 0` |

The failure is **timing-sensitive, not a nondeterministic race**. The suite configures working hours 08:00–22:00 and seeds today's appointments only from slots returned by `futureSlot()`, which requires `Date.parse(slot.start) > Date.now() + 30_000`. Both real-time runs occurred after 22:00 Cairo, so no future slot existed on "today"; the test therefore seeded zero today appointments and the unchanged assertion requiring `appointments.length > 0` failed. Pinning only the clock to 12:00 Cairo made the same unmodified test pass 14/14. The fixed-clock preload lived outside the repository and was used solely as a diagnostic.

Comparison with prior evidence:

- Phase 3 recorded a fresh isolated baseline of **127/127** plus 14 new tests = **141/141** passing.
- Phase 4 changed no backend code and explicitly recorded that the Phase 3 **141/141** result remained the current backend evidence.
- The current working tree has 144 backend tests; the earlier mandatory-core validation recorded 144 total / 142 pass / 2 fail, with the same Quick Actions subtest and parent suite failing after clinic close.
- The final refinement changed only `docker-compose.yml` and documentation. It did not change `backend/src/lib/whatsapp.ts`, `backend/tests/quick-actions-appointments.test.ts`, or any Quick Actions source. The pre-existing modifications to those files were preserved. No task change can have caused this after-hours failure.

No test was hidden, skipped, or weakened; no unrelated Quick Actions fix was applied.

### 18.5 Test results after the refinement

All runs targeted the isolated synthetic `_test` database; no production DB was accessed.

| Scope | Result |
|---|---|
| WhatsApp files (`whatsapp-delivery.test.ts`, `evolution-whatsapp.test.ts`, `phase3-whatsapp.test.ts`) | **28 tests, 28 passed, 0 failed, 0 skipped** |
| WhatsApp authz test in `authorization-idor.test.ts` | **1 test, 1 passed, 0 failed, 0 skipped** |
| Full backend suite (`npm test`) | **144 tests, 142 passed, 2 failed, 0 skipped** (56.6 s) |

The two full-suite failures were the Quick Actions subtest and its parent suite described in §18.4; every other test passed. One preliminary full-suite attempt used a placeholder-shaped `EVOLUTION_API_KEY` in the harness environment, which correctly triggered the existing production env-validation test; the authoritative rerun used a non-placeholder synthetic key and produced the counts above. This was a test-environment issue, not a product regression.

### 18.6 Remaining risks

- **Evolution remains a single point of failure for WhatsApp delivery.** Core clinic workflows remain available, but status/QR/send operations return `WHATSAPP_*` errors until the provider recovers. Automatic send retries are intentionally bounded and never replay a timed-out document send.
- **The Quick Actions test is still after-hours fragile.** It was deliberately left unchanged under the no-unrelated-fix constraint. A future change should make it clock-independent (for example, by seeding a deterministic future date or injecting a clock) and then re-run the full suite; until then, runs after 22:00 Cairo are expected to show this failure.
- **Synthetic validation only.** No production deployment, production DB access, real WhatsApp message, credential rotation, volume deletion/recreation, or `docker compose down -v` occurred. Session-volume backup and API-key hygiene remain operational responsibilities.
- **Carried-over infrastructure risks** from §14 remain: no image CVE scanner, no resource limits, no `no-new-privileges`, tag-pinned rather than digest-pinned images, flat network, no Caddy healthcheck, and manual/unencrypted backups (Phase 6 scope).
- **Local Docker Desktop instability recurred during validation** and auto-restarted the isolated stack; treated as a local-environment risk, not a deployment finding.
- No commit, push, destructive Git operation, Phase 6 work, report-block/template change, or unrelated workflow change was performed.

*Phase 5 status: complete for review. Deployment is NOT marked verified — no authorized production deployment or operational verification has occurred. Awaiting explicit review/approval before any approval-gated hardening (§14) or Phase 6 work.*
