// Offscreen document: owns the webcam and runs the local face-expression model.
// Frames are written straight into IndexedDB; only a tiny summary goes to the worker.
import * as db from '../shared/db.js';
import { computeMood, dominantExpression } from '../shared/mood.js';
import { hseLoad, hsePredict } from './hsemotion.js';
import { signalsLoad, startSignals, takeSignals, stopSignals, latestFaceBox } from './signals.js';

const video = document.getElementById('video');
const canvas = document.getElementById('frame');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const thumbCanvas = document.getElementById('thumb');
const thumbCtx = thumbCanvas.getContext('2d');

const state = {
  capturing: false, active: true, sessionId: null, opts: {}, stream: null, timer: null,
  modelsReady: null, backend: null, busy: false, hseReady: false,
};

const send = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'background' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'ensure-capture':
      if (state.capturing && state.sessionId === msg.sessionId) {
        state.active = msg.active !== false;
        state.opts = { ...state.opts, ...msg };
        return { capturing: true };
      }
      await startCapture(msg);
      return { capturing: state.capturing };
    case 'set-active':
      state.active = !!msg.active;
      return;
    case 'stop-capture':
      await stopCapture();
      return;
    case 'ping':
      return { capturing: state.capturing, sessionId: state.sessionId, backend: state.backend };
    default:
      throw new Error('unknown message ' + msg.type);
  }
}

async function loadModels() {
  if (!state.modelsReady) {
    state.modelsReady = (async () => {
      const t0 = performance.now();
      // Root-relative on purpose: face-api's URI parser mangles chrome-extension:// URLs.
      const base = '/models';
      await selectBackend('webgl');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.faceExpressionNet.loadFromUri(base),
      ]);
      // Warm up so the first real frame is not slow.
      const warm = document.createElement('canvas'); warm.width = 320; warm.height = 240;
      try { await detect(warm); } catch (e) { console.warn('[dhm] warm-up failed on', state.backend, e); await selectBackend('cpu'); await detect(warm); }
      send({ type: 'models-loaded', backend: state.backend, ms: Math.round(performance.now() - t0) });
      // Optional heavier models load in the background; frames simply lack their fields until ready.
      if (state.opts.useHsemotion) hseLoad().then((r) => send({ type: 'hse-loaded', ms: r.loadMs, threads: r.threads })).catch((e) => send({ type: 'model-error', model: 'hsemotion', message: String(e?.message || e) }));
      if (state.opts.signals) signalsLoad().then((r) => send({ type: 'signals-loaded', ms: r.loadMs, delegate: r.delegate })).catch((e) => send({ type: 'model-error', model: 'signals', message: String(e?.message || e) }));
    })().catch((e) => { state.modelsReady = null; throw e; });
  }
  return state.modelsReady;
}

async function selectBackend(preferred) {
  const tf = faceapi.tf;
  try {
    await tf.setBackend(preferred);
    await tf.ready();
    tf.tidy(() => tf.ones([4, 4]).square().dataSync()); // smoke test the backend
    state.backend = tf.getBackend();
  } catch (e) {
    console.warn('[dhm] backend', preferred, 'unavailable, falling back to cpu', e);
    await tf.setBackend('cpu');
    await tf.ready();
    state.backend = 'cpu';
  }
}

function detect(input) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 });
  return faceapi.detectSingleFace(input, options).withFaceExpressions();
}

async function startCapture(msg) {
  await stopCapture();
  state.sessionId = msg.sessionId;
  state.opts = msg;
  state.active = msg.active !== false;
  try {
    await loadModels();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch (e) {
    console.error('[dhm] capture failed', e);
    send({ type: 'capture-error', name: e?.name || 'Error', message: e?.message || String(e) });
    return;
  }
  video.srcObject = state.stream;
  await new Promise((resolve) => { if (video.readyState >= 2) resolve(); else video.onloadedmetadata = () => resolve(); });
  await video.play().catch(() => {});
  state.capturing = true;
  send({ type: 'capture-started', sessionId: state.sessionId });
  if (state.opts.signals) startSignals(video, 10).catch((e) => send({ type: 'model-error', model: 'signals', message: String(e?.message || e) }));
  state.timer = setTimeout(tick, 1200); // let auto-exposure settle before the first frame
}

async function stopCapture() {
  state.capturing = false;
  stopSignals();
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); state.stream = null; }
  video.srcObject = null;
  state.sessionId = null;
}

