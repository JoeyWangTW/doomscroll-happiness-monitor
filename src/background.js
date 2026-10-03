// Service worker: decides when you are "on social media", opens/closes sessions,
// and drives the offscreen page that owns the webcam + emotion model.
import { getSettings, saveSettings, hostnameFromUrl, matchTracked, normalizeDomain, DEFAULT_DOMAINS } from './shared/settings.js';
import * as db from './shared/db.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// ---------- state (survives service-worker restarts) ----------
async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { current: null, awaySince: null };
}
const setState = (state) => chrome.storage.session.set({ state });

// ---------- event wiring ----------
chrome.runtime.onInstalled.addListener(async () => {
  await closeDanglingSessions();
  await syncCustomContentScripts();
  chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  evaluate('installed');
});
chrome.runtime.onStartup.addListener(async () => {
  await closeDanglingSessions();
  chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
  evaluate('startup');
});
chrome.tabs.onActivated.addListener(() => evaluate('tab-activated'));
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') evaluate('tab-updated'); });
chrome.tabs.onRemoved.addListener(() => evaluate('tab-removed'));
chrome.windows.onFocusChanged.addListener(() => evaluate('window-focus'));
chrome.idle.onStateChanged.addListener(() => evaluate('idle'));
chrome.alarms.onAlarm.addListener((a) => evaluate('alarm:' + a.name));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    const s = changes.settings.newValue || {};
    chrome.idle.setDetectionInterval(Math.max(15, s.idleSeconds || 60));
    syncCustomContentScripts();
    evaluate('settings-changed');
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return false;
  handleMessage(msg, sender).then((r) => sendResponse(r ?? { ok: true }), (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

getSettings().then((s) => chrome.idle.setDetectionInterval(Math.max(15, s.idleSeconds || 60)));

// ---------- messages ----------
async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'frame': {
      await chrome.storage.session.set({ lastFrame: { ts: msg.ts, mood: msg.mood, dominant: msg.dominant, faceFound: msg.faceFound, inferMs: msg.inferMs, valence: msg.valence, arousal: msg.arousal, hseMs: msg.hseMs, blinkRate: msg.blinkRate } });
      const state = await getState();
      if (msg.frameId != null && state.current?.sessionId === msg.sessionId) await captureScreenFor(msg.frameId, state.current);
      evaluate('frame'); // doubles as a watchdog while the worker would otherwise sleep
      return;
    }
    case 'capture-started':
      await chrome.storage.local.remove('cameraError');
      return;
    case 'capture-error':
      await chrome.storage.local.set({ cameraError: { name: msg.name, message: msg.message, ts: Date.now() } });
      await updateBadge(await getState(), null);
      return;
    case 'models-loaded': {
      const { modelInfo } = await chrome.storage.local.get('modelInfo');
      await chrome.storage.local.set({ modelInfo: { ...(modelInfo || {}), backend: msg.backend, loadMs: msg.ms, ts: Date.now() } });
      return;
    }
    case 'hse-loaded': {
      const { modelInfo } = await chrome.storage.local.get('modelInfo');
      await chrome.storage.local.set({ modelInfo: { ...(modelInfo || {}), hseLoadMs: msg.ms, hseThreads: msg.threads, hseError: null } });
      return;
    }
    case 'signals-loaded': {
      const { modelInfo } = await chrome.storage.local.get('modelInfo');
      await chrome.storage.local.set({ modelInfo: { ...(modelInfo || {}), signalsLoadMs: msg.ms, signalsDelegate: msg.delegate, signalsError: null } });
      return;
    }
    case 'model-error': {
      const { modelInfo } = await chrome.storage.local.get('modelInfo');
      await chrome.storage.local.set({ modelInfo: { ...(modelInfo || {}), [msg.model === 'hsemotion' ? 'hseError' : 'signalsError']: msg.message } });
      return;
    }
    case 'activity': {
      const state = await getState();
      const cur = state.current;
      if (!cur || !sender.tab) return;
      const host = hostnameFromUrl(sender.tab.url);
      const settings = await getSettings();
      if (sender.tab.id !== cur.tabId && matchTracked(host, settings.trackedDomains) !== cur.domain) return;
      await db.add('activity', { sessionId: cur.sessionId, ts: msg.ts, scrollPx: msg.scrollPx | 0, clicks: msg.clicks | 0, keys: msg.keys | 0 });
      return;
    }
    case 'get-status': {
      const [settings, state, sess, local] = await Promise.all([
        getSettings(), getState(), chrome.storage.session.get('lastFrame'), chrome.storage.local.get(['cameraError', 'modelInfo']),
      ]);
      return { settings, state, lastFrame: sess.lastFrame || null, cameraError: local.cameraError || null, modelInfo: local.modelInfo || null };
    }
    case 'set-enabled':
      await saveSettings({ enabled: !!msg.enabled });
      return;
    case 'camera-granted':
      await chrome.storage.local.remove('cameraError');
      await evaluate('camera-granted');
      return;
    case 'evaluate':
      await evaluate('manual');
      return;
    default:
      throw new Error('unknown message ' + msg.type);
  }
}

