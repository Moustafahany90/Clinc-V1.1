# LAN Access for Clinic Windows Workstations

**Date:** 2026-11-21  
**Status:** `REPOSITORY PREPARATION ONLY — NOT DEPLOYED OR RUNTIME-VERIFIED`  
**Scope:** Configures direct IP HTTPS access (`https://192.168.1.11`) for clinic Windows computers on the local network, while preserving remote access via Tailscale.  
**Access Model:**
- **Inside the clinic (LAN):** Authorized Windows workstations access the system directly at `https://192.168.1.11`.
- **Outside the clinic (Remote):** Authorized remote devices and all mobile devices access the system through Tailscale. Mobile devices do not access via LAN and do not require certificate installation.
- **No Local DNS:** Uses the direct static IP `192.168.1.11` only. No custom hostnames, mDNS, `clinic.local`, or `home.arpa` are introduced.

---

## 1. Why this overlay exists

The base Tailscale deployment binds Caddy exclusively to the host's Tailscale IP (`100.x.y.z:443`). 

This overlay adds a **second Caddy listener** on the server's LAN IP (`192.168.1.11:443`) so clinic Windows computers on the local Wi-Fi or wired Ethernet can access the application directly over HTTPS without running Tailscale. Remote users and all mobile devices continue connecting through Tailscale.

---

## 2. Ingress Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Ubuntu Server (192.168.1.11 / 100.109.244.71)                         │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Caddy (dual listener)                                           │  │
│  │                                                                  │  │
│  │  Listener 1: 100.109.244.71:443  ← Tailscale cert                │  │
│  │  Listener 2: 192.168.1.11:443    ← Caddy Internal CA (IP SAN)    │  │
│  │                                                                  │  │
│  │  Both → reverse_proxy web:80 → /api/ → backend:4000              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  db  → 127.0.0.1:55432 only (loopback only)                            │
│  backend → no host port (internal clinic_net bridge)                   │
│  evolution → no host port (internal clinic_net bridge)                 │
│  web → 127.0.0.1:8080 only (loopback only)                             │
└────────────────────────────────────────────────────────────────────────┘

Windows PC on Clinic LAN ────(Direct HTTPS)────▶ https://192.168.1.11:443    ✓
Remote Users & Mobile ───────(Tailscale VPN)───▶ https://<CLINIC_DOMAIN>:443 ✓
Internet (Direct/Public) ────(Blocked)─────────▶ 192.168.1.11 (Non-routable RFC 1918)
```

---

## 3. Repository Artifacts

| File | Purpose |
|---|---|
| `deploy/Caddyfile.dual` | Dual-site Caddyfile: Tailscale site with issued certs + LAN direct-IP site with `tls internal`, `default_sni 192.168.1.11`, and `auto_https disable_redirects` |
| `docker-compose.lan.yml` | Compose overlay that adds the LAN port binding (`192.168.1.11:443`) and mounts `Caddyfile.dual` |
| `deploy/clinic.service` | Systemd unit template resolving Tailscale IP startup dependency and startup ordering |
| `.env.example` | Contains `LAN_IP` and `LAN_HOST` configuration examples |

No database, backend, or application code is modified.

---

## 4. Required Environment Variables

Configure these in the server's protected environment file (e.g. `/etc/clinic/clinic.env`):

| Variable | Value | Description |
|---|---|---|
| `LAN_IP` | `192.168.1.11` | Server's physical LAN IPv4 (`eno1`), used for Docker host port binding |
| `LAN_HOST` | `192.168.1.11` | IP address used for Caddy site block, IP SAN, and `default_sni` |
| `APP_ORIGIN` | `https://<CLINIC_DOMAIN>,https://192.168.1.11` | Comma-separated list of approved HTTPS origins for CORS and cookie origin checks |

Existing variables (`CLINIC_DOMAIN`, `TAILSCALE_IP`, `TAILSCALE_CERT_DIR`, `COOKIE_SECURE=true`, etc.) must remain unchanged.

---

## 5. Startup Ordering & Systemd Unit (`deploy/clinic.service`)

### 5.1 The Startup Dependency Problem
Caddy publishes `100.109.244.71:443` and `192.168.1.11:443`. On server boot, `docker.service` starts independently of `tailscaled.service`. If Docker starts the Caddy container before `tailscaled` assigns `100.109.244.71` to `tailscale0`, the Linux kernel rejects the bind (`EADDRNOTAVAIL`), causing container failure. Because both ports belong to the same Caddy container, LAN access on `192.168.1.11:443` is also blocked until Caddy successfully starts.

> [!IMPORTANT]
> `After=tailscaled.service` only guarantees the `tailscaled` daemon process has started. It does **NOT** guarantee that Tailscale is authenticated or that an IP address is assigned to `tailscale0`. The pre-flight check below explicitly verifies both conditions.

