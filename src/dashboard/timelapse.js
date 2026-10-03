// Renders a session's stored frames into a video, entirely in the page (canvas + MediaRecorder).
// mode: 'face' (webcam thumbnails), 'screen' (page screenshots) or 'both' (side by side).
import { smooth, moodEmoji } from '../shared/mood.js';
import { fmtTimeSec, fmtMood } from '../shared/format.js';

const BAR_H = 48;
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];

export function pickMime() {
  return MIME_CANDIDATES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

async function dims(blob) {
  const bmp = await createImageBitmap(blob);
  const d = { w: bmp.width, h: bmp.height };
  bmp.close();
  return d;
}

export async function renderTimelapse({ frames, session, mode = 'both', fps = 10, onProgress, signal }) {
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video (MediaRecorder unsupported).');
  const usable = frames
    .filter((f) => (mode === 'face' ? f.thumb : mode === 'screen' ? f.screen : (f.thumb || f.screen)))
    .sort((a, b) => a.ts - b.ts);
  if (!usable.length) throw new Error(`No stored ${mode === 'face' ? 'webcam thumbnails' : mode === 'screen' ? 'screenshots' : 'images'} in this session.`);

  // Layout from the first available images.
  const faceSample = usable.find((f) => f.thumb)?.thumb;
  const screenSample = usable.find((f) => f.screen)?.screen;
  const fd = faceSample ? await dims(faceSample) : { w: 4, h: 3 };
  const sd = screenSample ? await dims(screenSample) : { w: 16, h: 10 };
  let W, H, faceBox = null, screenBox = null;
  if (mode === 'face') {
    W = even(Math.max(480, fd.w)); H = even(W * fd.h / fd.w);
    faceBox = { x: 0, y: 0, w: W, h: H };
  } else if (mode === 'screen') {
    W = even(Math.max(480, sd.w)); H = even(W * sd.h / sd.w);
    screenBox = { x: 0, y: 0, w: W, h: H };
  } else {
    H = even(Math.max(360, sd.h));
    const sw = even(sd.w * H / sd.h), fw = even(fd.w * H / fd.h);
    W = sw + 4 + fw;
    screenBox = { x: 0, y: 0, w: sw, h: H };
    faceBox = { x: sw + 4, y: 0, w: fw, h: H };
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H + BAR_H;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Mood sparkline for the bottom bar (all frames with a face, whole session).
  const moodPts = frames.filter((f) => f.faceFound && typeof f.mood === 'number').sort((a, b) => a.ts - b.ts);
  const moodSmooth = smooth(moodPts.map((p) => p.mood), 5);
  const t0 = session.startedAt, t1 = Math.max(session.endedAt || usable[usable.length - 1].ts, t0 + 1000);
  const tx = (ts) => (W * (ts - t0)) / (t1 - t0);

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(1000);
  const frameMs = 1000 / fps;

  try {
    let last = 0;
    for (let i = 0; i < usable.length; i++) {
      if (signal?.aborted) break;
      const f = usable[i];
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H + BAR_H);
      if (screenBox) await drawInto(ctx, f.screen, screenBox, 'no screenshot');
      if (faceBox) await drawInto(ctx, f.thumb, faceBox, 'no webcam frame');
      drawBar(ctx, f, i, usable.length);
      track.requestFrame();
      onProgress?.(i + 1, usable.length);
      const wait = frameMs - (performance.now() - last);
      await sleep(Math.max(1, wait));
      last = performance.now();
    }
    // Hold the last frame briefly so encoders flush it.
    track.requestFrame();
    await sleep(Math.max(frameMs, 150));
  } finally {
    rec.stop();
    await stopped;
    track.stop();
    canvas.remove();
  }
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), mime, frames: usable.length, width: W, height: H + BAR_H };

  async function drawInto(ctx, blob, box, placeholder) {
    if (!blob) {
      ctx.fillStyle = '#222'; ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = '#888'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(placeholder, box.x + box.w / 2, box.y + box.h / 2);
      return;
    }
    const bmp = await createImageBitmap(blob);
    // contain, top-aligned for screenshots
    const s = Math.min(box.w / bmp.width, box.h / bmp.height);
    const w = bmp.width * s, h = bmp.height * s;
    ctx.fillStyle = '#000'; ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.drawImage(bmp, box.x + (box.w - w) / 2, box.y, w, h);
    bmp.close();
  }

  function drawBar(ctx, f, i, n) {
    const y0 = H;
    ctx.fillStyle = '#1a1a19'; ctx.fillRect(0, y0, W, BAR_H);
    // sparkline
    if (moodPts.length > 1) {
      const sy = (m) => y0 + BAR_H - 4 - ((m + 1) / 2) * (BAR_H - 8);
      ctx.strokeStyle = '#3a3a38'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, sy(0)); ctx.lineTo(W, sy(0)); ctx.stroke();
      ctx.strokeStyle = '#3987e5'; ctx.lineWidth = 2; ctx.beginPath();
      moodPts.forEach((p, k) => { const x = tx(p.ts), y = sy(moodSmooth[k]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      // progress marker
      ctx.fillStyle = '#e66767'; ctx.fillRect(tx(f.ts) - 1, y0, 2, BAR_H);
    }
    // text
    ctx.font = '600 15px system-ui, -apple-system, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const moodTxt = f.faceFound ? `${moodEmoji(f.mood)} ${fmtMood(f.mood, true)} ${f.dominant || ''}` : '🫥 no face';
    const label = `${session.domain}  ·  ${fmtTimeSec(f.ts)}  ·  ${moodTxt}`;
    ctx.fillStyle = '#fff'; ctx.fillText(label, 10, y0 + BAR_H / 2);
    ctx.textAlign = 'right'; ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#c3c2b7';
    ctx.fillText(`${i + 1}/${n}`, W - 10, y0 + BAR_H / 2);
  }
}
