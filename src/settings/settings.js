import * as db from '../shared/db.js';
import { getSettings, saveSettings, normalizeDomain, DEFAULT_DOMAINS } from '../shared/settings.js';
import { getCameraStatus, requestCamera, diagLine, undismissCameraBanner } from '../shared/camera.js';
import { fmtTime, dayKey } from '../shared/format.js';
import { moodEmoji, computeMood, dominantExpression } from '../shared/mood.js';
import { fmtMood } from '../shared/format.js';

const $ = (s) => document.querySelector(s);
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); else console.error('[dhm] missing element', sel); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function init() {
  on('#addDomainForm', 'submit', (e) => { e.preventDefault(); addDomain($('#addDomainInput').value); });
  on('#resetDomains', 'click', resetDomains);
  on('#camGrant', 'click', grantCamera);
  on('#camTest', 'click', testCamera);
  on('#camUndismiss', 'click', async () => { await undismissCameraBanner(); refreshCamera(); });
  on('#sSave', 'click', saveForm);
  on('#exportBtn', 'click', exportJson);
  on('#deleteAllBtn', 'click', deleteAll);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) { renderDomains(); loadForm(); }
    if (area === 'local' && (ch.cameraGranted || ch.cameraError || ch.cameraBannerDismissed)) refreshCamera();
  });
  $('#footer').textContent = `Doomscroll Happiness Monitor v${chrome.runtime.getManifest().version} · local only`;
  await Promise.all([renderDomains(), loadForm(), refreshCamera(), refreshDataStats()]);
}

// ---------------- tracked sites ----------------
async function renderDomains() {
  const { trackedDomains } = await getSettings();
  const el = $('#domainChips');
  el.innerHTML = '';
  if (!trackedDomains.length) el.innerHTML = '<span class="muted">No sites tracked. Add one below.</span>';
  for (const d of trackedDomains) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (DEFAULT_DOMAINS.includes(d) ? '' : ' custom');
    chip.innerHTML = `<span>${esc(d)}</span><button class="x" type="button" title="Stop tracking ${esc(d)}" aria-label="Remove ${esc(d)}">×</button>`;
    chip.querySelector('.x').addEventListener('click', () => removeDomain(d));
    el.appendChild(chip);
  }
}
async function addDomain(raw) {
  const d = normalizeDomain(raw);
  const msg = $('#domainMsg');
  if (!d || !d.includes('.')) { msg.textContent = 'Enter a domain like example.com'; return; }
  const { trackedDomains } = await getSettings();
  if (trackedDomains.includes(d)) { msg.textContent = `${d} is already tracked`; return; }
  await saveSettings({ trackedDomains: [...trackedDomains, d] });
  $('#addDomainInput').value = '';
  msg.textContent = `Added ${d}`;
  setTimeout(() => { if (msg.textContent === `Added ${d}`) msg.textContent = ''; }, 2500);
  renderDomains();
}
async function removeDomain(d) {
  const { trackedDomains } = await getSettings();
  await saveSettings({ trackedDomains: trackedDomains.filter((x) => x !== d) });
  renderDomains();
}
async function resetDomains() {
  await saveSettings({ trackedDomains: [...DEFAULT_DOMAINS] });
  $('#domainMsg').textContent = 'Reset to defaults';
  renderDomains();
}

// ---------------- camera ----------------
async function refreshCamera() {
  const s = await getCameraStatus();
  $('#camStatus').textContent = s.granted ? 'Camera access: granted ✓' : s.state === 'denied' ? 'Camera access: blocked by Chrome' : 'Camera access: not granted yet';
  $('#camGrant').hidden = s.granted;
  $('#camGrant').textContent = s.state === 'denied' ? 'Try again' : 'Allow camera';
  const msg = $('#camMsg');
  if (s.state === 'denied') { msg.hidden = false; msg.textContent = 'Chrome has the camera blocked for this extension. Open chrome://settings/content/camera, remove it from "Not allowed to use your camera", then click Try again.'; }
  else if (s.refused) { msg.hidden = false; msg.textContent = `The capture page was refused the camera (${s.cameraError.name}: ${s.cameraError.message}). Click Allow camera again.`; }
  else if (!msg.dataset.sticky) msg.hidden = true;
  const mi = s.modelInfo;
  $('#modelInfo').textContent = mi
    ? [`face-api on ${mi.backend} (${mi.loadMs}ms, last at ${fmtTime(mi.ts)})`,
       mi.hseLoadMs ? `HSEmotion loaded in ${mi.hseLoadMs}ms with ${mi.hseThreads} WASM thread${mi.hseThreads === 1 ? '' : 's'}` : null,
       mi.hseError ? `HSEmotion error: ${mi.hseError}` : null,
       mi.signalsDelegate ? `MediaPipe landmarker on ${mi.signalsDelegate} (${mi.signalsLoadMs}ms)` : null,
       mi.signalsError ? `signals error: ${mi.signalsError}` : null].filter(Boolean).join(' · ')
    : 'Models not loaded yet; they load on the first tracked session.';
  $('#camCause').textContent = s.cause;
  $('#camUndismiss').hidden = !s.cameraBannerDismissed;
  $('#camDiag').textContent = diagLine(s);
}
async function grantCamera() {
  const msg = $('#camMsg');
  msg.hidden = false; msg.dataset.sticky = '1';
  msg.textContent = 'Waiting for the camera permission prompt… (look for a bubble under the address bar, or a macOS dialog)';
  $('#camGrant').disabled = true;
  const r = await requestCamera();
  $('#camGrant').disabled = false;
  if (r.ok) { msg.textContent = 'Camera access granted. Capture will start on your next tracked session.'; setTimeout(() => { delete msg.dataset.sticky; refreshCamera(); }, 4000); }
  else { msg.textContent = `Camera request failed: ${r.name}: ${r.message}. ${r.hint}`; }
  refreshCamera();
}
let testStream = null;
async function testCamera() {
  const out = $('#camTestOut'), txt = $('#camTestText'), video = $('#camVideo');
  if (testStream) { for (const t of testStream.getTracks()) t.stop(); testStream = null; out.hidden = true; $('#camTest').textContent = 'Test detection'; return; }
  out.hidden = false; txt.textContent = 'Loading model…';
  try {
    if (!window.faceapi) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = chrome.runtime.getURL('lib/face-api.js'); s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri('/models'), faceapi.nets.faceExpressionNet.loadFromUri('/models')]);
    testStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } }, audio: false });
    await chrome.storage.local.set({ cameraGranted: Date.now() });
    refreshCamera();
    video.srcObject = testStream; await video.play();
    $('#camTest').textContent = 'Stop test';
    const loop = async () => {
      if (!testStream) return;
      const t0 = performance.now();
      const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })).withFaceExpressions();
      const ms = Math.round(performance.now() - t0);
      if (det) { const e = { ...det.expressions }; const mood = computeMood(e); txt.textContent = `${moodEmoji(mood)} mood ${fmtMood(mood, true)} · ${dominantExpression(e)} · ${ms}ms on ${faceapi.tf.getBackend()}`; }
      else txt.textContent = `No face detected · ${ms}ms`;
      setTimeout(loop, 700);
    };
    loop();
  } catch (e) { txt.textContent = `Test failed: ${e.name}: ${e.message}`; }
}

