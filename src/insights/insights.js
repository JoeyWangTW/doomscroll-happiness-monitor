import * as db from '../shared/db.js';
import { moodOf, moodEmoji } from '../shared/mood.js';
import { getSettings } from '../shared/settings.js';
import { fmtDuration, fmtMood, fmtTime, dayKey } from '../shared/format.js';
import * as I from '../shared/insights.js';

const $ = (s) => document.querySelector(s);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SLOTS = 7; // categorical colors --c1..--c7; less-used sites share --cOther
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LOW_N = 30; // buckets with fewer mood frames than this are drawn faded

const DEFAULTS = { range: '7d', custom: null, excluded: [], days: 'all', tod: 'all', source: null, timeMode: 'stack', heat: 'time', minute: 'chg', doomMin: 30, gapMin: 10, sort: { key: 'ms', dir: -1 } };
const state = { ...DEFAULTS };
try { Object.assign(state, JSON.parse(localStorage.getItem('insights') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('insights', JSON.stringify(state)); } catch {} };

let allSessions = [];
let siteRank = new Map();
let minSessionMs = 60000;
const cache = { start: null, end: null, until: null, frames: [] };
let cur = null; // last computed data, reused on resize

// ---------------- boot ----------------
async function init() {
  try { const st = await getSettings(); minSessionMs = st.minSessionMs ?? 60000; if (!state.source) state.source = st.moodSource || 'valence'; } catch { state.source ||= 'valence'; }
  bindTabs('#rangeTabs', 'range', (v) => { state.range = v; if (v === 'custom' && !state.custom) { const r = I.rangeBounds('7d'); state.custom = { from: dayKey(new Date(r.start)), to: dayKey(new Date(r.end - 1)) }; } });
  bindTabs('#sourceTabs', 'source', (v) => { state.source = v; });
  bindTabs('#timeTabs', 'mode', (v) => { state.timeMode = v; }, true);
  bindTabs('#heatTabs', 'metric', (v) => { state.heat = v; }, true);
  bindTabs('#minuteTabs', 'mode', (v) => { state.minute = v; }, true);
  for (const [sel, key] of [['#daysSel', 'days'], ['#todSel', 'tod'], ['#doomSel', 'doomMin'], ['#gapSel', 'gapMin']]) {
    $(sel).value = String(state[key]);
    $(sel).addEventListener('change', (e) => { state[key] = key.endsWith('Min') ? Number(e.target.value) : e.target.value; save(); render(); });
  }
  for (const id of ['#fromDate', '#toDate']) $(id).addEventListener('change', () => { state.custom = { from: $('#fromDate').value, to: $('#toDate').value }; save(); render(); });
  $('#sitesAll').addEventListener('click', () => { state.excluded = []; save(); render(); });
  $('#sitesNone').addEventListener('click', () => { state.excluded = [...siteRank.keys()]; save(); render(); });
  document.addEventListener('click', (e) => { const d = $('#siteDrop'); if (d.open && !d.contains(e.target)) d.open = false; });
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => cur && drawAll(cur), 120); });
  $('#footer').textContent = `v${chrome.runtime.getManifest().version} · local only · everything on this page is computed in your browser from the extension's IndexedDB`;
  await loadSessions();
  await render();
  setInterval(async () => { if (currentRange().end > Date.now() - I.DAY) { await loadSessions(); render(true); } }, 30000);
}

function bindTabs(sel, attr, set, drawOnly = false) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    set(b.dataset[attr]); save();
    if (drawOnly && cur) { syncControls(); drawAll(cur); } else render();
  });
}

async function loadSessions() {
  allSessions = await db.getAll('sessions');
  const totals = new Map();
  for (const s of allSessions) totals.set(s.domain, (totals.get(s.domain) || 0) + ((s.endedAt || Date.now()) - s.startedAt));
  siteRank = new Map([...totals.entries()].sort((a, b) => b[1] - a[1]).map(([d], i) => [d, i]));
  renderSiteList(totals);
}

function currentRange() {
  const earliest = allSessions.length ? Math.min(...allSessions.map((s) => s.startedAt)) : null;
  return I.rangeBounds(state.range, Date.now(), state.custom, earliest);
}

// Frames for the range, reduced to what the charts need. Cached per range; refreshes only fetch new ones.
async function loadFrames(start, end) {
  const light = (f) => ({ sid: f.sessionId, ts: f.ts, v: moodOf(f, 'valence'), f: moodOf(f, 'faceapi') });
  if (cache.start === start && cache.end === end) {
    if (cache.until < end) {
      const fresh = await db.framesInRange(cache.until, end);
      cache.frames.push(...fresh.map(light));
      if (fresh.length) cache.until = Math.max(...fresh.map((f) => f.ts)) + 1;
    }
    return cache.frames;
  }
  const raw = await db.framesInRange(start, end);
  Object.assign(cache, { start, end, frames: raw.map(light), until: raw.length ? Math.max(...raw.map((f) => f.ts)) + 1 : start });
  return cache.frames;
}

