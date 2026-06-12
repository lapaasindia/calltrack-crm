# CallTrack CRM

A CRM for your calling team that runs on **one office computer** — the whole team uses it
from their browsers (laptops **and phones**) over the office WiFi. No internet hosting,
no monthly fees, your data never leaves the office.

**What it does**

- 📞 **Today queue** — every caller sees exactly who to call: follow-ups due, overdue
  follow-ups (they never disappear), and payments/EMIs due.
- ✍️ **One-tap call logging** — Connected / Not picked / Busy / Switched off / Wrong number,
  outcome, notes, next follow-up. Tap-to-call and WhatsApp buttons with prefilled messages.
- 👥 **Lead pipeline** — New → Contacted → Interested → Follow-up → Won → Lost, with full
  history per lead.
- ⬆️ **Smart import** — upload Meta Lead Ads / Google Forms / any CSV or Excel export.
  Auto column-mapping, +91 phone cleanup, duplicate detection. Nothing silently dropped.
- 💰 **Full payment tracking** — deals per product, EMI schedules, partial payments,
  collected vs pending, overdue list.
- 📊 **Reports** — calls/connects/conversions per caller per day, connect rate,
  leaderboard vs daily targets, funnel, revenue by product, source performance. CSV export.
- 🛟 **Daily automatic backups** of the entire database.

---

## Option A (recommended): install the desktop app

CallTrack ships as a normal installable app for **Mac and Windows**. Installers are in the
`release/` folder (or build them yourself: `npm run dist:mac` / `npm run dist:win`):

| File | For |
|---|---|
| `CallTrack CRM-1.0.0-arm64.dmg` | Mac with Apple Silicon (M1/M2/M3/M4) |
| `CallTrack CRM-1.0.0.dmg` | Older Intel Macs |
| `CallTrack CRM Setup 1.0.0.exe` | Windows 10/11 (64-bit) |

On first launch the app asks one question:

- **"This is the MAIN computer"** → pick this on exactly ONE computer (the office machine
  that stays on). All data lives there — in the system's app-data folder, never in any
  cloud. It serves the office WiFi, so phones and browsers can still connect, and it can
  start automatically at login. Daily backups: menu → **Server → Open Backups Folder**.
- **"Connect to the main computer"** → pick this on everyone else's computer and type the
  main computer's address (find it on the main computer: menu → **Server → Connection Info**).

Moving existing data into the app: on the setup screen choose
**"I have a backup file — restore my data"** and pick your `crm-YYYY-MM-DD.sqlite` backup
(or `data/crm.sqlite` from this folder).

Because the app isn't code-signed with a paid developer certificate:
- **Mac**: if it says "can't be opened", right-click the app → **Open** → Open (needed once).
- **Windows**: if SmartScreen appears, click **More info → Run anyway** (needed once).

> Closing the window on the main computer does NOT stop the server — it keeps running in
> the background (tray/dock icon) so the team stays connected. Quit from the menu to
> actually stop it.

## Option B: run from this folder (no app install)

## First-time setup (one time, ~5 minutes)

Requires [Node.js 22](https://nodejs.org) (LTS) on the office Mac.

```bash
cd "CRM FABLE"
npm run setup        # installs everything, builds the app, creates demo data
npm start
```

The terminal prints the address and a **QR code** — team members scan it once on their
phones and bookmark it (Add to Home Screen makes it feel like an app).

**Default logins** (change passwords after first login — Settings → Team → Edit):

| user | password | role |
|---|---|---|
| `admin` | `admin123` | Admin (you) |
| `priya` | `caller123` | Demo caller |
| `rahul` | `caller123` | Demo caller |

Demo leads are included so you can explore. Remove them anytime:
**Settings → Clear demo data**. Add your real team in **Settings → Team**.

## Start automatically (recommended)

```bash
npm run install-autostart
```

This makes CallTrack start when the Mac logs in, restart if it crashes, and keeps the
Mac awake. Two one-time settings make it bulletproof:

1. **Auto-login**: System Settings → Users & Groups → Automatically log in as this user.
   (Otherwise after a power cut the app waits for someone to log in.)
2. **Fixed IP (DHCP reservation)**: open your WiFi router's admin page → DHCP →
   reserve the current IP for this Mac. Otherwise the app's address can change after the
   router restarts. (The `http://<computer-name>.local:3000` address keeps working
   regardless on iPhones and most Androids.)

## Backups — important

- A backup of the entire database is saved **automatically every day** into `backups/`
  (latest 30 kept). The admin dashboard shows when the last backup ran
  (**Settings → Data safety**), and you can back up on demand.
- **Put the `backups/` folder inside Google Drive / iCloud / Dropbox sync** so a copy
  leaves the building. Easiest way: move this whole project folder into your synced drive.
- **To restore**: stop the app, copy `backups/crm-YYYY-MM-DD.sqlite` over
  `data/crm.sqlite`, start the app. Test this once so it's not scary later.

## Getting leads in

- **Meta (Facebook/Instagram) Lead Ads**: Meta Ads Manager → your lead form → Download
  leads (CSV/XLSX) → upload in **Import**. The columns map automatically.
- **Google Forms**: open the linked Sheet → File → Download → CSV (or xlsx) → upload.
- **Tip for Hindi names**: prefer `.xlsx` downloads. Excel-saved plain CSVs often destroy
  Devanagari text and long phone numbers (the importer detects and reports both).
- True auto-sync from Meta/Google needs a public internet server — this app is
  office-network-only by design. A weekly export-import habit works well in practice.

## Day-to-day

- **Callers** open the app on their phone → **Today** tab → work the queue top to bottom.
  📞 dials, 💬 opens WhatsApp with a ready message, ✍️ logs the call.
- **Closing a sale**: lead page → **Win deal** → pick product, set value (edit for
  discounts), choose full payment or EMI schedule.
- **Recording money**: lead page → **Record payment** (UPI/cash/bank/…, optional EMI link,
  back-dating supported).
- **Admin**: assign leads (bulk-select on Leads page or during import), set daily targets
  per caller (Settings → Team), watch **Reports**.

## Notes & limits

- Passwords travel over your office WiFi unencrypted (plain http). Keep the WiFi
  WPA2-protected and don't reuse personal passwords here.
- Phone numbers are Indian mobiles (10 digits starting 6–9); `+91`/`0` prefixes are
  cleaned automatically everywhere.
- All dates/times are IST. A call logged at 11:55 PM counts for that day; 12:10 AM counts
  for the next — regardless of the computer's timezone.
- Money is stored exact (paise) — no rounding drift, lakh/crore formatting throughout.

## Tech (for the curious)

Node.js 22 + Express + SQLite (better-sqlite3, WAL) · React 18 + Vite · recharts ·
session auth (bcryptjs) · single process, single port. Database lives in `data/crm.sqlite`;
sessions in `data/sessions.sqlite`. Run tests with `npm test`.
