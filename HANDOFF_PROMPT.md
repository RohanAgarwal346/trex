# Hand-off prompt for Claude Code (copy everything below the line and paste it into Claude Code on the owner's PC)

---

You are taking over a project. Work autonomously from A to Z, ask me only when you are truly blocked, and ask permission only for things that are risky or irreversible.

## How to talk to me
- Talk to me in **simple Hindi (Hinglish is fine)**, short and step by step. I am not technical.
- **The app itself must be 100 % English** (UI text, AI replies, errors, desktop menus, Android screens). Never add Hindi text to the app.
- Never print or repeat passwords, PINs or API keys in your messages or in logs. Read them from my files and put them straight into the app.

## What exists (already built and working)
Repository: **RohanAgarwal346/trex** (GitHub, branch `main`). The app is called **Drishti AI** - a voice/AI-controlled smart CCTV system:
- `cctv-ai/` - Python engine (FastAPI + OpenCV). Cameras (RTSP/HTTP/webcam/file/demo), live view, recording (off / on motion / 24x7), person/vehicle detection and counting, zones and counting lines, events, rules/alerts (Telegram, webhook), gallery, CSV export. A Claude-powered assistant understands requests like "photo of the gate", "video from 9 to 10 am", "how many people today" and can add features by writing plugins (the user must approve plugin code in the Extensions page). Web UI in `cctv-ai/web/`.
- `apps/desktop/` - Electron desktop app. **Already installed on this PC** (release v1.0.1). It runs the engine at `http://127.0.0.1:8800`; data is in `%APPDATA%\Drishti AI\data`. Python venv is in `%APPDATA%\Drishti AI\venv`.
- `apps/android/` - Capacitor Android app that connects to the server address entered on first launch.
- `.github/workflows/release.yml` - on every push to `main` it builds desktop installers (Windows/Mac/Linux) and an Android APK and publishes them in one GitHub Release. Desktop apps auto-update; the Android app shows the new UI as soon as the server has it.
- Read `cctv-ai/README.md` for full details. API: every capability is a tool, call `POST http://127.0.0.1:8800/api/tool/<name>` with a JSON body and header `X-Requested-With: drishti`. Useful tools: `add_camera`, `update_camera`, `list_cameras`, `take_snapshot`, `get_video_clip`, `count_objects`, `set_recording`, `set_counting_zone`, `create_rule`, `set_notifications`, `create_folder`, `add_dashboard_widget`, `system_status`. Also `POST /api/cameras/test` with `{kind, source}`. If a PIN is set in the app, first `POST /api/login` with `{pin}` and keep the cookie.

## Current state
- Desktop app installed, running, showing 2 **demo** cameras only. **No real camera is connected yet.**
- The first GitHub Actions run built all 3 desktop installers OK, but the **Android job failed** (the `android-actions/setup-android` step). A fix is on branch `claude/cctv-ai-voice-app-1s4zo7` (commit `0aac5f6`, workflow now uses the preinstalled SDK). It still needs a **pull request merged into `main`**, then the Android job must be checked.
- Android signing key is not set up yet (see task 6).

## My real CCTV setup
- Folder **`CCTV Connect`** on this PC (path is wherever I opened this session) holds my older Python scripts for my **Dahua** NVR(s): `dahua_sdk.py`, `nvr_bridge.py`, `home_last.py`, `live_watch.py`, `live_roll.py`, `count_test.py`, `line_tool.py`, `godown.py`, `halchal_scan.py`, `bora_*.py`, `door11.json`, `lines.json`, `CLAUDE.md` and folders `live`, `snapshots`, `count_test`, `bag_catalog`, `vinod_ref`. I have about 2-3 NVRs/sites (home and others). **Read `CLAUDE.md` and these scripts first** - they contain the NVR IPs, user names, passwords, channel numbers, door/line settings and how counting was done before.
- Do not modify or delete anything in that folder. Make a copy if you need to experiment.

