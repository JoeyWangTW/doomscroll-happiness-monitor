import * as db from '../shared/db.js';
import { EXPRESSIONS, sessionStats, smooth, moodEmoji, withMoodSource, HSE_CLASSES } from '../shared/mood.js';
import { getSettings } from '../shared/settings.js';
import { fmtDuration, fmtTime, fmtTimeSec, fmtMood, dayKey, dayBounds, fmtDay } from '../shared/format.js';
import { renderTimelapse, pickMime } from './timelapse.js';
import { getCameraStatus, requestCamera, dismissCameraBanner } from '../shared/camera.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'background' });
const SVG_NS = 'http://www.w3.org/2000/svg';
const view = { day: dayKey(), selected: null, rows: [], gallery: 'both', showAll: false, moodSource: 'valence', page: 0, minSessionMs: 60000 };
const PAGE_SIZE = 10;
try { view.listMode = localStorage.getItem('listMode') || 'sessions'; view.gapMin = Number(localStorage.getItem('gapMin')) || 15; } catch { view.listMode = 'sessions'; view.gapMin = 15; }
try { view.gallery = localStorage.getItem('galleryView') || 'both'; } catch {}
// Deep link from the Insights page: ?day=YYYY-MM-DD&session=<id>
{
  const q = new URLSearchParams(location.search);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('day') || '')) view.day = q.get('day');
  if (q.get('session')) { view.selected = { session: { id: q.get('session') } }; view.listMode = 'sessions'; }
}
let objectUrls = [];

// ---------------- boot ----------------
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); else console.error('[dhm] missing element', sel); };

async function init() {
  on('#prevDay', 'click', () => shiftDay(-1));
  on('#nextDay', 'click', () => shiftDay(1));
  on('#todayBtn', 'click', () => { view.day = dayKey(); loadDay(); });
  on('#deleteDayBtn', 'click', deleteDay);
  on('#cameraBannerBtn', 'click', grantCamera);
  on('#cameraBannerDismiss', 'click', async () => { $('#cameraBanner').hidden = true; await dismissCameraBanner(); });
  on('#dDelete', 'click', deleteSelected);
  on('#tlToggle', 'click', () => { const p = $('#tlPanel'); p.hidden = !p.hidden; if (!p.hidden) { const r = document.querySelector(`input[name=tlMode][value=${view.gallery}]`); if (r) r.checked = true; } });
  on('#galleryTabs', 'click', (e) => { const b = e.target.closest('.tab'); if (!b) return; setGalleryMode(b.dataset.view); });
  on('#thumbsAll', 'click', () => { view.showAll = !view.showAll; if (view.selected) renderThumbs(view.selected.frames); });
  on('#lightbox', 'click', closeLightbox);
  on('#pPrev', 'click', () => stepPlayer(-1));
  on('#pNext', 'click', () => stepPlayer(1));
  on('#pPlay', 'click', togglePlay);
  on('#pFps', 'change', () => { if (player.playing) { stopPlay(); startPlay(); } });
  on('#pEnlarge', 'click', () => { const i = galleryIndexOfFrame(player.frame()); if (i >= 0) openLightbox(i); });
  on('#viewerTabs', 'click', (e) => { const b = e.target.closest('.tab'); if (!b) return; setGalleryMode(b.dataset.view); });
  on('#listModeTabs', 'click', (e) => { const b = e.target.closest('.tab'); if (!b) return; view.listMode = b.dataset.mode; try { localStorage.setItem('listMode', view.listMode); } catch {} view.page = 0; view.selected = null; relist(); });
  on('#gapSelect', 'change', (e) => { view.gapMin = Number(e.target.value) || 15; try { localStorage.setItem('gapMin', view.gapMin); } catch {} view.page = 0; view.selected = null; relist(); });
  $('#gapSelect').value = String(view.gapMin);
  on('#moodSourceTabs', 'click', (e) => { const b = e.target.closest('.tab'); if (!b) return; view.moodSource = b.dataset.source; rescoreRows(); });
  try { const st = await getSettings(); view.moodSource = st.moodSource || 'valence'; view.minSessionMs = st.minSessionMs ?? 60000; } catch {}
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) { const st = ch.settings.newValue || {}; if (st.minSessionMs != null) view.minSessionMs = st.minSessionMs; } });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (!$('#lightbox').hidden) { if (e.key === 'Escape') closeLightbox(); if (e.key === 'ArrowRight') stepLightbox(1); if (e.key === 'ArrowLeft') stepLightbox(-1); return; }
    if (typing || $('#detail').hidden) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepPlayer(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPlayer(-1); }
  });
  on('#tlStart', 'click', startTimelapse);
  on('#tlCancel', 'click', () => tlAbort?.abort());
  window.addEventListener('resize', () => { if (view.selected) renderDetail(view.selected); });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.cameraGranted || ch.cameraError || ch.cameraBannerDismissed)) refreshBanner(); });
  $('#footer').textContent = `v${chrome.runtime.getManifest().version} · local only · face-api.js (tiny face detector + expression net) · mood = happy + 0.3·surprised − sad − angry − disgusted − 0.7·fearful`;

  await Promise.all([loadDay(), refreshBanner()]);
  setInterval(() => { if (view.day === dayKey()) loadDay(true); }, 10000);
}

function shiftDay(n) {
  const { start } = dayBounds(view.day);
  const d = new Date(start); d.setDate(d.getDate() + n);
  view.day = dayKey(d);
  loadDay();
}

