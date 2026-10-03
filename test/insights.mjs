// Insights page with 30 days of synthetic sessions and frames: renders, filters, deep links. Screenshots to test/out/.
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--window-size=1200,900'] });
let failures = 0;
const check = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) failures++; };
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') { console.log('[console.error]', m.text()); failures++; } });
  const url = `chrome-extension://${extId}/src/insights/insights.html`;
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());

  // ---- seed: evenings heavy, mood sinks within long sittings ----
  const seeded = await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sites = ['youtube.com', 'reddit.com', 'x.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'bsky.app', 'threads.net', 'facebook.com'];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let n = 0, frames = 0;
    for (let d = 29; d >= 0; d--) {
      const day = new Date(today); day.setDate(day.getDate() - d);
      const count = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < count; k++) {
        const hour = rnd() < 0.6 ? 19 + Math.floor(rnd() * 4) : 8 + Math.floor(rnd() * 9);
        const start = day.getTime() + hour * 3600e3 + Math.floor(rnd() * 50) * 60e3;
        if (start > Date.now() - 60 * 60e3) continue;
        const len = (3 + Math.floor(rnd() ** 2 * 70)) * 60e3;
        const domain = sites[Math.min(sites.length - 1, Math.floor(rnd() ** 1.6 * sites.length))];
        const id = `syn-${d}-${k}`;
        await m.put('sessions', { id, domain, url: '', title: 'synthetic', startedAt: start, endedAt: start + len });
        const base = 0.25 - rnd() * 0.3;
        for (let t = start; t < start + len; t += 15000) {
          const face = rnd() > 0.1;
          const minutes = (t - start) / 60e3;
          const valence = Math.max(-1, Math.min(1, base - minutes * 0.006 + (rnd() - 0.5) * 0.3));
          await m.add('frames', { sessionId: id, ts: t, faceFound: face, expressions: face ? { neutral: 0.6, happy: Math.max(0, valence), sad: Math.max(0, -valence), angry: 0, fearful: 0, disgusted: 0, surprised: 0 } : null, hse: face ? { valence, arousal: 0 } : null });
          frames++;
        }
        n++;
      }
    }
    return { n, frames };
  });
  console.log('    seeded', seeded);

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tiles .tile').length === 6, { timeout: 15000 });
  await sleep(300);
  const tileText = () => page.$eval('#tiles', (e) => e.innerText);
  check(!(await tileText()).includes('0s\n'), 'tiles show time: ' + (await tileText()).split('\n').slice(0, 2).join(' '));
  check(await page.$$eval('#timeChart .seg', (s) => s.length) > 7, '7-day stacked bars render');
  check(await page.$$eval('#heatmap rect.cell', (s) => s.length) === 168, 'heatmap has 7×24 cells');
  check(await page.$$eval('#moodChart circle.dot', (s) => s.length) >= 5, 'mood trend dots');
  check(await page.$$eval('#minuteChart path.bar', (s) => s.length) >= 5, 'mood-by-minute bars');
  check(await page.$$eval('#scatter circle.dot', (s) => s.length) >= 5, 'sittings scatter');
  check(await page.$$eval('#siteTable tbody tr', (s) => s.length) >= 5, 'site table rows');

  // ---- range: 30 days ----
  await page.click('#rangeTabs [data-range="30d"]'); await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'insights-30d.png'), fullPage: true });
  check((await page.$eval('#rangeLabel', (e) => e.textContent)).includes('30 days'), 'range label 30 days');
  const legend30 = await page.$$eval('#timeLegend span > span.key', (s) => s.length);
  check(legend30 === 8, `legend folds 9 sites into 7 + Other (got ${legend30})`);
  const ytColor = () => page.$$eval('#siteTable tbody tr', (rows) => rows.find((r) => r.innerText.includes('youtube.com'))?.querySelector('.key').style.background);
  const ytBefore = await ytColor();

  // ---- site filter keeps colors ----
  await page.click('#siteSummary'); await sleep(100);
  await page.evaluate(() => { const cb = [...document.querySelectorAll('#siteList input')].find((c) => c.value === 'reddit.com'); cb.click(); });
  await sleep(600);
  check((await page.$eval('#siteSummary', (e) => e.textContent)).includes('8 of 9'), 'site filter summary');
  check(!(await page.$eval('#siteTable', (e) => e.innerText)).includes('reddit.com'), 'reddit filtered out of the table');
  check((await ytColor()) === ytBefore, 'youtube keeps its color after filtering');
  await page.click('#sitesAll'); await sleep(500);

  // ---- weekday / time of day / mood source / heatmap metric / minute mode ----
  await page.select('#daysSel', 'weekends'); await sleep(500);
  const weekdayRows = await page.$$eval('#heatmap .rowTotal', (t) => t.slice(0, 5).map((x) => x.textContent).join(''));
  check(weekdayRows === '', 'weekends filter empties Mon–Fri rows');
  await page.select('#daysSel', 'all'); await page.select('#todSel', 'evening'); await sleep(500);
  check(await page.$$eval('#heatmap rect.cell', (cells) => cells.filter((c, i) => i % 24 < 12 && !c.style.fill.includes('--empty')).length) === 0, 'evening filter leaves morning cells empty');
  await page.select('#todSel', 'all');
  await page.click('#heatTabs [data-metric="mood"]'); await sleep(300);
  check((await page.$eval('#heatLegend', (e) => e.textContent)).includes('fewer than 5'), 'heatmap mood legend');
  await page.click('#sourceTabs [data-source="faceapi"]'); await sleep(600);
  check(await page.$$eval('#moodChart circle.dot', (s) => s.length) >= 5, 'face-api mood source renders');
  await page.click('#sourceTabs [data-source="valence"]'); await sleep(500);
  const minuteNote = await page.$eval('#minuteNote', (e) => e.textContent);
  check(/After 30 min: −?-?0\.\d\d/.test(minuteNote) && minuteNote.includes('-'), 'synthetic decline shows up after 30 min: ' + minuteNote.match(/After 30 min: [^ ]+/)?.[0]);
  await page.click('#minuteTabs [data-mode="abs"]'); await sleep(200);
  check((await page.$eval('#minuteNote', (e) => e.textContent)).startsWith('Average mood'), 'absolute mode');

  // ---- custom range ----
  await page.click('#rangeTabs [data-range="custom"]'); await sleep(500);
  check(!(await page.$eval('#customRange', (e) => e.hidden)), 'custom date inputs shown');
  await page.click('#rangeTabs [data-range="today"]'); await sleep(500);
  check((await page.$eval('#timeTitle', (e) => e.textContent)).includes('by hour'), 'today switches to hourly buckets');

  // ---- hover tooltip ----
  await page.click('#rangeTabs [data-range="30d"]'); await sleep(600);
  await page.$eval('#heatmap', (e) => e.scrollIntoView({ block: 'center' })); await sleep(200);
  const box = await page.$$eval('#heatmap rect.cell', (cells) => { const r = cells[2 * 24 + 20].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await sleep(100);
  check(!(await page.$eval('#tooltip', (e) => e.hidden)) && (await page.$eval('#tooltip', (e) => e.textContent)).includes('Wednesday'), 'heatmap tooltip on hover');

  // ---- dark mode screenshot ----
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.mouse.move(0, 0); await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'insights-30d-dark.png'), fullPage: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // ---- narrow viewport: no horizontal scroll ----
  await page.setViewport({ width: 420, height: 900 }); await sleep(500);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 420px');
  await page.screenshot({ path: path.join(OUT, 'insights-mobile.png'), fullPage: true });
  await page.setViewport({ width: 1200, height: 900 }); await sleep(300);

  // ---- deep link into the day dashboard ----
  await page.click('#longest tbody tr');
  await page.waitForFunction(() => location.pathname.endsWith('dashboard.html'), { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('#detail').hidden, { timeout: 10000 });
  const q = await page.evaluate(() => location.search);
  const selId = new URLSearchParams(q).get('session');
  check(await page.evaluate(() => document.querySelector('#dTitle').textContent.length > 0), 'dashboard opens the sitting: ' + q);
  check(await page.evaluate(() => !!document.querySelector('#sessions tr.sel')), `dashboard highlights session ${selId}`);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'insights page passed');
process.exit(failures ? 1 : 0);
