// Settings live in chrome.storage.local under the key "settings".
export const DEFAULT_DOMAINS = [
  'youtube.com', 'twitter.com', 'x.com', 'reddit.com', 'instagram.com',
  'tiktok.com', 'facebook.com', 'threads.net', 'linkedin.com', 'bsky.app',
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  trackedDomains: DEFAULT_DOMAINS,
  captureIntervalMs: 3000,   // one webcam frame every N ms while on a tracked site
  storeThumbnails: true,     // keep a small JPEG of each frame (lets you re-run other models later)
  thumbSize: 160,            // thumbnail width in px
  useHsemotion: true,        // run the HSEmotion (AffectNet, valence/arousal) model in addition to face-api
  moodSource: 'valence',     // 'valence' (HSEmotion) or 'faceapi' (weighted expression formula)
  signals: true,             // continuous MediaPipe face-landmark sampling (blinks, brow, gaze, head pose)
  captureScreen: true,       // also screenshot the visible tab at each frame
  screenWidth: 480,          // screenshot width in px (JPEG, ~25-40 KB each)
  graceMs: 30000,            // time away from a tracked site before the session is closed
  minSessionMs: 60000,       // shorter visits are discarded (frames deleted) when they end
  idleSeconds: 60,           // no input for this long -> treated as away
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

export function hostnameFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// Returns the tracked domain that matches this hostname (exact or subdomain), or null.
export function matchTracked(hostname, domains) {
  if (!hostname) return null;
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) continue;
    if (hostname === d || hostname.endsWith('.' + d)) return d;
  }
  return null;
}