// ---------------- data ----------------
async function loadDay(quiet = false) {
  const { start, end } = dayBounds(view.day);
  $('#todayBtn').textContent = fmtDay(view.day);
  const sessions = (await db.sessionsInRange(start, end))
    .filter((s) => !s.endedAt || s.endedAt - s.startedAt >= view.minSessionMs) // hide leftovers shorter than the current minimum
    .sort((a, b) => b.startedAt - a.startedAt);
  const rows = [];
  for (const s of sessions) {
    const raw = await db.framesForSession(s.id);
    const frames = withMoodSource(raw, view.moodSource);
    const endedAt = s.endedAt || Date.now();
    rows.push({ session: s, raw, frames, stats: sessionStats(frames), duration: endedAt - s.startedAt, live: !s.endedAt });
  }
  view.rows = rows;
  $('#livePill').hidden = !rows.some((r) => r.live);
  renderTiles(rows);
  renderBySite(rows);
  const items = currentItems();
  renderSessions(items);
  const stillThere = items.find((r) => r.session.id === view.selected?.session?.id);
  const prev = view.selected;
  if (stillThere) view.selected = stillThere;
  else if (!quiet || !view.selected) view.selected = items[0] || null;
  if (view.selected) { const i = items.indexOf(view.selected); if (i >= 0 && !quiet) view.page = Math.floor(i / PAGE_SIZE); }
  if (!view.selected) { $('#detail').hidden = true; return; }
  // On the periodic live refresh, leave the detail panel alone unless something actually changed.
  const unchanged = quiet && prev && prev.session.id === view.selected.session.id && prev.frames.length === view.selected.frames.length && !!prev.session.endedAt === !!view.selected.session.endedAt;
  if (!unchanged) renderDetail(view.selected);
}

function rescoreRows() {
  for (const r of view.rows) { r.frames = withMoodSource(r.raw, view.moodSource); r.stats = sessionStats(r.frames); }
  renderTiles(view.rows);
  const items = currentItems();
  renderSessions(items);
  if (view.selected) { view.selected = items.find((r) => r.session.id === view.selected.session.id) || items[0] || null; }
  if (view.selected) { player.frames = [...view.selected.frames].sort((a, b) => a.ts - b.ts); renderDetail(view.selected); }
}

