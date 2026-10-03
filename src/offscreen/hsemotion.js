// HSEmotion enet_b0_8_va_mtl (AffectNet, EfficientNet-B0) via ONNX Runtime Web.
// Input: 224x224 face crop, RGB, ImageNet-normalized, NCHW. Output: 8 emotion logits + valence + arousal.
import { HSE_CLASSES } from '../shared/mood.js';

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225], SIZE = 224;
let sessionPromise = null;
const crop = document.createElement('canvas'); crop.width = SIZE; crop.height = SIZE;
const cctx = crop.getContext('2d', { willReadFrequently: true });

export function hseLoad() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!window.ort) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = chrome.runtime.getURL('lib/ort/ort.min.js'); s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const t0 = performance.now();
      const session = await ort.InferenceSession.create(chrome.runtime.getURL('models/hsemotion/enet_b0_8_va_mtl.onnx'), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      // warm-up
      await session.run({ input: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) });
      return { session, loadMs: Math.round(performance.now() - t0), threads: ort.env.wasm.numThreads };
    })().catch((e) => { sessionPromise = null; throw e; });
  }
  return sessionPromise;
}

function softmax(x) { const m = Math.max(...x); const e = x.map((v) => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((v) => v / s); }

// source: canvas/video; box in source pixels. Expands the box by `margin` on each side and squares it.
export async function hsePredict(source, box, margin = 0.1) {
  const { session } = await hseLoad();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const side = Math.max(box.width, box.height) * (1 + 2 * margin);
  cctx.drawImage(source, cx - side / 2, cy - side / 2, side, side, 0, 0, SIZE, SIZE);
  const { data } = cctx.getImageData(0, 0, SIZE, SIZE);
  const n = SIZE * SIZE, arr = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    arr[i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
    arr[n + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    arr[2 * n + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const t0 = performance.now();
  const out = await session.run({ input: new ort.Tensor('float32', arr, [1, 3, SIZE, SIZE]) });
  const scores = Array.from(out[session.outputNames[0]].data);
  const probs = softmax(scores.slice(0, 8));
  const result = { probs: {}, valence: Math.max(-1, Math.min(1, scores[8])), arousal: Math.max(-1, Math.min(1, scores[9])), ms: Math.round(performance.now() - t0) };
  HSE_CLASSES.forEach((k, i) => { result.probs[k] = probs[i]; });
  let best = 0; for (let i = 1; i < 8; i++) if (probs[i] > probs[best]) best = i;
  result.dominant = HSE_CLASSES[best];
  return result;
}
