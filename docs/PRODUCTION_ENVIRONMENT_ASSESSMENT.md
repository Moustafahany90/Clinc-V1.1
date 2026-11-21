# Production Environment Assessment — Clinic-V1.1

**Phase:** D — Stage 1 (Environment Assessment and Readiness)
**Assessment date:** 2026-11-21
**Host evidence timestamp:** 2026-11-21T13:14:14Z
**Project:** Clinic-V1.1 — Ultrasound Clinic Management System
**Deployment target:** Ubuntu Linux, Docker / Docker Compose, `main` branch, Tailscale-only access, Tailscale-approved HTTPS ingress, PostgreSQL
**Scope:** Read-only assessment only. No deployment, installation, configuration change, secret access, migration, or service start/stop was performed.
**Overall Stage 1 status:** `BLOCKED`

> **Post-assessment repository update (option A):** the missing Tailscale artifacts have since been prepared on the repository branch `feature/tailscale-ingress` (`docker-compose.tailscale.yml`, `deploy/Caddyfile.tailscale`, `scripts/deploy-github-main.sh`, and `docs/PHASE_T_TAILSCALE_INGRESS.md`). That branch is not merged to GitHub `main`, has not been deployed, and does not change the assessed production state. Statements below refer to the assessed `main` state unless this note says otherwise.

---

## 0. Method and evidence boundary

| Label | Meaning |
|---|---|
| **Verified now (agent)** | Checked directly by this agent on 2026-11-21 (GitHub, Git, CI, local repository/files). |
| **Owner-executed (2026-11-21 13:14Z)** | Read-only command block executed by the owner on the Ubuntu server and pasted back. This is current-state host evidence, but it is **not** an agent SSH session. Raw content is summarized in Appendix A. |
| **Owner evidence (2026-11-20)** | Historical terminal output recorded in `docs/PRODUCTION_READINESS_PHASE8_3_1.md`; not revalidated except where superseded by the 13:14Z output. |
| **Repository evidence** | Read from GitHub or the local checkout; describes code/config, not the live server. |
| **Not available** | No check was possible; no result is claimed. |

Statuses used: `READY`, `READY WITH WARNINGS`, `BLOCKED`, `NOT VERIFIED`. An item is never `READY` unless it was actually verified.

Agent commands were read-only: `git ls-remote`, a temporary `git clone --depth 1`, `git status`/`log`/`diff`, GitHub REST API, local file reads, and a non-interactive `ssh` probe (`BatchMode=yes`, `IdentitiesOnly=yes`, `NumberOfPasswordPrompts=0`, 8-second timeout). The owner-executed block was also read-only and printed no secret values or file contents. No password, private key, token, `.env` value, production secret, or patient record was read or printed.

---

## 1. Executive summary

| Area | Status |
|---|---|
| GitHub repository access and CI for exact `main` commit | `READY` |
| Ubuntu server SSH access (agent) | `BLOCKED` (owner-executed inspection available) |
| Permission / sudo on server | `READY WITH WARNINGS` |
| Ubuntu system specifications | `READY` |
| Docker / Compose versions and service status | `READY WITH WARNINGS` |
| Docker infrastructure inventory (containers/networks/volumes) | `READY WITH WARNINGS` |
| Tailscale service, tailnet IP, MagicDNS | `READY WITH WARNINGS` |
| Tailscale-only ingress artifacts and Phase T report | `BLOCKED` on `main`; repository-only draft prepared on `feature/tailscale-ingress` |
| Firewall and exposed ports (current state) | `READY WITH WARNINGS` |
| Storage mount, capacity, permissions | `READY WITH WARNINGS` |
| Production configuration readiness | `BLOCKED` |
| Repository readiness for required architecture | `BLOCKED` |
| Security posture | `BLOCKED` |

**Overall: `BLOCKED`. Stage 2 must not start.**

Verified positives:

- GitHub access works; deployment source is unambiguous: `main` @ `ad5c5454a824a3ac58fdfc75cab81504a6403524`; CI for that commit is green (3/3); local checkout is clean and content-identical.
- Host is Ubuntu 26.04.1 LTS, kernel 7.0.0-43-generic, 4 vCPU Xeon E3-1225 v5, 14 GiB RAM (13 GiB free), healthy disks (180 GiB free root, 435 GiB free backup disk), NTP synchronized, uptime ~1 week 22 h.
- Tailscale is installed, authenticated and healthy: tailnet IP `100.109.244.71`, MagicDNS FQDN `clincserver.tail885382.ts.net`, active peer `home-pc` (`100.83.86.76`).
- No application ports are currently listening: no `80`, `443`, `5432`/`55432`, or `8080` in `ss -ltnp`. Only SSH (`0.0.0.0:22`), DNS resolvers, and Tailscale-local ports are open.

Decisive blockers:

1. **Agent SSH remains denied** (`Permission denied (publickey,password)`). Host facts were obtained only because the owner executed the read-only block. Stage 2 automation still has no agent access.
2. **The required Tailscale ingress did not exist on the assessed `main` commit.** `docker-compose.tailscale.yml`, `deploy/Caddyfile.tailscale`, and any Phase T report were absent from the assessed checkout and the exact remote `main` commit. No Tailscale variable/config appeared anywhere in that artifact. Repository-only drafts now exist on `feature/tailscale-ingress`, but they are unmerged, undeployed, and not runtime-verified.
3. **The only shipped HTTPS ingress conflicts with Tailscale-only access.** `docker-compose.tls.yml` publishes `0.0.0.0:80/443` with public ACME. Applying it today would create public listeners on a host whose firewall has `INPUT` policy `accept` and `ufw` inactive.
4. **The program's blocker register is still mostly open:** 23 `BLOCKED`, 2 `OPEN`, 6 repo-only `CLOSED`; Phase 9.8 verdict is `PARTIAL`.
5. **Recovery is unproven on the target:** no real application-aware backup, verified restore, PITR base, or key-escrow check.
6. **No prior deployment exists to roll back to:** Docker has no containers, no Compose projects, no `ultrasound_clinic_*` volumes, and no clinic network. One inactive, 0-byte legacy volume `clinc_postgres_data` exists; it must be preserved and its provenance confirmed by the owner.
7. **No deployment checkout exists:** `/opt/clinic` and `/opt/clinic/Clinc-V1.1` are missing.

---

## 2. GitHub access status — `READY`

Verified now (agent):

| Check | Result | Evidence |
|---|---|---|
| Correct repository reachable | PASS | `origin` = `https://github.com/Moustafahany90/Clinc-V1.1.git` |
| Read access | PASS | `git ls-remote --heads origin` returned all remote branches |
| Inspect `main` | PASS | `refs/heads/main` = `ad5c5454a824a3ac58fdfc75cab81504a6403524` |
| Latest `main` commit SHA | Identified | `ad5c5454a824a3ac58fdfc75cab81504a6403524` |
| Inspect GitHub Actions / CI | PASS | GitHub REST API; run `44906974571` |
| Clone repository | PASS | Fresh `git clone --depth 1 --branch main` into a temporary assessment directory |
| Cloned `main` HEAD / tree | Matches / clean | HEAD `ad5c545…`, 0 modified or untracked entries |
| CI for exact `main` commit | PASS | 3/3 jobs `success`: static checks (13:04:36Z), backend audit (13:04:14Z), backend tests (13:06:06Z) |
| Local checkout | Clean, content-identical to `main` | Branch `fix/phase9-8-operational-defects` @ `3fce400…`; `git diff --shortstat origin/main..HEAD` empty |

The **deployment checkout on the Ubuntu server** is `BLOCKED` — owner-executed output confirms it does not exist yet (`/opt/clinic MISSING`).

---

## 3. Ubuntu SSH access status — `BLOCKED`

**Verified now (agent):** OpenSSH client present; key `phase6_deploy` exists with public fingerprint `SHA256:zSD4jBqz/1D4Irg03dDE4i75dEMxc5Cm1UDKVcAZb20` (private contents not printed); `known_hosts` contains `clincserver` and `100.109.244.71`; no `~/.ssh/config`; no agent. Non-interactive probes to `clinc_server@100.109.244.71` and `clinc_server@clincserver` both returned `Permission denied (publickey,password).`, exit 255. No bypass was attempted and no credential was requested.

**Owner-executed (2026-11-21 13:14Z):** the owner successfully ran the read-only block locally on the server as `clinc_server`. This provides current host evidence but does not change agent SSH status. For Stage 2, either authorize the existing public key or have the owner execute the deployment steps.

---

## 4. Permission and sudo status — `READY WITH WARNINGS`

**Owner-executed (2026-11-21 13:14Z):**

| Check | Result |
|---|---|
| Current user | `clinc_server`, uid/gid 1000; groups: `clinc_server`, `adm`, `cdrom`, `sudo`, `dip`, `plugdev`, `users`, `lxd` |
| Non-interactive sudo | `SUDO_NONINTERACTIVE=YES` |
| Docker group | `docker:x:107:` — **no members** |
| Docker socket as user | `DOCKER_SOCK_READABLE=no` |
| Docker socket via sudo | `DOCKER_SOCK_READABLE_VIA_SUDO=yes` |
| `/opt/clinic`, `/opt/clinic/Clinc-V1.1` | Missing |
| `/opt` | `drwxr-xr-x root:root` |
| `/mnt/clinic-backups` | `drwx------ root:root` |

Interpretation: the account can inspect the host and use Docker **only via sudo**. `clinc_server` is not in the `docker` group and cannot read the socket directly. Deployment scripts that call `docker` must therefore run as root or through `sudo`; changing group membership is **not** part of this assessment. Ability to read non-secret service configs and execute approved deployment scripts was not otherwise verified.

---

## 5. Ubuntu system specifications — `READY`

All values below are **owner-executed (2026-11-21T13:14Z)** and supersede the 2026-11-20 evidence.