// ---------------- grouping ----------------
// Items shown in the list: single sessions, or blocks of sessions whose gaps are <= gapMin.
function currentItems() {
  document.querySelectorAll('#listModeTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === view.listMode));
  $('#gapLabel').hidden = view.listMode !== 'groups';
  $('#sessionsTitle').textContent = view.listMode === 'groups' ? 'Blocks' : 'Sessions';
  return view.listMode === 'groups' ? buildGroups(view.rows, view.gapMin * 60000) : view.rows;
}
function buildGroups(rows, gapMs) {
  const asc = [...rows].sort((a, b) => a.session.startedAt - b.session.startedAt);
  const groups = [];
  let cur = null;
  for (const r of asc) {
    const end = r.session.endedAt || Date.now();
    if (cur && r.session.startedAt - cur.endAt <= gapMs) { cur.members.push(r); cur.endAt = Math.max(cur.endAt, end); }
    else { cur = { members: [r], endAt: end }; groups.push(cur); }
  }
  return groups.map((g) => {
    const members = g.members;
    const live = members.some((m) => m.live);
    const startedAt = members[0].session.startedAt;
    const endedAt = live ? null : g.endAt;
    const bySite = new Map();
    for (const m of members) bySite.set(m.session.domain, (bySite.get(m.session.domain) || 0) + m.duration);
    const sites = [...bySite.entries()].sort((a, b) => b[1] - a[1]);
    const raw = members.flatMap((m) => m.raw).sort((a, b) => a.ts - b.ts);
    const frames = withMoodSource(raw, view.moodSource);
    return {
      session: { id: 'grp-' + members[0].session.id, domain: sites.map(([d]) => d).join(' + '), startedAt, endedAt, url: '', title: `${members.length} session${members.length === 1 ? '' : 's'}` },
      members, sites, raw, frames, stats: sessionStats(frames),
      duration: members.reduce((a, m) => a + m.duration, 0), span: (endedAt || Date.now()) - startedAt, live,
    };
  }).sort((a, b) => b.session.startedAt - a.session.startedAt);
}
function relist() {
  const items = currentItems();
  view.selected = items[0] || null;
  renderSessions(items);
  if (view.selected) renderDetail(view.selected); else $('#detail').hidden = true;
}

// ---------------- tiles ----------------
function renderTiles(rows) {
  const total = rows.reduce((s, r) => s + r.duration, 0);
  const frames = rows.reduce((s, r) => s + r.stats.total, 0);
  const faced = rows.reduce((s, r) => s + r.stats.n, 0);
  const withMood = rows.filter((r) => r.stats.avg != null);
  const avg = withMood.length ? withMood.reduce((s, r) => s + r.stats.avg * r.stats.n, 0) / faced : null;
  const withDelta = rows.filter((r) => r.stats.delta != null);
  const drift = withDelta.length ? withDelta.reduce((s, r) => s + r.stats.delta * r.duration, 0) / withDelta.reduce((s, r) => s + r.duration, 0) : null;
  const driftCls = drift == null ? '' : drift > 0.1 ? 'up' : drift < -0.1 ? 'down' : '';
  const driftIcon = drift == null ? '' : drift > 0.1 ? '▲ ' : drift < -0.1 ? '▼ ' : '● ';
  $('#tiles').innerHTML = `
    <div class="tile"><div class="label">Time on tracked sites</div><div class="value">${fmtDuration(total)}</div><div class="sub">${rows.length} session${rows.length === 1 ? '' : 's'}</div></div>
    <div class="tile"><div class="label">Average mood</div><div class="value">${moodText(avg)}</div><div class="sub">scale −1 to +1</div></div>
    <div class="tile"><div class="label">Mood drift within sessions</div><div class="value ${driftCls}">${driftIcon}${fmtMood(drift, true)}</div><div class="sub">end vs. start, time-weighted</div></div>
    <div class="tile"><div class="label">Frames with a face</div><div class="value">${frames ? Math.round(100 * faced / frames) : 0}%</div><div class="sub">${faced} of ${frames} frames</div></div>`;
}

// ---------------- time by site ----------------
function renderBySite(rows) {
  const by = new Map();
  for (const r of rows) by.set(r.session.domain, (by.get(r.session.domain) || 0) + r.duration);
  const items = [...by.entries()].sort((a, b) => b[1] - a[1]);
  renderBars($('#bySite'), items.map(([label, v]) => ({ label, value: v, text: fmtDuration(v) })), 'No tracked sessions this day.');
}

function renderBars(el, items, emptyText) {
  if (!items.length) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
  const max = Math.max(...items.map((i) => i.value)) || 1;
  el.innerHTML = items.map((i) => `
    <div class="bar" title="${esc(i.label)}: ${esc(i.text)}">
      <span class="lbl">${esc(i.label)}</span>
      <span class="track"><span class="fill" style="width:${(100 * i.value / max).toFixed(1)}%"></span></span>
      <span class="val">${esc(i.text)}</span>
    </div>`).join('');
}

// ---------------- sessions table ----------------
function renderSessions(rows) {
  const el = $('#sessions');
  if (!rows.length) { el.innerHTML = '<div class="empty">Open a tracked site and this list fills in. Visits shorter than the minimum session length are ignored.</div>'; return; }
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  view.page = Math.max(0, Math.min(pages - 1, view.page));
  const pageRows = rows.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>When</th><th>Site</th><th>Length</th><th>Mood</th><th>Trend</th><th></th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const r of pageRows) {
    const tr = document.createElement('tr');
    if (r.session.id === view.selected?.session?.id) tr.classList.add('sel');
    const st = r.stats;
    const cls = st.label === 'improving' ? 'up' : st.label === 'declining' ? 'down' : 'flat';
    const icon = st.label === 'improving' ? '▲' : st.label === 'declining' ? '▼' : st.label === 'flat' ? '●' : '·';
    const siteCell = r.members
      ? `<div class="dom">${esc(r.sites[0][0])}${r.sites.length > 1 ? ` <span class="muted">+${r.sites.length - 1}</span>` : ''}</div><div class="sites">${r.sites.map(([d, ms]) => `${esc(d)} ${fmtDuration(ms)}`).join(' · ')}</div>`
      : `<span class="dom">${esc(r.session.domain)}</span>`;
    tr.innerHTML = `
      <td>${fmtTime(r.session.startedAt)}${r.members ? `–${r.session.endedAt ? fmtTime(r.session.endedAt) : 'now'}` : ''}${r.live ? ' <span class="pill">live</span>' : ''}</td>
      <td>${siteCell}</td>
      <td>${fmtDuration(r.duration)}${r.members && r.span - r.duration > 60000 ? `<div class="sites">of ${fmtDuration(r.span)}</div>` : ''}</td>
      <td>${moodText(st.avg)}</td>
      <td class="trend ${cls}">${icon} ${st.label}${st.delta != null ? ` (${fmtMood(st.delta, true)})` : ''}</td>
      <td></td>
      <td><button class="rowbtn" title="Export a timelapse video of this session">Timelapse</button></td>`;
    tr.children[5].appendChild(sparkline(r.frames));
    const select = (openExport) => { view.selected = r; renderSessions(rows); renderDetail(r); if (openExport) $('#tlPanel').hidden = false; $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    tr.addEventListener('click', () => select(false));
    tr.querySelector('.rowbtn').addEventListener('click', (e) => { e.stopPropagation(); select(true); });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  el.replaceChildren(table);
  if (rows.length > PAGE_SIZE) {
    const nav = document.createElement('div');
    nav.className = 'pager';
    const first = view.page * PAGE_SIZE + 1, last = Math.min(rows.length, (view.page + 1) * PAGE_SIZE);
    nav.innerHTML = `<button class="ghost" id="pgPrev" ${view.page === 0 ? 'disabled' : ''}>‹ Newer</button><span class="muted">${first}–${last} of ${rows.length} sessions</span><button class="ghost" id="pgNext" ${view.page >= pages - 1 ? 'disabled' : ''}>Older ›</button>`;
    nav.querySelector('#pgPrev').addEventListener('click', () => { view.page--; renderSessions(rows); });
    nav.querySelector('#pgNext').addEventListener('click', () => { view.page++; renderSessions(rows); });
    el.appendChild(nav);
  }
}

function sparkline(frames) {
  const W = 110, H = 28;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.classList.add('spark');
  const pts = frames.filter((f) => f.faceFound && typeof f.mood === 'number').sort((a, b) => a.ts - b.ts);
  const zero = document.createElementNS(SVG_NS, 'line');
  zero.setAttribute('x1', 0); zero.setAttribute('x2', W); zero.setAttribute('y1', H / 2); zero.setAttribute('y2', H / 2);
  zero.setAttribute('stroke', 'var(--grid)'); svg.appendChild(zero);
  if (pts.length < 2) return svg;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const ys = smooth(pts.map((p) => p.mood), 5);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(W * (p.ts - t0) / Math.max(1, t1 - t0)).toFixed(1)},${(H / 2 - ys[i] * (H / 2 - 2)).toFixed(1)}`).join(' ');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'var(--s1)'); path.setAttribute('stroke-width', '1.5');
  svg.appendChild(path);
  return svg;
}

// ---------------- detail ----------------
async function renderDetail(row) {
  const { session: s, frames, stats: st } = row;
  $('#detail').hidden = false;
  $('#dTitle').textContent = `${s.domain} · ${fmtTimeSec(s.startedAt)} – ${s.endedAt ? fmtTimeSec(s.endedAt) : 'now'}`;
  $('#dSub').textContent = row.members
    ? `${row.members.length} sessions · ${fmtDuration(row.duration)} active within ${fmtDuration(row.span)} · ${row.sites.map(([d, ms]) => `${d} ${fmtDuration(ms)}`).join(' · ')}`
    : (s.title || s.url || '');
  $('#dDelete').hidden = !!row.members;
  const cls = st.label === 'improving' ? 'up' : st.label === 'declining' ? 'down' : 'flat';
  $('#dStats').innerHTML = `
    <div>Length<b>${fmtDuration(row.duration)}</b></div>
    <div>Avg mood<b>${moodText(st.avg)}</b></div>
    <div>Start → end<b>${fmtMood(st.first, true)} → ${fmtMood(st.last, true)}</b></div>
    <div>Trend<b class="trend ${cls}">${st.label}</b></div>
    <div>Slope<b>${st.slopePerMin == null ? '—' : fmtMood(st.slopePerMin, true) + '/min'}</b></div>`;
  const hseCount = frames.filter((f) => f.hse).length;
  $('#dLegend').textContent = `${st.n} of ${st.total} frames had a face · ${hseCount} scored by HSEmotion · line is a 5-frame rolling mean`;
  document.querySelectorAll('#moodSourceTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.source === view.moodSource));
  setPlayerSession(row);
  renderMoodChart($('#moodChart'), frames, s, row, row.members ? row.members.map((m) => m.session) : null);
  renderViewer();
  renderSignals(frames, s);

  const items = EXPRESSIONS.map((k) => ({ label: k, value: st.expressionAvg?.[k] || 0, text: st.expressionAvg ? (100 * st.expressionAvg[k]).toFixed(0) + '%' : '—' }))
    .sort((a, b) => b.value - a.value);
  renderBars($('#exprMix'), st.n ? items : [], 'No faces detected in this session.');

  const activity = row.members
    ? (await Promise.all(row.members.map((m) => db.activityForSession(m.session.id)))).flat()
    : await db.activityForSession(s.id);
  renderActivityChart($('#activityChart'), activity, s, row);
  const scroll = activity.reduce((a, x) => a + x.scrollPx, 0), clicks = activity.reduce((a, x) => a + x.clicks, 0), keys = activity.reduce((a, x) => a + x.keys, 0);
  $('#activitySummary').textContent = activity.length ? `${Math.round(scroll).toLocaleString()} px scrolled · ${clicks} clicks · ${keys} keystrokes` : 'No activity recorded (content script not active on this site, or no input).';

  renderThumbs(frames);
}

function renderMoodChart(container, frames, session, row, bands = null) {
  clearChart(container);
  const W = Math.max(320, container.clientWidth), H = container.clientHeight || 240;
  const m = { l: 36, r: 12, t: 10, b: 24 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t0 = session.startedAt, t1 = Math.max(session.endedAt || Date.now(), t0 + 60000);
  const x = (ts) => m.l + iw * (ts - t0) / (t1 - t0);
  const y = (v) => m.t + ih * (1 - (v + 1) / 2);

  // grid + axes
  const g = el('g', { class: 'grid' });
  for (const v of [-1, -0.5, 0.5, 1]) {
    g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, v > 0 ? '+' + v : String(v)));
  }
  svg.appendChild(g);
  svg.appendChild(el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  svg.appendChild(el('text', { x: m.l - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0'));
  const ticks = timeTicks(t0, t1, Math.floor(iw / 90));
  for (const t of ticks) {
    svg.appendChild(el('line', { class: 'baseline', x1: x(t), x2: x(t), y1: H - m.b, y2: H - m.b + 4 }));
    svg.appendChild(el('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, fmtTime(t)));
  }
  svg.appendChild(el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  if (bands && bands.length > 1) {
    // one band per member session so you can see which site you were on
    for (const b of bands) {
      const bx0 = x(b.startedAt), bx1 = x(b.endedAt || Date.now());
      svg.appendChild(el('rect', { class: 'band', x: bx0, y: m.t, width: Math.max(1, bx1 - bx0), height: 14 }));
      svg.appendChild(el('line', { class: 'bandLine', x1: bx0, x2: bx0, y1: m.t, y2: H - m.b }));
      if (bx1 - bx0 > 40) svg.appendChild(el('text', { class: 'bandText', x: bx0 + 4, y: m.t + 10 }, b.domain.length > 18 ? b.domain.slice(0, 16) + '…' : b.domain));
    }
  }

  const all = [...frames].sort((a, b) => a.ts - b.ts);
  const pts = all.filter((f) => f.faceFound && typeof f.mood === 'number');
  // no-face frames as small ticks along the bottom
  for (const f of all) if (!f.faceFound) svg.appendChild(el('line', { class: 'noface', x1: x(f.ts), x2: x(f.ts), y1: H - m.b - 5, y2: H - m.b - 1 }));

  if (pts.length) {
    const ys = smooth(pts.map((p) => p.mood), 5);
    const gaps = pts.slice(1).map((p, i) => p.ts - pts[i].ts).sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3000;
    const maxGap = Math.max(median * 4, 15000);
    // build segments separated by long gaps
    const segs = [];
    let cur = [];
    pts.forEach((p, i) => { if (i && p.ts - pts[i - 1].ts > maxGap) { segs.push(cur); cur = []; } cur.push([x(p.ts), y(ys[i]), p]); });
    segs.push(cur);
    const clipPos = el('clipPath', { id: 'clipPos' }); clipPos.appendChild(el('rect', { x: 0, y: 0, width: W, height: y(0) }));
    const clipNeg = el('clipPath', { id: 'clipNeg' }); clipNeg.appendChild(el('rect', { x: 0, y: y(0), width: W, height: H - y(0) }));
    svg.appendChild(clipPos); svg.appendChild(clipNeg);
    for (const seg of segs) {
      if (seg.length < 2) { if (seg.length === 1) svg.appendChild(el('circle', { class: 'marker', cx: seg[0][0], cy: seg[0][1], r: 3 })); continue; }
      const line = seg.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
      const area = `${line} L${seg[seg.length - 1][0].toFixed(1)},${y(0)} L${seg[0][0].toFixed(1)},${y(0)} Z`;
      svg.appendChild(el('path', { class: 'areaPos', d: area, 'clip-path': 'url(#clipPos)' }));
      svg.appendChild(el('path', { class: 'areaNeg', d: area, 'clip-path': 'url(#clipNeg)' }));
      svg.appendChild(el('path', { class: 'line', d: line }));
    }
  }
  // hover + scrub layer (over ALL frames, so no-face frames can be scrubbed to as well)
  const hover = el('line', { class: 'hover', x1: 0, x2: 0, y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const hoverMark = el('circle', { class: 'marker', r: 4, visibility: 'hidden' });
  const playhead = el('line', { class: 'playhead', x1: 0, x2: 0, y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const playmark = el('circle', { class: 'playmark', r: 5, visibility: 'hidden' });
  svg.appendChild(hover); svg.appendChild(hoverMark); svg.appendChild(playhead); svg.appendChild(playmark);
  const overlay = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', style: 'cursor:crosshair' });
  svg.appendChild(overlay);
  const smoothAt = new Map();
  if (pts.length) { const ys = smooth(pts.map((p) => p.mood), 5); pts.forEach((p, i) => smoothAt.set(p, ys[i])); }
  const yFor = (f) => (smoothAt.has(f) ? y(smoothAt.get(f)) : y(0));
  const nearest = (ev) => {
    const rect = svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * W / rect.width;
    let best = 0;
    for (let i = 1; i < all.length; i++) if (Math.abs(x(all[i].ts) - mx) < Math.abs(x(all[best].ts) - mx)) best = i;
    return best;
  };
  view.chart = {
    setPlayhead(f) {
      if (!f) { playhead.setAttribute('visibility', 'hidden'); playmark.setAttribute('visibility', 'hidden'); return; }
      const px = x(f.ts);
      playhead.setAttribute('x1', px); playhead.setAttribute('x2', px); playhead.setAttribute('visibility', 'visible');
      playmark.setAttribute('cx', px); playmark.setAttribute('cy', yFor(f)); playmark.setAttribute('visibility', f.faceFound ? 'visible' : 'hidden');
    },
  };
  let dragging = false;
  const showAt = (ev) => {
    if (!all.length) return;
    const i = nearest(ev), f = all[i], px = x(f.ts);
    hover.setAttribute('x1', px); hover.setAttribute('x2', px); hover.setAttribute('visibility', 'visible');
    hoverMark.setAttribute('cx', px); hoverMark.setAttribute('cy', yFor(f)); hoverMark.setAttribute('visibility', f.faceFound ? 'visible' : 'hidden');
    showTooltip(ev, `<b>${fmtTimeSec(f.ts)}</b> · ${f.faceFound ? `${moodEmoji(f.mood)} mood ${fmtMood(f.mood, true)}` : '🫥 no face'}<br>${f.faceFound ? frameDetail(f) : 'no face detected'}`);
    if (dragging) { stopPlay(); setPlayerIndex(i); }
  };
  overlay.addEventListener('mousemove', showAt);
  overlay.addEventListener('mousedown', (ev) => { dragging = true; showAt(ev); ev.preventDefault(); });
  window.addEventListener('mouseup', () => { dragging = false; });
  overlay.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); hoverMark.setAttribute('visibility', 'hidden'); hideTooltip(); });
  if (!pts.length) {
    svg.appendChild(el('text', { x: W / 2, y: m.t + ih * 0.3, 'text-anchor': 'middle' }, frames.length ? 'No face detected in any frame' : (row.live ? 'Waiting for the first frame…' : 'No frames captured (camera not allowed?)')));
  }
  container.appendChild(svg);
  view.chart.setPlayhead(player.frame());
}

const SIGNAL_DEFS = [
  { key: 'arousal', label: 'Arousal', hint: 'HSEmotion · −1 calm … +1 activated', min: -1, max: 1, get: (f) => f.hse?.arousal, fmt: (v) => fmtMood(v, true) },
  { key: 'blinkRate', label: 'Blink rate', hint: 'blinks per minute · low = absorbed, high = fatigue/stress', min: 0, max: null, get: (f) => f.signals?.blinkRate, fmt: (v) => v.toFixed(0) + '/min' },
  { key: 'browDown', label: 'Brow furrow', hint: 'browDown blendshape · concentration or tension', min: 0, max: 1, get: (f) => f.signals?.browDown, fmt: (v) => (100 * v).toFixed(0) + '%' },
  { key: 'mouthPress', label: 'Lip press', hint: 'mouthPress blendshape · tension', min: 0, max: 1, get: (f) => f.signals?.mouthPress, fmt: (v) => (100 * v).toFixed(0) + '%' },
  { key: 'lookAway', label: 'Looking away', hint: 'share of samples with head turned or eyes down', min: 0, max: 1, get: (f) => f.signals?.lookAway, fmt: (v) => (100 * v).toFixed(0) + '%' },
  { key: 'faceWidth', label: 'Face size', hint: 'face width as share of frame · bigger = leaning in', min: 0, max: 1, get: (f) => f.box?.w, fmt: (v) => (100 * v).toFixed(0) + '%' },
];
function renderSignals(frames, session) {
  const root = $('#signals');
  root.innerHTML = '';
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  for (const def of SIGNAL_DEFS) {
    const pts = sorted.map((f) => ({ ts: f.ts, v: def.get(f) })).filter((p) => typeof p.v === 'number' && !Number.isNaN(p.v));
    const card = document.createElement('div');
    card.className = 'signal';
    const avg = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null;
    card.innerHTML = `<div class="sigHead"><b>${def.label}</b><span title="${esc(def.hint)}">${avg == null ? '—' : 'avg ' + def.fmt(avg)}</span></div><div class="chart"></div>`;
    root.appendChild(card);
    const c = card.querySelector('.chart');
    if (!pts.length) { c.innerHTML = `<div class="empty">no data</div>`; continue; }
    renderMiniLine(c, pts, session, def);
  }
}
function renderMiniLine(container, pts, session, def) {
  const W = Math.max(200, container.clientWidth), H = container.clientHeight || 90;
  const m = { l: 34, r: 6, t: 6, b: 4 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t0 = session.startedAt, t1 = Math.max(session.endedAt || Date.now(), t0 + 60000);
  const lo = def.min ?? Math.min(...pts.map((p) => p.v)), hi0 = def.max ?? Math.max(...pts.map((p) => p.v));
  const hi = hi0 > lo ? hi0 : lo + 1;
  const x = (ts) => m.l + iw * (ts - t0) / (t1 - t0);
  const y = (v) => m.t + ih * (1 - (v - lo) / (hi - lo));
  const g = el('g', { class: 'grid' });
  for (const v of [lo, (lo + hi) / 2, hi]) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) })); svg.appendChild(el('text', { x: m.l - 4, y: y(v) + 3, 'text-anchor': 'end', style: 'font-size:9px' }, def.fmt(v))); }
  svg.appendChild(g);
  if (lo < 0 && hi > 0) svg.appendChild(el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  const sm = smooth(pts.map((p) => p.v), 3);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(Math.max(lo, Math.min(hi, sm[i]))).toFixed(1)}`).join(' ');
  svg.appendChild(el('path', { class: 'line', d, style: 'stroke:var(--s2)' }));
  const mark = el('circle', { class: 'marker', r: 3, visibility: 'hidden', style: 'fill:var(--s2)' });
  svg.appendChild(mark);
  const overlay = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(overlay);
  overlay.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect(); const mx = (ev.clientX - rect.left) * W / rect.width;
    let b = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(x(pts[i].ts) - mx) < Math.abs(x(pts[b].ts) - mx)) b = i;
    mark.setAttribute('cx', x(pts[b].ts)); mark.setAttribute('cy', y(Math.max(lo, Math.min(hi, sm[b])))); mark.setAttribute('visibility', 'visible');
    showTooltip(ev, `<b>${fmtTimeSec(pts[b].ts)}</b> · ${def.label} ${def.fmt(pts[b].v)}<br><span class="muted">${esc(def.hint)}</span>`);
  });
  overlay.addEventListener('mouseleave', () => { mark.setAttribute('visibility', 'hidden'); hideTooltip(); });
  container.appendChild(svg);
}

