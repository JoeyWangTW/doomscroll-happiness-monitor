// Loads the extension in headless Chrome with a fake webcam, visits a tracked site,
// and checks that a session + frames land in IndexedDB and the dashboard renders.
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(EXT, 'test', 'out');
import fs from 'node:fs'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    ...(process.env.FACE_Y4M ? [`--use-file-for-fake-video-capture=${process.env.FACE_Y4M}`] : []),
    '--no-sandbox', '--window-size=1200,900',
  ],
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;
  console.log('extension id', extId);
  worker.on('console', (m) => console.log('[sw]', m.text()));

  // chrome.idle reflects real OS input, which a headless test cannot produce: raise the threshold.
  await worker.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...(settings || {}), idleSeconds: 86400, minSessionMs: 5000 } }); });

  // Grant camera by touching getUserMedia from an extension page (fake UI auto-accepts).
  const dash = await browser.newPage();
  dash.on('console', (m) => console.log('[dash]', m.text()));
  dash.on('pageerror', (e) => console.log('[dash ERROR]', e.message));
  await dash.goto(`chrome-extension://${extId}/src/dashboard/dashboard.html`, { waitUntil: 'load' });
  await dash.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); });
  console.log('camera permission', await dash.evaluate(async () => (await navigator.permissions.query({ name: 'camera' })).state));

  // Visit a tracked site in a new active tab.
  const yt = await browser.newPage();
  await yt.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('yt nav', e.message));
  await yt.bringToFront();
  await sleep(1500);
  const ytTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  console.log('cs injected (isolated world)', JSON.stringify(await worker.evaluate(async (tabId) => { try { const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => !!window.__dhmActivity }); return r.map((x) => x.result); } catch (e) { return 'ERR ' + e.message; } }, ytTab)));
  await yt.evaluate(() => { document.body.click(); document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); });
  await sleep(18000);

  console.log('worker view', JSON.stringify(await worker.evaluate(async () => {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch((e) => ({ err: String(e) }));
    const tabs = await chrome.tabs.query({ active: true });
    const idle = await chrome.idle.queryState(60);
    return { winFocused: win?.focused, winId: win?.id, idle, active: tabs.map((t) => ({ w: t.windowId, url: (t.url || '').slice(0, 40) })) };
  })));
  await worker.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'evaluate' }).catch(() => {}));
  await sleep(3000);
  const status = await worker.evaluate(async () => {
    const st = await chrome.storage.session.get(['state', 'lastFrame']);
    const local = await chrome.storage.local.get(['cameraError', 'modelInfo']);
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return { ...st, ...local, offscreen: ctx.length };
  });
  console.log('status', JSON.stringify(status, null, 1));

  // Attach to the offscreen document to read its console.
  const offTarget = browser.targets().find((t) => t.url().includes('offscreen.html'));
  console.log('offscreen target', !!offTarget);

  // Leave the site so the session closes, then inspect the DB from the dashboard.
  await dash.bringToFront();
  await sleep(1500);
  const db = await dash.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    const sessions = await m.getAll('sessions');
    const frames = await m.getAll('frames');
    const activity = await m.getAll('activity');
    const last = frames[frames.length - 1];
    const withHse = frames.find((f) => f.hse);
    return { sessions: sessions.map(({ id, domain, startedAt, endedAt, open }) => ({ domain, dur: (endedAt || Date.now()) - startedAt, open: !!open })), frames: frames.length, hse: frames.map((f) => f.hse ? 'y' : (f.hse === null ? 'null' : 'undef')).join(''), hseSample: withHse ? { valence: +withHse.hse.valence.toFixed(2), arousal: +withHse.hse.arousal.toFixed(2), dominant: withHse.hse.dominant, ms: withHse.hse.ms, mood: +withHse.mood.toFixed(2) } : null, signalsFull: last?.signals ? Object.fromEntries(Object.entries(last.signals).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])) : null, signals: last?.signals ? { samples: last.signals.samples, faceSamples: last.signals.faceSamples, windowMs: last.signals.windowMs, blinkRate: last.signals.blinkRate } : last?.signals, faceFrames: frames.filter((f) => f.faceFound).length, thumbs: frames.filter((f) => f.thumb).length, screens: frames.filter((f) => f.screen).length, screenKB: frames.filter((f) => f.screen).map((f) => Math.round(f.screen.size / 1024)), pageTitle: frames.find((f) => f.pageTitle)?.pageTitle, inferMs: frames.map((f) => f.inferMs), backend: frames[0]?.backend, activity: activity.length, scroll: activity.reduce((a, x) => a + x.scrollPx, 0) };
  });
  console.log('db', JSON.stringify(db));
  console.log('screenError', JSON.stringify(await worker.evaluate(() => chrome.storage.local.get('screenError'))));
  console.log('modelInfo', JSON.stringify(await worker.evaluate(() => chrome.storage.local.get('modelInfo'))));
  console.log('offscreen isolated', JSON.stringify(await worker.evaluate(async () => { try { return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' }); } catch (e) { return String(e); } })));

  // Timelapse export in all three modes (rendered in-page with MediaRecorder).
  for (const mode of ['both', 'screen', 'face']) {
    const tl = await dash.evaluate(async (mode) => {
      const m = await import(chrome.runtime.getURL('src/shared/db.js'));
      const { renderTimelapse, pickMime } = await import(chrome.runtime.getURL('src/dashboard/timelapse.js'));
      const [session] = await m.getAll('sessions');
      const frames = await m.framesForSession(session.id);
      const t0 = performance.now();
      try {
        const out = await renderTimelapse({ frames, session, mode, fps: 15 });
        const b64 = btoa(String.fromCharCode(...new Uint8Array(await out.blob.arrayBuffer())));
        return { mode, mime: out.mime, size: out.blob.size, frames: out.frames, w: out.width, h: out.height, ms: Math.round(performance.now() - t0), supported: pickMime(), b64 };
      } catch (e) { return { mode, error: e.message }; }
    }, mode);
    if (tl.b64) { fs.writeFileSync(path.join(OUT, `timelapse-${mode}.${tl.mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`), Buffer.from(tl.b64, 'base64')); delete tl.b64; }
    console.log('timelapse', JSON.stringify(tl));
  }

  await dash.reload({ waitUntil: 'load' });
  await sleep(1500);
  const ui = await dash.evaluate(() => ({ tiles: document.querySelector('#tiles').innerText.replace(/\n+/g, ' | '), sessions: document.querySelector('#sessions').innerText.replace(/\n+/g, ' | ').slice(0, 300), detailHidden: document.querySelector('#detail').hidden, chartPaths: document.querySelectorAll('#moodChart svg *').length, banner: document.querySelector('#cameraBanner').hidden }));
  console.log('ui', JSON.stringify(ui));
  // player: viewer, scrub, hover tooltip without images, play
  const pl = async () => dash.evaluate(() => ({ pos: document.querySelector('#pPos').textContent, imgs: document.querySelectorAll('#viewerImgs img').length, cap: document.querySelector('#viewerCap').textContent.slice(0, 60), playhead: document.querySelector('#moodChart .playhead')?.getAttribute('visibility'), playBtn: document.querySelector('#pPlay').textContent }));
  console.log('player initial', JSON.stringify(await pl()));
  await dash.click('#pNext'); await sleep(100);
  console.log('player next', JSON.stringify(await pl()));
  const ov = await dash.$('#moodChart rect[fill=transparent]');
  await ov.scrollIntoView(); await sleep(100);
  const bb = await ov.boundingBox();
  await dash.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5); await sleep(150);
  console.log('hover tooltip', JSON.stringify(await dash.evaluate(() => ({ hidden: document.querySelector('#tooltip').hidden, hasImg: !!document.querySelector('#tooltip img'), text: document.querySelector('#tooltip').textContent.slice(0, 60) }))));
  await dash.mouse.down(); await dash.mouse.up(); await sleep(100);
  console.log('after scrub click (expect ~middle)', JSON.stringify(await pl()));
  await dash.mouse.down(); await dash.mouse.move(bb.x + bb.width * 0.95, bb.y + bb.height * 0.5, { steps: 5 }); await dash.mouse.up(); await sleep(100);
  console.log('after drag to end', (await pl()).pos);
  await dash.mouse.move(0, 0);
  await dash.select('#pFps', '24');
  await dash.click('#pPlay'); await sleep(80);
  console.log('playing', JSON.stringify(await pl()));
  await sleep(700);
  console.log('after play', JSON.stringify(await pl()));
  await dash.keyboard.press('ArrowLeft'); await sleep(50);
  console.log('key left', (await pl()).pos);

  // signals + mood source toggle
  console.log('signals cards', JSON.stringify(await dash.evaluate(() => [...document.querySelectorAll('#signals .signal')].map((c) => ({ label: c.querySelector('b').textContent, hasSvg: !!c.querySelector('svg'), empty: !!c.querySelector('.empty') })))));
  await dash.click('#moodSourceTabs .tab[data-source=faceapi]'); await sleep(300);
  console.log('mood source faceapi', JSON.stringify(await dash.evaluate(() => ({ active: document.querySelector('#moodSourceTabs .tab.active')?.dataset.source, legend: document.querySelector('#dLegend').textContent }))));
  await dash.click('#moodSourceTabs .tab[data-source=valence]'); await sleep(300);

  // gallery tabs + lightbox + export panel
  const gal = async () => dash.evaluate(() => ({ active: document.querySelector('#galleryTabs .tab.active')?.dataset.view, figs: document.querySelectorAll('#thumbs figure').length, imgsPerFig: document.querySelector('#thumbs figure .pic')?.querySelectorAll('img').length, note: document.querySelector('#thumbsNote').textContent }));
  console.log('gallery both', JSON.stringify(await gal()));
  await dash.click('#galleryTabs .tab[data-view=screen]'); await sleep(200);
  console.log('gallery screen', JSON.stringify(await gal()));
  await dash.click('#galleryTabs .tab[data-view=face]'); await sleep(200);
  console.log('gallery face', JSON.stringify(await gal()));
  await dash.click('#galleryTabs .tab[data-view=both]'); await sleep(200);
  await dash.click('#thumbs figure .pic'); await sleep(200);
  console.log('gallery click -> player', (await pl()).pos);
  await dash.click('#pEnlarge'); await sleep(200);
  console.log('lightbox', JSON.stringify(await dash.evaluate(() => ({ open: !document.querySelector('#lightbox').hidden, cap: document.querySelector('#lbCap').textContent, screenShown: !document.querySelector('#lbScreen').hidden, faceShown: !document.querySelector('#lbFace').hidden }))));
  await dash.keyboard.press('ArrowRight'); await sleep(100);
  console.log('lightbox next', await dash.$eval('#lbCap', (e) => e.textContent.slice(-4)));
  await dash.keyboard.press('Escape'); await sleep(100);
  console.log('lightbox closed', await dash.$eval('#lightbox', (e) => e.hidden));
  await dash.click('#tlToggle'); await sleep(100);
  console.log('export panel', JSON.stringify(await dash.evaluate(() => ({ visible: !document.querySelector('#tlPanel').hidden, mode: document.querySelector('input[name=tlMode]:checked').value, inGallery: !!document.querySelector('.galleryHead + .tlPanel') }))));
  await dash.click('#sessions .rowbtn'); await sleep(300);
  console.log('row timelapse button opens panel', await dash.$eval('#tlPanel', (e) => !e.hidden));
  await dash.screenshot({ path: path.join(OUT, 'dashboard.png'), fullPage: true });
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => console.log('[popup ERROR]', e.message));
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'load' });
  await sleep(800);
  console.log('popup', await popup.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ')));
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });
} finally {
  await browser.close();
}
