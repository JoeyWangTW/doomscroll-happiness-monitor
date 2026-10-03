// Pure aggregation for the Insights page: time ranges, filters, time-per-bucket, the weekday×hour grid,
// "sittings" (sessions merged across short gaps), mood by minutes into a sitting, and per-site rows.
// No DOM and no IndexedDB here so it can be unit tested in node.
//
// Inputs:
//   sessions  { id, domain, startedAt, endedAt|null }
//   frames    light frames { sid, ts, mood|null }   (mood already resolved for the chosen source)

export const HOUR = 3600e3, DAY = 24 * HOUR;

export function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
export function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
function nextHour(ts) { const d = new Date(ts); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d.getTime(); }
function nextDay(ts) { return addDays(startOfDay(ts), 1); }
// Monday = 0 … Sunday = 6
export const weekdayIndex = (ts) => (new Date(ts).getDay() + 6) % 7;

// Range presets. `custom` is { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } (both inclusive).
export function rangeBounds(key, now = Date.now(), custom = null, earliest = null) {
  const end = addDays(startOfDay(now), 1);
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[key];
  if (days) return { start: addDays(end, -days), end };
  if (key === 'all') return { start: startOfDay(earliest ?? now), end };
  if (key === 'custom' && custom?.from && custom?.to) {
    const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
    const a = parse(custom.from), b = parse(custom.to);
    return { start: Math.min(a, b), end: addDays(Math.max(a, b), 1) };
  }
  return { start: addDays(end, -7), end };
}
export const rangeDays = ({ start, end }) => Math.max(1, Math.round((end - start) / DAY));

export const TIME_OF_DAY = {
  all: null,
  morning: [5, 12], afternoon: [12, 17], evening: [17, 22], night: [22, 5],
};
function inTimeOfDay(ts, tod) {
  const r = TIME_OF_DAY[tod];
  if (!r) return true;
  const h = new Date(ts).getHours();
  return r[0] < r[1] ? h >= r[0] && h < r[1] : h >= r[0] || h < r[1];
}

// sessions filtered by range (start time), excluded sites, weekday/weekend and time of day (start hour).
export function filterSessions(sessions, { start, end, excluded = new Set(), days = 'all', tod = 'all', minSessionMs = 0, now = Date.now() }) {
  return sessions.filter((s) => {
    if (s.startedAt < start || s.startedAt >= end) return false;
    if (excluded.has(s.domain)) return false;
    if (s.endedAt && s.endedAt - s.startedAt < minSessionMs) return false;
    const wd = weekdayIndex(s.startedAt);
    if (days === 'weekdays' && wd > 4) return false;
    if (days === 'weekends' && wd < 5) return false;
    return inTimeOfDay(s.startedAt, tod);
  }).map((s) => ({ ...s, end: s.endedAt || now }));
}

// Calls fn(from, to) for each piece of [s, e) cut at hour (or day) boundaries.
export function splitSpan(s, e, unit, fn) {
  const step = unit === 'day' ? nextDay : nextHour;
  for (let t = s; t < e;) { const n = Math.min(step(t), e); fn(t, n); t = n; }
}

// Time per hour or day bucket, split by site. Returns [{ t, total, bySite: {domain: ms} }].
export function timeBuckets(sessions, start, end, unit) {
  const buckets = [];
  const index = new Map();
  for (let t = start; t < end; t = unit === 'day' ? addDays(t, 1) : nextHour(t)) { const b = { t, total: 0, bySite: {} }; buckets.push(b); index.set(t, b); }
  const keyOf = unit === 'day' ? startOfDay : (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };
  for (const s of sessions) {
    splitSpan(Math.max(s.startedAt, start), Math.min(s.end, end), unit, (a, b) => {
      const bk = index.get(keyOf(a));
      if (!bk) return;
      bk.total += b - a;
      bk.bySite[s.domain] = (bk.bySite[s.domain] || 0) + (b - a);
    });
  }
  return buckets;
}

// 7×24 grid (Mon-first) of time spent and mood per weekday/hour.
export function weekHourGrid(sessions, frames) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ ms: 0, sum: 0, n: 0 })));
  for (const s of sessions) splitSpan(s.startedAt, s.end, 'hour', (a, b) => { grid[weekdayIndex(a)][new Date(a).getHours()].ms += b - a; });
  for (const f of frames) if (f.mood != null) { const c = grid[weekdayIndex(f.ts)][new Date(f.ts).getHours()]; c.sum += f.mood; c.n++; }
  return grid;
}