// ---------- core loop ----------
let chain = Promise.resolve();
function evaluate(reason) {
  chain = chain.then(() => _evaluate(reason)).catch((e) => console.error('[dhm] evaluate failed', reason, e));
  return chain;
}

async function _evaluate(reason) {
  const settings = await getSettings();
  const state = await getState();
  const now = Date.now();
  if (reason === 'alarm:close-offscreen' && !state.current) { await closeOffscreen(); return; }

  let tracked = null, tab = null;
  if (settings.enabled) {
    const idle = await chrome.idle.queryState(Math.max(15, settings.idleSeconds || 60));
    let present = idle === 'active';
    if (!present && state.current) {
      // chrome.idle only sees keyboard/mouse input. Someone watching a video is idle to it,
      // so a recently detected face keeps a running session alive.
      const { lastFrame } = await chrome.storage.session.get('lastFrame');
      if (lastFrame?.faceFound && now - lastFrame.ts < 45000) present = true;
    }
    if (present) {
      tab = await getFocusedActiveTab();
      if (tab?.url) tracked = matchTracked(hostnameFromUrl(tab.url), settings.trackedDomains);
    }
  }

  if (tracked) {
    if (state.current && state.current.domain === tracked) {
      state.current.lastSeenAt = now;
      state.current.tabId = tab.id;
      state.current.title = tab.title || state.current.title;
      state.awaySince = null;
      await setState(state);
      await ensureCapturing(state.current, settings, true);
    } else {
      if (state.current) await endSession(state, now);
      await startSession(state, tracked, tab, settings, now);
    }
  } else if (state.current) {
    if (!state.awaySince) {
      state.awaySince = now;
      await setState(state);
      chrome.alarms.create('grace', { when: now + settings.graceMs + 1000 });
      await ensureCapturing(state.current, settings, false); // pause inference while away
    } else if (now - state.awaySince >= settings.graceMs) {
      await endSession(state, state.awaySince);
    }
  }
  await updateBadge(state, tracked);
}

async function getFocusedActiveTab() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!win || !win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab || null;
  } catch {
    return null;
  }
}

async function startSession(state, domain, tab, settings, now) {
  const session = { id: crypto.randomUUID(), domain, url: tab.url, title: tab.title || '', startedAt: now, endedAt: null, open: 1 };
  await db.put('sessions', session);
  state.current = { sessionId: session.id, domain, startedAt: now, lastSeenAt: now, tabId: tab.id, title: tab.title || '' };
  state.awaySince = null;
  await setState(state);
  await chrome.storage.session.remove('lastFrame');
  chrome.alarms.clear('close-offscreen');
  await ensureCapturing(state.current, settings, true);
}

