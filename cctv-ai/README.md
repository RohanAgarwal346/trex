# 👁️ दृष्टि AI — Voice-controlled Smart CCTV

Apne CCTV cameras ko **bolkar** chalao: *"gate ka photo do"*, *"pichhle 2 minute ki video"*, *"kal subah 9 se 10 ke beech kitne log aaye?"*,
*"raat 10 ke baad koi aaye to alert do"* — aur agar app mein koi feature kam hai to bas AI ko bolo, wo **khud naya feature bana dega**.

## Quick start

```bash
cd cctv-ai
./run.sh                       # installs deps, starts on http://localhost:8800
```

Requirements: Python 3.10+, `ffmpeg` (video clips ke liye). Pehli baar kholne par 2 **demo cameras** milte hain, taaki bina hardware ke sab kuch try kar sako.

1. **Cameras → Camera jodo** — brand ka template chuno (Hikvision, Dahua/CP Plus, Tapo, Reolink, Ezviz…), IP/user/password bharo, *Test* dabao.
   Phone ko camera banana ho to "IP Webcam" app ka `http://phone-ip:8080/video` URL do. Laptop webcam = type *webcam*, source `0`.
2. **Settings → AI (Claude)** — Anthropic API key daalo (ya `export ANTHROPIC_API_KEY=...`). Bina key ke sirf basic keyword mode chalta hai.
3. 🎙️ orb dabao, mic dabao aur bolo (Chrome/Edge; Hindi `हिं` ya English `EN` toggle).
4. **Settings → PIN** lagao. (Phone/internet se kholne ke liye PIN zaroori hai — bina PIN ke app sirf local network se khulta hai.)

Phone se mic chalane ke liye browser ko **HTTPS** chahiye (e.g. Tailscale / Cloudflare Tunnel). `DRISHTI_HOST=0.0.0.0 ./run.sh` se LAN par khulta hai.

## Kya-kya kar sakta hai

| Aap bolo / karo | Kya hota hai |
|---|---|
| "Gate ka photo do" | Live **still photo**, boxes + timestamp ke saath |
| "Details ke saath photo do" | Photo par **DETAILS panel**: kya-kya mila, counts, motion % |
| "Left side ka zoom photo" | `crop` — kisi hisse ka zoom |
| "Kal 9:15 ka photo" | Recording se **past time ka frame** |
| "Pichhle 30 sec ki video" / "agle 20 sec record karo" | Clip (pre-roll ke saath), H.264, browser mein chalti hai |
| "Kal shaam 6 se 7 ki video" | Saved recording se **time-range clip**; "8x speed" = **time-lapse** |
| "Abhi kitne log/gaadi?" | Live **count** (log, car, bike, truck, bus, cycle, dog, cat) |
| "Aaj 9 se 12 ke beech kitne log aaye?" | **Unique** log (tracking se, same banda dobara nahi), peak-at-once, in/out count |
| "Is shop mein kitne bikes khade hain? / shutter khula hai?" | `ask_about_camera` — AI **khud image dekh kar** koi bhi cheez gin/bata sakta hai |
| "Aaj kab sabse zyada bheed thi?" | Hour-by-hour chart + busiest hour |
| "Gate par line banao, aane-jaane ginti karo" | Counting **line** (in/out) aur **zone** (sirf us hisse mein count) |
| "Motion par record karo, 14 din rakho" | Recording: off / motion (pre-roll) / 24×7, retention |
| "Raat 10 se 6 ke beech person dikhe to bolkar batao + photo bhejo" | **Rules**: notify / speak / photo / clip, time-window, cooldown; Telegram + webhook |
| "Important folder bana ke ye photo usme rakho" | Gallery **folders** |
| "Dashboard par gaadiyon ka card jodo" | Dashboard **widgets** |
| "Events ka CSV do" | Export |

## 🧩 AI se app mein naya feature jodna (self-extending)

Yeh app ka sabse khaas hissa hai. Chat mein bolo: *"ek naya page banao jo din bhar ki gaadiyon ki list dikhaye"*.

* **Bina code ke changes** (rules, folders, dashboard cards, camera settings, recording, alerts, accent color) — AI turant kar deta hai.
* **Naya code wala feature** — AI ek Python **plugin** likhta hai (naye tools, naya sidebar page, event hooks). Wo **Pending** mein aata hai; aap
  *Extensions* page par code padhkar **Approve** dabate ho, tabhi chalu hota hai. Plugin approve hote hi AI ke tools mein judd jaata hai
  (`plugin__tool`) aur uska page sidebar mein aa jaata hai — restart nahi chahiye.