// How many of each weekday fall in [start, end), for "average per Monday" style numbers.
export function weekdayCounts(start, end) {
  const out = new Array(7).fill(0);
  for (let t = start; t < end; t = addDays(t, 1)) out[weekdayIndex(t)]++;
  return out;
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

// First-third vs last-third mood change (same definition as the per-session trend on the dashboard).
export function moodStats(frames) {
  const pts = frames.filter((f) => f.mood != null);
  const n = pts.length;
  if (!n) return { n: 0, avg: null, delta: null };
  const moods = pts.map((f) => f.mood);
  const third = Math.max(1, Math.floor(n / 3));
  return { n, avg: mean(moods), delta: n >= 2 ? mean(moods.slice(n - third)) - mean(moods.slice(0, third)) : null };
}

// Merge sessions whose gap is <= gapMs into sittings. framesBySid: Map sid -> frames sorted by ts.
export function buildSittings(sessions, framesBySid, gapMs) {
  const asc = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const out = [];
  let cur = null;
  for (const s of asc) {
    if (cur && s.startedAt - cur.end <= gapMs) { cur.members.push(s); cur.end = Math.max(cur.end, s.end); }
    else { cur = { members: [s], start: s.startedAt, end: s.end }; out.push(cur); }
  }
  return out.map((g) => {
    const bySite = new Map();
    for (const m of g.members) bySite.set(m.domain, (bySite.get(m.domain) || 0) + (m.end - m.startedAt));
    const frames = g.members.flatMap((m) => framesBySid.get(m.id) || []).sort((a, b) => a.ts - b.ts);
    const activeMs = g.members.reduce((a, m) => a + (m.end - m.startedAt), 0);
    return { ...g, activeMs, sites: [...bySite.entries()].sort((a, b) => b[1] - a[1]), frames, ...moodStats(frames) };
  });
}

// Mood by minutes into a sitting, in bucketMin-wide buckets up to maxMin (last bucket is maxMin+).
// `abs` is plain average mood; `chg` is mood minus that sitting's own average over its first bucket,
// so long and short sittings are compared against their own starting point.
export function moodByMinute(sittings, bucketMin = 5, maxMin = 60) {
  const nb = Math.floor(maxMin / bucketMin) + 1;
  const buckets = Array.from({ length: nb }, (_, i) => ({ from: i * bucketMin, to: i === nb - 1 ? null : (i + 1) * bucketMin, abs: { sum: 0, n: 0 }, chg: { sum: 0, n: 0, sittings: new Set() } }));
  sittings.forEach((st, si) => {
    const pts = st.frames.filter((f) => f.mood != null);
    if (!pts.length) return;
    const idx = (f) => Math.min(nb - 1, Math.floor((f.ts - st.start) / 60000 / bucketMin));
    const base = pts.filter((f) => idx(f) === 0);
    const baseline = base.length >= 3 ? mean(base.map((f) => f.mood)) : null;
    for (const f of pts) {
      const b = buckets[idx(f)];
      b.abs.sum += f.mood; b.abs.n++;
      if (baseline != null) { b.chg.sum += f.mood - baseline; b.chg.n++; b.chg.sittings.add(si); }
    }
  });
  return buckets.map((b) => ({
    from: b.from, to: b.to,
    abs: b.abs.n ? b.abs.sum / b.abs.n : null, absN: b.abs.n,
    chg: b.chg.n ? b.chg.sum / b.chg.n : null, chgN: b.chg.n, chgSittings: b.chg.sittings.size,
  }));
}

// Average mood per bucket (hour or day) plus a trailing rolling mean over `win` buckets.
export function moodBuckets(frames, start, end, unit, win = 7) {
  const out = [];
  const index = new Map();
  for (let t = start; t < end; t = unit === 'day' ? addDays(t, 1) : nextHour(t)) { const b = { t, sum: 0, n: 0 }; out.push(b); index.set(t, b); }
  const keyOf = unit === 'day' ? startOfDay : (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };
  for (const f of frames) { if (f.mood == null) continue; const b = index.get(keyOf(f.ts)); if (b) { b.sum += f.mood; b.n++; } }
  return out.map((b, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - win + 1); j <= i; j++) { s += out[j].sum; n += out[j].n; }
    return { t: b.t, avg: b.n ? b.sum / b.n : null, n: b.n, rolling: n ? s / n : null };
  });
}

// Least-squares slope of y over x for [{x, y}], or null with fewer than 3 points.
export function slope(points) {
  const p = points.filter((q) => q.y != null);
  if (p.length < 3) return null;
  const mx = mean(p.map((q) => q.x)), my = mean(p.map((q) => q.y));
  let num = 0, den = 0;
  for (const q of p) { num += (q.x - mx) * (q.y - my); den += (q.x - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

// Per-site summary rows.
export function siteRows(sessions, framesBySid, sittings, doomMs) {
  const rows = new Map();
  const row = (d) => { if (!rows.has(d)) rows.set(d, { domain: d, ms: 0, sessions: 0, moodSum: 0, moodN: 0, deltas: [], doomMs: 0, longest: 0 }); return rows.get(d); };
  for (const s of sessions) {
    const r = row(s.domain), dur = s.end - s.startedAt;
    r.ms += dur; r.sessions++; r.longest = Math.max(r.longest, dur);
    const st = moodStats(framesBySid.get(s.id) || []);
    if (st.n) { r.moodSum += st.avg * st.n; r.moodN += st.n; }
    if (st.delta != null) r.deltas.push(st.delta);
  }
  for (const st of sittings) if (st.activeMs >= doomMs) for (const [d, ms] of st.sites) row(d).doomMs += ms;
  const total = [...rows.values()].reduce((a, r) => a + r.ms, 0) || 1;
  return [...rows.values()].map((r) => ({
    domain: r.domain, ms: r.ms, share: r.ms / total, sessions: r.sessions, avgSession: r.ms / r.sessions, longest: r.longest,
    mood: r.moodN ? r.moodSum / r.moodN : null, moodN: r.moodN, drift: mean(r.deltas), doomMs: r.doomMs,
  }));
}
