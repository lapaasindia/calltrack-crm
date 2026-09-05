# ADR 0004 — Bundle the WhatsApp engine (Baileys) in the installer, off by default

**Status:** Accepted (2026-06-17, `5e336d4`) · supersedes the opt-in-install
approach of `4c0b0db` · **Deciders:** maintainer

## Context

Callers chase leads on WhatsApp. An inbox inside the CRM (messages attached to
the lead's timeline, reply from the lead page, phone notifications) was the most
requested LapaasOS feature. The only workable library is **Baileys**, an
unofficial WhatsApp Web protocol client. An earlier version made it a separate
`npm install` on the office computer; operators could not do that step, so the
feature was effectively unavailable.

## Decision

- `baileys` is a **runtime dependency** and therefore ships inside every desktop
  installer and every `npm ci` of the server.
- It is **inert until an owner/admin clicks Connect** in Settings → WhatsApp and
  scans the QR with the business phone; auth state lives under `data/` and
  `Logout`/`Reset` wipe it.
- The docs (LIVE-SETUP, WHATSAPP-MOBILE) warn in bold: **dedicated business
  number only**, real ban risk, one account, host must stay online.
- Pinned to the `legacy` 6.7 line (`~6.7.24`); 7.x is not adopted until it is GA.

## Consequences

- **Install size** +~20 MB (baileys, libsignal, axios, protobufjs, music-metadata)
  in installers that otherwise need none of it.
- **Licensing:** `libsignal` (via baileys) is **GPL-3.0** and is loaded
  in-process. CallTrack is MIT and its source is public, so the corresponding
  source is available to every recipient — but a closed-source fork must remove
  the engine. Recorded in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md).
- **Reproducibility:** `libsignal` resolves from a git commit on GitHub with no
  npm integrity hash; `npm ci` needs git and network access, and an offline
  office machine cannot reinstall. Follow-up: vendor a tarball with an
  integrity hash, or return to an optional engine package.
- **Ban risk** is a product risk the operator accepts by connecting; it is not a
  security issue and is excluded from [SECURITY.md](../../SECURITY.md).
- Revisit if: WhatsApp offers an official small-business API without per-message
  pricing, baileys 7 ships GA, or a customer needs a GPL-free distribution.
