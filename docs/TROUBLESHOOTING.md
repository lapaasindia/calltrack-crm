# Install & Setup Troubleshooting

Quick fixes for the most common issues when installing CallTrack or connecting
phones. None of these mean anything is broken — they're normal for a free,
local-network app.

---

## 🍎 Mac: "CallTrack CRM is damaged and can't be opened"

This is **not** real damage. macOS quarantines apps downloaded from the web, and
because CallTrack isn't signed with a paid Apple certificate, it shows this
message (on both Apple Silicon **and** Intel Macs). Clear the quarantine once:

1. Drag **CallTrack CRM** into your **Applications** folder.
2. Open **Terminal** (press **⌘ + Space**, type `Terminal`, press **Enter**), then
   paste this line and press **Enter**:
   ```bash
   xattr -cr "/Applications/CallTrack CRM.app" && open "/Applications/CallTrack CRM.app"
   ```
3. The app opens, and you won't need to do this again on that Mac.

> Right-click → Open does **not** clear the "damaged" message — only the command
> above does. (The only way to remove the step entirely is paid Apple notarization.)

---

## 🪟 Windows: "Windows protected your PC" (blue box)

This is **SmartScreen**, shown for any app not signed with a paid certificate.
The app is fine:

1. Click the **More info** link in the blue box.
2. Click **Run anyway** at the bottom.

Needed once per PC.

---

## 📱 Phone pairing / QR scan not working on some phones

The most common cause is that the QR pointed the phone at an address it can't
reach (e.g. a `.local` name some Android phones don't support, or the wrong
network). The desktop app now puts a direct LAN IP in the QR, but if scanning
still fails on a phone, **use manual entry — it always works**:

1. On the office computer: open CallTrack → **Settings → Pair phone** → pick the
   team member. Note the **server address** shown (e.g. `192.168.1.50:3000`) and
   the **pairing code**.
2. In the CallTrack phone app, tap **"— or enter manually —"**, then type that
   **server address** and **pairing code**, and tap **Connect**.

If it still won't connect, check each of these:

- **Same Wi-Fi.** The phone and the office computer must be on the **same office
  Wi-Fi network** (not mobile data, not a guest network).
- **Use the numeric IP, not the `.local` name.** Many Android phones can't resolve
  `hostname.local`. Always prefer the `192.168.x.x` style address.
- **Multiple addresses listed?** If the host shows more than one address under
  **Server → Connection Info**, the office computer is on more than one network —
  try each one until the phone connects. The right one is on the same range as
  the phone's Wi-Fi (e.g. both start with `192.168.1.`).
- **Code expired.** Pairing codes are valid for **15 minutes** and work **once** —
  generate a fresh one if needed.

> If the **camera scanner** itself won't open on a particular phone (old Android,
> camera permission denied), just use manual entry above — it doesn't need the
> camera.

---

## 🌐 Phones / browsers can't open the server at all

- Make sure the office computer (the **host**) is **on** and CallTrack is running.
- On the host, open **Server → Connection Info** and try the listed `http://192.168.x.x:PORT`
  address in the phone's browser.
- All devices must be on the **same Wi-Fi**. Corporate/guest networks often block
  device-to-device traffic ("client isolation") — use the main office Wi-Fi.
- If a firewall prompt appeared on the host when CallTrack first started, allow it.

---

## 🔑 Can't log in / forgot the admin password

- First login on a fresh install is **`admin` / `admin123`** — change it in
  **Settings → Team**.
- If the admin password is lost, another admin can reset it in **Settings → Team**.
  If there's no other admin, see the credential-reset notes in the README.

---

## ▶️ App won't start / "port already in use"

- CallTrack may already be running (check the menu-bar/tray icon). Only one host
  instance runs at a time.
- On the office Mac it also runs as a background service — the desktop app simply
  attaches to it, so closing the window doesn't stop the server (use the tray menu
  → **Quit** to fully stop it).

---

Still stuck? Open an issue: https://github.com/lapaasindia/calltrack-crm/issues
