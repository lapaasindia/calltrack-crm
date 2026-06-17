# CallTrack → LapaasOS feature plan

**Goal:** bring the LapaasOS PRD's capabilities into CallTrack **without changing the architecture** —
stays on Node + Express + better-sqlite3 + React/Vite, LAN-only, on the office Mac. No Supabase, no
public internet hosting. The PRD's "Supabase" is just Postgres + Auth + Storage + Realtime; we already
have the LAN-native equivalents (SQLite + express-session + local files + polling), so we port the
**features**, not the infrastructure.

Decided with Sahil (2026-06-16):
- **AI = hybrid.** On-device whisper.cpp + Ollama stays the default (recordings never leave the office).
  Add a per-recording **opt-in** to send that one file to **Sarvam** for higher Hindi/Hinglish accuracy.
- **Price builder = internal only.** No public website. Build the quote/pricing calculator inside the CRM.
- **Build all four core areas** (AI/scoring, pipeline+invoices, projects/tasks/time, meetings/dashboards).
- **WhatsApp = full two-way Baileys inbox**, plus chat tracking + notifications in the Android app.

## Non-negotiable invariants (carried from CallTrack)
- Money is **integer paise**. UTC in `*_at`, IST `YYYY-MM-DD` business dates via `server/lib/istTime.js`.
- Phones normalized only via `server/lib/phone.js`. Today queue never filters by lead stage.
- One pending follow-up per lead. Pending balance always computed from `payments`.
- New schema ships as **migrations 004+** (PRAGMA user_version, auto-applied on restart).
- Keep **session auth** — do NOT migrate to a Supabase-Auth-style flow (the PRD's entire §5.12 migration
  is irrelevant to us). We only widen roles + add an audit log.

## What we deliberately SKIP from the PRD (and why)
| PRD item | Why skipped |
|---|---|
| Public marketing website + `/service/:slug` pages (§5.1) | LAN-only app can't serve internet visitors. Replaced by an **internal** price builder. |
| Public ticket-ingest edge function + anon lead capture | Needs a public endpoint. Tickets become an internal-only module. |
| MCP server (§5.10) | Niche; defer. Can add later as an embedded Node module if wanted. |
| Google Calendar two-way sync (§5.9) | OAuth needs public HTTPS; awkward on LAN. Optional one-way push later. |
| Multi-tenant / multi-WhatsApp-account | Single office, single account — same as today. |
| Supabase Auth + RLS migration (§5.12) | We keep session auth; "authorization" is enforced server-side in route handlers. |
| Every item the PRD marks **GAP / orphaned / dead code** | We build the *intended* behavior, not the original's bugs. |

