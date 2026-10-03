// Continuous face-signal sampling with MediaPipe Face Landmarker (52 blendshapes + head pose).
// Runs at ~10 fps while a session is active and aggregates into a window that the emotion
// frame flushes every capture interval. Everything stays local.
let landmarkerPromise = null;
let sampling = false, timer = null;
let lastTs = 0;
const BLINK_ON = 0.5, BLINK_OFF = 0.3; // hysteresis on the eyeBlink blendshapes
let eyeClosed = false;
let win = null;
let lastFace = null; // { box: {x,y,width,height} normalized, ts }

// Most recent face box seen by the landmarker (normalized to the video frame), if fresh enough.
export function latestFaceBox(maxAgeMs = 2000) {
  return lastFace && Date.now() - lastFace.ts <= maxAgeMs ? lastFace.box : null;
}

export function newWindow() {
  return { samples: 0, faceSamples: 0, blinks: 0, startedAt: Date.now(), sum: { browDown: 0, browInnerUp: 0, mouthPress: 0, jawOpen: 0, eyeSquint: 0, smile: 0, eyeLookDown: 0, lookAway: 0, yaw: 0, pitch: 0, roll: 0 } };
}

export function signalsLoad(delegate = 'GPU') {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const t0 = performance.now();
      const mp = await import(chrome.runtime.getURL('lib/mediapipe/vision_bundle.mjs'));
      const files = await mp.FilesetResolver.forVisionTasks(chrome.runtime.getURL('lib/mediapipe'));
      const make = (d) => mp.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task'), delegate: d },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      let lm, used = delegate;
      try { lm = await make(delegate); } catch (e) { console.warn('[dhm] landmarker', delegate, 'failed, using CPU', e); lm = await make('CPU'); used = 'CPU'; }
      return { lm, delegate: used, loadMs: Math.round(performance.now() - t0) };
    })().catch((e) => { landmarkerPromise = null; throw e; });
  }
  return landmarkerPromise;
}

function bs(cats, name) { const c = cats.find((x) => x.categoryName === name); return c ? c.score : 0; }
function headPose(matrix) {
  // column-major 4x4; R[r][c] = m[c*4+r]
  const m = matrix.data;
  const yaw = Math.atan2(m[8], m[10]) * 180 / Math.PI;
  const pitch = Math.atan2(-m[9], Math.hypot(m[8], m[10])) * 180 / Math.PI;
  const roll = Math.atan2(m[1], m[5]) * 180 / Math.PI;
  return { yaw, pitch, roll };
}

// Feed one landmarker result into the current window. Exported for unit tests.
export function accumulate(w, res) {
  w.samples++;
  const cats = res?.faceBlendshapes?.[0]?.categories;
  if (!cats) { eyeClosed = false; return; }
  w.faceSamples++;
  const lms = res.faceLandmarks?.[0];
  if (lms?.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of lms) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
    lastFace = { box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, ts: Date.now() };
  }
  const blink = (bs(cats, 'eyeBlinkLeft') + bs(cats, 'eyeBlinkRight')) / 2;
  if (!eyeClosed && blink > BLINK_ON) { eyeClosed = true; w.blinks++; }
  else if (eyeClosed && blink < BLINK_OFF) eyeClosed = false;
  const s = w.sum;
  s.browDown += (bs(cats, 'browDownLeft') + bs(cats, 'browDownRight')) / 2;
  s.browInnerUp += bs(cats, 'browInnerUp');
  s.mouthPress += (bs(cats, 'mouthPressLeft') + bs(cats, 'mouthPressRight')) / 2;
  s.jawOpen += bs(cats, 'jawOpen');
  s.eyeSquint += (bs(cats, 'eyeSquintLeft') + bs(cats, 'eyeSquintRight')) / 2;
  s.smile += (bs(cats, 'mouthSmileLeft') + bs(cats, 'mouthSmileRight')) / 2;
  const lookDown = (bs(cats, 'eyeLookDownLeft') + bs(cats, 'eyeLookDownRight')) / 2;
  s.eyeLookDown += lookDown;
  let pose = { yaw: 0, pitch: 0, roll: 0 };
  const mat = res.facialTransformationMatrixes?.[0];
  if (mat) pose = headPose(mat);
  s.yaw += pose.yaw; s.pitch += pose.pitch; s.roll += pose.roll;
  if (Math.abs(pose.yaw) > 25 || Math.abs(pose.pitch) > 20 || lookDown > 0.6) s.lookAway++;
}

// Close the window and return per-interval aggregates (means over face samples, rates per minute).
export function flush(w) {
  const dur = Math.max(1, Date.now() - w.startedAt);
  const n = Math.max(1, w.faceSamples);
  const out = {
    samples: w.samples, faceSamples: w.faceSamples, windowMs: dur,
    blinks: w.blinks, blinkRate: w.faceSamples ? w.blinks / (dur / 60000) : null,
    facePresence: w.samples ? w.faceSamples / w.samples : null,
    lookAway: w.faceSamples ? w.sum.lookAway / n : null,
  };
  for (const k of ['browDown', 'browInnerUp', 'mouthPress', 'jawOpen', 'eyeSquint', 'smile', 'eyeLookDown', 'yaw', 'pitch', 'roll']) out[k] = w.faceSamples ? w.sum[k] / n : null;
  return out;
}

export async function startSignals(video, fps = 10) {
  const { lm } = await signalsLoad();
  win = newWindow();
  sampling = true;
  const step = () => {
    if (!sampling) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const ts = Math.max(lastTs + 1, Math.round(performance.now()));
        lastTs = ts;
        accumulate(win, lm.detectForVideo(video, ts));
      }
    } catch (e) { console.warn('[dhm] signals sample failed', e); }
    timer = setTimeout(step, 1000 / fps);
  };
  step();
}
export function takeSignals() {
  if (!win) return null;
  const out = flush(win);
  win = newWindow();
  return out;
}
export function stopSignals() {
  sampling = false;
  lastFace = null;
  if (timer) { clearTimeout(timer); timer = null; }
  win = null;
}