function renderActivityChart(container, activity, session, row) {
  clearChart(container);
  const W = Math.max(280, container.clientWidth), H = container.clientHeight || 140;
  const m = { l: 40, r: 8, t: 8, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t0 = session.startedAt, t1 = Math.max(session.endedAt || Date.now(), t0 + 60000);
  const nb = Math.max(1, Math.ceil((t1 - t0) / 60000));
  const buckets = new Array(nb).fill(0);
  for (const a of activity) { const i = Math.min(nb - 1, Math.max(0, Math.floor((a.ts - t0) / 60000))); buckets[i] += a.scrollPx; }
  const max = Math.max(1, ...buckets);
  const x = (i) => m.l + iw * i / nb, bw = Math.max(1, iw / nb - 2);
  const y = (v) => m.t + ih * (1 - v / max);
  const g = el('g', { class: 'grid' });
  if (max >= 2) for (const f of [0.5, 1]) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(max * f), y2: y(max * f) })); svg.appendChild(el('text', { x: m.l - 6, y: y(max * f) + 4, 'text-anchor': 'end' }, fmtK(max * f))); }
  svg.appendChild(g);
  svg.appendChild(el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  for (const t of timeTicks(t0, t1, Math.floor(iw / 80))) svg.appendChild(el('text', { x: m.l + iw * (t - t0) / (t1 - t0), y: H - 6, 'text-anchor': 'middle' }, fmtTime(t)));
  if (!activity.length) { svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'No activity data')); container.appendChild(svg); return; }
  buckets.forEach((v, i) => {
    if (!v) return;
    const r = el('rect', { class: 'col', x: x(i) + 1, y: y(v), width: bw, height: Math.max(1, H - m.b - y(v)), rx: 2 });
    r.addEventListener('mousemove', (ev) => showTooltip(ev, `<b>${fmtTime(t0 + i * 60000)}</b><br>${Math.round(v).toLocaleString()} px scrolled`));
    r.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(r);
  });
  container.appendChild(svg);
}

