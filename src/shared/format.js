export function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60 ? (s % 60) + 's' : ''}`.trim();
}
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtTimeSec(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
export function fmtMood(m, signed = false) {
  if (m == null || Number.isNaN(m)) return '—';
  const s = m.toFixed(2);
  return signed && m > 0 ? '+' + s : s;
}
export function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function dayBounds(key) {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
  return { start, end };
}
export function fmtDay(key) {
  const { start } = dayBounds(key);
  const today = dayKey();
  if (key === today) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === dayKey(y)) return 'Yesterday';
  return new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