// ---------------- compute ----------------
async function render(quiet = false) {
  const main = $('#main');
  if (!quiet) main.classList.add('loading');
  try {
    syncControls();
    const range = currentRange();
    const lightFrames = await loadFrames(range.start, range.end);
    const filter = { excluded: new Set(state.excluded), days: state.days, tod: state.tod, minSessionMs };
    const sessions = I.filterSessions(allSessions, { ...range, ...filter });
    const len = range.end - range.start;
    const prevSessions = state.range === 'all' ? [] : I.filterSessions(allSessions, { start: range.start - len, end: range.start, ...filter });
    const sids = new Set(sessions.map((s) => s.id));
    const key = state.source === 'faceapi' ? 'f' : 'v';
    const frames = lightFrames.filter((f) => sids.has(f.sid)).map((f) => ({ sid: f.sid, ts: f.ts, mood: f[key] })).sort((a, b) => a.ts - b.ts);
    const framesBySid = new Map();
    for (const f of frames) { if (!framesBySid.has(f.sid)) framesBySid.set(f.sid, []); framesBySid.get(f.sid).push(f); }
    cur = { range, sessions, prevSessions, frames, framesBySid, unit: I.rangeDays(range) <= 2 ? 'hour' : 'day' };
    drawAll(cur);
  } catch (e) {
    console.error('[dhm] insights render failed', e);
  } finally {
    main.classList.remove('loading');
  }
}

function drawAll(d) {
  d.sittings = I.buildSittings(d.sessions, d.framesBySid, state.gapMin * 60000);
  d.doomMs = state.doomMin * 60000;
  renderTiles(d);
  renderTime(d);
  renderHeatmap(d);
  renderMoodTrend(d);
  renderMinutes(d);
  renderScatter(d);
  renderLongest(d);
  renderSiteTable(d);
}

function syncControls() {
  const act = (sel, attr, v) => document.querySelectorAll(`${sel} .tab`).forEach((t) => t.classList.toggle('active', t.dataset[attr] === v));
  act('#rangeTabs', 'range', state.range);
  act('#sourceTabs', 'source', state.source);
  act('#timeTabs', 'mode', state.timeMode);
  act('#heatTabs', 'metric', state.heat);
  act('#minuteTabs', 'mode', state.minute);
  $('#customRange').hidden = state.range !== 'custom';
  if (state.custom) { $('#fromDate').value = state.custom.from; $('#toDate').value = state.custom.to; }
  const r = currentRange();
  const days = I.rangeDays(r);
  $('#rangeLabel').textContent = days === 1 ? fmtDate(r.start, true) : `${fmtDate(r.start)} – ${fmtDate(r.end - 1)} · ${days} days`;
  const included = [...siteRank.keys()].filter((d) => !state.excluded.includes(d));
  $('#siteSummary').textContent = !state.excluded.length ? 'All sites' : included.length === 1 ? included[0] : `${included.length} of ${siteRank.size} sites`;
  document.querySelectorAll('#siteList input').forEach((cb) => { cb.checked = !state.excluded.includes(cb.value); });
}

function renderSiteList(totals) {
  const list = $('#siteList');
  list.replaceChildren();
  if (!siteRank.size) { list.innerHTML = '<div class="muted">No sessions yet.</div>'; return; }
  for (const d of siteRank.keys()) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = d; cb.checked = !state.excluded.includes(d);
    cb.addEventListener('change', () => { state.excluded = cb.checked ? state.excluded.filter((x) => x !== d) : [...state.excluded, d]; save(); render(); });
    const key = document.createElement('span'); key.className = 'key'; key.style.background = siteColor(d);
    const name = document.createElement('span'); name.textContent = d;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = fmtDuration(totals.get(d));
    lab.append(cb, key, name, n);
    list.appendChild(lab);
  }
}

// Colors follow the site's all-time rank, so filtering never repaints a site.
function siteColor(d) { const r = siteRank.get(d); return r != null && r < SLOTS ? `var(--c${r + 1})` : 'var(--cOther)'; }
const isOther = (d) => !(siteRank.get(d) < SLOTS);

