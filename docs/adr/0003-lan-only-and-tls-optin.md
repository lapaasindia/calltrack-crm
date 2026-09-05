# ADR 0003 — LAN-only by design; TLS is opt-in and recommended

**Status:** Accepted (2026-06, amended 2026-09) · **Deciders:** maintainer

## Context

CallTrack's customers want zero cloud exposure and zero subscriptions. The
server binds `0.0.0.0:3000` on the office Wi-Fi; phones and laptops reach it by
LAN IP or `<host>.local`. The 2026-06 security audit showed that "the LAN is a
trust boundary" does not hold against a hostile peer on the same Wi-Fi (passive
sniffing, ARP MITM), and that several issues are transport-independent
(default credentials, authorization bugs, XSS).

## Decision

- **No internet exposure, ever.** No port-forwarding guidance, no relay, no
  hosted tier. Outbound-only integrations (Drive backup, Sarvam, WhatsApp) are
  opt-in and switched on by an owner.
- **Authentication and authorization do not rely on the network.** Server-side
  sessions, bcrypt passwords, forced rotation of the default admin, per-IP and
  per-user login throttling, expiring device tokens, a central role model
  (`server/lib/permissions.js`) and per-route ownership checks.
- **TLS is supported and recommended, not mandatory.** `CRM_TLS_CERT` +
  `CRM_TLS_KEY` make the same server speak HTTPS; session cookies become
  `Secure` automatically; pairing QR codes carry the real scheme. It is opt-in
  because a self-signed or mkcert certificate must be trusted on every phone
  and laptop, and a first-run experience that fails on certificate errors would
  push teams back to spreadsheets.
- Plain HTTP remains the default for the first run; the README's Security
  section tells operators how to turn TLS on and why.

## Consequences

- Teams that follow the README get a working system in minutes; teams that
  care about a hostile-LAN threat model can close the transport gap without
  changing anything else.
- Bearer tokens in URLs are limited to one short-lived media-ticket route so a
  plaintext leak has minimal blast radius.
- Reports about sniffing on a deployment that chose not to enable TLS are
  tracked as hardening, not vulnerabilities ([SECURITY.md](../../SECURITY.md)).
- Future work: ship a one-command mkcert flow and a "TLS on" indicator in the
  desktop shell; consider making TLS the default once phones can be provisioned
  with the CA during pairing.
