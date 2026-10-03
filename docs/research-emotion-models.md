# Emotion models and mental-state signals: research notes (2026-09-12)

All candidates had to run fully locally in a Chrome extension (offscreen document), on the
webcam frame every few seconds, without sending anything anywhere.

## Benchmark

Harness: `test/` style headless Chrome on this Mac (Apple M3 Max, Chrome 152), 261 labeled faces
sampled from the public `muxspace/facial_expressions` set (40 per class, 21 for fear). Every model
scored the same 224 px face crop. Accuracy is 7-class (contempt dropped), warm median latency.

| Model | What it is | 7-class acc. | WASM 1 thread | WASM 8 threads | Extra outputs |
|---|---|---|---|---|---|
| face-api expression net (current) | tiny CNN, FER-2013 lineage, tfjs WebGL | 49.8 % | 7 ms (WebGL) | — | 7 classes |
| HSEmotion `mbf_va_mtl` | MobileFaceNet 112 px, AffectNet | 50.2 % | 23 ms | 4 ms | 8 classes + valence + arousal |
| **HSEmotion `enet_b0_8_va_mtl`** | EfficientNet-B0 224 px, AffectNet | **51.0 %** | 40 ms | 8 ms | 8 classes + **valence + arousal** |
| HSEmotion `enet_b0_8_best_afew` | EfficientNet-B0, AffectNet + AFEW | 46.4 % | 40 ms | 8 ms | 8 classes |
| HSEmotion `enet_b2_8` | EfficientNet-B2 260 px | 43.7 % | 87 ms | 15 ms | 8 classes |
| MediaPipe Face Landmarker | 478 landmarks + 52 blendshapes + head pose | n/a | 15 ms (GPU) | — | blink, brow, gaze, pose |

Per-class (7-class accuracy, %):

| | anger | disgust | fear | happiness | neutral | sadness | surprise |
|---|---|---|---|---|---|---|---|
| face-api | 65 | 3 | 14 | 95 | 63 | 40 | 53 |
| enet_b0_8_va_mtl | 68 | 8 | 67 | 98 | 25 | 60 | 40 |

Mean valence / arousal from `enet_b0_8_va_mtl` per labeled class, which is the number the mood
line actually uses:

| class | valence | arousal |
|---|---|---|
| happiness | +0.69 | +0.17 |
| neutral | −0.25 | +0.23 |
| surprise | −0.23 | +0.69 |
| fear | −0.29 | +0.45 |
| disgust | −0.31 | +0.09 |
| anger | −0.46 | +0.86 |
| sadness | −0.54 | −0.02 |

Caveats: this test set is small, crowd-labeled and noisy (its "neutral" images are celebrity
photos with slight smiles), so absolute accuracies are low for every model and the ranking is not
statistically strong. Published AffectNet numbers (the models' own benchmark) are 61.9 % 8-class /
64.9 % 7-class for `enet_b0_8_va_mtl` versus roughly mid-50s for FER-2013-era models like face-api's.
Inside the extension the B0 model runs with 4 WASM threads (the manifest enables cross-origin
isolation) at about 14 ms per frame after a 0.4-1 s load.

Decision: ship `enet_b0_8_va_mtl` alongside face-api. face-api keeps providing the face box and
its 7 probabilities (cheap, and keeps old data comparable); HSEmotion adds 8 probabilities plus
valence and arousal. The mood line defaults to **valence**, which is a continuous, model-native
"how positive" estimate instead of a hand-weighted sum of class probabilities. The dashboard can
switch between the two sources for any session, old or new.

Not chosen: transformers.js ViT emotion classifiers (hundreds of MB, seconds per frame on WASM,
no valence head) and WebGPU execution (ONNX Runtime's WebGPU build needs another 27 MB of WASM and
the threaded WASM path is already under 15 ms).

## Signals beyond the emotion label

What the literature says is measurable from a webcam and relates to mental state
(sources at the end):

- **Blink rate**: drops when absorbed or cognitively loaded, rises with fatigue, stress and
  anxiety. Typical resting 15-20/min; deep engagement can halve it. Needs sampling at ≥10 fps
  because a blink lasts 100-400 ms, so it is computed continuously, not from the 3 s frames.
- **Brow furrow (AU4, `browDown`)** and **lip press (AU24, `mouthPress`)**: concentration, tension,
  negative affect. iMotions and the workload studies use these as the primary "load/stress" AUs.
- **Eye aspect ratio / PERCLOS and blink duration**: fatigue. Available from the same landmarks;
  not yet aggregated.
- **Gaze and head pose**: looking away, eyes down (phone in hand while a video plays), head
  turned. A "looking away" share per interval is a cheap attention proxy.
- **Arousal**: HSEmotion's arousal head. Doomscrolling tends to be low-valence *and* low-arousal
  (flat, numb) which a valence-only score would miss.
- **Face size / distance**: leaning in (bigger face) is a crude engagement or agitation marker.
- **Face presence**: share of frames with a face; absence often means phone or walked away.
- **Behavioral**: scroll velocity and burstiness, clicks, keystrokes (already recorded), session
  length, time of day, and what was on screen (screenshots and page titles are stored, so per-video
  or per-subreddit breakdowns are possible).
- **Heart rate via rPPG** from skin colour changes: possible in principle from a webcam, but
  fragile under screen-light changes and would need 30 fps capture; deferred.

Implemented now (per capture interval, from MediaPipe blendshapes sampled at 10 fps on the GPU):
blink rate, brow furrow, lip press, looking-away share, eye-look-down, jaw open, eye squint, smile,
head yaw/pitch/roll, face presence; plus arousal from HSEmotion and face size from the detector box.
They are shown as small multiples under the mood chart and stored on each frame under `signals`.

Suggested next steps, in order of expected value:
1. Collect a week of data, then look at which signals actually move within your sessions
   (correlate blink rate and brow furrow with the valence trend).
2. Add PERCLOS / blink duration for a fatigue score.
3. Personal baselines: z-score every signal against your own median so "high" means high for you.
4. A composite "state" per session (e.g. absorbed / tense / flat / cheerful) from valence,
   arousal, blink rate and brow furrow, once step 1 shows they separate.

Sources:
- [HSEmotion ONNX models and README](https://github.com/av-savchenko/hsemotion-onnx)
- [HSEmotion: High-speed emotion recognition library (Savchenko)](https://www.researchgate.net/publication/364625072_HSEmotion_High-speed_emotion_recognition_library)
- [EmotiEffLib, the successor library](https://github.com/sb-ai-lab/EmotiEffLib)
- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)
- [Facial expression analysis guide (iMotions): AUs, valence, engagement, blink metrics](https://imotions.com/blog/learning/product-guides/facial-expression-analysis-in-imotions/)
- [Computational analysis of stress, depression and engagement: a survey (arXiv 2403.08824)](https://arxiv.org/pdf/2403.08824)
- [Real-time mental fatigue detection using webcam-based eye analysis](https://www.researchsquare.com/article/rs-8036038/v1)
- [Facial movement dynamics reveal workload during multitasking (arXiv 2603.17767)](https://arxiv.org/pdf/2603.17767)
- [Video-based stress detection through deep learning (PMC7582689)](https://ncbi.nlm.nih.gov/pmc/articles/PMC7582689)
