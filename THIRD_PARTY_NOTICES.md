# Third-party notices

This repository's own code is MIT licensed (see `LICENSE`). It also bundles the following third-party libraries and model weights, which keep their own licenses.

| Component | Files | Version | License | Source |
|---|---|---|---|---|
| @vladmandic/face-api (bundles TensorFlow.js) | `lib/face-api.js` | 1.7.15 | MIT, see `lib/LICENSE-face-api` | https://github.com/vladmandic/face-api |
| face-api tiny face detector + expression weights | `models/tiny_face_detector_model*`, `models/face_expression_model*` | from face-api 1.7.15 | MIT, see `lib/LICENSE-face-api` | https://github.com/vladmandic/face-api |
| ONNX Runtime Web | `lib/ort/` | 1.29.0 | MIT, see `lib/LICENSE-onnxruntime` | https://github.com/microsoft/onnxruntime |
| MediaPipe Tasks Vision | `lib/mediapipe/` | 1.0.1 | Apache-2.0, see `lib/LICENSE-apache-2.0.txt` | https://github.com/google-ai-edge/mediapipe |
| MediaPipe Face Landmarker model | `models/face_landmarker.task` | — | Apache-2.0, see `lib/LICENSE-apache-2.0.txt` | https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker |
| HSEmotion `enet_b0_8_va_mtl` | `models/hsemotion/enet_b0_8_va_mtl.onnx` | — | Apache-2.0, see `lib/LICENSE-apache-2.0.txt` | https://github.com/av-savchenko/hsemotion-onnx |

## Note on the HSEmotion weights

The HSEmotion model is trained on the [AffectNet](http://mohammadmahoor.com/affectnet/) dataset, whose terms restrict use to non-commercial research. The weights themselves are published under Apache-2.0, but if you plan any commercial use, review AffectNet's terms first.