### 5.2 The Systemd Solution
The template service `deploy/clinic.service` resolves this by:
1. Declaring `After=network-online.target docker.service tailscaled.service` and `Wants=network-online.target docker.service tailscaled.service`.
2. Running an `ExecStartPre` pre-flight check that:
   - Polls `tailscale status --json` safely and extracts `BackendState` to confirm an authenticated `"Running"` session. Missing JSON or daemon errors are handled gracefully without crashing.
   - Verifies `TAILSCALE_IP` is assigned strictly to `tailscale0` using exact IPv4 address comparison (`ip -o -4 addr show dev tailscale0` parsed with `awk '{print $4}' | cut -d/ -f1` and matched with `grep -Fx`). No regex or partial substring matching is used, preventing `100.1.2.3` from matching `100.1.2.30`.
   - Waits up to **60 seconds** (30 iterations × 2s) before failing with explicit diagnostics.
3. Verifying that `LAN_IP` is present on the designated `LAN_INTERFACE` (if defined in `/etc/clinic/clinic.env`, e.g. `eno1`) or across host interfaces, also using exact string matching (`grep -Fx`).
4. Using `docker compose ... down` on shutdown to fully remove containers and the default bridge network, ensuring a clean state on restart.

### 5.3 Timeout Behaviour
| Phase | Timeout | Behaviour on timeout |
|---|---|---|
| Tailscale readiness (ExecStartPre) | 60s (30 × 2s poll) | Unit fails with descriptive error and recovery instructions in journal |
| All ExecStartPre + ExecStart combined | 180s (`TimeoutStartSec`) | systemd kills the start sequence and marks unit failed |
| ExecStop (shutdown) | 120s (`TimeoutStopSec`) | systemd sends SIGKILL to remaining processes |

### 5.4 Installation & Enablement (Operator Runbook)
```bash
# 1. Copy the unit file
sudo cp /opt/clinic/deploy/clinic.service /etc/systemd/system/clinic.service

# 2. Reload systemd daemon
sudo systemctl daemon-reload

# 3. Enable the service to start automatically on system boot
sudo systemctl enable clinic.service

# 4. Start or check status
sudo systemctl start clinic.service
sudo systemctl status clinic.service
```

### 5.5 Verification Commands
```bash
# Check service status and start times
systemctl status clinic.service

# Inspect startup logs and pre-flight checks
journalctl -u clinic.service -b --no-pager

# Validate the unit file syntax (run on Ubuntu server)
systemd-analyze verify /etc/systemd/system/clinic.service
```

### 5.6 Recovering from a Failed Tailscale Startup Check

If the clinic service fails to start because Tailscale is not ready within 60 seconds:

```bash
# Step 1: Check Tailscale authentication status
tailscale status

# Step 2a: If "Logged out" or "NeedsLogin" — authenticate first
sudo tailscale up

# Step 2b: If "Running" but IP not assigned — restart tailscaled
sudo systemctl restart tailscaled
# Wait a few seconds, then verify
tailscale status
ip -4 addr show dev tailscale0

# Step 3: Once Tailscale is confirmed ready, start the clinic service
sudo systemctl start clinic.service
sudo systemctl status clinic.service
```

> [!NOTE]
> The clinic service is `Type=oneshot` with `RemainAfterExit=yes`. It does **not** automatically restart on failure. This is intentional: an automatic restart loop could fight with Docker Compose's own container restart policies and create unpredictable state. Manual intervention ensures the operator understands and resolves the root cause.

### 5.7 Rollback / Uninstall

> [!WARNING]
> `systemctl disable --now clinic.service` performs **two actions**: it stops the running application (`--now`) AND removes the service from automatic boot startup (`disable`). All Docker Compose containers will be stopped and removed.

```bash
# Disable and stop the service
sudo systemctl disable --now clinic.service

# Remove the unit file
sudo rm -f /etc/systemd/system/clinic.service

# Reload systemd to clear the removed unit
sudo systemctl daemon-reload
```

---

## 6. Windows Root CA Export & Installation

Caddy's built-in PKI authority generates an internal Root Certificate Authority on first start. Windows workstations must trust this public Root CA to establish secure, green-lock HTTPS connections to `https://192.168.1.11` without certificate warnings.

> [!CRITICAL]
> **Key Security Rule:** Export ONLY the public certificate `root.crt`.  
> **NEVER** export, copy, share, or distribute `root.key`.  
> The `root.key` file must permanently remain inside the container volume (`caddy_data`). The public certificate `clinic-internal-ca.crt` contains only the public key and is completely safe to distribute.

### 6.1 Export the Public Root Certificate from the Server

