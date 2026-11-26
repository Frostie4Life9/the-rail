/* cutout.js — background removal for new closet photos, on the phone, free. No server, no paid API.

   A small open segmentation model (U²-Net-p, Apache-2.0, 4.6 MB, in models/) runs in the browser with ONNX Runtime
   Web (vendor/ort/, MIT). It looks at the photo at 320x320 and says, per pixel, how likely it is to be "the thing".
   That coarse mask is then refined here at the photo's own size:
     1. upsample, then a guided filter steered by the photo itself, so edges follow the real fabric edge
        instead of the 320px blur;
     2. firm the alpha up (soft only in a thin band at the edge) and drop specks: keep the largest piece plus anything
        at least 4% of its size (a pair of shoes, a sock pair);
     3. defringe: edge pixels are part floor, so we estimate the floor colour from the photo border and un-mix it
        out of them (otherwise grey carpet leaves a grey halo on a white tee);
     4. crop to the piece with a little room, cap the long side at 640px (the owner's cut-outs are ~560px).
   Everything except `run()` is a pure function on {data, width, height} (RGBA, like ImageData), so node tests run
   the same code. `RailCut.cut(imageData)` returns {img, ok, why, coverage}; `ok` is false when the result looks
   wrong (nothing found, or the "piece" is nearly the whole frame), and the app then keeps the plain photo. */
