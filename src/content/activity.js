// Counts scrolling, clicks and keystrokes on tracked sites and reports totals
// every 5 seconds. No content, URLs or key values are recorded, only counts.
(() => {
  if (window.__dhmActivity) return;
  window.__dhmActivity = true;

  let scrollPx = 0, clicks = 0, keys = 0;
  const lastTop = new WeakMap();

  const scrollTopOf = (t) => (t === document || t === window) ? (window.scrollY || document.documentElement.scrollTop || 0) : (t.scrollTop || 0);
  document.addEventListener('scroll', (e) => {
    const t = e.target === document ? document : e.target;
    const now = scrollTopOf(t);
    const prev = lastTop.get(t);
    if (prev != null) scrollPx += Math.abs(now - prev);
    lastTop.set(t, now);
  }, { capture: true, passive: true });
  document.addEventListener('click', () => { clicks++; }, { capture: true, passive: true });
  document.addEventListener('keydown', () => { keys++; }, { capture: true, passive: true });

  setInterval(() => {
    if (!scrollPx && !clicks && !keys) return;
    const payload = { target: 'background', type: 'activity', ts: Date.now(), scrollPx: Math.round(scrollPx), clicks, keys };
    scrollPx = 0; clicks = 0; keys = 0;
    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch { /* extension reloaded */ }
  }, 5000);
})();
