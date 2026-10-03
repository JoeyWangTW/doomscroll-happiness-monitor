# Doomscroll Happiness Monitor

A Chrome extension that notices when you are on social media, quietly takes a webcam frame every few seconds, runs a **fully local** facial-expression model on each frame, and shows you a dashboard of what you used, for how long, and how your mood trended while you scrolled.

Nothing leaves your machine. There is no server, no analytics, no network call. Frames and scores live in the extension's own IndexedDB and can be deleted from the dashboard at any time.

## How it works

```
active tab on a tracked site ──▶ background.js opens a "session"
                                  │
                                  ▼
                       offscreen page (src/offscreen)
                       ├─ getUserMedia (webcam)
                       ├─ every 3 s: draw frame → face-api tiny detector + expression net
                       └─ write {expressions, mood, thumbnail} → IndexedDB
                                  │
content script (src/content) ─────┤ scroll px / clicks / keys every 5 s
                                  ▼
                        dashboard (src/dashboard) reads IndexedDB
```

- **Session detection** (`src/background.js`): a session starts when the focused window's active tab is on a tracked domain and you are not idle. It ends after you have been away for 30 s (configurable), which absorbs quick tab switches. Sessions shorter than the minimum (60 s by default, configurable) are discarded together with their frames when they end, so clicking through a site does not leave a record. Chrome's idle signal only sees keyboard and mouse input, so a recently detected face keeps a running session alive while you sit still watching a video.
- **Capture + inference** (`src/offscreen/offscreen.js`): Chrome's offscreen-document API owns the camera. Each frame goes through three local models:
  - `@vladmandic/face-api` tiny face detector + 7-class expression net (tfjs WebGL, ~0.5 MB) gives the face box and the classic 7 probabilities.
  - **HSEmotion `enet_b0_8_va_mtl`** (EfficientNet-B0 trained on AffectNet, 16 MB ONNX, run with ONNX Runtime Web on multi-threaded WASM, ~14 ms/frame) gives 8 probabilities plus **valence and arousal**.
  - **MediaPipe Face Landmarker** (3.6 MB, GPU) samples the video continuously at 10 fps and aggregates per interval: blink rate, brow furrow, lip press, looking-away share, jaw open, eye squint, smile, head yaw/pitch/roll, face presence.
  See `docs/research-emotion-models.md` for the benchmark and the reasoning. The camera is released the moment the session ends.
- **Mood score** (`src/shared/mood.js`): one number in [-1, +1]. By default it is HSEmotion's **valence**; the alternative source is the face-api formula `happy + 0.3·surprised − sad − angry − disgusted − 0.7·fearful`. Both are stored on every frame, and the dashboard can switch the mood line between them for any session. Per session it reports the average, the first-third vs last-third delta (the "trend"), and a least-squares slope per minute.
- **Page screenshots** (`captureScreenFor` in `src/background.js`): at each webcam frame the worker also grabs the visible tab with `chrome.tabs.captureVisibleTab`, downscales it (480 px wide by default, ~25-40 KB JPEG) and stores it next to the frame with the page title and URL. This is why the manifest asks for `<all_urls>`: Chrome only allows tab capture with that permission, even though the code only captures on tracked sites. Turn it off in Settings if you don't want screenshots kept.
- **Timelapse export** (`src/dashboard/timelapse.js`): renders a session's frames into a video in the page itself (canvas + MediaRecorder, MP4 where Chrome supports it, otherwise WebM). Modes: screen + webcam side by side, screen only, webcam only. Each frame gets a bar with site, time, mood, and a mood sparkline with a progress marker. Rendering runs in real time at the chosen frame rate.
- **Activity** (`src/content/activity.js`): counts scroll distance, clicks and keystrokes on tracked sites. Only counts, never content.

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
2. Click the extension icon → **Settings** → **Allow camera**. Chrome remembers this for the extension, so the offscreen capture page can use the webcam later without prompting. Use **Test detection** to see the model react to your face live. If nothing happens after ~20 s the page tells you why (on macOS, Chrome itself usually needs camera permission in System Settings → Privacy & Security → Camera).
3. Open YouTube / X / Reddit / … The badge turns red `REC` while a session is being captured. The camera LED will be on during sessions.
4. Click the icon → **Open dashboard**.

Chrome 116+ is required (offscreen documents + `runtime.getContexts`).

## Dashboard