async function endSession(state, endAt) {
  const cur = state.current;
  state.current = null;
  state.awaySince = null;
  await setState(state);
  await chrome.storage.session.remove('lastFrame');
  try { await sendToOffscreen({ type: 'stop-capture' }); } catch {}
  // Camera is released immediately; the page (and loaded model) is kept for a while so the
  // next session does not pay the model load again.
  chrome.alarms.create('close-offscreen', { delayInMinutes: 10 });
  const s = await db.get('sessions', cur.sessionId);
  if (!s) return;
  const endedAt = Math.max(endAt, s.startedAt);
  const { minSessionMs } = await getSettings();
  if (endedAt - s.startedAt < Math.max(5000, minSessionMs || 0)) {
    await db.deleteSession(s.id); // a quick visit, not a session
    return;
  }
  s.endedAt = endedAt;
  delete s.open;
  await db.put('sessions', s);
}

async function closeDanglingSessions() {
  const open = await db.openSessions().catch(() => []);
  const { minSessionMs } = await getSettings();
  for (const s of open) {
    const frames = await db.framesForSession(s.id);
    const last = frames.reduce((m, f) => Math.max(m, f.ts), s.startedAt);
    if (last - s.startedAt < Math.max(5000, minSessionMs || 0)) { await db.deleteSession(s.id); continue; }
    s.endedAt = last;
    delete s.open;
    await db.put('sessions', s);
  }
  await chrome.storage.session.remove(['state', 'lastFrame']);
  await closeOffscreen();
}

// ---------- offscreen document (camera + model) ----------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}
let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture webcam frames while on social media and run a local emotion model on them.',
    }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; }).finally(() => { creating = null; });
  }
  await creating;
}
async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}
function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}
async function ensureCapturing(cur, settings, active) {
  await ensureOffscreen();
  await sendToOffscreen({
    type: 'ensure-capture',
    sessionId: cur.sessionId,
    intervalMs: settings.captureIntervalMs,
    storeThumbnails: settings.storeThumbnails,
    thumbSize: settings.thumbSize,
    useHsemotion: settings.useHsemotion,
    moodSource: settings.moodSource,
    signals: settings.signals,
    active,
  }).catch((e) => console.warn('[dhm] offscreen unreachable', e));
}

// ---------- screenshot of the page at the moment of a webcam frame ----------
async function captureScreenFor(frameId, cur) {
  const settings = await getSettings();
  if (!settings.captureScreen) return;
  try {
    const tab = await getFocusedActiveTab();
    if (!tab || tab.id !== cur.tabId) return; // user moved on between the frame and now
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    const full = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(full);
    const w = Math.min(Math.max(160, settings.screenWidth || 480), bmp.width);
    const h = Math.round(bmp.height * w / bmp.width);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const screen = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    await db.update('frames', frameId, { screen, pageUrl: tab.url, pageTitle: tab.title || '' });
    const { screenError } = await chrome.storage.local.get('screenError');
    if (screenError) await chrome.storage.local.remove('screenError');
  } catch (e) {
    // Typical causes: no host permission for this site, window minimized, rate limit.
    await chrome.storage.local.set({ screenError: { message: String(e?.message || e), ts: Date.now() } });
  }
}

// ---------- badge ----------
async function updateBadge(state, tracked) {
  const { cameraError } = await chrome.storage.local.get('cameraError');
  const settings = await getSettings();
  let text = '', color = '#2a78d6';
  if (!settings.enabled) { text = 'off'; color = '#898781'; }
  else if (cameraError && state.current) { text = '!'; color = '#d03b3b'; }
  else if (state.current && tracked) { text = 'REC'; color = '#e34948'; }
  else if (state.current) { text = '…'; color = '#898781'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---------- content scripts for user-added domains ----------
async function syncCustomContentScripts() {
  try {
    const settings = await getSettings();
    const custom = settings.trackedDomains.map(normalizeDomain).filter((d) => d && !DEFAULT_DOMAINS.includes(d));
    const matches = custom.map((d) => `*://*.${d}/*`);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['activity-custom'] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['activity-custom'] });
    if (matches.length) {
      await chrome.scripting.registerContentScripts([{ id: 'activity-custom', matches, js: ['src/content/activity.js'], runAt: 'document_idle' }]);
    }
  } catch (e) {
    console.warn('[dhm] content script sync failed', e);
  }
}