function setGalleryMode(mode) {
  view.gallery = mode;
  try { localStorage.setItem('galleryView', mode); } catch {}
  if (view.selected) renderThumbs(view.selected.frames);
  renderViewer();
}
function galleryIndexOfFrame(f) { return f ? galleryItems.findIndex((it) => it.f === f) : -1; }

// ---------------- player (timeline scrubbing + playback) ----------------
const player = { sessionId: null, frames: [], idx: -1, playing: false, timer: null, frame() { return this.frames[this.idx] || null; } };
function setPlayerSession(row) {
  const frames = [...row.frames].sort((a, b) => a.ts - b.ts);
  const wasAtEnd = player.idx >= player.frames.length - 1;
  if (player.sessionId !== row.session.id) { stopPlay(); player.idx = frames.length ? 0 : -1; }
  else if (wasAtEnd && frames.length > player.frames.length && !player.playing) player.idx = frames.length - 1; // live: follow the newest frame
  player.sessionId = row.session.id;
  player.frames = frames;
  if (player.idx >= frames.length) player.idx = frames.length - 1;
}
function setPlayerIndex(i) {
  if (!player.frames.length) return;
  player.idx = Math.max(0, Math.min(player.frames.length - 1, i));
  renderViewer();
}
function stepPlayer(d) { stopPlay(); setPlayerIndex(player.idx + d); }
function togglePlay() { if (player.playing) stopPlay(); else startPlay(); }
function startPlay() {
  if (!player.frames.length) return;
  if (player.idx >= player.frames.length - 1) player.idx = 0;
  player.playing = true;
  $('#pPlay').textContent = '⏸ Pause';
  const fps = Number($('#pFps').value) || 10;
  const tick = () => {
    if (!player.playing) return;
    if (player.idx >= player.frames.length - 1) { stopPlay(); return; }
    setPlayerIndex(player.idx + 1);
    player.timer = setTimeout(tick, 1000 / fps);
  };
  renderViewer();
  player.timer = setTimeout(tick, 1000 / fps);
}
function stopPlay() {
  player.playing = false;
  if (player.timer) { clearTimeout(player.timer); player.timer = null; }
  const b = $('#pPlay'); if (b) b.textContent = '▶ Play';
}
// Decoded-image cache so frames swap in without a blank flash (LRU by frame id).
const imgCache = new Map();
const IMG_CACHE_MAX = 40;
function cachedImages(f) {
  if (imgCache.has(f.id)) { const v = imgCache.get(f.id); imgCache.delete(f.id); imgCache.set(f.id, v); return v.promise; }
  const load = async (blob) => {
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { /* still usable */ }
    return { img, url };
  };
  const promise = Promise.all([load(f.screen), load(f.thumb)]).then(([screen, face]) => ({ screen, face }));
  imgCache.set(f.id, { promise });
  while (imgCache.size > IMG_CACHE_MAX) {
    const [k, v] = imgCache.entries().next().value;
    imgCache.delete(k);
    v.promise.then((r) => { for (const e of [r.screen, r.face]) if (e) URL.revokeObjectURL(e.url); });
  }
  return promise;
}
function preloadAround(idx) {
  for (let i = idx + 1; i <= Math.min(player.frames.length - 1, idx + 4); i++) cachedImages(player.frames[i]);
}
let viewerToken = 0;
async function renderViewer() {
  const f = player.frame();
  const mode = view.gallery;
  document.querySelectorAll('#viewerTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === mode));
  view.chart?.setPlayhead(f);
  const empty = $('#viewerEmpty'), slotS = $('#slotScreen'), slotF = $('#slotFace'), cap = $('#viewerCap');
  if (!f) { empty.hidden = false; empty.textContent = 'No frames in this session yet'; slotS.hidden = slotF.hidden = true; cap.textContent = ''; $('#pPos').textContent = ''; return; }
  $('#pPos').textContent = `${player.idx + 1} / ${player.frames.length}`;
  cap.innerHTML = `<b>${fmtTimeSec(f.ts)}</b> · ${f.faceFound ? `${moodEmoji(f.mood)} mood ${fmtMood(f.mood, true)} · ${frameDetail(f)}` : '🫥 no face detected'}${f.pageTitle ? `<br>${esc(f.pageTitle)}` : ''}`;
  const token = ++viewerToken;
  const imgs = await cachedImages(f);
  if (token !== viewerToken) return; // a newer frame was requested meanwhile
  preloadAround(player.idx);
  const place = (slot, entry, show, placeholder) => {
    slot.hidden = !show;
    if (!show) return;
    if (entry) {
      if (slot.firstChild !== entry.img) slot.replaceChildren(entry.img);
      slot.style.flex = `${(entry.img.naturalWidth / Math.max(1, entry.img.naturalHeight)).toFixed(3)} 1 0`;
    } else {
      slot.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: placeholder }));
      slot.style.flex = '1.4 1 0';
    }
  };
  empty.hidden = true;
  place(slotS, imgs.screen, mode !== 'face', 'no screenshot');
  place(slotF, imgs.face, mode !== 'screen', 'no webcam frame');
}

