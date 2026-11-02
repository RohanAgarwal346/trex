# Rohpo Staff app

Staff Android app + owner admin panel + Tally connector.

| Part | Folder | What it does |
|---|---|---|
| Server + admin panel | `server/` | Staff login (mobile + PIN), 100 m godown geofence attendance, receipts queue, CSV export, webhook |
| Android app | `mobile/` | What staff install (APK). Built by GitHub Actions: **Actions → Build Rohpo Staff APK** |
| Tally bridge | `tally-bridge/` | Runs on the Tally PC; pushes receipts into Tally, loads customer list from Tally |

## 1. Run the server (needs a public HTTPS address so staff phones can reach it)
```
cd apps/staff/server
ADMIN_PASSWORD=choose-one node --disable-warning=ExperimentalWarning server.js   # Node 22.13+
```
Or Docker: `docker build -t ropo-staff . && docker run -d -p 8080:8080 -v ropo-data:/data -e ADMIN_PASSWORD=... ropo-staff`.
Open `/admin`, then:
1. **Godowns** - add each godown (lat/long, radius 100 m). Or log in to the app as a *Manager*, stand at the godown, Profile → "Set here".
2. **Staff** - add name, mobile, PIN; give each person their mobile + PIN.
3. **Settings & Tally** - set your Cash / Bank ledger names; copy the bridge key.

## 2. Build the APK
GitHub → Actions → **Build Rohpo Staff APK** → Run workflow, type your server address. Download `Rohpo-Staff.apk` from the Release, send it to staff (WhatsApp). On the phone: allow "install unknown apps", open, log in, allow Location.

**One-time signing key (so updates install over old versions):** create a keystore on your PC
`keytool -genkeypair -keystore ropo.jks -alias ropo -keyalg RSA -keysize 2048 -validity 10000`
then add GitHub repo secrets `ANDROID_KEYSTORE_B64` (`base64 -w0 ropo.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Without them the APK is debug-signed and must be uninstalled before installing a newer one.

## 3. Connect Tally
On the Tally PC: F1 → Settings → Connectivity → Tally acts as **Both**, port 9000, company open. Copy `tally-bridge/config.example.json` to `config.json`, fill serverUrl + bridgeKey, run `start-bridge.bat`.

## Logo
The ROHPO logo is in `mobile/assets/logo.png`, `mobile/www/logo.png` and `server/public/logo.png` (replace all three to change it).

## Security notes
* The server enforces the 100 m rule (the phone only reports GPS). One account = one phone (admin can reset). 5 wrong PINs = 10-minute lock.
* Fake-GPS apps cannot be fully blocked from a web-based app; the phone lock and the map link on every punch (Admin → Attendance) help you spot it.
