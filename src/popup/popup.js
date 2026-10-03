import { moodEmoji } from '../shared/mood.js';
import { fmtDuration, fmtMood } from '../shared/format.js';
import { getSettings, saveSettings, hostnameFromUrl, matchTracked, normalizeDomain } from '../shared/settings.js';
import { getCameraStatus } from '../shared/camera.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'background' });

$('#openDash').addEventListener('click', () => openDashboard(''));
$('#openSettings').addEventListener('click', () => openPage('src/settings/settings.html'));
$('#cameraBtn').addEventListener('click', () => openPage('src/settings/settings.html'));
$('#enabled').addEventListener('change', async (e) => { await send({ type: 'set-enabled', enabled: e.target.checked }); refresh(); });

$('#trackBtn').addEventListener('click', toggleTrackCurrent);

async function currentTabHost() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return hostnameFromUrl(tab?.url);
}
async function refreshTrackBtn(settings) {
  const btn = $('#trackBtn');
  const host = await currentTabHost();
  if (!host) { btn.hidden = true; return; }
  const matched = matchTracked(host, settings.trackedDomains);
  btn.hidden = false;
  btn.dataset.host = host; btn.dataset.matched = matched || '';
  btn.textContent = matched ? `Stop tracking ${matched}` : `Track ${host}`;
}
async function toggleTrackCurrent() {
  const btn = $('#trackBtn');
  const settings = await getSettings();
  if (btn.dataset.matched) {
    await saveSettings({ trackedDomains: settings.trackedDomains.filter((d) => normalizeDomain(d) !== btn.dataset.matched) });
  } else {
    const d = btn.dataset.host;
    await saveSettings({ trackedDomains: [...settings.trackedDomains, d] });
  }
  refresh();
}

function openDashboard(hash) { openPage('src/dashboard/dashboard.html' + hash); }
function openPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

async function refresh() {
  const st = await send({ type: 'get-status' });
  if (!st || st.error) { $('#statusText').textContent = 'Background not responding'; return; }
  const { settings, state, lastFrame, cameraError, modelInfo } = st;
  $('#enabled').checked = !!settings.enabled;
  await refreshTrackBtn(settings);

  const dot = $('#dot'), text = $('#statusText'), moodRow = $('#moodRow');
  const cur = state?.current;
  if (!settings.enabled) {
    dot.className = 'dot'; text.textContent = 'Paused'; moodRow.hidden = true;
  } else if (cur) {
    const elapsed = Date.now() - cur.startedAt;
    dot.className = 'dot rec';
    text.textContent = `Tracking ${cur.domain} · ${fmtDuration(elapsed)}`;
    moodRow.hidden = false;
    if (lastFrame && lastFrame.faceFound) {
      $('#emoji').textContent = moodEmoji(lastFrame.mood);
      $('#moodValue').textContent = `Mood ${fmtMood(lastFrame.mood, true)}`;
      const va = typeof lastFrame.valence === 'number' ? `valence ${fmtMood(lastFrame.valence, true)} · arousal ${fmtMood(lastFrame.arousal, true)} · ` : '';
      const br = typeof lastFrame.blinkRate === 'number' ? ` · ${lastFrame.blinkRate.toFixed(0)} blinks/min` : '';
      $('#moodSub').textContent = `${va}${lastFrame.dominant}${br} · ${Math.round((Date.now() - lastFrame.ts) / 1000)}s ago`;
    } else if (lastFrame) {
      $('#emoji').textContent = '🫥'; $('#moodValue').textContent = 'No face in frame'; $('#moodSub').textContent = 'Move into view of the webcam';
    } else {
      $('#emoji').textContent = '⏳'; $('#moodValue').textContent = 'Starting camera…'; $('#moodSub').textContent = 'Loading local model';
    }
  } else {
    dot.className = 'dot on'; text.textContent = 'Not on a tracked site'; moodRow.hidden = true;
  }

  const cam = await getCameraStatus();
  const camCard = $('#cameraCard');
  if (cam.cameraBannerDismissed) {
    camCard.hidden = true;
  } else if (cam.state === 'denied') {
    camCard.hidden = false;
    $('#cameraText').textContent = 'Camera access is blocked for this extension. Open Settings for instructions.';
  } else if (cam.refused && cur) {
    camCard.hidden = false;
    $('#cameraText').textContent = `Camera error: ${cameraError?.name}: ${cameraError?.message}. Re-grant access from Settings.`;
  } else if (!cam.granted && !cam.cameraBannerDismissed) {
    camCard.hidden = false;
    $('#cameraText').textContent = 'Camera access has not been granted yet. Without it, only time on site is tracked.';
  } else {
    camCard.hidden = true;
  }

  $('#foot').textContent = modelInfo
    ? `face-api ${modelInfo.backend}${lastFrame?.inferMs ? ` ${lastFrame.inferMs}ms` : ''}${modelInfo.hseLoadMs ? ` · HSEmotion ${modelInfo.hseThreads}thr${lastFrame?.hseMs ? ` ${lastFrame.hseMs}ms` : ''}` : ''}${modelInfo.signalsDelegate ? ` · signals ${modelInfo.signalsDelegate}` : ''}${modelInfo.hseError ? ` · HSEmotion error: ${modelInfo.hseError}` : ''}${modelInfo.signalsError ? ` · signals error: ${modelInfo.signalsError}` : ''}`
    : 'Everything runs locally. No data leaves this computer.';
}

refresh();
setInterval(refresh, 2000);