async function tick() {
  if (!state.capturing) return;
  if (state.active && !state.busy) {
    try { await captureOne(); } catch (e) { console.error('[dhm] frame failed', e); }
  }
  if (state.capturing) state.timer = setTimeout(tick, Math.max(500, state.opts.intervalMs || 3000));
}

async function captureOne() {
  state.busy = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    const t0 = performance.now();
    let det = null;
    try {
      det = await detect(canvas);
    } catch (e) {
      if (state.backend !== 'cpu') { await selectBackend('cpu'); det = await detect(canvas); } else throw e;
    }
    const inferMs = Math.round(performance.now() - t0);

    let expressions = det ? { ...det.expressions } : null;
    let pixelBox = det ? det.detection.box : null;
    let detector = det ? 'faceapi' : null;
    let score = det ? det.detection.score : null;
    if (!pixelBox) {
      // The tiny detector misses a lot; fall back to the landmarker's face box when it has one.
      const nb = latestFaceBox();
      if (nb) {
        pixelBox = { x: nb.x * w, y: nb.y * h, width: nb.width * w, height: nb.height * h };
        detector = 'mediapipe';
        try {
          const cx = pixelBox.x + pixelBox.width / 2, cy = pixelBox.y + pixelBox.height / 2, side = Math.max(pixelBox.width, pixelBox.height) * 1.2;
          const crop = document.createElement('canvas'); crop.width = 224; crop.height = 224;
          crop.getContext('2d').drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, 224, 224);
          expressions = { ...(await faceapi.nets.faceExpressionNet.predictExpressions(crop)) };
        } catch (e) { console.warn('[dhm] expression on landmark crop failed', e); }
      }
    }
    const faceFound = !!pixelBox;
    const dominant = dominantExpression(expressions);
    const box = pixelBox ? { x: pixelBox.x / w, y: pixelBox.y / h, w: pixelBox.width / w, h: pixelBox.height / h } : null;
    let hse = null;
    if (faceFound && state.opts.useHsemotion && state.hseReady) {
      try { hse = await hsePredict(canvas, pixelBox); } catch (e) { console.warn('[dhm] hsemotion failed', e); }
    } else if (faceFound && state.opts.useHsemotion) {
      hseLoad().then(() => { state.hseReady = true; }).catch(() => {});
    }
    const mood = state.opts.moodSource === 'valence' && hse ? hse.valence : computeMood(expressions);
    const signals = state.opts.signals ? takeSignals() : null;

    let thumb = null;
    if (state.opts.storeThumbnails) {
      const tw = Math.max(48, state.opts.thumbSize || 160), th = Math.round(tw * h / w);
      thumbCanvas.width = tw; thumbCanvas.height = th;
      thumbCtx.drawImage(canvas, 0, 0, tw, th);
      thumb = await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.7));
    }

    const rec = {
      sessionId: state.sessionId, ts: Date.now(), faceFound, score, detector,
      box, expressions, mood, dominant, thumb, inferMs, backend: state.backend, hse, signals,
    };
    if (!state.capturing) return; // stopped while we were inferring
    const frameId = await db.add('frames', rec);
    send({ type: 'frame', frameId, sessionId: rec.sessionId, ts: rec.ts, faceFound: rec.faceFound, mood, dominant, inferMs, valence: hse?.valence ?? null, arousal: hse?.arousal ?? null, hseMs: hse?.ms ?? null, blinkRate: signals?.blinkRate ?? null });
  } finally {
    state.busy = false;
  }
}