let galleryItems = [];
let galleryKey = null;
function renderThumbs(frames) {
  const el = $('#thumbs');
  const mode = view.gallery;
  document.querySelectorAll('#galleryTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === mode));
  const wanted = frames.filter((f) => (mode === 'face' ? f.thumb : mode === 'screen' ? f.screen : (f.thumb || f.screen))).sort((a, b) => a.ts - b.ts);
  if (!wanted.length) {
    for (const u of objectUrls) URL.revokeObjectURL(u); objectUrls = [];
    el.innerHTML = `<div class="muted">No ${mode === 'face' ? 'webcam thumbnails' : mode === 'screen' ? 'screenshots' : 'images'} stored for this session.</div>`;
    $('#thumbsNote').textContent = ''; $('#thumbsAll').hidden = true; galleryItems = []; galleryKey = null; return;
  }
  const maxShow = 48;
  const step = view.showAll ? 1 : Math.max(1, Math.ceil(wanted.length / maxShow));
  const shown = wanted.filter((_, i) => i % step === 0);
  $('#thumbsNote').textContent = `showing ${shown.length} of ${wanted.length}`;
  const allBtn = $('#thumbsAll');
  allBtn.hidden = wanted.length <= maxShow;
  allBtn.textContent = view.showAll ? `Show a sample of ${maxShow}` : `Show all ${wanted.length} frames`;
  // Same session, same mode, sampling step 1 and only new frames at the end: append instead of rebuilding.
  const canAppend = galleryKey && galleryKey.sessionId === player.sessionId && galleryKey.mode === mode && galleryKey.step === 1 && step === 1
    && galleryItems.length && shown.length >= galleryItems.length && galleryItems.every((it, i) => it.f.id === shown[i].id);
  const startAt = canAppend ? galleryItems.length : 0;
  if (!canAppend) { for (const u of objectUrls) URL.revokeObjectURL(u); objectUrls = []; el.innerHTML = ''; galleryItems = []; }
  galleryKey = { sessionId: player.sessionId, mode, step };
  const fresh = shown.slice(startAt).map((f) => {
    const faceUrl = f.thumb ? URL.createObjectURL(f.thumb) : null;
    const screenUrl = f.screen ? URL.createObjectURL(f.screen) : null;
    for (const u of [faceUrl, screenUrl]) if (u) objectUrls.push(u);
    return { f, faceUrl, screenUrl };
  });
  galleryItems = galleryItems.concat(fresh);
  fresh.forEach((it, j) => {
    const idx = startAt + j;
    const { f, faceUrl, screenUrl } = it;
    const fig = document.createElement('figure');
    fig.className = `view-${mode}`;
    const imgs = [];
    if (mode !== 'face' && screenUrl) imgs.push(`<img class="screen" src="${screenUrl}" alt="" loading="lazy">`);
    if (mode !== 'screen' && faceUrl) imgs.push(`<img class="face" src="${faceUrl}" alt="" loading="lazy">`);
    const cap = `${fmtTimeSec(f.ts)} ${f.faceFound ? `${moodEmoji(f.mood)} ${fmtMood(f.mood, true)}` : '🫥'}${mode !== 'face' && f.pageTitle ? ` · ${esc(f.pageTitle)}` : ''}`;
    fig.innerHTML = `<div class="pic">${imgs.join('')}</div><figcaption>${cap}</figcaption>`;
    fig.title = `${f.faceFound ? `mood ${fmtMood(f.mood, true)} · ${f.dominant}` : 'no face'}${f.pageTitle ? ` · ${f.pageTitle}` : ''}`;
    fig.querySelector('.pic').addEventListener('click', () => { stopPlay(); const i = player.frames.indexOf(f); if (i >= 0) setPlayerIndex(i); $('#viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    fig.addEventListener('dblclick', () => openLightbox(idx));
    el.appendChild(fig);
  });
}

let lbIndex = -1;
function openLightbox(idx) {
  const it = galleryItems[idx]; if (!it) return;
  lbIndex = idx;
  const { f, faceUrl, screenUrl } = it;
  const sImg = $('#lbScreen'), fImg = $('#lbFace');
  sImg.hidden = !screenUrl || view.gallery === 'face'; if (screenUrl) sImg.src = screenUrl;
  fImg.hidden = !faceUrl || view.gallery === 'screen'; if (faceUrl) fImg.src = faceUrl;
  const top = f.expressions ? EXPRESSIONS.map((k) => [k, f.expressions[k] || 0]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(' · ') : 'no face';
  $('#lbCap').textContent = `${fmtTimeSec(f.ts)} · ${f.faceFound ? `${moodEmoji(f.mood)} mood ${fmtMood(f.mood, true)} · ${top}` : '🫥 no face'}${f.pageTitle ? ` · ${f.pageTitle}` : ''} · ${idx + 1}/${galleryItems.length}`;
  $('#lightbox').hidden = false;
}
function stepLightbox(d) { const n = galleryItems.length; if (!n) return; openLightbox((lbIndex + d + n) % n); }
function closeLightbox() { $('#lightbox').hidden = true; }

// ---------------- timelapse export ----------------
let tlAbort = null;
async function startTimelapse() {
  if (!view.selected || tlAbort) return;
  const { session, frames } = view.selected;
  const mode = document.querySelector('input[name=tlMode]:checked').value;
  const fps = Number($('#tlFps').value) || 10;
  const status = $('#tlStatus');
  if (!pickMime()) { status.textContent = 'Video recording is not supported in this browser.'; return; }
  tlAbort = new AbortController();
  $('#tlStart').disabled = true; $('#tlCancel').hidden = false;
  status.textContent = 'Preparing…';
  try {
    const out = await renderTimelapse({
      frames, session, mode, fps, signal: tlAbort.signal,
      onProgress: (i, n) => { status.textContent = `Rendering frame ${i} of ${n} (${Math.round((n - i) / fps)}s left)…`; },
    });
    if (tlAbort.signal.aborted) { status.textContent = 'Cancelled.'; return; }
    const ext = out.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const name = `timelapse-${session.domain.replace(/[^a-z0-9.]+/gi, '_')}-${dayKey(new Date(session.startedAt))}-${fmtTime(session.startedAt).replace(/[^0-9]/g, '')}-${mode}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out.blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status.textContent = `Saved ${name} (${out.frames} frames, ${out.width}×${out.height}, ${(out.blob.size / 1e6).toFixed(1)} MB).`;
  } catch (e) {
    status.textContent = `Export failed: ${e.message}`;
  } finally {
    tlAbort = null; $('#tlStart').disabled = false; $('#tlCancel').hidden = true;
  }
}

// ---------------- helpers ----------------
// One-line model detail for a frame: HSEmotion valence/arousal + top class when present, face-api top-3 otherwise.
function frameDetail(f) {
  const fa = f.expressions ? EXPRESSIONS.map((k) => [k, f.expressions[k] || 0]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(' · ') : 'no face';
  if (!f.hse) return fa;
  const top = HSE_CLASSES.map((k) => [k, f.hse.probs?.[k] || 0]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(' · ');
  return `valence ${fmtMood(f.hse.valence, true)} · arousal ${fmtMood(f.hse.arousal, true)} · ${top} <span class="muted">· face-api: ${fa}</span>`;
}
function moodText(m) { return m == null ? '—' : `${moodEmoji(m)} ${fmtMood(m, true)}`; }
function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
function clearChart(c) { c.replaceChildren(); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtK(v) { return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : String(Math.round(v)); }
function timeTicks(t0, t1, n) {
  n = Math.max(2, n);
  const span = t1 - t0;
  const steps = [30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3];
  const step = steps.find((s) => span / s <= n) || steps[steps.length - 1];
  const out = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}
const tooltip = $('#tooltip');
function showTooltip(ev, html) {
  tooltip.innerHTML = html; tooltip.hidden = false;
  const pad = 14;
  let left = ev.clientX + pad, top = ev.clientY + pad;
  const r = tooltip.getBoundingClientRect();
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - pad;
  tooltip.style.left = left + 'px'; tooltip.style.top = top + 'px';
}
function hideTooltip() { tooltip.hidden = true; }

// ---------------- camera banner ----------------
async function refreshBanner() {
  try {
    const st = await getCameraStatus();
    const banner = $('#cameraBanner');
    banner.hidden = !st.showBanner;
    $('#cameraBannerCause').textContent = st.cause;
    if (st.state === 'denied') $('#cameraBannerText').textContent = 'Chrome has the camera blocked for this extension. Fix it under chrome://extensions → Details → Site settings → Camera: Allow, or open Camera settings for instructions.';
    else if (st.refused) $('#cameraBannerText').textContent = 'The capture page could not use the camera. Click Allow camera again, or set Camera: Allow under chrome://extensions → Details → Site settings.';
  } catch (e) { console.error('[dhm] banner', e); }
}
async function grantCamera() {
  const text = $('#cameraBannerText'), btn = $('#cameraBannerBtn');
  btn.disabled = true; text.textContent = 'Waiting for the camera permission prompt…';
  const r = await requestCamera();
  btn.disabled = false;
  if (r.ok) { $('#cameraBanner').hidden = true; return; }
  text.textContent = `Camera request failed: ${r.name}: ${r.message}. ${r.hint}`;
}

async function deleteDay() {
  if (!confirm(`Delete all sessions and frames for ${fmtDay(view.day)}?`)) return;
  for (const r of view.rows) await db.deleteSession(r.session.id);
  view.selected = null; loadDay();
}
async function deleteSelected() {
  if (!view.selected || !confirm('Delete this session?')) return;
  await db.deleteSession(view.selected.session.id);
  view.selected = null; loadDay();
}

init().catch((e) => { console.error('[dhm] dashboard init failed', e); document.body.insertAdjacentHTML('afterbegin', `<div class="banner">Dashboard failed to start: ${esc(e.message)}</div>`); });