- **Tiles**: time on tracked sites, average mood, time-weighted mood drift within sessions, share of frames with a face.
- **Time by site** and a **session list** (10 per page) with a sparkline and trend (▲ improving / ▼ declining / ● flat). A **Grouped** mode merges sessions that follow each other within a chosen gap (5 min to 2 h) into blocks, so hopping between YouTube and Reddit reads as one sitting; the detail view then covers the whole block with bands on the mood chart showing which site was open when.
- **Session detail**: a mood-source toggle (HSEmotion valence / face-api formula), then the mood line (5-frame rolling mean, blue above zero / red below) doubles as a timeline. Hovering shows time, mood and top expressions; clicking or dragging scrubs a **player** beside the chart that shows the screenshot and webcam frame for that moment, with play/pause at 2-24 fps, frame stepping (← →, space), a Both/Screen/Webcam toggle and Enlarge. Below: a **Signals** grid of small charts (arousal, blink rate, brow furrow, lip press, looking away, face size), expression mix, scroll activity per minute, and a frame gallery with the same three views (click a frame to jump the player there, double-click to enlarge). **Export timelapse** lives in the gallery header.
- **Timelapse** button on every session row, and **Export timelapse** in the detail panel.

## Settings page

Its own page (`src/settings/settings.html`, also the extension's options page):

- **Tracked sites**: chips for every tracked domain with remove buttons, an add box, and reset to defaults. Changes save immediately. The popup also has a one-click **Track this site / Stop tracking** button for the current tab.
- **Camera**: status, Allow camera, Test detection (live preview with the model running), and a `diag:` line with the raw permission state, grant flag, last capture error and last frame time for troubleshooting.
- **Capture**: frame interval, model toggles (HSEmotion, face signals) and which source the mood line uses, grace period, idle threshold, thumbnails on/off and size, camera permission, export to JSON (without thumbnails), delete a day or everything.

Sites added to the list get the activity counter registered automatically.

## Data model (IndexedDB `doomscroll-happiness-monitor`)

| store | fields |
|---|---|
| `sessions` | `id, domain, url, title, startedAt, endedAt, open` |
| `frames` | `sessionId, ts, faceFound, score, box, expressions{7}, mood, dominant, thumb (JPEG Blob), inferMs, backend, screen (JPEG Blob), pageUrl, pageTitle, hse {probs{8}, valence, arousal, dominant, ms}, signals {blinkRate, browDown, mouthPress, lookAway, eyeLookDown, jawOpen, eyeSquint, smile, yaw, pitch, roll, facePresence, samples, windowMs}` |
| `activity` | `sessionId, ts, scrollPx, clicks, keys` |

Thumbnails and screenshots are kept by default so other local models can be run over past frames later and so timelapses can be exported; turn either off in Settings if you would rather keep only the scores. Expect roughly 40-60 MB per hour of scrolling with both on at default sizes.

## Roadmap ideas

- Swap or add models (e.g. MediaPipe blendshapes, a ViT emotion classifier via transformers.js) by adding a second scorer in the offscreen page and a column in `frames`.
- Attention / posture / blink-rate metrics from the same frames.
- Per-video or per-subreddit breakdown using the tab URL at each frame.
- Nudges: notify when a session's trend has been declining for N minutes.

## Layout

```
manifest.json
lib/face-api.js            @vladmandic/face-api 1.7.15 (bundled tfjs, MIT)
lib/ort/                   onnxruntime-web 1.29 (WASM, multi-threaded via COOP/COEP in the manifest)
lib/mediapipe/             @mediapipe/tasks-vision 1.0.1 (vision bundle + wasm)
models/                    tiny_face_detector + face_expression weights, face_landmarker.task,
                           hsemotion/enet_b0_8_va_mtl.onnx
docs/                      research notes (model benchmark, signal literature)
src/background.js          service worker: session state machine, offscreen lifecycle, badge
src/offscreen/             webcam capture + inference
src/content/activity.js    scroll/click/key counters
src/popup/                 status popup
src/dashboard/             dashboard (charts, session detail, timelapse export)
src/settings/              settings page (tracked sites, camera, capture, data) — also the options page
src/shared/                db.js (IndexedDB), mood.js (scoring), settings.js, camera.js, format.js
```

## Tests

```
cd test && npm install        # downloads Chrome for Testing
npm run unit                  # mood scoring + domain matching
npm run e2e                   # loads the extension headless with a fake webcam, visits YouTube,
                              # checks sessions/frames/screenshots/activity in IndexedDB, renders
                              # timelapses in all three modes, screenshots to test/out/
npm run settings              # settings page: domain add/remove/reset, camera grant/dismiss flows, popup
node unit-signals.mjs         # blink counting / signal aggregation
```

## License

MIT, see `LICENSE`. Bundled libraries and model weights keep their own licenses, listed in `THIRD_PARTY_NOTICES.md`.