// ---------------- capture settings ----------------
async function loadForm() {
  const s = await getSettings();
  $('#sEnabled').checked = s.enabled;
  $('#sInterval').value = s.captureIntervalMs / 1000;
  $('#sGrace').value = Math.round(s.graceMs / 1000);
  $('#sIdle').value = s.idleSeconds;
  $('#sMinSession').value = Math.round((s.minSessionMs ?? 60000) / 1000);
  $('#sThumbs').checked = s.storeThumbnails;
  $('#sThumbSize').value = s.thumbSize;
  $('#sScreen').checked = s.captureScreen;
  $('#sScreenWidth').value = s.screenWidth;
  $('#sHse').checked = s.useHsemotion;
  $('#sMoodSource').value = s.moodSource;
  $('#sSignals').checked = s.signals;
  const { screenError } = await chrome.storage.local.get('screenError');
  $('#screenInfo').textContent = screenError
    ? `Last screenshot error (${fmtTime(screenError.ts)}): ${screenError.message}`
    : 'Screenshots use Chrome\'s tab-capture API on tracked sites only and are stored next to the webcam frame. They can contain private content (DMs, emails); everything stays on this machine.';
}
async function saveForm() {
  await saveSettings({
    enabled: $('#sEnabled').checked,
    captureIntervalMs: Math.round(Math.max(1, Number($('#sInterval').value) || 3) * 1000),
    graceMs: Math.max(5, Number($('#sGrace').value) || 30) * 1000,
    idleSeconds: Math.max(15, Number($('#sIdle').value) || 60),
    minSessionMs: Math.max(5, Number($('#sMinSession').value) || 60) * 1000,
    storeThumbnails: $('#sThumbs').checked,
    thumbSize: Math.max(48, Number($('#sThumbSize').value) || 160),
    captureScreen: $('#sScreen').checked,
    screenWidth: Math.max(160, Number($('#sScreenWidth').value) || 480),
    useHsemotion: $('#sHse').checked,
    moodSource: $('#sMoodSource').value,
    signals: $('#sSignals').checked,
  });
  $('#sSaved').textContent = 'Saved.';
  setTimeout(() => { $('#sSaved').textContent = ''; }, 2000);
}

// ---------------- data ----------------
async function refreshDataStats() {
  const sessions = await db.getAll('sessions');
  const frames = await db.countByIndex('frames', 'ts', IDBKeyRange.lowerBound(0));
  let est = '';
  try { const q = await navigator.storage.estimate(); est = ` · ~${(q.usage / 1e6).toFixed(1)} MB used`; } catch {}
  $('#dataStats').textContent = `${sessions.length} sessions · ${frames} frames${est}`;
}
async function exportJson() {
  const sessions = await db.getAll('sessions');
  const out = { exportedAt: new Date().toISOString(), moodFormula: 'happy + 0.3*surprised - sad - angry - disgusted - 0.7*fearful', sessions: [] };
  for (const s of sessions) {
    const frames = (await db.framesForSession(s.id)).map(({ thumb, screen, ...f }) => f);
    const activity = await db.activityForSession(s.id);
    out.sessions.push({ ...s, frames, activity });
  }
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `happiness-monitor-${dayKey()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function deleteAll() {
  if (!confirm('Delete ALL recorded data? This cannot be undone.')) return;
  await db.clearAll();
  refreshDataStats();
}

init().catch((e) => { console.error('[dhm] settings init failed', e); document.body.insertAdjacentHTML('afterbegin', `<div class="banner">Settings page failed to start: ${esc(e.message)}</div>`); });
