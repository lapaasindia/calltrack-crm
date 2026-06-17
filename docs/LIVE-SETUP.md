# Turning on the cloud features (Drive backup · Sarvam AI · WhatsApp)

CallTrack runs 100% on your office network out of the box. Three **optional** features reach the
internet and need a one-time setup by an **owner/admin**. This is the plain-English walkthrough; the
deeper technical notes are linked at the end of each section.

> **Do every "Connect" step on the office Mac itself**, in a browser at `http://localhost:3000`
> (not the `192.168.x.x` LAN address). Google's sign-in only accepts `localhost` for this kind of app.

---

## 1. Off-site backup to Google Drive

**What it does:** every day, an **encrypted** copy of your whole CallTrack data folder (database +
call recordings + invoices) is uploaded to *your own* Google Drive. If the office Mac dies or is
stolen, you can restore everything. Google only ever sees scrambled files it cannot read.

### A. Create a free Google sign-in key (one time, ~5 min)
1. Go to **console.cloud.google.com** and sign in with your Gmail (`lapaasindia@gmail.com`).
2. Top bar → **Select a project → New Project** → name it `CallTrack Backup` → **Create**.
3. Left menu → **APIs & Services → Library** → search **Google Drive API** → **Enable**.
4. **APIs & Services → OAuth consent screen** → choose **External** → fill App name (`CallTrack`),
   your support email, developer email → **Save and continue** through the steps. On **Test users**,
   click **Add users** and add your Gmail. **Save**.
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   Application type **Desktop app** → name it → **Create**.
6. A box shows a **Client ID** and **Client secret**. Copy both.

### B. Connect it in CallTrack
1. On the office Mac, open `http://localhost:3000` → **Settings → Cloud Backup (Google Drive)**.
2. Paste the **Client ID** and **Client secret** → save.
3. Click **Connect Google Drive** → a Google window opens → choose your account → **Allow**.
   (You may see an "unverified app" notice — it's your own app; click **Advanced → Continue**.)
4. Back in Settings, set a **backup passphrase** and **write it down somewhere safe**.

> ⚠️ The passphrase is **never stored**. Lose it and the backups **cannot be restored**. After a
> Mac restart you re-enter it once in Settings (or set the `CRM_BACKUP_PASSPHRASE` environment
> variable so unattended daily backups keep running).

5. Click **Back up now** to test. You should see a success time and the files appear in a
   "CallTrack Backups" folder in your Drive (as encrypted blobs).

**Restore later:** `npm run restore-cloud` on the Mac (it downloads, asks for the passphrase, and
restores the database + recordings).

📄 Deep dive: [GOOGLE-DRIVE-BACKUP.md](GOOGLE-DRIVE-BACKUP.md)

---

## 2. Sarvam cloud transcription (better Hindi/Hinglish on hard calls)

**What it does:** by default, call recordings are transcribed **on the office Mac** (private, free).
For tricky Hindi/Hinglish calls you can send *one* recording to **Sarvam** for higher accuracy. This
is **opt-in per recording** — nothing is auto-uploaded.

> Privacy: when you use this, **that one audio file leaves the office** and goes to Sarvam's servers.
> The default on-device transcription keeps your promise that recordings never leave the office.

1. Sign up at **sarvam.ai**, open the dashboard, and copy your **API subscription key**.
2. In CallTrack: **Settings → Cloud AI** → paste the **Sarvam API key** → turn on
   **Enable cloud transcription**.
   (The key is write-only — Settings will only ever show "key saved", never the key itself.)
3. Open a lead → a recording → click **☁️ Transcribe with Sarvam (cloud)**. You'll get the Hindi
   transcript **plus an English translation**, and the AI intent/sentiment/coaching re-runs on it.

If you ever want to go fully private again, just turn **Enable cloud transcription** off — everything
falls back to on-device whisper.

---

## 3. WhatsApp inbox (two-way chat inside CallTrack)

**What it does:** links your business WhatsApp to CallTrack. Incoming chats automatically attach to
the matching lead, show up in the lead's timeline, nudge the lead score, and you can reply right from
the CRM. The Android app can also pop a local notification on new messages.

> ⚠️ **Use a DEDICATED business number, not your personal WhatsApp.** This uses WhatsApp Web's
> unofficial protocol (Baileys). There is a real risk WhatsApp bans the number — never risk a
> personal account. The office Mac must stay on and online for it to work; it's one account only.

### One-time
1. On the Mac, in the project folder, run **`npm install`** once (this pulls in the WhatsApp engine;
   it's already listed in `package.json`).
2. Put your **business WhatsApp** on a phone that's on the **office WiFi**.

### Connect
1. **Settings → WhatsApp** → click **Connect**. A **QR code** appears.
2. On the business phone: WhatsApp → **Settings → Linked devices → Link a device** → scan the QR.
3. Status flips to **connected**. A **WhatsApp** item now appears in the sidebar → the 3-pane inbox
   (chats · messages · the linked lead). Reply, search, and **Create lead** from a chat there.

To unlink: **Settings → WhatsApp → Logout** (or **Reset**, which also wipes the cached chats).

### Phone notifications (Android app)
The phone app's **Chats** tab + new-message notifications need a one-time Android rebuild
(install the notifications plugin, add the permission, rebuild the APK). Full checklist:
📄 [WHATSAPP-MOBILE.md](WHATSAPP-MOBILE.md). Notifications work while the app is open; alerting when
fully closed needs the background service noted in that doc. (No internet push on a LAN app — it
polls the office server, so the phone must be on the office WiFi.)

---

## Quick reference — where each switch lives

| Feature | Turn it on in | Needs from you |
|---|---|---|
| Google Drive backup | Settings → Cloud Backup | Google Cloud OAuth client (free) + a passphrase |
| Sarvam transcription | Settings → Cloud AI | A Sarvam API key |
| WhatsApp inbox | Settings → WhatsApp | `npm install` once + a dedicated business number |
| WhatsApp phone alerts | Android rebuild | Android Studio build (see WHATSAPP-MOBILE.md) |

All three are **off by default** — CallTrack stays fully on-network until you switch one on.