// ---------------- tiles ----------------
function renderTiles(d) {
  const { sessions, prevSessions, frames, sittings, doomMs, range } = d;
  const total = sessions.reduce((a, s) => a + s.end - s.startedAt, 0);
  const prev = prevSessions.reduce((a, s) => a + s.end - s.startedAt, 0);
  const days = I.rangeDays(range);
  const doom = sittings.filter((s) => s.activeMs >= doomMs);
  const doomTotal = doom.reduce((a, s) => a + s.activeMs, 0);
  const longest = sittings.reduce((b, s) => (!b || s.activeMs > b.activeMs ? s : b), null);
  const faced = frames.filter((f) => f.mood != null);
  const avg = faced.length ? faced.reduce((a, f) => a + f.mood, 0) / faced.length : null;
  const driftSet = (doom.length ? doom : sittings).filter((s) => s.delta != null);
  const drift = driftSet.length ? driftSet.reduce((a, s) => a + s.delta * s.activeMs, 0) / driftSet.reduce((a, s) => a + s.activeMs, 0) : null;
  const driftCls = drift == null ? '' : drift > 0.1 ? 'up' : drift < -0.1 ? 'down' : '';
  const driftIcon = drift == null ? '' : drift > 0.1 ? '▲ ' : drift < -0.1 ? '▼ ' : '● ';
  let vsPrev = '';
  if (state.range !== 'all') {
    if (prev > 0) { const pct = Math.round(100 * (total - prev) / prev); vsPrev = `${pct >= 0 ? '+' : ''}${pct}% vs previous ${days === 1 ? 'day' : days + ' days'}`; }
    else vsPrev = `nothing in the previous ${days === 1 ? 'day' : days + ' days'}`;
  }
  const tile = (label, value, sub, cls = '') => `<div class="tile"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  $('#tiles').innerHTML = [
    tile('Time on tracked sites', fmtDuration(total), vsPrev || `${sessions.length} sessions`),
    tile('Per day', fmtDuration(total / days), `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${sittings.length} sitting${sittings.length === 1 ? '' : 's'}`),
    tile(`Doomscrolling (≥ ${state.doomMin} min)`, fmtDuration(doomTotal), `${doom.length} sitting${doom.length === 1 ? '' : 's'} · ${total ? Math.round(100 * doomTotal / total) : 0}% of time`),
    tile('Longest sitting', longest ? fmtDuration(longest.activeMs) : '—', longest ? `${esc(fmtDate(longest.start))} ${esc(fmtTime(longest.start))} · ${esc(longest.sites.map(([s]) => s).slice(0, 2).join(' + '))}` : 'no sittings', 'small'),
    tile('Average mood', moodText(avg), `${faced.length.toLocaleString()} frames with a face`),
    tile(doom.length ? 'Mood drift in doomscrolls' : 'Mood drift in sittings', `${driftIcon}${fmtMood(drift, true)}`, 'end vs. start, time-weighted', driftCls),
  ].join('');
}

// ---------------- time per bucket (stacked by site) ----------------
function renderTime(d) {
  const { sessions, range, unit } = d;
  const c = $('#timeChart');
  $('#timeTitle').textContent = unit === 'hour' ? 'Time on tracked sites by hour' : 'Time on tracked sites per day';
  const buckets = I.timeBuckets(sessions, range.start, range.end, unit);
  // stack order = color slot order; low-ranked sites fold into "Other"
  const present = [...new Set(sessions.map((s) => s.domain))];
  const named = present.filter((x) => !isOther(x)).sort((a, b) => siteRank.get(a) - siteRank.get(b));
  const hasOther = present.some(isOther);
  const series = [...named.map((x) => ({ key: x, label: x, color: siteColor(x) })), ...(hasOther ? [{ key: '__other', label: 'Other', color: 'var(--cOther)' }] : [])];
  const valueOf = (b, key) => key === '__other' ? Object.entries(b.bySite).filter(([x]) => isOther(x)).reduce((a, [, v]) => a + v, 0) : (b.bySite[key] || 0);
  const stacked = state.timeMode === 'stack';
  const legend = $('#timeLegend');
  legend.replaceChildren();
  if (stacked && series.length > 1) for (const s of series) legend.appendChild(legendItem(s.label, s.color));
  const peak = buckets.reduce((b, x) => (x.total > (b?.total || 0) ? x : b), null);
  $('#timeNote').textContent = peak ? `busiest ${unit === 'hour' ? 'hour' : 'day'}: ${fmtBucket(peak.t, unit, true)} · ${fmtDuration(peak.total)}` : '';

  const { svg, W, H, m, iw, ih } = frame(c, { l: 44, r: 8, t: 8, b: 24 });
  const max = Math.max(...buckets.map((b) => b.total), 0);
  if (!max) return emptyChart(c, svg, W, H, 'No time on tracked sites for these filters.');
  const { step, top } = durTicks(max);
  const y = (v) => m.t + ih * (1 - v / top);
  const g = el('g', { class: 'grid' });
  for (let v = step; v <= top + 1; v += step) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtTick(v))); }
  svg.appendChild(g);
  const n = buckets.length, slot = iw / n, bw = Math.max(1, slot - 2);
  const base = m.t + ih;
  xLabels(svg, buckets.map((b) => b.t), unit, (i) => m.l + slot * i + slot / 2, H - 6, slot);
  buckets.forEach((b, i) => {
    const x0 = m.l + slot * i + (slot - bw) / 2;
    if (b.total > 0) {
      const parts = stacked ? series.map((s) => ({ s, v: valueOf(b, s.key) })).filter((p) => p.v > 0) : [{ s: { color: 'var(--c1)' }, v: b.total }];
      let cum = 0;
      parts.forEach((p, k) => {
        const h = ih * p.v / top;
        const gap = cum > 0 && h > 3 ? 2 : 0;
        const yTop = base - cum - h, hh = Math.max(1, h - gap);
        const last = k === parts.length - 1;
        svg.appendChild(last ? el('path', { class: 'seg', d: roundTop(x0, yTop, bw, hh, Math.min(4, bw / 2, hh)), style: `fill:${p.s.color}` }) : el('rect', { class: 'seg', x: x0, y: yTop, width: bw, height: hh, style: `fill:${p.s.color}` }));
        cum += h;
      });
    }
    const hit = el('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ih, fill: 'transparent' });
    hit.addEventListener('mousemove', (ev) => {
      const rows = series.map((s) => [s, valueOf(b, s.key)]).filter(([, v]) => v > 0).sort((a, z) => z[1] - a[1]);
      showTooltip(ev, `<b>${fmtDuration(b.total)}</b> · ${esc(fmtBucket(b.t, unit, true))}${rows.map(([s, v]) => `<br>${lineKey(s.color)} <b>${fmtDuration(v)}</b> <span class="muted">${esc(s.label)}</span>`).join('')}`);
    });
    hit.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(hit);
  });
  svg.appendChild(el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: base, y2: base }));
  c.appendChild(svg);
}

// ---------------- weekday × hour heatmap ----------------
function renderHeatmap(d) {
  const { sessions, frames, range } = d;
  const c = $('#heatmap');
  c.replaceChildren();
  const grid = I.weekHourGrid(sessions, frames);
  const counts = I.weekdayCounts(range.start, range.end);
  const time = state.heat === 'time';
  const W = Math.max(300, c.clientWidth);
  const m = { l: 40, r: 64, t: time ? 46 : 18, b: 4 };
  const cw = (W - m.l - m.r) / 24, ch = 24, H = m.t + ch * 7 + m.b;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  const maxMs = Math.max(0, ...grid.flat().map((x) => x.ms));
  const moods = grid.flat().filter((x) => x.n >= 5).map((x) => x.sum / x.n);
  const L = Math.max(0.1, Math.ceil(Math.max(0, ...moods.map(Math.abs)) * 10) / 10);
  const colorOf = (cell) => {
    if (time) {
      if (!cell.ms) return 'var(--empty)';
      const q = Math.ceil(6 * cell.ms / maxMs); // 6 visible steps
      return `color-mix(in oklab, var(--seqHi) ${Math.round(8 + 92 * (q - 1) / 5)}%, var(--seqLo))`;
    }
    if (cell.n < 5) return 'var(--empty)';
    const v = cell.sum / cell.n, p = Math.round(100 * Math.min(1, Math.abs(v) / L));
    return `color-mix(in oklab, ${v >= 0 ? 'var(--pos)' : 'var(--neg)'} ${p}%, var(--mid))`;
  };
  // hour labels + (time mode) a marginal bar of total time per hour
  const hourTotals = Array.from({ length: 24 }, (_, h) => grid.reduce((a, row) => a + row[h].ms, 0));
  const maxHour = Math.max(1, ...hourTotals);
  for (let h = 0; h < 24; h++) {
    const x = m.l + h * cw;
    if (h % (cw < 14 ? 6 : 3) === 0) svg.appendChild(el('text', { x: x + 1, y: m.t - 5 }, hourLabel(h)));
    if (time && hourTotals[h]) {
      const bh = 20 * hourTotals[h] / maxHour;
      const bar = el('path', { class: 'colbar', d: roundTop(x + 1, m.t - 20 - bh, cw - 2, bh, Math.min(3, bh)) });
      bar.addEventListener('mousemove', (ev) => showTooltip(ev, `<b>${fmtDuration(hourTotals[h])}</b> · ${hourLabel(h)}–${hourLabel((h + 1) % 24)} <span class="muted">all days</span>`));
      bar.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(bar);
    }
  }
  grid.forEach((row, wd) => {
    const y = m.t + wd * ch;
    svg.appendChild(el('text', { x: m.l - 8, y: y + ch / 2 + 4, 'text-anchor': 'end' }, WEEKDAYS[wd]));
    row.forEach((cell, h) => {
      const r = el('rect', { class: 'cell', x: m.l + h * cw + 1, y: y + 1, width: Math.max(1, cw - 2), height: ch - 2, rx: 3, style: `fill:${colorOf(cell)}` });
      r.addEventListener('mousemove', (ev) => {
        const per = counts[wd] ? cell.ms / counts[wd] : 0;
        showTooltip(ev, `<b>${WEEKDAYS_LONG[wd]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)}</b><br>${cell.ms ? `<b>${fmtDuration(cell.ms)}</b> total · ${fmtDuration(per)} per ${WEEKDAYS_LONG[wd]} on average` : 'no time spent'}<br>${cell.n ? `mood <b>${fmtMood(cell.sum / cell.n, true)}</b> <span class="muted">${cell.n.toLocaleString()} frames</span>` : '<span class="muted">no mood frames</span>'}`);
      });
      r.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(r);
    });
    const rowMs = row.reduce((a, x) => a + x.ms, 0), rowN = row.reduce((a, x) => a + x.n, 0), rowSum = row.reduce((a, x) => a + x.sum, 0);
    svg.appendChild(el('text', { class: 'rowTotal', x: W - m.r + 8, y: y + ch / 2 + 4 }, time ? (rowMs ? fmtDuration(rowMs) : '') : (rowN ? fmtMood(rowSum / rowN, true) : '')));
  });
  c.appendChild(svg);
  const lg = $('#heatLegend');
  lg.innerHTML = time
    ? `<span>less</span><span class="ramp" style="background:linear-gradient(90deg, color-mix(in oklab, var(--seqHi) 8%, var(--seqLo)), var(--seqHi))"></span><span>more</span><span>· bars on top: total per hour · right: total per weekday</span>`
    : `<span>${fmtMood(-L, true)}</span><span class="ramp" style="background:linear-gradient(90deg, var(--neg), var(--mid), var(--pos))"></span><span>${fmtMood(L, true)}</span><span>· empty cells have fewer than 5 face frames · right: weekday average</span>`;
  const busiest = grid.flatMap((row, wd) => row.map((cell, h) => ({ wd, h, ms: cell.ms }))).sort((a, b) => b.ms - a.ms)[0];
  $('#heatNote').textContent = busiest?.ms ? `peak: ${WEEKDAYS_LONG[busiest.wd]}s around ${hourLabel(busiest.h)}` : '';
}

// ---------------- mood over time ----------------
function renderMoodTrend(d) {
  const { frames, range, unit } = d;
  const c = $('#moodChart');
  const win = unit === 'day' ? 7 : 3;
  const pts = I.moodBuckets(frames, range.start, range.end, unit, win);
  $('#moodTitle').textContent = unit === 'hour' ? 'Mood by hour' : 'Mood over time';
  const per = unit === 'day' ? 7 : 1;
  const sl = I.slope(pts.map((p, i) => ({ x: i, y: p.avg })));
  const trend = $('#moodTrend');
  if (sl == null) { trend.textContent = ''; trend.className = 'trendText'; }
  else {
    const v = sl * per, flat = Math.abs(v) < 0.02;
    trend.className = `trendText ${flat ? '' : v > 0 ? 'up' : 'down'}`;
    trend.textContent = `${flat ? '●' : v > 0 ? '▲' : '▼'} ${flat ? 'flat' : fmtMood(v, true)} per ${unit === 'day' ? 'week' : 'hour'}`;
  }
  $('#moodNote').textContent = `dots: ${unit === 'day' ? 'daily' : 'hourly'} average (faded = under ${LOW_N} frames) · line: ${win}-${unit} rolling mean`;

  const { svg, W, H, m, iw, ih } = frame(c, { l: 40, r: 10, t: 10, b: 24 });
  const vals = pts.filter((p) => p.avg != null);
  if (!vals.length) return emptyChart(c, svg, W, H, 'No frames with a face for these filters.');
  const L = Math.max(0.2, Math.min(1, Math.ceil(Math.max(...vals.map((p) => Math.abs(p.avg))) * 5) / 5));
  const n = pts.length, slot = iw / n;
  const x = (i) => m.l + slot * i + slot / 2;
  const y = (v) => m.t + ih * (1 - (v + L) / (2 * L));
  const g = el('g', { class: 'grid' });
  for (const v of [-L, -L / 2, L / 2, L]) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtMood(v, true))); }
  svg.appendChild(g);
  svg.appendChild(el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  svg.appendChild(el('text', { x: m.l - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0'));
  xLabels(svg, pts.map((p) => p.t), unit, x, H - 6, slot);
  // rolling mean, broken where there is no data in the window
  let path = '', open = false;
  pts.forEach((p, i) => { if (p.rolling == null) { open = false; return; } path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rolling).toFixed(1)} `; open = true; });
  if (path) svg.appendChild(el('path', { class: 'roll', d: path }));
  pts.forEach((p, i) => { if (p.avg != null) svg.appendChild(el('circle', { class: 'dot', cx: x(i), cy: y(p.avg), r: 4, style: `fill:${p.avg >= 0 ? 'var(--pos)' : 'var(--neg)'};opacity:${p.n < LOW_N ? 0.4 : 1}` })); });
  crosshair(svg, m, iw, ih, n, x, (i, ev) => {
    const p = pts[i];
    showTooltip(ev, `<b>${esc(fmtBucket(p.t, unit, true))}</b><br>${p.avg != null ? `<b>${fmtMood(p.avg, true)}</b> ${moodEmoji(p.avg)} average <span class="muted">${p.n.toLocaleString()} frames</span>` : '<span class="muted">no face frames</span>'}<br>${p.rolling != null ? `<b>${fmtMood(p.rolling, true)}</b> <span class="muted">${win}-${unit} rolling mean</span>` : ''}`);
  });
  c.appendChild(svg);
}