| Item | Verified value |
|---|---|
| Hostname | `clincserver`; FQDN `clincserver.tail885382.ts.net` |
| OS | Ubuntu 26.04.1 LTS, `VERSION_ID=26.04` |
| Kernel | `Linux clincserver 7.0.0-43-generic #43-Ubuntu SMP PREEMPT_DYNAMIC Fri Oct 23 13:25:25 UTC 2026 x86_64` |
| CPU | 4 logical CPUs; Intel Xeon E3-1225 v5 @ 3.30 GHz; 1 thread/core, 4 cores; scaling 86% |
| RAM | 14 GiB total; 705 MiB used; 13 GiB free; 1.4 GiB buff/cache; 14 GiB available; swap 4.0 GiB (0 used) |
| Uptime | Up 1 week, 22 h, 19 min; booted 2026-11-13 14:55:08 |
| Time / NTP | `Etc/UTC (UTC, +0000)`; system clock synchronized `yes`; NTP service `active`; RTC in local TZ `no` |
| Root filesystem | `/dev/mapper/ubuntu--vg-ubuntu--lv` ext4, 197 G total, 7.7 G used, 180 G free (5%); 13,107,200 inodes total, 111,661 used (1%) |
| Backup disk | `/dev/sda1` ext4, label `clinic-backups`, UUID `0f21089c-c507-4903-96e5-daf637100d53`, 458 G total, 2.1 M used, 435 G free (1%); 30,531,584 inodes, 24 used |
| Other disks | `sdb1` vfat 7397-F1EC `/boot/efi` (1 G); `sdb2` ext4 00e87bf4… `/boot` (1.7 G); `sdb3` LVM2 W1qO2K…; snap loops `core24`, `hwctl`, `snapd` |
| Mount check | `findmnt -M /mnt/clinic-backups` → `/dev/sda1`, ext4, `rw,relatime`, correct UUID and label |
| Network interfaces | `lo` 127.0.0.1/8, ::1/128; `eno1` UP 192.168.1.11/24; `tailscale0` 100.109.244.71/32, fd7a:115c:a1e0::bf35:f448/128; `docker0` DOWN 172.17.0.1/16 |
| Routing | default via 192.168.1.1 dev `eno1` (static); 172.17.0.0/16 via docker0; 192.168.1.0/24 via eno1 |

Note: the host timezone is UTC while the repository default `APP_TIMEZONE` is `Africa/Cairo`; Compose sets `TZ`/`PGTZ` explicitly, so this is not a defect but should be confirmed in the production env.

---

## 6. Docker and Compose status — `READY WITH WARNINGS`

**Owner-executed (2026-11-21 13:14Z):**

| Component | Version / status | Requirement |
|---|---|---|
| Docker Engine | 29.1.3, build `29.1.3-0ubuntu4.1`; `docker.service` loaded/active/running | Installed and operational |
| Docker Compose | `2.40.3+ds1-0ubuntu1` (Compose v2) | Satisfied |
| Git | 2.53.0 | Installed |
| Tailscale | `tailscaled.service` loaded/active/running; CLI present | Installed and running |
| OpenSSH | `OpenSSH_10.2p1 Ubuntu-2ubuntu3.8`; port 22 listening | Available |
| systemd | 259 (`259.9-0ubuntu0.1`) | Available; no Clinic units/timers present |
| curl | 8.18.0 | Installed |
| openssl | OpenSSL 3.5.5 | Installed |
| rsync | 3.4.1 | Installed |
| age | 1.2.1 | Installed |
| rclone | `NOT_INSTALLED` | Not required by repo default; no off-site destination configured |
| psql / pg_dump | `NOT_INSTALLED` on host | Expected — run inside `db` container |
| caddy | `NOT_INSTALLED` on host | Expected — container image in TLS overlay |
| PostgreSQL (image) | Not verified | Plan: `postgres:16-alpine` / `postgres:16.4-alpine` in CI |

Warnings: Docker commands require `sudo` for this account; the inventory was collected successfully via sudo (§7). No missing package was installed. No version was assessed against an unsatisfiable repository minimum — no explicit minimum is declared beyond Compose v2.

---

## 7. Existing infrastructure inventory — `READY WITH WARNINGS`

**Owner-executed sudo inventory (2026-11-21):** collection succeeded via `sudo`; the earlier `clinc_server` permission-denied result is resolved.

| Item | Verified result |
|---|---|
| Containers (`docker ps -a`) | **None** — no running or stopped containers |
| Restart policies / health checks | None to report (no containers) |
| Compose projects (`docker compose ls`) | **None** |
| Images | Only `hello-world:latest` (`cf1b20a0c89a`, 25.9 kB) |
| Networks | Defaults only: `bridge`, `host`, `none` — no `ultrasound_clinic_net` |
| Volumes | One local volume: `clinc_postgres_data`, 0 B, **inactive** |
| Published ports | None (no containers) |
| Docker disk usage | 1 image (36.94 kB), 0 containers, 1 local volume (0 B), 0 build cache |
| Systemd | `docker.service` and `tailscaled.service` active; no Clinic units/timers |

**Warnings:**

- The legacy volume `clinc_postgres_data` (note the `clinc` spelling) is inactive and reports 0 B, but it is existing host state. Per the global safety rules it **must be preserved** — do not remove or recreate it. Its provenance/ownership requires owner confirmation before Stage 2.
- No `ultrasound_clinic_*` volumes, network, or containers exist, so **no existing Clinic production data is present on this host** and there is no previously deployed release to roll back to.
- `docker0` exists but is DOWN; no application traffic path is currently active.

