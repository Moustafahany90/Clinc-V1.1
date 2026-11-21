# Phase T — Tailscale-only ingress design (repository preparation)

**Date:** 2026-11-21  
**Status:** `REPOSITORY PREPARATION ONLY — NOT DEPLOYED OR RUNTIME-VERIFIED`  
**Scope:** Add the missing Tailscale-only ingress artifacts and a GitHub-pinned deployment helper. No Ubuntu host, firewall, SSH, Tailscale, DNS, TLS, Docker, database, volume, or secret was changed.  
**Companion evidence:** `docs/PRODUCTION_ENVIRONMENT_ASSESSMENT.md`

> This document is a design and operator reference, not a Phase T acceptance report. It does **not** close the Tailscale hostname approval, Phase T report, or any entry in `docs/PRODUCTION_BLOCKER_REGISTER.md`. Runtime acceptance remains `BLOCKED` until the owner executes the verification in §6 on the target host and records the result in a change log.

---

## 1. Why this overlay exists

The shipped public TLS overlay (`docker-compose.tls.yml` + `deploy/Caddyfile`) publishes `0.0.0.0:80` and `0.0.0.0:443` and uses public ACME. That is incompatible with the approved Tailscale-only deployment model. On the assessed host, `ufw` is inactive and the nftables `INPUT` policy is `accept`; applying the public overlay would create public listeners.

The Tailscale overlay keeps the base stack's safe binds:

| Service | Exposure in `docker-compose.yml` | Change in this overlay |
|---|---|---|
| `db` | `127.0.0.1:55432` only | None |
| `backend` | No host port | None |
| `evolution` | No host port | None |
| `web` | `127.0.0.1:8080` only | None |
| `caddy` | Not in base stack | `TAILSCALE_IP:443` only; no port 80 |

---

## 2. New repository artifacts

| File | Purpose |
|---|---|
| `docker-compose.tailscale.yml` | Caddy overlay that publishes only `${TAILSCALE_IP}:443`, mounts the Tailscale Caddyfile read-only, mounts issued certificate files read-only, and keeps the existing Caddy resource limits. |
| `deploy/Caddyfile.tailscale` | Disables `auto_https`, serves only `https://{$CLINIC_DOMAIN}`, uses `{$TAILSCALE_CERT_DIR}/{$CLINIC_DOMAIN}.crt` and `.key`, preserves HSTS and log redaction, and proxies to `web:80`. |
| `scripts/deploy-github-main.sh` | Fails-closed helper that deploys only the current GitHub `main` tip pinned by exact SHA. Dry-run by default; real deployment requires `--apply --confirm DEPLOY`. |
| `scripts/repair-tailscale-caddy.sh` | Narrow, GitHub-pinned in-place repair helper for the Caddy ingress. Restarts only Caddy and never touches DB, migrations, volumes, or other services. Dry-run by default; real repair requires `--apply --confirm REPAIR`. |
| `.env.example` | Adds non-secret `CLINIC_DOMAIN`, `TAILSCALE_IP`, and `TAILSCALE_CERT_DIR` placeholders. |

No production `.env`, private key, token, password, certificate, or patient record is added to the repository.

---

## 3. Required environment contract

Add these to the protected server env file (outside Git):

| Variable | Required value | Secret? |
|---|---|---|
| `CLINIC_DOMAIN` | Approved Tailscale HTTPS name, e.g. `clinic.example.ts.net` | No |
| `TAILSCALE_IP` | This host's IPv4 from `tailscale ip -4`; must be in `100.64.0.0/10` | No |
| `TAILSCALE_CERT_DIR` | Host directory containing `<CLINIC_DOMAIN>.crt` and `<CLINIC_DOMAIN>.key` | No (directory path only) |
| `APP_ORIGIN` | `https://<CLINIC_DOMAIN>` | No |
| `COOKIE_SECURE` | `true` in production | No |
| `TRUST_PROXY` | `1` or greater | No |

The backend's production guards are not bypassed. `APP_ORIGIN` must be the approved HTTPS origin, and the JWT and Evolution keys remain required and outside Git.

Certificate files must be readable by the Caddy container user. The repository does not change host permissions. The owner must issue and place the Tailscale certificate before deployment; do not paste key material into the terminal log, chat, or change record.

---

## 4. Deployment script behavior

`scripts/deploy-github-main.sh` fails closed:

1. Requires `--commit <40-hex-sha>`.
2. Reads `refs/heads/main` from `https://github.com/Moustafahany90/Clinc-V1.1.git` and refuses unless the requested SHA is the current main tip.
3. Clones only from that GitHub URL into a temporary validation directory. It never reads a desktop checkout.
4. Verifies the temporary clone is clean and at the exact commit.
5. Detects the host tailnet IPv4 with `tailscale ip -4` and validates the CGNAT range.
6. Refuses if any Clinic container or project-managed volume already exists. The legacy `clinc_postgres_data` volume is reported and preserved untouched.
7. Refuses if ports `80`, `443`, `55432`, or `8080` are already listening.
8. Renders the Compose configuration and asserts that the only published ports are Caddy `443` on the tailnet IP and loopback `db`/`web`. No public `0.0.0.0` or `::` binding is accepted.
9. Checks that the Tailscale Caddyfile disables automatic HTTPS and has no HTTP site block or redirect listener.
10. With `--apply --confirm DEPLOY`, installs the pinned checkout under the single approved root `/opt/clinic`, installs the protected env file with mode `0600`, starts the stack, and rechecks live published ports.

Without `--apply`, steps 1–9 run and the script exits without touching `/opt/clinic`, Docker, DNS, TLS, firewall, or Tailscale.

---

