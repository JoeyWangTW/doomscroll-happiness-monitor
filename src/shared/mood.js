// Turns the 7 face-api expression probabilities into a single valence score
// in [-1, 1] and derives per-session statistics.
export const EXPRESSIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

// Weights are deliberately simple and explainable. Tune here, everything else follows.
const WEIGHTS = { happy: 1, surprised: 0.3, neutral: 0, sad: -1, angry: -1, disgusted: -1, fearful: -0.7 };

export function computeMood(e) {
  if (!e) return null;
  let v = 0;
  for (const k of EXPRESSIONS) v += (e[k] || 0) * WEIGHTS[k];
  return Math.max(-1, Math.min(1, v));
}

// HSEmotion (AffectNet) classes, in the model's output order.
export const HSE_CLASSES = ['anger', 'contempt', 'disgust', 'fear', 'happiness', 'neutral', 'sadness', 'surprise'];

// Mood for a stored frame under a given source. 'valence' uses the HSEmotion valence head when
// present and falls back to the face-api formula; 'faceapi' always uses the formula.
export function moodOf(frame, source = 'valence') {
  if (!frame?.faceFound) return null;
  if (source === 'valence' && typeof frame.hse?.valence === 'number') return Math.max(-1, Math.min(1, frame.hse.valence));
  return computeMood(frame.expressions);
}
export function withMoodSource(frames, source) {
  return frames.map((f) => ({ ...f, mood: moodOf(f, source) }));
}

export function dominantExpression(e) {
  if (!e) return null;
  let best = null, bestV = -1;
  for (const k of EXPRESSIONS) if ((e[k] || 0) > bestV) { bestV = e[k] || 0; best = k; }
  return best;
}

export function moodEmoji(m) {
  if (m == null || Number.isNaN(m)) return '·';
  if (m > 0.35) return '😊';
  if (m > 0.1) return '🙂';
  if (m > -0.1) return '😐';
  if (m > -0.35) return '🙁';
  return '😞';
}

export function trendLabel(delta) {
  if (delta == null) return 'no data';
  if (delta > 0.1) return 'improving';
  if (delta < -0.1) return 'declining';
  return 'flat';
}

// Rolling mean over a window of k frames (odd numbers look best).
export function smooth(values, k = 5) {
  const half = Math.floor(k / 2);
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) { sum += values[j]; n++; }
    return sum / n;
  });
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

export function sessionStats(frames) {
  const total = frames.length;
  const withFace = frames.filter((f) => f.faceFound && typeof f.mood === 'number').sort((a, b) => a.ts - b.ts);
  const n = withFace.length;
  if (n === 0) return { total, n: 0, avg: null, first: null, last: null, delta: null, slopePerMin: null, label: 'no data', expressionAvg: null };

  const moods = withFace.map((f) => f.mood);
  const avg = mean(moods);
  const third = Math.max(1, Math.floor(n / 3));
  const first = mean(moods.slice(0, third));
  const last = mean(moods.slice(n - third));
  const delta = n >= 2 ? last - first : null;

  // Least-squares slope of mood vs. time, in mood units per minute.
  let slopePerMin = null;
  if (n >= 3) {
    const t0 = withFace[0].ts;
    const xs = withFace.map((f) => (f.ts - t0) / 60000);
    const mx = mean(xs), my = avg;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (moods[i] - my); den += (xs[i] - mx) ** 2; }
    slopePerMin = den > 0 ? num / den : 0;
  }

  const expressionAvg = {};
  for (const k of EXPRESSIONS) expressionAvg[k] = mean(withFace.map((f) => f.expressions?.[k] || 0));

  return { total, n, avg, first, last, delta, slopePerMin, label: trendLabel(delta), expressionAvg };
}
