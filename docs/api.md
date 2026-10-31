# API Overview

Base URL: /api/v1 (proxied via Nginx in Docker, or directly to backend in dev)

## Authentication
- Access token: short-lived JWT in Authorization: Bearer <token> header (frontend stores in memory only). It contains a token version (`tv`) checked against the account on every request.
- Refresh token: opaque token in httpOnly cookie uc_refresh with path /api/v1/auth, rotated on use with family revocation
- On 401 with valid refresh cookie, frontend auto-refreshes and retries
- Password changes/resets, account archive/restore and password setup increment the token version, invalidating all previously issued access tokens immediately
- Temporary-password accounts receive `403 PASSWORD_CHANGE_REQUIRED` from every endpoint except `/auth/me`, `/auth/change-password`, `/auth/logout` and session listing

## Key Endpoints
- GET /healthz - Process + database readiness (also exposes audit write-failure counters)
- GET /readyz - Readiness under the API prefix
- GET /health - Liveness only
- GET /health/db - Explicit database check
- GET /setup/status - Check if initial setup required
- POST /setup - First-run setup (creates admin, clinic settings) - single use
- POST /auth/login - Login
- POST /auth/refresh - Refresh access token
- POST /auth/logout - Logout (blacklists the access token and revokes refresh token)
- GET /auth/me - Current user
- POST /auth/change-password - Change password (revokes other sessions)

## RBAC
Roles: ADMIN, RECEPTIONIST, DOCTOR. Permissions are explicit arrays. Clinical permissions never implied by ADMIN; stripped from RECEPTIONIST.

`APPOINTMENTS_OVERRIDE` is required (with a recorded reason) to book outside the schedule or to complete an appointment without a completed visit and finalized report. `VISITS_OVERRIDE` is required (with a recorded reason) to complete a visit without a finalized report. Both default to ADMIN only.

`REPORTS_SEND` is required, together with `CLINICAL_READ` and normal doctor ownership checks, to send a finalized report PDF through WhatsApp. It defaults to DOCTOR; administrators need both clinical read and this permission explicitly. Delivery is manual, consent-acknowledged, and audited.

## Report delivery & WhatsApp (Evolution API / Baileys)
- `GET /reports/:id/deliveries` - Safe delivery history (status, provider message id, masked recipient last four)
- `POST /reports/:id/whatsapp` - Send the current finalized report version as a PDF using Evolution API (WHATSAPP-BAILEYS). Body: `{ "consent": true, "resend": false }`. Returns `409` if the version is already being sent or was already sent without `resend`, `400` if the patient phone is missing/invalid, and `503` if WhatsApp is not configured. `resend: true` also recovers a `PENDING` attempt that has been stuck for at least five minutes.
- Delivery failures return `502` and are recorded with a sanitized error code; raw provider payloads, full phone numbers and report content are never logged.
- `GET /settings/whatsapp` - Get Evolution API connection status (`open`, `connecting`, `close`, `unconfigured`) and instance name.
- `POST /settings/whatsapp/connect` - Connect or generate QR code for Baileys pairing.
- `POST /settings/whatsapp/disconnect` - Log out active WhatsApp session.
- `POST /settings/whatsapp/test` - Verify connection state.

## Core Modules
Patients, Appointments, Queue, Visits, Reports (with versioning/amendments), Files (authorized streaming), Payments/Charges/Refunds, Expenses, Financial Reports, Users/Invites, Settings, Audit, Dashboard

## Error Format
{"error": {"code": "ERROR_CODE", "message": "...", "details": [...] }}

## Money
All amounts in integer piasters. Frontend parses decimal strings via parseMoneyToMinor.

## Timezone
All dates/times in Africa/Cairo (configurable). Date-only operations use clinic day boundaries.
