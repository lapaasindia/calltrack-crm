# ADR 0001 — One SQLite database in one Node process

**Status:** Accepted (2026-06, reaffirmed 2026-09) · **Deciders:** maintainer

## Context

CallTrack serves 2–15 callers on one office network. The team has no ops staff,
no cloud budget, and a hard requirement that customer data never leaves the
office. Reports must be exact (money, funnel transitions) and the system must
survive laptop reboots and power cuts without a database administrator.

## Decision

- One Node.js process (`server/app.js`) hosts the Express API, the static web
  client, the schedulers (backup, retention, AI worker, nightly maintenance) and
  the optional WhatsApp engine.
- Business data lives in **one SQLite file** (`data/crm.sqlite`) opened with
  `better-sqlite3` in **WAL** mode, `synchronous = NORMAL`, `foreign_keys = ON`,
  `busy_timeout = 5000`. Sessions get their own file (`sessions.sqlite`) so
  login churn stays out of business backups.
- Schema changes are numbered SQL files in `server/migrations/` applied in order
  and tracked with `PRAGMA user_version`; an older build refuses to open a newer
  database.
- Backups use SQLite's online backup API into `backups/crm-<IST date>.sqlite`,
  verified with `quick_check` before being renamed into place; 30 kept.
- Scale-out is explicitly **not** a goal: the design target is ~200k calls /
  25k installments on a laptop, which measured in the milliseconds after the
  September 2026 index pass.

## Consequences

- **Simple to run:** `npm start` or one desktop app is the whole deployment.
  Restore is "copy one file". No connection strings, no services to babysit.
- **Single point of failure:** the host laptop. Mitigated by daily local +
  optional encrypted off-site backups, not by replication. Documented in the
  README and in [ARCHITECTURE.md](../ARCHITECTURE.md#deployment-topologies).
- **Synchronous DB calls** block the event loop; long work must be chunked
  (nightly maintenance yields between 5k-row batches) or run on the backup
  API's worker thread. Reviewers reject `VACUUM`/full scans on request paths.
- **Native module:** `better-sqlite3` must match the runtime ABI (Node vs
  Electron). This is the fragile part of packaging and the reason the office
  host must never run `electron-rebuild` in the live checkout.
- `node:sqlite` (built into Node ≥ 22.13 / Electron ≥ 35) is the exit path if
  the native-module cost ever outweighs `better-sqlite3`'s features.