**Repository-declared resources** (planned, not live): project `ultrasound-clinic`; services `db`, `migrate`, `backend`, `web`, `evolution`, plus `caddy` (TLS overlay) and `clinic-monitor` (profile); volumes `ultrasound_clinic_db_data`, `ultrasound_clinic_storage`, `ultrasound_clinic_evolution_instances`, `ultrasound_clinic_caddy_data`, `ultrasound_clinic_caddy_config`; network `ultrasound_clinic_net`.

Conflict check: no direct name collision with the planned stack; no existing published ports. No Docker resource was modified, pruned, started, or stopped.

---

## 8. Tailscale and network status — `READY WITH WARNINGS` (service) / `BLOCKED` (ingress)

**Owner-executed (2026-11-21 13:14Z):**

| Requirement | Status | Evidence |
|---|---|---|
| Tailscale installed / authenticated | `READY` | `tailscaled.service` active; CLI present |
| Tailnet IP assigned | `READY` | `100.109.244.71` (`tailscale ip -4`), IPv4 and IPv6 on `tailscale0` |
| MagicDNS hostname available | `READY` | FQDN `clincserver.tail885382.ts.net`; short name `clincserver` in `tailscale status` |
| Peer reachability | `READY WITH WARNINGS` | `home-pc` 100.83.86.76 active (direct 197.45.88.178:41641); `windows-m5ah2is` 100.87.135.125 offline |
| Intended HTTPS hostname formally approved | `BLOCKED` | MagicDNS FQDN is known but no owner decision naming the production HTTPS hostname exists |
| Tailscale-only ingress implemented | `BLOCKED` on `main`; draft on `feature/tailscale-ingress` | Assessed artifact lacked `docker-compose.tailscale.yml` and `deploy/Caddyfile.tailscale`; the branch draft is not merged or runtime-verified |
| Tailscale variables/config in repository | `BLOCKED` on `main`; added in branch draft | Assessed artifact had no `tailscale`/`tailnet` references; branch draft adds non-secret variables to `.env.example` |
| Caddy topology compatible with Tailscale-only | `BLOCKED` on `main`; draft on `feature/tailscale-ingress` | Assessed Caddy uses public ACME and publishes `80`/`443`; the branch draft uses Tailscale certs and binds only the tailnet IP to 443 |
| Phase T report exists | `BLOCKED` as runtime acceptance | A repository-only design reference now exists (`docs/PHASE_T_TAILSCALE_INGRESS.md`); owner runtime verification is still required |

No DNS, TLS, Tailscale, or firewall setting was changed.

---

## 9. Firewall and exposed-port assessment — `READY WITH WARNINGS` (current state) / `BLOCKED` (shipped overlay)

**Owner-executed (2026-11-21 13:14Z):**

- `ufw status verbose` → `Status: inactive`.
- `nft list ruleset`: `table ip filter` has `ts-input`, `ts-forward`, and Docker chains; `INPUT` policy is `accept`, `FORWARD` policy is `drop`. Tailscale rules accept `tailscale0` traffic and UDP/41641, and drop spoofed `100.64.0.0/10` traffic on non-tailscale interfaces. Docker NAT/forward chains are present. `iptables -S` agrees: `-P INPUT ACCEPT`, `-P FORWARD DROP`, `-P OUTPUT ACCEPT`.
- `ss -ltnp` listening sockets:
  - `127.0.0.53:53`, `127.0.0.54:53` — systemd-resolved
  - `0.0.0.0:22` and `[::]:22` — SSH (public on all interfaces)
  - `100.109.244.71%tailscale0:61931`, `[fd7a:…]%tailscale0:37746` — Tailscale-local
  - `127.0.0.1:45329` — loopback service
  - **No** `80`, `443`, `5432`, `55432`, `4000`, or `8080` listeners.

Conclusion: **no unintended public application port is currently exposed**. Warnings: (a) the firewall is not a restrictive barrier — `ufw` is inactive and `nft INPUT` policy is `accept`, so safety currently relies on nothing listening publicly; (b) SSH is exposed on all interfaces; (c) applying the shipped `docker-compose.tls.yml` would publish `0.0.0.0:80/443` and violate the Tailscale-only rule. No firewall or port setting was changed.

---

## 10. Storage assessment — `READY WITH WARNINGS`

**Owner-executed (2026-11-21 13:14Z):**

| Purpose | Location | Verified state |
|---|---|---|
| Application releases | `/opt/clinic` | **Missing** — `ls` reported no such file; `/opt` is `root:root 0755` |
| PostgreSQL data | Planned volume `ultrasound_clinic_db_data` | Confirmed absent; only legacy `clinc_postgres_data` (0 B, inactive) exists |
| Uploads | Planned volume `ultrasound_clinic_storage` | Confirmed absent |
| Backups | `/mnt/clinic-backups` | Mounted `/dev/sda1` ext4, correct UUID/label, 435 G free, 30.5 M free inodes; directory `drwx------ root:root` |
| Backup tree contents | Under `/mnt/clinic-backups` | Verified via sudo: `daily`, `weekly`, `monthly`, `manifests`, `quarantine`, `logs`, `wal-archive`, plus `lost+found` and `daily/.staging`; all `0700 root:root`. Files exist only in one synthetic test set `daily/clinic-daily-20261120T153524Z-clinic-backup-test` (`SHA256SUMS` 84 B, `backup.tar.gz.age` 559 B, `MANIFEST.txt` 171 B, all `0600 root:root`). `manifests/`, `wal-archive/`, `quarantine/`, `weekly/`, `monthly/` contain no files |
| Logs | Docker json-file + planned `/var/lib/clinic-monitor` | No Clinic log files or state dir found; no containers exist |
| Caddy data/config | Planned volumes `ultrasound_clinic_caddy_data`/`_config` | Confirmed absent |
| Evolution data | Planned volume `ultrasound_clinic_evolution_instances` | Confirmed absent |