// ---------------- mood by minutes into a sitting ----------------
function renderMinutes(d) {
  const c = $('#minuteChart');
  const chg = state.minute === 'chg';
  const buckets = I.moodByMinute(d.sittings, 5, 60).map((b) => ({ ...b, v: chg ? b.chg : b.abs, n: chg ? b.chgN : b.absN }));
  const { svg, W, H, m, iw, ih } = frame(c, { l: 40, r: 8, t: 10, b: 34 });
  const vals = buckets.filter((b) => b.v != null);
  const note = $('#minuteNote');
  if (!vals.length) { note.textContent = ''; return emptyChart(c, svg, W, H, chg ? 'Needs sittings with at least 3 face frames in their first 5 minutes.' : 'No frames with a face for these filters.'); }
  const later = buckets.filter((b) => b.from >= 30 && b.v != null && b.n >= LOW_N);
  const laterAvg = later.length ? later.reduce((a, b) => a + b.v * b.n, 0) / later.reduce((a, b) => a + b.n, 0) : null;
  note.textContent = chg
    ? `Each sitting is compared with its own first 5 minutes, so a bar below zero means mood fell as the sitting went on.${laterAvg != null ? ` After 30 min: ${fmtMood(laterAvg, true)} on average.` : ''} Faded bars have under ${LOW_N} frames.`
    : `Average mood of all frames at that point of a sitting. Long sittings dominate later bars. Faded bars have under ${LOW_N} frames.`;
  const L = Math.max(0.1, Math.ceil(Math.max(...vals.map((b) => Math.abs(b.v))) * 10) / 10);
  const y = (v) => m.t + ih * (1 - (v + L) / (2 * L));
  const g = el('g', { class: 'grid' });
  for (const v of [-L, L]) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtMood(v, true))); }
  svg.appendChild(g);
  const slot = iw / buckets.length, bw = Math.max(2, Math.min(36, slot - 6));
  buckets.forEach((b, i) => {
    const cx = m.l + slot * i + slot / 2;
    svg.appendChild(el('text', { x: cx, y: H - 20, 'text-anchor': 'middle' }, b.to == null ? `${b.from}+` : String(b.from)));
    if (b.v != null) {
      const y0 = y(0), y1 = y(b.v), h = Math.abs(y1 - y0);
      const up = b.v >= 0;
      svg.appendChild(el('path', { class: 'bar', d: up ? roundTop(cx - bw / 2, y1, bw, Math.max(1, h), Math.min(4, h)) : roundBottom(cx - bw / 2, y0, bw, Math.max(1, h), Math.min(4, h)), style: `fill:${up ? 'var(--pos)' : 'var(--neg)'};opacity:${b.n < LOW_N ? 0.35 : 1}` }));
    }
    const hit = el('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ih, fill: 'transparent' });
    hit.addEventListener('mousemove', (ev) => showTooltip(ev, `<b>${b.to == null ? `${b.from}+` : `${b.from}–${b.to}`} min</b> into a sitting<br>${b.v == null ? '<span class="muted">no data</span>' : `<b>${fmtMood(b.v, true)}</b> ${chg ? 'vs. the first 5 minutes' : 'average mood'}<br><span class="muted">${b.n.toLocaleString()} frames${chg ? ` from ${b.chgSittings} sitting${b.chgSittings === 1 ? '' : 's'}` : ''}</span>`}`));
    hit.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(hit);
  });
  svg.appendChild(el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  svg.appendChild(el('text', { x: m.l - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0'));
  svg.appendChild(el('text', { x: m.l + iw / 2, y: H - 4, 'text-anchor': 'middle' }, 'minutes into sitting'));
  c.appendChild(svg);
}

// ---------------- sittings scatter ----------------
function renderScatter(d) {
  const c = $('#scatter');
  const pts = d.sittings.filter((s) => s.delta != null);
  const { svg, W, H, m, iw, ih } = frame(c, { l: 40, r: 12, t: 22, b: 36 });
  if (!pts.length) return emptyChart(c, svg, W, H, 'No sittings with mood data for these filters.');
  const maxX = Math.max(state.doomMin * 1.3, ...pts.map((s) => s.activeMs / 60000)) * 1.05;
  const L = Math.max(0.25, Math.min(2, Math.ceil(Math.max(...pts.map((s) => Math.abs(s.delta))) * 4) / 4));
  const x = (min) => m.l + iw * min / maxX;
  const y = (v) => m.t + ih * (1 - (v + L) / (2 * L));
  const g = el('g', { class: 'grid' });
  for (const v of [-L, L]) { g.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtMood(v, true))); }
  svg.appendChild(g);
  svg.appendChild(el('line', { class: 'zero', x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  svg.appendChild(el('text', { x: m.l - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0'));
  const step = [5, 10, 15, 30, 60, 120, 240].find((s) => maxX / s <= 6) || 480;
  for (let v = 0; v <= maxX; v += step) svg.appendChild(el('text', { x: x(v), y: H - 20, 'text-anchor': 'middle' }, v >= 60 && v % 60 === 0 ? `${v / 60}h` : `${v}m`));
  svg.appendChild(el('text', { x: m.l + iw / 2, y: H - 1, 'text-anchor': 'middle' }, 'sitting length · y: mood change, end vs. start'));
  svg.appendChild(el('line', { class: 'baseline', x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
  svg.appendChild(el('line', { class: 'thresh', x1: x(state.doomMin), x2: x(state.doomMin), y1: m.t, y2: m.t + ih }));
  svg.appendChild(el('text', { class: 'threshText', x: x(state.doomMin) + 4, y: m.t - 8 }, `doomscroll ≥ ${state.doomMin} min →`));
  for (const s of pts) {
    const doom = s.activeMs >= d.doomMs;
    const cx = x(s.activeMs / 60000), cy = y(s.delta);
    svg.appendChild(el('circle', { class: 'dot', cx, cy, r: 4.5, style: `fill:${doom ? 'var(--c2)' : 'var(--c1)'}` }));
    const hit = el('circle', { cx, cy, r: 12, fill: 'transparent', style: 'cursor:pointer' });
    hit.addEventListener('mousemove', (ev) => showTooltip(ev, sittingTip(s)));
    hit.addEventListener('mouseleave', hideTooltip);
    hit.addEventListener('click', () => openSitting(s));
    svg.appendChild(hit);
  }
  c.appendChild(svg);
}

function renderLongest(d) {
  const el0 = $('#longest');
  const top = [...d.sittings].sort((a, b) => b.activeMs - a.activeMs).slice(0, 8);
  if (!top.length) { el0.innerHTML = '<div class="empty">No sittings for these filters.</div>'; return; }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>When</th><th>Length</th><th>Sites</th><th>Mood</th><th>Change</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const s of top) {
    const tr = document.createElement('tr');
    const cls = s.delta == null ? 'flat' : s.delta > 0.1 ? 'up' : s.delta < -0.1 ? 'down' : 'flat';
    const icon = s.delta == null ? '·' : s.delta > 0.1 ? '▲' : s.delta < -0.1 ? '▼' : '●';
    tr.innerHTML = `<td>${esc(fmtDate(s.start))} ${esc(fmtTime(s.start))}</td><td>${fmtDuration(s.activeMs)}${s.activeMs >= d.doomMs ? ' <span class="pill">doom</span>' : ''}</td><td class="sites">${esc(s.sites.map(([x]) => x).join(' + '))}</td><td>${moodText(s.avg)}</td><td class="trend ${cls}">${icon} ${fmtMood(s.delta, true)}</td>`;
    tr.addEventListener('click', () => openSitting(s));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  el0.replaceChildren(table);
}

function sittingTip(s) {
  return `<b>${fmtDuration(s.activeMs)}</b> · ${esc(fmtDate(s.start))} ${esc(fmtTime(s.start))}–${esc(fmtTime(s.end))}<br>${esc(s.sites.map(([x, ms]) => `${x} ${fmtDuration(ms)}`).join(' · '))}<br>mood <b>${fmtMood(s.avg, true)}</b> · change <b>${fmtMood(s.delta, true)}</b> <span class="muted">${s.n} frames · click to open</span>`;
}
function openSitting(s) {
  location.href = `../dashboard/dashboard.html?day=${dayKey(new Date(s.start))}&session=${encodeURIComponent(s.members[0].id)}`;
}

// ---------------- per-site table ----------------
const SITE_COLS = [
  { key: 'domain', label: 'Site' },
  { key: 'ms', label: 'Time', num: true },
  { key: 'sessions', label: 'Sessions', num: true },
  { key: 'avgSession', label: 'Avg session', num: true },
  { key: 'longest', label: 'Longest', num: true },
  { key: 'doomMs', label: 'Doomscrolling', num: true },
  { key: 'mood', label: 'Avg mood', num: true },
  { key: 'drift', label: 'Drift in session', num: true },
];
function renderSiteTable(d) {
  const box = $('#siteTable');
  const rows = I.siteRows(d.sessions, d.framesBySid, d.sittings, d.doomMs);
  if (!rows.length) { box.innerHTML = '<div class="empty">No sessions for these filters.</div>'; return; }
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
  });
  const maxShare = Math.max(...rows.map((r) => r.share));
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const col of SITE_COLS) {
    const th = document.createElement('th');
    th.className = `sortable${col.num ? ' num' : ''}${col.key === key ? ' sorted' : ''}`;
    th.textContent = col.label + (col.key === key ? (dir < 0 ? ' ↓' : ' ↑') : '');
    th.addEventListener('click', () => { state.sort = { key: col.key, dir: col.key === key ? -dir : (col.key === 'domain' ? 1 : -1) }; save(); renderSiteTable(d); });
    head.appendChild(th);
  }
  const thead = document.createElement('thead'); thead.appendChild(head); table.appendChild(thead);
  const tb = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const cls = r.drift == null ? 'flat' : r.drift > 0.1 ? 'up' : r.drift < -0.1 ? 'down' : 'flat';
    const icon = r.drift == null ? '·' : r.drift > 0.1 ? '▲' : r.drift < -0.1 ? '▼' : '●';
    tr.innerHTML = `
      <td><span class="siteCell"><span class="key" style="background:${siteColor(r.domain)}"></span><span class="dom"></span></span></td>
      <td class="num"><span class="share" style="width:${(48 * r.share / maxShare).toFixed(1)}px"></span>${fmtDuration(r.ms)} <span class="muted">${Math.round(100 * r.share)}%</span></td>
      <td class="num">${r.sessions}</td>
      <td class="num">${fmtDuration(r.avgSession)}</td>
      <td class="num">${fmtDuration(r.longest)}</td>
      <td class="num">${r.doomMs ? fmtDuration(r.doomMs) : '—'}</td>
      <td class="num">${moodText(r.mood)}</td>
      <td class="num trend ${cls}">${icon} ${fmtMood(r.drift, true)}</td>`;
    tr.querySelector('.dom').textContent = r.domain;
    tr.title = `Show only ${r.domain}`;
    tr.addEventListener('click', () => { state.excluded = [...siteRank.keys()].filter((x) => x !== r.domain); save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  box.replaceChildren(table);
}

// ---------------- chart helpers ----------------
function frame(c, m) {
  c.replaceChildren();
  const W = Math.max(280, c.clientWidth), H = c.clientHeight || 240;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  return { svg, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b };
}
function emptyChart(c, svg, W, H, text) { svg.appendChild(el('text', { class: 'empty', x: W / 2, y: H / 2, 'text-anchor': 'middle' }, text)); c.appendChild(svg); }
// Vertical hairline that snaps to the nearest bucket.
function crosshair(svg, m, iw, ih, n, x, onHover) {
  const line = el('line', { class: 'hitline', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  const overlay = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(line); svg.appendChild(overlay);
  overlay.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const mx = (ev.clientX - r.left) * vb.width / r.width;
    const i = Math.max(0, Math.min(n - 1, Math.floor((mx - m.l) / (iw / n))));
    line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('visibility', 'visible');
    onHover(i, ev);
  });
  overlay.addEventListener('mouseleave', () => { line.setAttribute('visibility', 'hidden'); hideTooltip(); });
}
function xLabels(svg, ts, unit, xAt, yPos, slot) {
  const every = Math.max(1, Math.ceil(56 / slot));
  ts.forEach((t, i) => { if (i % every === 0) svg.appendChild(el('text', { x: xAt(i), y: yPos, 'text-anchor': 'middle' }, fmtBucket(t, unit, false))); });
}
function roundTop(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function roundBottom(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w - r} Q${x + w},${y + h} ${x + w},${y + h - r} V${y} Z`;
}
function durTicks(max, n = 4) {
  const steps = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, I.HOUR, 2 * I.HOUR, 3 * I.HOUR, 4 * I.HOUR, 6 * I.HOUR, 12 * I.HOUR];
  const step = steps.find((s) => max / s <= n) || 24 * I.HOUR;
  return { step, top: Math.ceil(max / step) * step };
}
function fmtTick(ms) { return ms >= I.HOUR ? `${+(ms / I.HOUR).toFixed(1)}h` : `${Math.round(ms / 60000)}m`; }
function hourLabel(h) { return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }).replace(':00', '').replace(/\s/g, '').toLowerCase(); }
function fmtDate(ts, weekday = false) { return new Date(ts).toLocaleDateString([], { ...(weekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' }); }
function fmtBucket(t, unit, long) {
  if (unit === 'hour') return long ? `${fmtDate(t, true)} ${hourLabel(new Date(t).getHours())}` : hourLabel(new Date(t).getHours());
  return long ? fmtDate(t, true) : fmtDate(t);
}
function legendItem(label, color) {
  const s = document.createElement('span');
  const k = document.createElement('span'); k.className = 'key'; k.style.background = color;
  s.append(k, document.createTextNode(label));
  return s;
}
const lineKey = (color) => `<span class="key line" style="background:${color}"></span>`;
function moodText(m) { return m == null ? '—' : `${moodEmoji(m)} ${fmtMood(m, true)}`; }
function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
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

init().catch((e) => { console.error('[dhm] insights init failed', e); document.body.insertAdjacentHTML('afterbegin', `<div class="banner">Insights failed to start: ${esc(e.message)}</div>`); });
