# 👁️ Drishti AI — Voice-controlled Smart CCTV

Talk to your CCTV cameras in plain English: *"Take a photo of the gate"*, *"Give me the last 2 minutes of video"*,
*"How many people came yesterday between 9 and 10 am?"*, *"Alert me if anyone appears after 10 pm"* — and if the app is missing a
feature, just ask the AI and it **builds the feature for you** (after you approve it).

Everything — the desktop app, the Android app, the web UI and the AI's replies — is in **English**.

## One codebase, three ways to use it

| | What it is | How it updates |
|---|---|---|
| **Server + web UI** (`cctv-ai/`) | Python engine: cameras, recording, detection, AI. Serves the UI. | Edit once, push once. |
| **Desktop app** (`apps/desktop/`) | Windows / macOS / Linux installer. Starts the engine on that PC and shows the UI. Can also connect to a server elsewhere. | Auto-updates itself from GitHub Releases (new installer is built on every push). |
| **Android app** (`apps/android/`) | APK that connects to your server and shows the same UI. | UI changes appear **instantly** (the UI is served by the server). The APK is rebuilt on every push and attached to the Release. |

So: change the code → push to `main` → GitHub Actions (`.github/workflows/release.yml`) builds the desktop installers and the APK and publishes them in one release.
Desktop apps update themselves; the Android app shows the new UI as soon as the server has it.

## Quick start (any computer)

```bash
cd cctv-ai
./run.sh                      # installs dependencies, serves http://localhost:8800
```
Needs Python 3.10+ and `ffmpeg` (the desktop installer bundles ffmpeg). Two demo cameras are created on first run so you can try everything without hardware.

1. **Cameras → Add camera** — pick your brand template (Hikvision, Dahua/CP Plus, Tapo, Reolink, Ezviz…), enter IP/user/password, press *Test*.
   A phone can act as a camera with an "IP Webcam" app (`http://phone-ip:8080/video`). Laptop webcam = type *webcam*, source `0`.
2. **Settings → AI** — paste an Anthropic API key (or `export ANTHROPIC_API_KEY=…`). Without a key only a basic keyword mode works.
3. Tap the 🎙️ button, then the mic, and speak.
4. **Settings → PIN** — set one before you open the app to the internet (without a PIN the app refuses non-local connections).

### Voice
* Chrome/Edge use the built-in recognizer.
* The desktop and Android apps (and any browser without speech support) record a short clip and transcribe it **on the server** with offline Whisper:
  `pip install -r requirements-voice.txt` (the desktop installer does this automatically; the first use downloads a ~150 MB model, so it needs internet once).
* On Android you can also use the keyboard's own microphone key in the text box.
* Phone browsers need HTTPS for the mic (use Tailscale or a Cloudflare Tunnel).

## What you can ask for

| Say | What happens |
|---|---|
| "Photo of the gate" | Live still with boxes + timestamp |
| "Photo with details" | Adds a DETAILS panel: objects found, counts, motion |
| "Zoom into the left side" | Cropped, enlarged photo |
| "Photo of the gate yesterday at 9:15 pm" | Frame pulled from the recording |
| "Last 30 seconds" / "record the next 20 seconds" | Video clip (with pre-roll), plays in the browser |
| "Video of yesterday 6 to 7 pm" / "8x time-lapse" | Clip cut from stored recordings |
| "How many people / cars right now?" | Live count (people, car, bike, truck, bus, cycle, dog, cat) |
| "How many people between 9 and 12 today?" | Unique people (tracked, not double-counted), peak at once, in/out |
| "How many bikes are parked? Is the shutter open?" | The AI looks at the image itself and answers |
| "When was it busiest today?" | Hourly chart + busiest hour |
| "Draw a counting line at the gate" | Zone / line for in-out counting |
| "Record on motion, keep 14 days" | off / motion (pre-roll) / 24×7 + retention |
| "Alert me if a person appears between 10 pm and 6 am" | Rules: notify / speak / photo / clip; Telegram + webhook |
| "Create an Important folder" | Gallery folders |
| "Add a vehicles card to the dashboard" | Dashboard widgets |
| "Export events as CSV" | Download |