## 5. Operator usage (after separate Stage 2 approval)

Owner executes on the Ubuntu host. Replace the SHA with the CI-green main commit recorded in the change log.

### 5.1 Dry run — no production change

```bash
cd /opt/clinic 2>/dev/null || true
bash <(curl -fsSL https://raw.githubusercontent.com/Moustafahany90/Clinc-V1.1/main/scripts/deploy-github-main.sh) \
  --commit <CI_GREEN_MAIN_SHA> \
  --env-file /etc/clinic/clinic.env
```

Run the script from the pinned checkout instead of `raw.githubusercontent.com` if the change record requires the script itself to be commit-pinned:

```bash
sudo git clone --depth 1 --branch main https://github.com/Moustafahany90/Clinc-V1.1.git /tmp/clinic-deploy-helper
cd /tmp/clinic-deploy-helper
git checkout --detach <CI_GREEN_MAIN_SHA>
bash scripts/deploy-github-main.sh --commit <CI_GREEN_MAIN_SHA> --env-file /etc/clinic/clinic.env
```

### 5.2 Gated apply — production change

```bash
bash scripts/deploy-github-main.sh \
  --commit <CI_GREEN_MAIN_SHA> \
  --env-file /etc/clinic/clinic.env \
  --apply --confirm DEPLOY
```

Do not run this command until Stage 2 is explicitly approved, the exact commit is CI-green, the protected env file exists, Tailscale certificate files are in place, and the change record names a rollback decision owner.

### 5.3 Caddy-only repair after an initial install

The initial release used the host certificate directory variable directly inside the Caddyfile. Because Compose bind-mounts that host directory at `/etc/tailscale/certs`, Caddy looked for the certificate at a non-existent path inside the container and restarted. The pinned fix uses the fixed mounted path and adds a repair helper for existing installs.

The repair helper is also GitHub-only and commit-pinned. It requires both the currently deployed SHA and a newer CI-green GitHub `main` SHA, validates ingress files and port shape from a temporary GitHub clone, then restarts only `caddy`:

```bash
# Dry run first — no production change
bash /usr/local/bin/clinic-repair-tailscale-caddy.sh \
  --commit <NEW_CI_GREEN_MAIN_SHA> \
  --expected-current <CURRENTLY_DEPLOYED_SHA> \
  --env-file /etc/clinic/clinic.env

# Gated repair — Caddy only
bash /usr/local/bin/clinic-repair-tailscale-caddy.sh \
  --commit <NEW_CI_GREEN_MAIN_SHA> \
  --expected-current <CURRENTLY_DEPLOYED_SHA> \
  --env-file /etc/clinic/clinic.env \
  --apply --confirm REPAIR
```

The original `deploy-github-main.sh` remains intentionally first-install-only: it refuses when Clinic containers or project volumes already exist. Use the repair helper for an existing install rather than rerunning the initial apply.

---

## 6. Required runtime verification (owner executes after apply)

All commands are read-only. Do not paste certificates, keys, tokens, cookies, patient data, or raw request bodies into the change record.

```bash
# 1. Artifact identity and clean tree
git -C /opt/clinic rev-parse HEAD
git -C /opt/clinic status --porcelain

# 2. Published ports: expect only the tailnet IP on 443 plus loopback db/web
sudo ss -ltnp | grep -E ':(80|443|55432|8080)\b'

# 3. Stack status and compose project
cd /opt/clinic
sudo docker compose -f docker-compose.yml -f docker-compose.tailscale.yml ps
sudo docker compose ls

# 4. Certificate is the expected Tailscale-issued identity (fingerprint only)
sudo openssl x509 -in "$TAILSCALE_CERT_DIR/$CLINIC_DOMAIN.crt" -noout -subject -issuer -fingerprint -dates

# 5. Health and HTTPS from another tailnet device
curl --fail --silent --show-error "https://$CLINIC_DOMAIN/healthz"
```

Acceptance requires: no `0.0.0.0:80`, `0.0.0.0:443`, `:::80`, or `:::443`; no backend/evolution host port; expected certificate name and validity; `/healthz` `200` over the tailnet; and no credential headers or query strings in Caddy logs.

---

## 7. Repository-only validation performed

The following checks were run on the preparation checkout with synthetic, non-production values only:

| Check | Result |
|---|---|
| `bash -n scripts/deploy-github-main.sh` | PASS |
| `docker compose -f docker-compose.yml -f docker-compose.tailscale.yml config --quiet` | PASS |
| `caddy validate` with a disposable self-signed certificate | PASS (`Valid configuration`; automatic HTTPS reported disabled) |
| Rendered published ports | `db` `127.0.0.1:55432`, `web` `127.0.0.1:8080`, `caddy` `100.64.0.1:443` (synthetic tailnet IP) |
| `node scripts/secret-scan.mjs` | No actionable findings; only the two pre-existing allowlisted fixtures |
| `bash scripts/p97-readiness-preflight.sh` | PASS (repository invariants only, not production readiness) |

These checks prove repository syntax and the intended port shape. They are not target-host acceptance evidence.

---

## 8. Explicit non-claims

- No production deployment was performed to produce this document.
- No Tailscale certificate was issued, copied, or inspected.
- No HTTPS hostname was formally approved by the owner here.
- No firewall, SSH, Tailscale, DNS, systemd, Docker, database, backup, or monitoring setting was changed.
- No backup, restore, PITR, migration, image-scan, or alert-drill blocker is closed by this document.
- The deployment script was syntax-checked and its Compose output was validated with synthetic values during repository preparation; it has not been executed against the Ubuntu target.

**Stage 2 remains gated on explicit owner approval and the remaining blocker-register decisions.**
