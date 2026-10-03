// Aggregation behind the Insights page.
import * as I from '../src/shared/insights.js';

let failures = 0;
const assert = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) failures++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const MIN = 60000;

const now = new Date(2026, 9, 3, 15, 30).getTime(); // Sat Oct 3 2026, 15:30 local
const day0 = I.startOfDay(now);

// ranges
const r7 = I.rangeBounds('7d', now);
assert(r7.end === I.addDays(day0, 1) && I.rangeDays(r7) === 7, '7d range ends tomorrow midnight, 7 days');
assert(I.rangeBounds('today', now).start === day0, 'today starts at midnight');
const rc = I.rangeBounds('custom', now, { from: '2026-10-02', to: '2026-09-28' });
assert(I.rangeDays(rc) === 5 && rc.start === new Date(2026, 8, 28).getTime(), 'custom range swaps reversed dates, inclusive');
assert(I.rangeBounds('all', now, null, new Date(2026, 0, 5, 9).getTime()).start === new Date(2026, 0, 5).getTime(), 'all starts at earliest day');

// sessions: Fri 21:50-22:20 youtube, gap 5 min, Fri 22:25-22:40 reddit, Sat 10:00-10:10 x.com, one too short
const fri = I.addDays(day0, -1);
const at = (base, h, m) => base + h * 3600e3 + m * MIN;
const sessions = [
  { id: 'a', domain: 'youtube.com', startedAt: at(fri, 21, 50), endedAt: at(fri, 22, 20) },
  { id: 'b', domain: 'reddit.com', startedAt: at(fri, 22, 25), endedAt: at(fri, 22, 40) },
  { id: 'c', domain: 'x.com', startedAt: at(day0, 10, 0), endedAt: at(day0, 10, 10) },
  { id: 'short', domain: 'x.com', startedAt: at(day0, 11, 0), endedAt: at(day0, 11, 0) + 20000 },
];
const all = I.filterSessions(sessions, { ...r7, minSessionMs: MIN, now });
assert(all.length === 3, 'min session length drops the short one');
assert(I.filterSessions(sessions, { ...r7, excluded: new Set(['x.com']), now }).length === 2, 'excluded sites');
assert(I.filterSessions(sessions, { ...r7, days: 'weekends', minSessionMs: MIN, now }).map((s) => s.id).join() === 'c', 'weekends only (Sat)');
assert(I.filterSessions(sessions, { ...r7, tod: 'evening', now }).map((s) => s.id).join() === 'a', 'evening = 17-22 by start hour');
assert(I.filterSessions(sessions, { ...r7, tod: 'night', now }).map((s) => s.id).join() === 'b', 'night wraps past midnight');

// time buckets split across the hour boundary
const hours = I.timeBuckets(all, fri, I.addDays(fri, 1), 'hour');
assert(hours.length === 24, '24 hour buckets');
assert(hours[21].bySite['youtube.com'] === 10 * MIN && hours[22].bySite['youtube.com'] === 20 * MIN, 'youtube split 10m/20m across 22:00');
assert(hours[22].total === 35 * MIN, '22:00 bucket total = 20m youtube + 15m reddit');
const days = I.timeBuckets(all, r7.start, r7.end, 'day');
assert(days.length === 7 && days[5].total === 45 * MIN && days[6].total === 10 * MIN, 'day buckets');

// frames: youtube happy at start then sad, reddit sad
const frames = [];
for (let t = at(fri, 21, 50); t < at(fri, 22, 20); t += 30000) frames.push({ sid: 'a', ts: t, mood: t < at(fri, 21, 55) ? 0.5 : 0.1 });
for (let t = at(fri, 22, 25); t < at(fri, 22, 40); t += 30000) frames.push({ sid: 'b', ts: t, mood: -0.3 });
frames.push({ sid: 'c', ts: at(day0, 10, 1), mood: null });
const bySid = new Map();
for (const f of frames) { if (!bySid.has(f.sid)) bySid.set(f.sid, []); bySid.get(f.sid).push(f); }

const grid = I.weekHourGrid(all, frames);
assert(grid[4][21].ms === 10 * MIN && grid[4][22].ms === 35 * MIN && grid[5][10].ms === 10 * MIN, 'week×hour grid time (Fri=4, Sat=5)');
assert(grid[4][21].n === 20 && near(grid[4][21].sum / grid[4][21].n, 0.3), 'grid mood average for Fri 21h');
assert(I.weekdayCounts(r7.start, r7.end).every((n) => n === 1), 'one of each weekday in 7 days');

// sittings: a+b merge with a 10 min gap limit, not with 2 min
const sit = I.buildSittings(all, bySid, 10 * MIN);
assert(sit.length === 2 && sit[0].members.length === 2, 'a and b merge into one sitting');
assert(sit[0].activeMs === 45 * MIN && sit[0].end - sit[0].start === 50 * MIN, 'active 45m within a 50m span');
assert(sit[0].sites[0][0] === 'youtube.com', 'sites sorted by time');
assert(sit[0].delta < 0, 'sitting mood declines');
assert(I.buildSittings(all, bySid, 2 * MIN).length === 3, 'no merge with a 2 min gap limit');

const mm = I.moodByMinute(sit, 5, 60);
assert(mm.length === 13 && mm[12].to === null, '12 five-minute buckets + 60+');
assert(near(mm[0].chg, 0) && near(mm[0].abs, 0.5), 'first bucket is the baseline');
assert(near(mm[2].chg, -0.4), '10-15 min: 0.1 - 0.5 = -0.4');
assert(near(mm[8].chg, -0.8) && mm[8].chgSittings === 1, '40-45 min: reddit -0.3 - 0.5 = -0.8');

const mb = I.moodBuckets(frames, fri, I.addDays(fri, 1), 'hour', 3);
assert(near(mb[21].avg, 0.3) && mb[20].avg == null && mb[23].avg == null, 'hourly mood buckets');
assert(mb[23].rolling != null, 'rolling mean carries over an empty bucket');

assert(near(I.slope([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]), 1), 'slope');
assert(I.slope([{ x: 0, y: 1 }, { x: 1, y: null }]) === null, 'slope needs 3 points');

const rows = I.siteRows(all, bySid, sit, 30 * MIN);
const yt = rows.find((r) => r.domain === 'youtube.com');
assert(yt.ms === 30 * MIN && yt.sessions === 1 && yt.doomMs === 30 * MIN, 'site row time and doomscroll share');
assert(rows.find((r) => r.domain === 'x.com').mood === null, 'no-face site has no mood');
assert(near(rows.reduce((a, r) => a + r.share, 0), 1), 'shares sum to 1');

console.log(failures ? `${failures} FAILED` : 'all insights tests passed');
process.exit(failures ? 1 : 0);