* Plugin API: `api.cameras()`, `api.counts()`, `api.snapshot()`, `api.events()`, `api.sql("SELECT …")` (read-only), `api.notify()`, `api.kv_get/kv_set`.

⚠️ Plugins aapke server par poori permission se chalte hain — **sirf wahi approve karo jo padh liya ho.**

## Dusre apps se kya-kya liya gaya (research)

Maine in sab ke feature-sets se compare karke ek jagah jodne ki koshish ki: **Hik-Connect, Dahua DMSS/iDMSS, CP Plus Guard / Godrej Eve, Ezviz,
Imou Life, Reolink, TP-Link Tapo, V380, Xiaomi Mi Home, Google Nest, Ring, Arlo, Wyze, Blue Iris, Frigate NVR, Synology Surveillance,
Milestone XProtect, Verkada, Eagle Eye.**

| Idea | Source jaisa app | Yahan |
|---|---|---|
| Live multi-camera grid, brand RTSP templates | Hik-Connect, DMSS, Blue Iris | ✅ |
| Motion/person/vehicle events + snapshot thumbnails + timeline | Frigate, Ring, Nest | ✅ |
| Pre-roll recording, motion-only storage saving | Frigate, Blue Iris | ✅ |
| Zones & counting lines | Frigate, Milestone, Verkada | ✅ |
| Time-lapse, clip export, CSV | Synology, Blue Iris | ✅ |
| Rules (if-this-then-that), quiet hours | Arlo, Wyze, Ring modes | ✅ |
| Telegram/webhook push | Frigate + Home Assistant | ✅ (browser push bhi) |
| Natural-language search / vision Q&A | Verkada, Eagle Eye, Google Home AI | ✅ (Claude vision) |
| PIN lock, retention, disk status | sab | ✅ |
| PTZ / ONVIF control | Hik-Connect, Reolink | 🔜 (plugin se `onvif-zeep` ke saath add ho sakta hai) |
| Two-way audio / siren | Ring, Tapo | 🔜 |
| Face recognition / number-plate (ANPR) | Verkada, Frigate+ | 🔜 — privacy/legal ki wajah se jaanbujhkar default mein nahi |
| Multi-user roles, cloud backup | Ring, Arlo | 🔜 |
| Installable on phone | — | ✅ PWA manifest ("Add to Home Screen") |

Honest note: ye comparison meri jaankari par based hai (is session mein sabhi apps ka live web-scrape nahi kiya gaya). Jo 🔜 hain wo AI plugin se ya agle version mein aa sakte hain.

## Detection quality

* **Default (zero download):** OpenCV HOG — sirf **log** (person) pehchanta hai, moderate accuracy + motion detection.
* **Better:** `pip install ultralytics` — phir YOLOv8 automatically use hota hai (log, gaadi, bike, bus, truck, cycle, kutta, billi).
  *(pehli baar model download internet maangta hai.)*
* **Sabse flexible:** AI ko bolo "ask about camera" wale sawal — Claude image dekhkar koi bhi cheez gin deta hai (par ye history mein save nahi hota).

## Seemayein (jo jaanna zaroori hai)

* Past recordings sirf unhi dino/samay ki milti hain jab **recording mode ON** tha. Counting history sirf app chalu hone ke baad ki hai.
* Clip/photo ki quality camera ke stream aur `Processing FPS` (Settings) par depend karti hai; recordings ~10 fps par save hoti hain.
* HOG detector bheed mein ya door ke log miss kar sakta hai — accurate counting ke liye YOLO use karo.
* Voice recognition browser ki Web Speech API se hoti hai (Chrome/Edge best); audio browser vendor ke servers par jaa sakta hai.
* Dusron ko record karna kai jagah legal/privacy rules ke andar aata hai — apni property par hi lagao aur board lagao.

## Structure

```
cctv-ai/
  run.sh  requirements.txt
  server/  core.py (db/settings)  camera.py (capture, record, events)  detect.py (HOG/YOLO, tracker)
           tools.py (saari capabilities)  ai.py (Claude agent)  plugins.py (self-extension)  rules.py  media.py  main.py (API)
  web/     index.html  style.css  app.js  manifest.json
  data/    (auto) drishti.db, snapshots/, clips/, recordings/, plugins/
```

`data/` mein aapki recordings aur settings (API key samet) hain — ise git mein commit mat karo (`.gitignore` mein already hai).