Run this command on the server once Caddy is running:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.tailscale.yml \
  -f docker-compose.lan.yml \
  exec caddy cat /data/caddy/pki/authorities/local/root.crt > clinic-internal-ca.crt
```

Transfer the resulting `clinic-internal-ca.crt` file to the clinic Windows computers (via a USB drive, internal network share, or secure admin transfer).

---

### 6.2 Manual Windows Workstation Installation (`certlm.msc`)

Perform this procedure **once per Windows computer**:

1. Log in to the Windows computer with Administrator privileges.
2. Press `Win + R`, type `certlm.msc`, and press **Enter** (this opens the *Certificates - Local Computer* management console).
3. In the left navigation tree, expand:  
   `Trusted Root Certification Authorities` → `Certificates`
4. Right-click on the `Certificates` folder, select **All Tasks** → **Import...**.
5. In the Certificate Import Wizard:
   - Click **Next**.
   - Browse to select `clinic-internal-ca.crt`. Click **Next**.
   - Confirm that **Place all certificates in the following store** is selected and set to **Trusted Root Certification Authorities**. Click **Next**.
   - Click **Finish**.
6. A dialog will confirm: *"The import was successful."*
7. Verify that **Clinic Internal CA** now appears in the list of Trusted Root Certification Authorities.
8. Close all browser windows (Chrome, Edge, etc.) and reopen the browser.
9. Navigate to: `https://192.168.1.11`
10. Confirm that the browser shows a valid, secure HTTPS connection (padlock icon / "Connection is secure") with no security warnings.

---

### 6.3 Optional Active Directory GPO Distribution

If the clinic workstations are joined to an Active Directory domain, the CA certificate can be distributed centrally across all domain computers without visiting each machine:

1. Copy `clinic-internal-ca.crt` to a domain controller or management workstation with RSAT installed.
2. Open **Group Policy Management** (`gpmc.msc`).
3. Create a new GPO (or edit an existing baseline policy), for example: `Clinic-Internal-Root-CA-Policy`.
4. Navigate to:  
   `Computer Configuration` → `Policies` → `Windows Settings` → `Security Settings` → `Public Key Policies` → `Trusted Root Certification Authorities`
5. Right-click in the right pane (or on `Trusted Root Certification Authorities`) and select **Import...**.
6. Follow the wizard to import `clinic-internal-ca.crt`.
7. Link the GPO to the Active Directory Organizational Unit (OU) containing the clinic computer accounts.
8. On a test workstation, open an elevated Command Prompt and run:
   ```cmd
   gpupdate /force
   ```
9. Open `certlm.msc` and verify that **Clinic Internal CA** appears in `Trusted Root Certification Authorities > Certificates`.
10. Test access by navigating to `https://192.168.1.11` in Edge or Chrome.

---

## 7. Disaster Recovery & Caddy CA Volume Restoration

### 7.1 Volume Backup Lifecycle
- In `scripts/backup.sh`, the named volume `ultrasound_clinic_caddy_data` is automatically included in `CADDY_VOLUMES`.
- `backup.sh` archives `/data` (containing `caddy/pki/authorities/local/root.crt` and `root.key`) and encrypts it with `age` into:  
  `ultrasound_clinic_caddy_data-<STAMP>.tar.gz.age`.

> [!CAUTION]
> **The encrypted backup contains the Caddy CA private key (`root.key`).** Anyone with access to this key can issue certificates trusted by all clinic workstations. The encrypted archive must NEVER be decrypted to an ordinary file on the host filesystem — even temporarily — because:
> - `rm` does not securely erase file contents; data may remain on disk and in filesystem journals.
> - A crash or power loss between decryption and deletion leaves the key exposed.
> - Forensic tools can recover deleted files from ext4 journals and unallocated blocks.
>
> Always use the streaming restoration procedure below.

### 7.2 Full-System Recovery Order of Operations
During bare-metal disaster recovery on a new host, follow this sequence:

1. **Step 1: Database & Storage Recovery:** Run `scripts/restore-backup.sh` to restore PostgreSQL database tables and medical storage files (`storage.tar.gz`).

