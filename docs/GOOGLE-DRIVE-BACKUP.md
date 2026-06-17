# Off-site encrypted Google Drive backup (Phase 1B)

CallTrack can upload a **daily, AES-256 encrypted** copy of all your data to **your own
Google Drive**, so a stolen, dead, or ransomware'd office computer doesn't lose everything.

- **Outbound only.** The Mac pushes to Drive. Nothing on the internet can reach your LAN app.
- **Zero-knowledge.** Every file is encrypted on *this* computer with *your* passphrase before
  upload. Google only ever stores ciphertext it cannot read.
- **Least privilege.** The app uses Google's `drive.file` scope — it can see only the backups it
  creates, never the rest of your Drive.
- **Incremental.** Recordings are content-addressed and upload exactly once. The database snapshot
  changes daily, so it's one new encrypted blob per day. Old daily DB snapshots are pruned to the
  newest 30 in Drive.

> ⚠️ **The passphrase is never stored anywhere.** If you lose it, the backups are **permanently
> unrecoverable** — there is no reset. Write it down and keep it somewhere safe (a password manager
> or a sealed envelope in a safe).

---

## One-time Google Cloud setup (≈10 minutes)

You need a free Google account (the one whose Drive will hold the backups).

1. Go to <https://console.cloud.google.com/> and sign in.
2. **Create a project**: top bar → project dropdown → *New Project* → name it e.g. `CallTrack Backup`
   → *Create*. Select it.
3. **Enable the Drive API**: search bar → "Google Drive API" → *Enable*.
4. **Configure the OAuth consent screen**:
   - APIs & Services → *OAuth consent screen*.
   - User type: **External** → *Create*.
   - App name `CallTrack Backup`, your email for support + developer contact → *Save and continue*.
   - Scopes: *Save and continue* (we request the scope at sign-in, none to add here).
   - Test users: **add your own Google account email** → *Save and continue*.
   - (You can leave the app in "Testing" — it works indefinitely for the test users you add.)
5. **Create the OAuth client**:
   - APIs & Services → *Credentials* → *Create Credentials* → **OAuth client ID**.
   - Application type: **Desktop app**. Name it anything → *Create*.
   - Copy the **Client ID** and **Client secret**.

> Why "Desktop app"? Google lets desktop clients use the **loopback redirect** — Google sends the
> code back to `http://<your-server>/api/backup/google/callback` on your own machine. No public
> HTTPS or domain is needed.

---

## Connect it in CallTrack

In **Settings → ☁️ Cloud Backup (Google Drive)** (owner/admin only):

1. Paste the **Client ID** and **Client secret** → *Save Google credentials*.
2. Click **Connect Google Drive**. A Google tab opens — choose your account, click through the
   "Google hasn't verified this app" / unverified warning (*Advanced → Go to CallTrack Backup*,
   this is your own app), and **Allow**. The tab confirms "connected" and closes.
3. **Set a backup passphrase** (min 8 chars). Read the warning. Write it down.
4. Click **Back up now** to run the first upload immediately.

After that, the backup runs automatically (piggybacking the existing 30-minute backup tick): once
per day, after the local snapshot, if Drive is connected and today's cloud sync isn't done yet.
Offline / no internet = it skips quietly and retries on the next tick.

### Unattended daily runs

The passphrase lives only in the running process's memory (it's never persisted). After a server
restart, the scheduler needs it again before it can run unattended. Either:

- Open Settings and re-enter the passphrase (it's verified, then held for the session), **or**
- Set the environment variable `CRM_BACKUP_PASSPHRASE` so the daily job can run after every restart.

---

## What gets backed up

**Included**
- The latest consistent **database snapshot** (`backups/crm-<date>.sqlite`, produced by `VACUUM INTO`).
- `data/recordings/**` (all call recordings, content-addressed → uploaded once each).
- `data/invoices/**` and any other data files (exports, etc.).

**Excluded**
- The live `crm.sqlite` + its `-wal`/`-shm` sidecars (a naive copy of a live WAL DB can tear — that's
  why we upload the VACUUM snapshot instead).
- `sessions.sqlite*` (login sessions — not business data).
- `secret.key`, `*.log`, `data/apk/` (build artifact), scratch `tmp/` folders.

---

## Restore (disaster recovery)

Restore is a command-line tool, run **on the original machine** (it reads the OAuth tokens, which
are encrypted under that machine's `data/secret.key`). You also need the **backup passphrase**.

List what's in Drive:

```bash
CRM_BACKUP_PASSPHRASE='your passphrase' npm run restore-cloud list
```

Download + decrypt everything into a folder:

```bash
CRM_BACKUP_PASSPHRASE='your passphrase' npm run restore-cloud restore -- --out ./restored
# optionally pick an older DB snapshot:
#   ... restore -- --out ./restored --date 2026-06-10
```

This writes the chosen DB snapshot to `./restored/crm.sqlite` and the recordings/invoices under
`./restored/` preserving their paths. **To go live:** stop the app, then copy `crm.sqlite` over your
`data/crm.sqlite` and `recordings/` over your `data/recordings/`.

> If you've lost the original machine, you need a copy of its `data/secret.key` (it decrypts the
> stored Google refresh token) **and** the backup passphrase (it decrypts the data itself). Keep
> both safe and separate.
