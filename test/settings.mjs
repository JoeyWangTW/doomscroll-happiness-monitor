// Settings page + camera banner flows in headless Chrome.
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox', '--window-size=1100,900'] });
let failures = 0;
const check = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) failures++; };
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  // Pretend Chrome's permission query never says "granted" (what a real extension origin can do).
  await page.evaluateOnNewDocument(() => { navigator.permissions.query = async () => ({ state: 'prompt' }); });

  // ---- settings page: domains ----
  await page.goto(`chrome-extension://${extId}/src/settings/settings.html`, { waitUntil: 'load' });
  await sleep(500);
  const chips = () => page.evaluate(() => [...document.querySelectorAll('#domainChips .chip')].map((c) => c.firstChild.textContent));
  check((await chips()).length === 10, 'settings shows 10 default chips');
  await page.type('#addDomainInput', 'news.ycombinator.com');
  await page.click('#addDomainForm button[type=submit]');
  await sleep(500);
  check((await chips()).includes('news.ycombinator.com'), 'add domain');
  await page.click('#domainChips .chip:first-child .x'); await sleep(300);
  check((await chips()).length === 10 && !(await chips()).includes('youtube.com'), 'remove domain');
  await page.click('#resetDomains'); await sleep(300);
  check((await chips()).length === 10 && (await chips()).includes('youtube.com'), 'reset domains');

  // ---- settings page: camera ----
  const camStatus = () => page.$eval('#camStatus', (e) => e.textContent);
  check((await camStatus()).includes('not granted'), 'camera initially not granted: ' + await camStatus());
  await page.click('#camGrant'); await sleep(1200);
  check((await camStatus()).includes('granted ✓'), 'camera granted after click: ' + await camStatus());
  check(await page.$eval('#camGrant', (b) => b.hidden), 'grant button hidden');
  console.log('   ', await page.$eval('#camDiag', (e) => e.textContent));
  await page.select('#sMoodSource', 'faceapi');
  await page.click('#sSave'); await sleep(300);
  check((await page.$eval('#sSaved', (e) => e.textContent)) === 'Saved.', 'save settings');
  check((await page.evaluate(() => chrome.storage.local.get('settings'))).settings.moodSource === 'faceapi', 'mood source persisted');
  await page.select('#sMoodSource', 'valence'); await page.click('#sSave'); await sleep(200);
  check((await page.$eval('#footer', (e) => e.textContent)).includes('v0.5.0'), 'settings footer version');

  // ---- min session setting persists ----
  await page.evaluate(() => { document.querySelector('#sMinSession').value = '90'; });
  await page.click('#sSave'); await sleep(300);
  check((await page.evaluate(() => chrome.storage.local.get('settings'))).settings.minSessionMs === 90000, 'min session length persisted');

  // ---- dashboard pagination with 23 synthetic sessions (and 2 short ones that must be hidden) ----
  await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    // Anchor inside today (01:00 onwards) so the day filter keeps every synthetic session whatever the clock says.
    const d = new Date(); d.setHours(1, 0, 0, 0); const base = d.getTime();
    for (let i = 0; i < 23; i++) { const st = base + i * 600000; await m.put('sessions', { id: 'syn-' + i, domain: i % 2 ? 'reddit.com' : 'youtube.com', url: '', title: 'synthetic', startedAt: st, endedAt: st + 120000 + i * 1000 }); }
    await m.put('sessions', { id: 'short-1', domain: 'x.com', url: '', title: 'short', startedAt: base + 23 * 600000, endedAt: base + 23 * 600000 + 20000 });
    await m.put('sessions', { id: 'short-2', domain: 'x.com', url: '', title: 'short', startedAt: base + 24 * 600000, endedAt: base + 24 * 600000 + 80000 });
  });
  await page.goto(`chrome-extension://${extId}/src/dashboard/dashboard.html`, { waitUntil: 'load' }); await sleep(800);
  const rowsOnPage = () => page.evaluate(() => document.querySelectorAll('#sessions tbody tr').length);
  const pagerText = () => page.evaluate(() => document.querySelector('#sessions .pager span')?.textContent);
  check((await rowsOnPage()) === 10, 'first page shows 10 rows');
  check((await pagerText()) === '1–10 of 23 sessions', 'pager text: ' + await pagerText());
  check(!(await page.evaluate(() => [...document.querySelectorAll('#sessions td')].some((td) => td.textContent.includes('x.com')))), 'short sessions hidden (90 s minimum)');
  await page.click('#pgNext'); await sleep(200);
  check((await pagerText()) === '11–20 of 23 sessions', 'second page');
  await page.click('#pgNext'); await sleep(200);
  check((await rowsOnPage()) === 3 && (await pagerText()) === '21–23 of 23 sessions', 'last page has 3 rows');
  check(await page.$eval('#pgNext', (b) => b.disabled), 'older disabled on last page');
  await page.click('#pgPrev'); await sleep(200);
  check((await pagerText()) === '11–20 of 23 sessions', 'back to second page');
  // ---- grouped view: 23 sessions spaced 10 min apart (2 min long => 8 min gaps) ----
  await page.click('#listModeTabs .tab[data-mode=groups]'); await sleep(300);
  const title = () => page.$eval('#sessionsTitle', (e) => e.textContent);
  check((await title()) === 'Blocks', 'grouped mode title');
  // gap 15 min: all 23 chain into one block
  check((await rowsOnPage()) === 1, 'gap 15 min -> 1 block, rows=' + await rowsOnPage());
  console.log('   ', await page.evaluate(() => document.querySelector('#sessions tbody tr').innerText.replace(/\s+/g, ' ').slice(0, 120)));
  check((await page.evaluate(() => document.querySelector('#dSub').textContent)).startsWith('23 sessions'), 'detail shows 23 sessions: ' + await page.evaluate(() => document.querySelector('#dSub').textContent.slice(0, 60)));
  check((await page.evaluate(() => document.querySelectorAll('#moodChart .band').length)) === 23, 'chart has 23 site bands');
  check(await page.$eval('#dDelete', (b) => b.hidden), 'delete hidden for blocks');
  await page.select('#gapSelect', '5'); await sleep(300);
  check((await pagerText()) === '1–10 of 23 sessions', 'gap 5 min -> 23 separate blocks');
  await page.click('#listModeTabs .tab[data-mode=sessions]'); await sleep(200);
  check((await title()) === 'Sessions' && (await rowsOnPage()) === 10, 'back to sessions mode');
  await page.evaluate(async () => { const m = await import(chrome.runtime.getURL('src/shared/db.js')); for (const s of await m.getAll('sessions')) await m.deleteSession(s.id); });
  await page.goto(`chrome-extension://${extId}/src/settings/settings.html`, { waitUntil: 'load' }); await sleep(300);
  await page.evaluate(() => { document.querySelector('#sMinSession').value = '60'; }); await page.click('#sSave'); await sleep(200);

  // ---- dashboard banner: hidden because granted flag ----
  await page.goto(`chrome-extension://${extId}/src/dashboard/dashboard.html`, { waitUntil: 'load' }); await sleep(500);
  check(await page.$eval('#cameraBanner', (e) => e.hidden), 'dashboard banner hidden after grant');
  check((await page.$eval('#footer', (e) => e.textContent)).includes('v0.5.0'), 'dashboard footer version');
  check(!!(await page.$('#settingsLink')), 'dashboard links to settings');
  check(!(await page.$('#settings')), 'no inline settings section');

  // ---- dashboard banner: dismiss path with no grant flag ----
  await page.evaluate(() => chrome.storage.local.remove(['cameraGranted', 'cameraBannerDismissed']));
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  check(!(await page.$eval('#cameraBanner', (e) => e.hidden)), 'banner shows without grant flag');
  await page.click('#cameraBannerDismiss'); await sleep(300);
  check(await page.$eval('#cameraBanner', (e) => e.hidden), 'dismiss hides banner');
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  check(await page.$eval('#cameraBanner', (e) => e.hidden), 'dismiss persists across reload');

  // ---- dismiss must also win over a "refused" capture error and a denied query ----
  await page.evaluate(() => chrome.storage.local.set({ cameraError: { name: 'NotAllowedError', message: 'Permission denied', ts: Date.now() } }));
  await page.evaluate(() => chrome.storage.local.remove(['cameraBannerDismissed']));
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  check(!(await page.$eval('#cameraBanner', (e) => e.hidden)), 'banner shows on refused error');
  console.log('    cause:', await page.$eval('#cameraBannerCause', (e) => e.textContent));
  await page.click('#cameraBannerDismiss'); await sleep(300);
  check(await page.$eval('#cameraBanner', (e) => e.hidden), 'dismiss wins over refused error');
  await page.evaluate(() => chrome.storage.local.remove(['cameraError']));

  // ---- banner Allow button path ----
  await page.evaluate(() => chrome.storage.local.remove(['cameraBannerDismissed']));
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  check(!(await page.$eval('#cameraBanner', (e) => e.hidden)), 'banner back after undismiss');
  await page.click('#cameraBannerBtn'); await sleep(1200);
  check(await page.$eval('#cameraBanner', (e) => e.hidden), 'banner Allow hides banner');

  // ---- popup ----
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => { console.log('[popup pageerror]', e.message); failures++; });
  await popup.evaluateOnNewDocument(() => { navigator.permissions.query = async () => ({ state: 'prompt' }); });
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: 'load' }); await sleep(600);
  check(await popup.$eval('#cameraCard', (e) => e.hidden), 'popup camera card hidden when granted');
} finally { await browser.close(); }
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exitCode = failures ? 1 : 0;