(function (root) {
  "use strict";
  const S = 320, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const MAX_SIDE = 640, PAD = 0.04;

  /* photo -> model input: stretch to SxS (that's how the model was trained), scale by the brightest value, normalise. */
  function prep(img) {
    const { width: W, height: H, data } = img, N = S * S, x = new Float32Array(3 * N);
    let mx = 1;
    for (let i = 0; i < data.length; i += 4) mx = Math.max(mx, data[i], data[i + 1], data[i + 2]);
    for (let y = 0; y < S; y++) {
      const sy = Math.min(H - 1, Math.floor((y + 0.5) * H / S));
      for (let xx = 0; xx < S; xx++) {
        const sx = Math.min(W - 1, Math.floor((xx + 0.5) * W / S)), i = (sy * W + sx) * 4, o = y * S + xx;
        for (let k = 0; k < 3; k++) x[k * N + o] = (data[i + k] / mx - MEAN[k]) / STD[k];
      }
    }
    return x;
  }

  /* raw model output (S*S floats) -> 0..1 mask, min-max normalised like the reference implementation. */
  function norm(out) {
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const m = new Float32Array(out.length), d = hi - lo || 1;
    for (let i = 0; i < out.length; i++) m[i] = (out[i] - lo) / d;
    return m;
  }

  /* bilinear upsample of an sw x sh float map to W x H */
  function upsample(m, sw, sh, W, H) {
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const fy = Math.max(0, (y + 0.5) * sh / H - 0.5), y0 = Math.min(sh - 1, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.max(0, (x + 0.5) * sw / W - 0.5), x0 = Math.min(sw - 1, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        o[y * W + x] = (m[y0 * sw + x0] * (1 - wx) + m[y0 * sw + x1] * wx) * (1 - wy) + (m[y1 * sw + x0] * (1 - wx) + m[y1 * sw + x1] * wx) * wy;
      }
    }
    return o;
  }

  /* box mean with radius r (summed-area table) */
  function box(a, W, H, r) {
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += a[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        o[y * W + x] = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      }
    }
    return o;
  }

  /* guided filter (He et al.): the mask p takes on the edges of guide image g (both 0..1, W x H) */
  function guided(g, p, W, H, r, eps) {
    const N = W * H, gp = new Float32Array(N), gg = new Float32Array(N);
    for (let i = 0; i < N; i++) { gp[i] = g[i] * p[i]; gg[i] = g[i] * g[i]; }
    const mg = box(g, W, H, r), mp = box(p, W, H, r), mgp = box(gp, W, H, r), mgg = box(gg, W, H, r);
    const a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = mgg[i] - mg[i] * mg[i]; a[i] = (mgp[i] - mg[i] * mp[i]) / (v + eps); b[i] = mp[i] - a[i] * mg[i]; }
    const ma = box(a, W, H, r), mb = box(b, W, H, r), q = new Float32Array(N);
    for (let i = 0; i < N; i++) q[i] = Math.min(1, Math.max(0, ma[i] * g[i] + mb[i]));
    return q;
  }

  /* keep the largest connected piece and anything at least `keep` of its size; returns a 0/1 keep-map */
  function pieces(alpha, W, H, keep = 0.04) {
    const lab = new Int32Array(W * H), sizes = [0], st = [];
    for (let s = 0; s < W * H; s++) {
      if (alpha[s] < 0.5 || lab[s]) continue;
      const id = sizes.length; let n = 0; lab[s] = id; st.push(s);
      while (st.length) {
        const i = st.pop(); n++; const x = i % W, y = (i - x) / W;
        if (x > 0 && !lab[i - 1] && alpha[i - 1] >= 0.5) { lab[i - 1] = id; st.push(i - 1); }
        if (x < W - 1 && !lab[i + 1] && alpha[i + 1] >= 0.5) { lab[i + 1] = id; st.push(i + 1); }
        if (y > 0 && !lab[i - W] && alpha[i - W] >= 0.5) { lab[i - W] = id; st.push(i - W); }
        if (y < H - 1 && !lab[i + W] && alpha[i + W] >= 0.5) { lab[i + W] = id; st.push(i + W); }
      }
      sizes.push(n);
    }
    const big = Math.max(0, ...sizes), ok = sizes.map(n => n >= big * keep && n > 0);
    return { lab, ok, big };
  }

  /* median colour of the outer 3% border: our best guess at the floor */
  function floorColour(img) {
    const { width: W, height: H, data } = img, b = Math.max(2, Math.round(Math.min(W, H) * 0.03)), C = [[], [], []];
    const step = Math.max(1, Math.floor((W + H) / 400));
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      if (x >= b && x < W - b && y >= b && y < H - b) continue;
      const i = (y * W + x) * 4; C[0].push(data[i]); C[1].push(data[i + 1]); C[2].push(data[i + 2]);
    }
    return C.map(a => { a.sort((p, q) => p - q); return a[a.length >> 1] || 0; });
  }

  /* model mask (S*S, 0..1) + the photo -> refined cut-out */
  function refine(img, m) {
    const { width: W, height: H, data } = img, N = W * H;
    const up = upsample(m, S, S, W, H), g = new Float32Array(N);
    for (let i = 0; i < N; i++) g[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
    const r = Math.max(2, Math.round(Math.max(W, H) / 120));
    let a = guided(g, up, W, H, r, 1e-3);
    // firm up: fully solid inside, fully clear outside, soft only across the edge
    for (let i = 0; i < N; i++) { const v = (a[i] - 0.25) / 0.5; a[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v); }
    const P = pieces(a, W, H);
    // soft edge pixels belong to whichever solid piece they touch; specks and their halos go
    const own = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (P.lab[i]) own[i] = P.ok[P.lab[i]] ? 1 : 2;
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < N; i++) {
      if (own[i] || a[i] <= 0) continue;
      const x = i % W, nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W].filter(j => j >= 0 && j < N && own[j]);
      if (nb.length) own[i] = own[nb[0]];
    }
    let cov = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < N; i++) {
      if (own[i] !== 1) a[i] = 0;
      if (a[i] > 0.5) { cov++; const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const coverage = cov / N;
    if (!cov || coverage < 0.03) return { ok: false, why: "nothing found", coverage };
    const edgeTouch = (x0 <= 1) + (y0 <= 1) + (x1 >= W - 2) + (y1 >= H - 2);
    if (coverage > 0.92 || edgeTouch >= 4) return { ok: false, why: "couldn't tell the piece from the floor", coverage };
    // defringe: C = a*F + (1-a)*B  =>  F = (C - (1-a)*B) / a, for the soft edge band only
    const B = floorColour(img), out = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      const al = a[i], j = i * 4;
      for (let k = 0; k < 3; k++) {
        const c = data[j + k];
        out[j + k] = al > 0.02 && al < 0.98 ? Math.max(0, Math.min(255, (c - (1 - al) * B[k]) / Math.max(al, 0.35))) : c;
      }
      out[j + 3] = Math.round(al * 255);
    }
    // crop with a little room, cap the size
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * PAD);
    const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad), cx1 = Math.min(W - 1, x1 + pad), cy1 = Math.min(H - 1, y1 + pad);
    const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1, crop = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) crop.set(out.subarray(((cy0 + y) * W + cx0) * 4, ((cy0 + y) * W + cx0 + cw) * 4), y * cw * 4);
    return { ok: true, img: { data: crop, width: cw, height: ch }, alpha: a, box: [cx0, cy0, cw, ch], coverage, scale: Math.min(1, MAX_SIDE / Math.max(cw, ch)) };
  }

  /* ---- browser: load the model once, run it ---- */
  let session = null, loading = null;
  const base = () => (root.document && document.baseURI) || "./";
  async function load(onProgress) {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      const ort = await import(new URL("vendor/ort/ort.wasm.min.mjs", base()).href);
      ort.env.wasm.wasmPaths = new URL("vendor/ort/", base()).href;
      ort.env.wasm.numThreads = 1;                   // GitHub Pages can't send the headers threads need
      const res = await fetch(new URL(`models/${MODEL}`, base()).href);
      if (!res.ok) throw new Error("model " + res.status);
      const total = +res.headers.get("content-length") || MODEL_BYTES, reader = res.body.getReader(), parts = [];
      let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress && onProgress(Math.min(1, got / total)); }
      const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
      session = { ort, s: await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] }) };
      return session;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function run(img, onProgress) {
    const { ort, s } = await load(onProgress);
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", prep(img), [1, 3, S, S]) });
    return norm(out[s.outputNames[0]].data);
  }
  async function cut(img, onProgress) { return refine(img, await run(img, onProgress)); }

  const MODEL = "u2netp.onnx", MODEL_BYTES = 4574861;
  const api = { S, prep, norm, upsample, guided, pieces, floorColour, refine, load, run, cut, MODEL, MODEL_BYTES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RailCut = api;
})(typeof self !== "undefined" ? self : this);