## 🧩 Adding features by asking the AI

* **No-code changes** (rules, folders, dashboard cards, camera settings, recording, accent colour) are applied instantly.
* **New code features**: the AI writes a small Python **plugin** (new tools, a new sidebar page, event hooks). It lands in *Extensions → Waiting for approval*;
  you read the code and press **Approve**. It becomes an AI tool and sidebar page immediately — no restart.
  Plugin API: `api.cameras()`, `api.counts()`, `api.snapshot()`, `api.events()`, `api.sql("SELECT …")` (read-only), `api.notify()`, `api.kv_get/kv_set`.

⚠️ Plugins run on your server with full permissions — only approve code you have read.

## Building the apps

Everything is automated by GitHub Actions on every push to `main` that touches `cctv-ai/` or `apps/`.
Manual builds:

```bash
# Desktop (needs Node 20)
cd apps/desktop && npm install && npm start          # run in development
npm run dist                                         # build an installer into apps/desktop/dist

# Android (needs JDK 21 + Android SDK)
cd apps/android && npm install && npx cap sync android
cd android && ./gradlew assembleDebug                # apk in app/build/outputs/apk/debug
```

**Android signing (do this once):** an app can only be updated in place if every APK is signed with the same key.
```bash
keytool -genkeypair -v -keystore release.jks -alias drishti -keyalg RSA -keysize 2048 -validity 36500
base64 -w0 release.jks     # paste into the repo secret ANDROID_KEYSTORE_B64
```
Then add the secrets `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Keep `release.jks` safe — losing it means users must uninstall and reinstall.

The Android app asks for your server address on first launch (e.g. `http://192.168.1.20:8800`) and remembers it; *Settings → Change server* lets you switch.

## Compared with other CCTV apps

Features were combined from Hik-Connect, Dahua DMSS, CP Plus Guard, Ezviz, Reolink, Tapo, Google Nest, Ring, Arlo, Wyze, Blue Iris, Frigate, Synology Surveillance Station,
Milestone XProtect, Verkada and Eagle Eye (from general knowledge — no live scraping was done).

| Idea | Seen in | Here |
|---|---|---|
| Multi-camera live grid, brand RTSP templates | Hik-Connect, DMSS, Blue Iris | ✅ |
| Motion/person/vehicle events with snapshots + timeline | Frigate, Ring, Nest | ✅ |
| Pre-roll, motion-only recording, retention | Frigate, Blue Iris | ✅ |
| Zones and counting lines | Frigate, Milestone, Verkada | ✅ |
| Time-lapse, clip export, CSV | Synology, Blue Iris | ✅ |
| Rules with quiet hours | Arlo, Wyze, Ring | ✅ |
| Telegram / webhook / in-app alerts | Frigate + Home Assistant | ✅ |
| Natural-language control and vision Q&A | Verkada, Eagle Eye | ✅ |
| PIN lock, disk status | all | ✅ |
| PTZ / ONVIF | Hik-Connect, Reolink | 🔜 can be added as a plugin |
| Two-way audio, siren | Ring, Tapo | 🔜 |
| Face / number-plate recognition | Verkada, Frigate+ | 🔜 (left out on purpose: privacy and legal risk) |
| Multi-user roles, cloud backup | Ring, Arlo | 🔜 |

## Limits to know about

* Past footage exists only for periods when recording was on; counting history starts when the app first ran.
* The built-in detector (OpenCV HOG) finds **people only** and can miss crowds or distant people. For cars, bikes, animals: `pip install ultralytics` (YOLOv8, downloads a model once).
* The Android app and desktop **voice** features, the installers and the APK were produced from this repo's configuration; the desktop app was run and checked here, but the APK could not be built or run in this environment (no Android SDK) — the first CI build is its first test.
* Recording other people can be regulated where you live — only film areas you are entitled to and post a notice.

## Layout

```
cctv-ai/    server/ (engine, API, AI, plugins)   web/ (UI)   run.sh   requirements*.txt
apps/desktop/   Electron shell + installer config + auto-update
apps/android/   Capacitor project (APK)
.github/workflows/release.yml   builds + publishes everything
```