## Your tasks (do them in this order)
1. **Understand my setup**: read `CLAUDE.md` and the scripts; make a short table (site/NVR, IP, user, channels, what each camera watches). Show it to me WITHOUT passwords and confirm it is right.
2. **Connect every real camera to Drishti AI** using the API above. Dahua RTSP format: `rtsp://USER:PASS@IP:554/cam/realmonitor?channel=N&subtype=0` (use `subtype=1` sub-stream for low-power PCs; URL-encode special characters in passwords such as `@`). Test each with `/api/cameras/test` before adding. Give each camera a clear English name and a `location` (gate, godown, door, etc.). Make sure this PC is on the same network as each NVR; if an NVR is on another site, tell me the options (VPN/Tailscale or one Drishti AI server per site) instead of guessing.
3. **Verify**: for each camera take a snapshot with `take_snapshot` (details=true) and a 10-second clip, look at the images yourself, and tell me what you see. Then delete the 2 demo cameras (ask me first).
4. **Bring over my previous logic**: look at `line_tool`, `lines.json`, `door11.json`, `count_test`, `godown`, `bag_catalog`. Recreate the counting lines/zones with `set_counting_zone`, and where my old scripts did something Drishti AI cannot (for example counting bags in the godown), write it as a Drishti AI **plugin** (see the plugin format in `cctv-ai/server/plugins.py`) and ask me to approve it in the Extensions page. Prefer YOLO for better counting: run `pip install ultralytics` inside the app venv (`%APPDATA%\Drishti AI\venv`) and set the detector to `auto`.
5. **Set up the daily essentials**: recording mode `motion` for important cameras with retention 14 days (check disk space first with `system_status`), a PIN for the app (ask me what PIN to use), my Anthropic API key in Settings (I will paste it myself in the app - do not ask me to paste it in chat), and alert rules I want (ask me 3 simple questions about what alerts I need). Telegram/webhook only if I ask.
6. **Ship the apps**:
   a. Open a pull request from `claude/cctv-ai-voice-app-1s4zo7` into `main` (use `gh` if installed and logged in; otherwise guide me click by click in the GitHub website). Merge it with my OK.
   b. Watch the GitHub Actions run until the Android job is green; if it fails, read the log, fix `.github/workflows/release.yml` or the Android project, and repeat. Release assets must contain the 3 desktop installers and `Drishti-AI.apk`.
   c. Android signing (once): help me create a keystore with `keytool`, and add the repository secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Tell me to keep `release.jks` safe. Never commit it.
   d. Help me install the APK on my phone and connect it to `http://<this PC's LAN IP>:8800`. Note: the desktop app currently binds only to `127.0.0.1`. To allow the phone, add a setting/option so the engine can listen on the LAN (`--host 0.0.0.0`) **only when a PIN is set**, update `apps/desktop/main.js` accordingly, add Windows Firewall guidance, push to `main`, and confirm the auto-update reaches this PC.
7. **Make updates easy for me**: from now on, when I ask for a change, you edit the code, test it, commit, push to `main`, and confirm the new GitHub Release was built so desktop and Android both get it. Tell me in one line what changed.

## Known limits (be honest about them)
- Built-in detector without YOLO finds people only. Voice in the desktop/Android app uses offline Whisper (`faster-whisper`, first use downloads a ~150 MB model and needs internet).
- The Android APK has never been run on a real phone; expect to fix small things on first test.
- Plugins run with full permissions - never auto-approve them; I must read and approve.
- Recording people may be regulated by law; remind me once to put a notice where cameras film.

## Definition of done
Real cameras visible in Live View, I can say/type "photo of the godown", "video of the last 2 minutes of gate", "how many people came today" and get correct results, recording is on, the PIN and API key are set, the Android APK is installed on my phone and works, and pushing to `main` updates both apps.

Start with task 1 now.
