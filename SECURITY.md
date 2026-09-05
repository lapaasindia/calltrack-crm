# Security policy

CallTrack CRM stores call logs, call recordings, customer phone numbers and
payment records for small calling teams. We take reports seriously and fix
confirmed issues in the next patch release.

## Supported versions

Only the newest minor line receives security fixes. Older installers are not
patched — update the office computer and re-download the desktop app.

| Version | Supported |
|---|---|
| 1.2.x (latest release on the [Releases page](https://github.com/lapaasindia/calltrack-crm/releases)) | ✅ |
| 1.1.x and older | ❌ — please upgrade |

The web UI is served by the office host, so browsers and phones always run the
host's version; the **desktop shell** (Electron) and the **Android app** only
change when you install a new build. `Settings → About` / the login screen show
the version you are on; the host reports it at `GET /api/health`.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use GitHub's private vulnerability reporting:
<https://github.com/lapaasindia/calltrack-crm/security/advisories/new>
(Security tab → *Report a vulnerability*). This creates a private advisory that
only the maintainers can see; GitHub notifies us immediately.

Include: the version (`/api/health`), how to reproduce, what an attacker gains,
and whether it needs a login / a paired phone / LAN access. If you can, say
which of the boundaries below it crosses.

We aim to acknowledge within 3 working days and to ship a fix for confirmed
High/Critical issues within 14 days. We will credit you in the CHANGELOG unless
you prefer otherwise. Please give us a reasonable time to fix before disclosing
publicly.

## Threat model — what CallTrack does and does not defend against

CallTrack is a **LAN-only, single-host** application: one office computer runs
the server; browsers, desktop shells and Android phones on the same Wi-Fi talk
to it. Nothing is exposed to the internet by design (the only outbound features
— Google Drive backup, Sarvam transcription, WhatsApp — are opt-in and
documented in [docs/LIVE-SETUP.md](docs/LIVE-SETUP.md)).

**In scope (we consider these bugs):**

- Anything reachable by a peer on the office network without valid credentials
  (pre-auth request handling, login throttling, pairing codes).
- Any role doing more than the [role table](README.md#roles) allows —
  callers/agents reaching other people's leads, managers reaching owner-only
  settings, `read_only` writing anything, a paired phone acting outside its
  user.
- Stored/reflected XSS in the web client or the Android WebView, injection into
  SQL, CSV/XLSX exports or the AI prompts, path traversal in uploads / backups /
  restore.
- Secrets at rest: session signing key, sealed API keys, device tokens, backup
  passphrase handling.
- Supply chain: vulnerable shipped dependencies (`npm audit --omit=dev` is a CI
  gate), unsigned or tampered installers.

**Out of scope / accepted by the model (documented, not defended):**

- An attacker who already controls the office host machine or its backups
  folder. Protect the host like you would protect a filing cabinet.
- Plaintext HTTP on the LAN when TLS is not turned on. The server supports TLS
  (`CRM_TLS_CERT` / `CRM_TLS_KEY`, cookies become `Secure` automatically) and we
  recommend it; see the README's Security section. Reports about sniffing on a
  network where the operator chose not to enable TLS will be tracked as
  hardening, not as vulnerabilities.
- Users sharing passwords, leaving the demo accounts in place, or pairing a
  phone they do not control. The seed script forces a password change for the
  default admin; keep it that way.
- Denial of service by a device that is already paired and authenticated beyond
  the upload quotas and per-IP throttles that exist (bounded by the LAN).
- The WhatsApp engine (Baileys) is an unofficial client; account bans are a
  product risk, not a security issue.

## Security-relevant configuration

| Setting | Effect |
|---|---|
| `CRM_ADMIN_PASSWORD` | Provisions the first admin with a real password (no forced change). Without it, `admin`/`admin123` is created **with a forced password change on first login**. |
| `CRM_TLS_CERT`, `CRM_TLS_KEY` | Serve HTTPS; session cookies become `Secure`. |
| `CRM_SECURE_COOKIES=true` | Force `Secure` cookies behind an HTTPS reverse proxy. |
| `CRM_BACKUP_PASSPHRASE` | Lets encrypted cloud backups run unattended after a restart. Never stored on disk by the app. |
| `CRM_OAUTH_REDIRECT_HOST` | Pins the host accepted for the Google Drive OAuth redirect. |
| `upload_daily_quota_mb` (setting, `PUT /api/settings` by an owner) | Per-device daily recording upload quota (default 2048 MB). |
| `data/secret.key` | Roots session signing, the secret box and media tickets. Mode 0600, re-asserted on every boot. Back it up separately from the database; it is what decrypts stored OAuth tokens. |

## Past audits

- [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md) — full audit of v1.2.0 (June 2026).
- [docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md) — what was fixed,
  what was partially fixed, and the September 2026 re-audit status.