## What already exists (extend, don't rebuild)
Leads + stages + `lead_events` · `calls` + dispositions + `recordings` · **local AI** (`server/lib/ai.js`:
whisper→Ollama→`ai_suggestions`, reviewed) · `deals` + **`installments` + `payments`** (our money side is
better than the PRD's ephemeral invoices) · `tasks` · `follow_ups` (one-pending rule) · `targets` ·
`message_templates` · import · mobile call-capture + `device_tokens`/`pairing_codes`/`captured_calls` ·
Review queue · admin/caller roles.

---

## Phase 1 — Foundations (unblocks everything)
**Migration `004_foundations.sql`**
- Widen `users.role` CHECK from `admin|caller` → `super_admin|admin|manager|agent|caller|read_only`
  (keep `admin`/`caller` as valid; map existing rows). Add optional `users.department`.
  Add `server/lib/permissions.js` (`isAdmin`, `hasPermission(perm)` matrix) used by routes + client nav.
- `audit_logs` table + **a viewer** (fix the PRD's write-only gap). Log login/logout, employee CRUD,
  deletes, invoice issue. `server/lib/audit.js` + `GET /api/audit` (admin).
- `notifications` table (`user_id, title, body, type, read, created_at`) + bell in the topbar
  (poll-based, reuse the existing 60s `lapaas-data-update`-style refresh) + `server/routes/notifications.js`.
- Settings additions for: AI provider toggle (`ai_cloud_enabled`, `sarvam_api_key`), company invoice
  block (legal name, address, GSTIN, default GST %), currency stays INR.

**Effort: S.** Pure additive; no behavior change to existing flows.

## Phase 1B — Off-site encrypted Google Drive backup  *(ops; independent, can ship early)*
Outbound-only (Mac → Drive), so it does **not** expose the LAN app to the internet. Layers on top of the
existing `server/lib/backup.js` (which already produces a consistent daily `VACUUM INTO` snapshot) — the
local backup is untouched; this just uploads.

Decided with Sahil (2026-06-16): **back up everything under `data/`**, **AES-encrypted with a passphrase**,
connected via an **in-app "Connect Google Drive" OAuth button**.

- **`server/lib/googleDrive.js`** — OAuth **loopback** flow (`http://127.0.0.1:PORT/oauth/callback`, the
  same trick Google allows for desktop apps; no public HTTPS needed). Scope **`drive.file`** only
  (least privilege — the app can see only the backups it creates, never the rest of the user's Drive).
  Refresh token stored encrypted under `data/secret.key`. One-time Google Cloud setup (create a Desktop
  OAuth client + enable Drive API) → documented click-by-click in `docs/GOOGLE-DRIVE-BACKUP.md`.
- **`server/lib/cloudBackup.js`** — builds the upload set from `data/`:
  - **Include:** the latest **VACUUM snapshot** (`backups/crm-<date>.sqlite`, NOT the live `crm.sqlite`
    + `-wal`/`-shm`), `data/recordings/**`, future `data/invoices/**` and exports.
  - **Exclude:** `sessions.sqlite*`, `*-wal`/`*-shm`, `*.log`, `data/apk/` (build artifact, not data).
  - Each file is **AES-256-GCM** encrypted locally (key = scrypt(passphrase, per-install salt)) before
    upload. Google only ever stores ciphertext.
  - **Incremental:** a `cloud_backup_files` ledger (source path + sha256 → Drive file id). Recordings are
    already content-addressed by `sha256` (see `recordings.sha256`) → each uploads exactly once, never
    again. The DB snapshot changes daily → one new encrypted blob/day.
  - **Retention** in Drive mirrors local (`KEEP=30` daily DB snapshots, configurable); older deleted.
- **Scheduling** — piggyback the existing 30-min backup tick: after the local snapshot, if Drive is
  connected and today's cloud sync isn't done, run it. Offline/no-internet = skip quietly, retry next tick.
- **Status & safety** — `last_cloud_backup` setting (date, files, bytes, ok/err) shown in Settings;
  failure → notification (Phase 1) + audit log (Phase 1). Passphrase is **never stored** (only a scrypt
  salt + a GCM verifier); the UI warns prominently that **losing the passphrase = backups unrecoverable**.
- **Restore** — `npm run restore-cloud` (and an admin Settings action): list Drive backups → download →
  decrypt with passphrase → restore DB + recordings. Documented in `docs/GOOGLE-DRIVE-BACKUP.md`.

New dep: `googleapis` (or `google-auth-library` + fetch). No new migration beyond the small
`cloud_backup_files` ledger + settings.

**Effort: M.** ⚠️ Passphrase custody is on the user — make the "write it down" warning unmissable.

## Phase 2 — Lead scoring + AI call intelligence  *(priority 1)*
**Migration `005_lead_ai.sql`** — add to `leads`: `score INTEGER`, `score_factors TEXT(json)`,
`ai_score INTEGER`, `ai_intent`, `ai_sentiment`, `ai_rating TEXT(json)`, `ai_status_reason`,
`ai_analyzed_at`. Add `recordings.provider` (`local|sarvam`) + `recordings.translation`.

- **Rule-based scoring** `server/lib/scoring.js` (0–100, Hot≥80/Warm≥50/Cold<50): source + engagement
  (count/weight of `calls`) + recency decay + budget if present. Recompute on each new call/event.
  Show score badge + breakdown on Leads list and LeadDetail.
- **Richer AI extraction** — extend `server/lib/ai.js`'s Ollama prompt to also return intent
  (Hot/Warm/Cold/Informational/Follow-up Required), sentiment (Pos/Neu/Neg/Mixed), a 4-axis rating
  (clarity/engagement/conversion/overall 1–10), strengths, improvements, one coaching tip. Persist on
  the recording + derive `leads.ai_score`/`ai_intent`/`ai_sentiment`. Keep the **review-before-apply**
  model (`ai_suggestions`) — never silently overwrite a lead.
- **Hybrid transcription** — default path unchanged (local). Add `POST /api/recordings/:id/transcribe-cloud`
  → server reads the local file, calls Sarvam Saaras (chunk to ≤25s WAV), stores transcript+translation,
  sets `provider='sarvam'`. Gated by `ai_cloud_enabled`. A "Re-transcribe with Sarvam (Hindi)" button in
  the recording UI. **Privacy note in the UI**: this one file leaves the office.
- **AI Intelligence panel** on LeadDetail: transcript + English translation, intent/sentiment chips,
  rating bars, strengths/improvements/coaching, audio player.
- **Routing rules** `lead_routing_rules` (subject → assignee) + round-robin among active callers
  (`server/lib/assignment.js`), applied on lead create when owner is empty.
- **Daily Learning / coaching** `GET /api/coaching/daily` — per caller: calls today, avg rating, 7-day
  trend, streak, hot leads, top strengths/focus. New `daily_learnings` table for manual check-ins +
  deal-closed learnings. Report-card page; admin leaderboard.

**Effort: M.** Highest leverage — it's mostly an extension of code you already have.

## Phase 3 — Pipeline Kanban + internal price builder + GST invoices  *(priority 2)*
**Migration `006_pipeline_invoices.sql`**
- **Kanban over existing lead stages** (no new "deal stage" model — avoids the PRD's dual-model mess):
  drag a lead across `new→contacted→interested→follow_up→won→lost`, require a note, write a `lead_event`,
  and on **won** open the existing WinDealModal (creates a `deal`). Board view added to the Leads page.
- **Service catalog** `services` + `service_addons` (scaled-down `pricing_configs`): name, base_price_paise,
  category, term multipliers (monthly/quarterly/annual), active flag. Admin editor under Settings.
- **Internal price builder** — a CRM page: platform tier + bandwidth + services + add-ons + billing term →
  live INR total, **copy quote** + **"Create invoice / deal from quote."** No public exposure.
- **Invoices (persisted — fixes PRD gap)** `invoices` + `invoice_items`: auto number `INV-xxxxxx`,
  bill-to from lead, line items from catalog, subtotal + **18% GST** (configurable), total in paise.
  **Real PDF** server-side (pdfkit) saved under `data/invoices/`, downloadable; link to `deal_id`.
  Optional later: push to **Zoho Books** via the available connector for real accounting.

**Effort: M–L.**

## Phase 4 — Projects, Tasks & Time tracking  *(priority 3)*
**Migration `007_projects_time.sql`**
- `projects` (from won deal/lead): name, client lead, service type, budget_paise, head, progress 0–100,
  status. Project board + details.
- Extend `tasks`: add `status` Kanban (`To Do/Doing/Review/Done/Drop`), `priority`, `project_id`,
  `origin`, `subtasks TEXT(json)`, `time_entries TEXT(json)`, `time_tracked INTEGER(sec)`,
  `scheduled_start_at`/`scheduled_end_at`. Keep feeding the **Today** queue.
- **Single global timer** (localStorage state machine, cross-tab sync) — starting it moves To Do→Doing.
  `time_blocks` table (Deep Work/Break/Out of Office…) + same-day conflict detection.
- **Calendar page** (week/month/day) overlaying meetings + scheduled tasks + time blocks.
- **Current-work widget** (polls every 15s) — "what am I on right now," start/stop from anywhere.

**Effort: L.**

## Phase 5 — Meeting OS + Dashboards  *(priority 4)*
**Migration `008_meetings.sql`** — `meetings`, `meeting_agenda`, `meeting_roles`, `meeting_decisions`,
`meeting_actions`, `meeting_timer_sessions`. Meeting detail: start/end state machine, live countdown
timer with 80%/100% warnings + extend, agenda time rollup, decisions, **actions → tasks**.
- **Role dashboards** (admin/manager/caller) extending `server/routes/reports.js`: KPI cards, revenue,
  pipeline value, top performers, upcoming follow-ups, Intelligence tab (per-call AI summary/coaching).
  Weekly printable report.

**Effort: M–L.**

## Phase 6 — WhatsApp two-way inbox (Baileys) + mobile notifications  *(explicit ask; highest risk)*
**Migration `009_whatsapp.sql`** — `wa_sessions`, `wa_contacts` (link to `leads` via normalized phone),
`wa_messages` (idempotent on `wa_message_id`).
- **Embed Baileys in the existing server process** (NOT a separate Supabase-style worker): `server/lib/whatsapp.js`
  started from `server/app.js`, persists auth to `data/.whatsapp-auth/`, writes straight to the same SQLite DB.
  One process = no DB contention, no Docker netns, no Nginx proxy (all PRD complexity we skip).
- QR pairing UI in Settings; status lifecycle; auto-reconnect with backoff.
- Ingest inbound (skip groups/status); link to existing lead by phone (your `phone.js` beats the PRD's
  `ilike`); mirror messages into the lead timeline / `calls` notes; recompute lead score on inbound.
- **Inbox UI** (conversation list + thread + lead panel); reply (text); convert chat → lead.
- **Mobile (Capacitor Android):** add a WhatsApp inbox view + **local notifications** on new inbound.
  LAN reality: no FCM/internet push, so the existing foreground service (the call-capture
  `CallObserverService` planned in `docs/ANDROID-FIXES.md`) **polls** `/api/whatsapp/unread` every N
  seconds and fires `@capacitor/local-notifications`. Document the "phone must be on office WiFi" limit.

**Effort: L.** ⚠️ **Risk:** Baileys is unofficial WhatsApp Web — real account-ban risk + ongoing
maintenance as WhatsApp changes. Use a dedicated business number, not a personal one.

---

## Cross-cutting / sequencing notes
- Each phase is independently shippable and gated behind a settings flag where it touches existing flows.
- Phases 2–5 are pure CRM and low-risk; **Phase 6 is deliberately last** so WhatsApp's risk/effort never
  blocks the core. Reorder only if WhatsApp is the urgent driver.
- Versioning/release discipline stays as in [[calltrack-crm-project]] (bump all FOUR version spots, cut a
  GitHub release, etc.). The pending **1.2.0** Android work (`docs/ANDROID-FIXES.md`) should land first or
  alongside Phase 6, since both touch the foreground service.
- Effort key: **S** ≈ small, **M** ≈ medium, **L** ≈ large. No calendar estimates until we pick the order.

## Open questions to settle before coding a phase
1. **Sarvam key + budget** — do you have a Sarvam API key, and a rough monthly cap on cloud transcription?
2. **Roles** — is `admin / manager / caller` enough, or do you genuinely want all 6 PRD roles?
3. **Invoices** — CRM-generated PDF only, or also push to **Zoho Books** (the connector is available)?
4. **WhatsApp number** — dedicated business number set aside for the Baileys session?