No patient records were inspected; only path metadata, sizes, ownership, and modes were collected. No production directory was created, overwritten, or deleted.

---

## 11. Production configuration readiness — `BLOCKED`

No populated production environment file was read, no value displayed, and no secret generated or rotated. Names come from `.env.example`, `backend/src/config/env.ts`, Compose files, and `deploy/*.env.example`.

| Group | Variables (names only) | Required? | Secret? | Status / impact |
|---|---|---|---|---|
| Database | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `POSTGRES_BIND`, `DATABASE_URL` | Required | `POSTGRES_PASSWORD`, `DATABASE_URL` | `NOT VERIFIED`. Compose fails closed without `POSTGRES_PASSWORD`; changing it affects DB authentication. |
| WAL / PITR | `WAL_ARCHIVE_*`, `PITR_*` | Optional, approval-gated | No | `BLOCKED`. Overlay not enabled; PB-01–PB-03 require verified mount values. |
| Application | `NODE_ENV`, `APP_NAME`, `APP_TIMEZONE`, `APP_CURRENCY`, `APP_ORIGIN`, `PORT`, `TRUST_PROXY`, `LOG_LEVEL`, `BODY_LIMIT`, `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `PDF_*` | Mostly defaulted; `APP_ORIGIN` required in production | No | `BLOCKED`. `APP_ORIGIN` must be the approved HTTPS origin; changing it affects CORS/links/cookies. `COOKIE_SECURE=true`, `TRUST_PROXY>=1` enforced. |
| Authentication / JWT | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_SECURE`, `COOKIE_DOMAIN` | Required | Both JWT secrets | `NOT VERIFIED`. Must be distinct, ≥32 chars, non-placeholder. Rotation invalidates sessions. |
| LDAP / Active Directory | None | Not required | — | `READY` — verified absent by design (feature specification lines 66 and 551; no LDAP code/variables). |
| Tailscale | None | Required for target architecture | — | `BLOCKED`. No Tailscale configuration exists; HTTPS hostname not formally approved. |
| HTTPS / Caddy | `CLINIC_DOMAIN`, `deploy/Caddyfile`, `docker-compose.tls.yml` | Required | No | `BLOCKED`. Public-ACME overlay only; no Tailscale variant; PB-16/PB-17 open. |
| File storage | `UPLOAD_DIR`, `MAX_UPLOAD_MB`, `clinic_storage`, `/mnt/clinic-backups/*` | Required | No | `READY WITH WARNINGS` for mount; values `NOT VERIFIED`. Existing uploads must be preserved. |
| WhatsApp / Evolution | `EVOLUTION_API_ENABLED`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`, `EVOLUTION_API_TIMEOUT_MS`, `EVOLUTION_DEFAULT_COUNTRY_CODE` | `EVOLUTION_API_KEY` required by Compose | `EVOLUTION_API_KEY` | `NOT VERIFIED`. No committed fallback; rotation can affect paired sessions. |
| Backup | `BACKUP_ROOT`, `BACKUP_EXPECTED_UUID`, `BACKUP_EXPECTED_FSTYPE`, `BACKUP_AGE_RECIPIENT`, `BACKUP_REQUIRE_ENCRYPTION`, `PITR_PG*`, `SCHED_*` | Required in templates | Age private key escrowed externally | `BLOCKED`. Templates only; `/etc/clinic/backup.env` and `/etc/clinic/monitor.env` confirmed absent. `/etc/clinic-backup/recipient.txt` exists (`0600 root:root`, 63 B) but its value was not read and escrow was not verified. |
| Monitoring | `P7_BACKUP_*`, `P7_WAL_*`, `P7_PITR_*`, `P7_CERT_FILES`, `P7_CERT_ENDPOINTS`, `P7_TELEGRAM_BOT_TOKEN`, `P7_TELEGRAM_CHAT_ID`, `P7_HOST_LABEL`, `P7_ALLOW_INSECURE_TEST`, `P7_HEARTBEAT_URL`, `P7_SINK_*`, `P7_STATE_DIR`, `P7_ALERT_SINK` | Optional / approval-gated | Bot token, chat ID, heartbeat URL | `BLOCKED`. Templates only; `P7_ALLOW_INSECURE_TEST` must remain 0. |
| Email | None | Not required | — | `READY` — verified removed by migration `20261113135000_remove_email_delivery`; no SMTP/email variables in app config. |

---

## 12. Repository readiness — `BLOCKED`

| Check | Status | Result |
|---|---|---|
| Repository URL / branch / exact commit | `READY` | `origin`; `main` @ `ad5c5454a824a3ac58fdfc75cab81504a6403524` |
| CI passed for exact commit | `READY` | 3/3 jobs `success` (run `44906974571`) |
| Local checkout clean | `READY` | Clean, content-identical to `main` |
| Server deployment checkout | `BLOCKED` | `/opt/clinic` confirmed absent (owner-executed, 13:14Z) |
| Core production files | `READY WITH WARNINGS` | Compose, Caddyfile, backup/restore scripts, env examples present |
| `docker-compose.tailscale.yml` | `BLOCKED` on `main`; draft on `feature/tailscale-ingress` | Absent from assessed artifact; branch draft is not merged or runtime-verified |
| `deploy/Caddyfile.tailscale` | `BLOCKED` | Absent |
| Env examples complete for target architecture | `BLOCKED` on `main`; branch draft updated | `.env.example` on `feature/tailscale-ingress` adds non-secret Tailscale/HTTPS-hostname variables |
| Migration scripts | `READY` | 9 committed Prisma migrations (including destructive #6/#7 and Phase 9.1 indexes) |
| Backup/recovery scripts | `READY WITH WARNINGS` | Present; real target execution unproven |
| Phase 9.8 report | `READY` | Exists; verdict `PARTIAL` |
| Phase 9.8 prerequisites | `BLOCKED` | Target-host, DNS/TLS, scheduler, image, RTO/RPO and PB-15 items unresolved (PB-22 improved by green CI on `main`) |
| Phase T report | `BLOCKED` as acceptance evidence | Repository-only design reference added on `feature/tailscale-ingress`; no runtime proof |
| Blocker register | `BLOCKED` | 23 `BLOCKED`, 2 `OPEN`, 6 repo-only `CLOSED` |
| Deployment runbook | `READY WITH WARNINGS` | Exists but DRAFT, NO-GO by default; 18 approval-gated steps |

---

## 13. Security concerns — `BLOCKED`

| Concern | Status | Detail |
|---|---|---|
| Public exposure via shipped TLS overlay | `BLOCKED` | Ports `0.0.0.0:80/443` with public ACME; Tailscale-only requirement unimplemented. Current host has no such listeners, and `INPUT` policy is `accept` — applying the overlay would expose them. |
| Firewall posture | `READY WITH WARNINGS` | `ufw` inactive; nftables has Tailscale/Docker rules but `INPUT` policy `accept`; SSH public on `0.0.0.0:22`. No public app ports currently. |
| Image provenance / CVEs | `BLOCKED` | PB-20: no digest pinning, scan, SBOM, or signature. |
| Backups / recovery | `BLOCKED` | PB-04/PB-05/PB-21: no fresh verified backup, escrow check, or production-shaped restore/RTO/RPO drill. |
| Migration safety | `BLOCKED` | PB-09–PB-14: target inventory unknown; #8 constraints and #9 indexes need populated-table evidence; #6/#7 destructive and require separate approval; no `migrate reset`, `db push`, or ledger edits. |
| Dependency advisories | `BLOCKED` | PB-15: 4 High Prisma-cluster advisories under a CI exception; no formal owner acceptance. |
| Alerting / monitoring | `BLOCKED` | PB-08/PB-29: no real sink, heartbeat, or observed drill; no Clinic units installed (verified). |
| Secrets handling | `READY WITH WARNINGS` | `.env` gitignored and untracked; CI secret scan passes; no secret read here. Production values/escrow unverified. |
| PHI handling | `READY WITH WARNINGS` | No patient data accessed; repository redaction controls exist but runtime behavior unverified. |
| SSH hardening | `BLOCKED` | Agent key not authorized; SSH exposed on all interfaces; server SSH policy not fully reviewed. |

---

## 14. Missing dependencies — `BLOCKED`

Resolved by the owner-executed output: OS/kernel/CPU/RAM/disk/timezone/network inventory, Tailscale health and MagicDNS, firewall ruleset, listening ports, software versions, sudo capability, Docker socket permissions, Docker inventory (containers/images/networks/volumes/ports/disk), backup tree metadata and permissions, absence of `/opt/clinic` and of the `/etc/clinic/*.env` files.

Still missing:

1. **Agent SSH access** (for Stage 2 automation) or a documented owner-execution model.
2. **Merge and runtime-verify the Tailscale ingress artifacts** from `feature/tailscale-ingress`, plus the still-missing approved HTTPS hostname decision.
3. **Phase T runtime acceptance evidence** and owner closure/acceptance of the 23 BLOCKED + 2 OPEN register items.
4. **Key escrow verification** — recipient file metadata is known; private-key custodian/escrow procedure and restore-with-escrowed-key are unverified.
5. **Recovery evidence**: fresh verified backup, isolated restore drill, PITR base/WAL verification.
6. **Migration evidence**: read-only target inventory, constraint-violation queries, table sizes/lock budget, written approvals for destructive migrations.
7. **Image security**: scanned immutable digests and owner acceptance.
8. **Formal owner acceptance** of PB-15.
9. **Monitoring/alert configuration** and observed synthetic drill.
10. **Rollback readiness**: approved runbook, named rollback owner, and acknowledgement that there is no previous release on this host (no containers, no Clinic volumes, no `/opt/clinic`).
11. **Legacy volume decision**: owner confirmation of the provenance of the inactive `clinc_postgres_data` volume (preserve it; do not delete or reuse without approval).

No package or tool was installed during this assessment.

---

## 15. Required manual actions (owner)

**A. [COMPLETED 2026-11-21 — output received and incorporated into §§7, 10, 11 and Appendix A.]** The sudo inspection block below is retained for reproducibility. Remaining actions B–E are still required.

```bash
sudo -n bash -c '
echo "===== DOCKER + BACKUP ROOT (SUDO, READ-ONLY) ====="
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
echo "-- restart/health --"
for c in $(docker ps -aq); do
  printf "%s " "$(docker inspect --format "{{.Name}}" "$c")"
  docker inspect --format "restart={{.HostConfig.RestartPolicy.Name}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$c"
done
echo "-- compose projects --"; docker compose ls
echo "-- images --"; docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}" | head -60
echo "-- networks --"; docker network ls
echo "-- volumes --"; docker volume ls
echo "-- docker disk --"; docker system df
echo "-- backup tree metadata --"
find /mnt/clinic-backups -maxdepth 3 -printf "%M %u:%g %s %TY-%Tm-%TdT%TH:%TM %p\n" | head -120
echo "-- config file names/metadata only (NO VALUES) --"
ls -ld /etc/clinic /etc/clinic/backup.env /etc/clinic/monitor.env /etc/clinic-backup /etc/clinic-backup/recipient.txt 2>&1 || true
echo "===== END ====="
'
```

**B. Approve and merge the ingress design.** Confirm the production HTTPS hostname (the known MagicDNS FQDN is `clincserver.tail885382.ts.net`) and review/merge the `feature/tailscale-ingress` artifacts: `docker-compose.tailscale.yml`, `deploy/Caddyfile.tailscale`, `scripts/deploy-github-main.sh`, and `docs/PHASE_T_TAILSCALE_INGRESS.md`. Do not use the public 80/443 overlay.

**C. Supply Phase T runtime acceptance evidence** and record owner decisions for the 23 BLOCKED / 2 OPEN register items.

**D. Provide target evidence** (after a separate change authorization): migration inventory and constraint checks, fresh verified backup and restore drill, image digests/scans, age key escrow, alert/heartbeat drill, capacity telemetry.

**E. For Stage 2**, either authorize the existing agent public key (fingerprint `SHA256:zSD4jBqz/1D4Irg03dDE4i75dEMxc5Cm1UDKVcAZb20`) or formally adopt an owner-executed deployment model with named approvals and a rollback owner.

Do not paste passwords, private keys, tokens, or secrets into the conversation.

---

## 16. Estimated deployment blockers — `BLOCKED`

| # | Blocker | Severity | Status | Estimate |
|---|---|---|---|---|
| 1 | No working agent SSH / no owner-execution model for Stage 2 | High | `BLOCKED` | Key authorization or written owner-execution decision |
| 2 | Tailscale compose/Caddy artifacts exist only on an unmerged branch; no approved hostname | Critical | `BLOCKED` | Owner review/merge + hostname decision + runtime validation |
| 3 | Shipped public 80/443 TLS overlay | Critical | `BLOCKED` | Architecture decision plus replacement ingress config |
| 4 | No Phase T runtime acceptance evidence | High | `BLOCKED` | Owner to execute §6 of `docs/PHASE_T_TAILSCALE_INGRESS.md` and record results |
| 5 | 23 BLOCKED + 2 OPEN register items | Critical | `BLOCKED` | Multiple approvals/change windows |
| 6 | No verified backup/restore/PITR on target | Critical | `BLOCKED` | Authorized window and drill |
| 7 | Target migration inventory / destructive migrations unknown | Critical | `BLOCKED` | Read-only queries, approvals, verified pre-change backup |
| 8 | Legacy inactive Docker volume `clinc_postgres_data` (0 B) — provenance unknown, must be preserved | Medium | `READY WITH WARNINGS` | Owner confirmation only; no deletion or reuse |
| 9 | No image CVE scan, digest pinning, or provenance | High | `BLOCKED` | Isolated scanning + acceptance |
| 10 | PB-15 Prisma advisory exception | High | `OPEN` | Owner decision or approved upgrade |
| 11 | No real monitoring/alert/heartbeat evidence | High | `BLOCKED` | Host config + observed synthetic drill |
| 12 | No deployment checkout or previous release (confirmed absent) / no rollback owner | High | `BLOCKED` | Owner decision before Stage 2 |

**Estimate:** Stage 2 cannot start until blockers 2–5 are resolved and 6–7 have verified evidence. Items 1 and 9–12 must be resolved or formally accepted before deployment approval; item 8 needs only an owner provenance decision and must not result in deletion. No owner-dependent schedule is claimed.

---

## Appendix A — Owner-executed host evidence (2026-11-21T13:14:14Z)

Condensed verbatim facts from the read-only block (no secrets, no file contents):

- `WHOAMI=clinc_server`; `uid=1000(clinc_server) gid=1000(clinc_server) groups=1000(clinc_server),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),100(users),101(lxd)`; `HOSTNAME=clincserver`; `clincserver.tail885382.ts.net`.
- `Linux clincserver 7.0.0-43-generic #43-Ubuntu SMP PREEMPT_DYNAMIC Fri Oct 23 13:25:25 UTC 2026 x86_64`; `PRETTY_NAME=Ubuntu 26.04.1 LTS`; `VERSION_ID=26.04`.
- `CPU(s): 4`; `Model name: Intel(R) Xeon(R) CPU E3-1225 v5 @ 3.30GHz`; `Thread(s) per core: 1`; `Core(s) per socket: 4`; `nproc` = 4.
- `Mem: total 14Gi, used 705Mi, free 13Gi, buff/cache 1.4Gi, available 14Gi`; `Swap: 4.0Gi, 0B used`.
- `up 1 week, 22 hours, 19 minutes`; boot `2026-11-13 14:55:08`; `Time zone: Etc/UTC`; `System clock synchronized: yes`; `NTP service: active`.
- `sda1 ext4 clinic-backups 0f21089c-c507-4903-96e5-daf637100d53`, 435 G available, mounted `/mnt/clinic-backups`; LVM root ext4 `22a8d78b-…`, 180 G available, mounted `/`.
- `tailscale status` self: `100.109.244.71 clincserver moustafahany57@ linux`; peers: `100.83.86.76 home-pc … active; direct 197.45.88.178:41641`, `100.87.135.125 windows-m5ah2is … offline`; `tailscale ip -4` = `100.109.244.71`.
- `ufw`: `Status: inactive`; nftables: `chain INPUT … policy accept`, `chain FORWARD … policy drop`, Tailscale and Docker chains; `iptables -S`: `-P INPUT ACCEPT`, `-P FORWARD DROP`, `-P OUTPUT ACCEPT`.
- `ss -ltnp`: `0.0.0.0:22`, `[::]:22`, `127.0.0.53:53`, `127.0.0.54:53`, `100.109.244.71%tailscale0:61931`, `[fd7a:…]%tailscale0:37746`, `127.0.0.1:45329`; no application ports.
- Versions: git 2.53.0; OpenSSL 3.5.5; curl 8.18.0; rsync 3.4.1; age 1.2.1; rclone/psql/pg_dump/caddy NOT_INSTALLED; systemd 259; Docker 29.1.3; Compose 2.40.3+ds1-0ubuntu1; OpenSSH_10.2p1.
- `SUDO_NONINTERACTIVE=YES`; `docker:x:107:` (no members); `DOCKER_SOCK_READABLE=no`; via sudo `yes`; `/mnt/clinic-backups drwx------ root:root`; `/opt` `drwxr-xr-x root:root`.
- Docker commands: `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` (all inventory sections).
- `systemctl` filtered: `docker.service loaded active running`; `tailscaled.service loaded active running`; no Clinic units/timers.
- `find /mnt/clinic-backups -maxdepth 3` as `clinc_server` returned only the root directory (traversal denied by `0700 root:root`).
- `/opt/clinic` and `/opt/clinic/Clinc-V1.1`: `MISSING`.

### A.2 Sudo Docker and backup inventory (owner-executed, 2026-11-21)

- `docker ps -a`: empty header only — no running or stopped containers; no restart policies or health checks to report.
- `docker compose ls`: empty — no Compose projects.
- `docker images`: only `hello-world latest cf1b20a0c89a`, 8 months ago, 25.9 kB.
- `docker network ls`: `bridge`, `host`, `none` only — no `ultrasound_clinic_net`.
- `docker volume ls`: one local volume `clinc_postgres_data` (inactive, 0 B in `docker system df`).
- `docker system df`: Images 1 total / 0 active / 36.94 kB; Containers 0; Local Volumes 1 total / 0 active / 0 B; Build Cache 0.
- `/mnt/clinic-backups` tree (all `drwx------ root:root`): root, `manifests`, `logs`, `weekly`, `monthly`, `daily`, `daily/.staging`, `daily/clinic-daily-20261120T153524Z-clinic-backup-test` (files: `SHA256SUMS` 84 B, `backup.tar.gz.age` 559 B, `MANIFEST.txt` 171 B, all `-rw------- root:root`), `lost+found`, `wal-archive`, `quarantine`. No other files.
- Config metadata (no values read): `/etc/clinic`, `/etc/clinic/backup.env`, `/etc/clinic/monitor.env` — all absent; `/etc/clinic-backup` `drwx------ root:root`; `/etc/clinic-backup/recipient.txt` `-rw------- root:root` 63 B.

---

## Stage 1 stop gate

Stage 1 is complete with overall status `BLOCKED`. The sudo inventory is now included; the remaining blockers are architectural, documentary, recovery/migration evidence, and the absence of agent SSH for Stage 2. Repository-only tailscale ingress drafts were later prepared on `feature/tailscale-ingress`; they are not merged to `main`, not deployed, and not runtime-verified. No packages were installed; no Ubuntu, firewall, SSH, Docker, Tailscale, DNS, or TLS setting was changed; no container, volume, network, image, database, or migration was touched; no secret was generated or displayed; no deployment was performed.

**Awaiting your explicit approval of the assessment and deployment plan before Stage 2.**
