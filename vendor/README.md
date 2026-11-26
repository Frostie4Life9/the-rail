# Vendored for the background cut-out (cutout.js)

Served from this site so the cut-out works with no paid API and no third-party CDN, and keeps working offline once cached.

- `ort/` — ONNX Runtime Web 1.31.1 (wasm-only build: `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}`).
  © Microsoft, MIT License. https://github.com/microsoft/onnxruntime
- `../models/u2netp.onnx` — U²-Net-p (small) salient-object model, 4.6 MB, sha256 309c8469…f4ddd8.
  © Xuebin Qin et al., Apache License 2.0. https://github.com/xuebinqin/U-2-Net

Why U²-Net-p: on the owner's cut-outs laid on real carpet (210 synthetic flat lays) it scored IoU 0.977 / 0.980 / 0.963
on carpet / wood / white sheet, about 1.3 s per photo on two desktop cores, against ISNet-q8 (44 MB, 7 s, 0.89 on carpet)
and RMBG-1.4 (44 MB, 6.4 s, 0.98, but a non-commercial licence). cutout.js's guided-filter edge refinement cuts its
edge error to ISNet/RMBG levels. To swap models later: add the file under models/ with a NEW name and change `MODEL`.