2. **Step 2: Caddy CA Volume Recovery (Before starting the stack):**

   Use `scripts/restore-caddy-volume.sh` for failure-safe streaming restoration. This script **never creates a plaintext archive on the host filesystem**.
   
   #### The Staging-Volume Recovery Architecture
   To guarantee that an existing or partial volume is never corrupted or cleared prematurely:
   - **Pass 1 (Streaming Validation):** Stream-decrypts the full archive through validation checks without writing to disk. Consumes the stream to EOF to prevent pipefail SIGPIPE. Validates entry paths (rejects absolute paths, `..` traversals, symlinks, and hardlinks) and confirms `root.crt` and `root.key` are present.
   - **Pass 2 (Staging Extraction):** Stream-decrypts directly into an ephemeral **staging Docker volume** (`caddy_restore_stage_<STAMP>_<PID>`). The target volume is **NEVER modified** during extraction.
   - **Staging Verification:** Checks that `root.crt` and `root.key` exist and that `root.key` has strict mode `600` permissions. Calculates and displays the Root CA SHA-256 fingerprint.
   - **Explicit Replacement (`--replace`):** Only when `--replace` is explicitly provided does the script modify the target volume. If the target volume already contains data, it is automatically backed up to a timestamped backup volume (`<TARGET>_backup_<STAMP>`) before being replaced with the verified staging contents.

   #### Execution Steps
   ```bash
   # Step A: Validate and extract to staging volume (Dry-Run / Verification)
   # Target volume is completely untouched. Fingerprint is displayed.
   ./scripts/restore-caddy-volume.sh \
     --archive /mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>/ultrasound_clinic_caddy_data-<STAMP>.tar.gz.age \
     --key-file /etc/clinic-backup/key.txt \
     --volume ultrasound_clinic_caddy_data

   # Step B: Review the CA certificate fingerprint printed by the script.
   # Confirm it matches the fingerprint recorded when the clinic CA was first created.

   # Step C: Perform explicit replacement into the target volume
   # Automatically backs up any existing target volume contents before replacement.
   ./scripts/restore-caddy-volume.sh \
     --archive /mnt/clinic-backups/<tier>/clinic-<tier>-<STAMP>/ultrasound_clinic_caddy_data-<STAMP>.tar.gz.age \
     --key-file /etc/clinic-backup/key.txt \
     --volume ultrasound_clinic_caddy_data \
     --replace
   ```

   #### Failure Behavior & Volume Retention
   - **If Pass 1 validation fails:** Target volume is untouched. No Docker volume is modified.
   - **If Pass 2 extraction fails:** Target volume is untouched. Staging volume is preserved for diagnostics.
   - **If staging verification fails:** Target volume is untouched. Staging volume is preserved.
   - **If replacement fails:** Previous target volume contents remain safe in the `<TARGET>_backup_<STAMP>` volume.
   - **Temporary Volume Cleanup:** Staging volumes are removed automatically after successful replacement (unless `--keep-staging` is specified). The backup volume (`<TARGET>_backup_<STAMP>`) is deliberately retained so the operator can roll back if needed. Once verified in production, remove it with `docker volume rm <TARGET>_backup_<STAMP>`.

   #### Verify the Restored CA Fingerprint Independently:
   ```bash
   docker run --rm \
     -v ultrasound_clinic_caddy_data:/data:ro \
     alpine:3.22 sh -c \
       'apk add --no-cache openssl >/dev/null 2>&1; openssl x509 -in /data/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256'
   ```

3. **Step 3: Start Application Stack:**  
   Launch via `systemctl start clinic.service` (or `docker compose ... up -d`).

### 7.3 Client Trust Impact
- **When restored:** Caddy loads the original Root CA certificate and private key. All existing Windows workstations retain valid HTTPS trust with **zero reconfiguration or reimportation**.
- **If skipped / volume wiped:** Caddy creates a new Root CA on boot. All existing Windows workstations will see certificate warnings until the new `clinic-internal-ca.crt` is distributed.

---

## 8. Runtime Verification (After Deployment)

Perform these read-only verification checks on the server:

```bash
# 1. Verify listening TCP sockets (expect Tailscale IP:443, LAN IP:443, loopback :8080 and :55432)
sudo ss -ltnp | grep -E ':(443|8080|55432)\b'

# 2. Confirm no unintended listeners on 0.0.0.0
sudo ss -ltnp | grep -E '0\.0\.0\.0:(443|8080|55432)'

# 3. Test LAN HTTPS locally with the exported CA certificate
curl --fail --silent --show-error --cacert clinic-internal-ca.crt "https://192.168.1.11/healthz"

# 4. Test Tailscale HTTPS from another tailnet device
curl --fail --silent --show-error "https://$CLINIC_DOMAIN/healthz"
```

---

## 9. Rollback Procedure

To instantly revert to the Tailscale-only ingress model:

```bash
cd /opt/clinic
docker compose \
  -f docker-compose.yml \
  -f docker-compose.tailscale.yml \
  up -d --no-deps caddy
```

This unbinds `192.168.1.11:443` and restores `Caddyfile.tailscale`. No database, volume, or application data is affected.

---

## 10. Explicit Non-Claims

- No production containers have been started, modified, or recreated.
- No changes to Ubuntu firewall (`ufw` / `nftables`) or network routing have been made.
- No private key material has been generated, exported, or handled.
- The `clinic-internal-ca.crt` file will be created by Caddy on the server only upon live execution.
