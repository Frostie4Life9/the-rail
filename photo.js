/* photo.js — colour correction and framing for new closet photos. Pure functions on {data, width, height}
   (RGBA, like ImageData), so they run the same in the browser and in node tests.

   How the colour fix works: every camera shot has its own white balance (the phone decides per photo), so one
   reference photo can't fix a batch. Instead each shot carries its own reference — a corner of plain white paper in
   the box marked on the viewfinder. We read that patch, and scale R, G and B so the paper comes out neutral and
   bright, then roll highlights off softly so nothing clips. If there's no usable paper (too dark, too coloured, or
   not even), we fall back to a gentle gray-world nudge (±8%) and say the colour is approximate. The person can
   also tap anything white in the photo to use that as the reference instead.

   Paper caveat: bright office paper has optical brighteners and reads slightly blue under daylight, so it can
   push colours a touch warm. Small; the target below is a hair warm of pure white to offset it. */
(function (root) {
  "use strict";
  const TARGET = [241, 240, 237];          // what "white paper" should land on (slightly warm; offsets brighteners)
  const MAX_GAIN = 2.4, KNEE = 222;

  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /* Median colour of a rectangle {x, y, w, h} in 0-1 coordinates (inset by `inset` on each side), plus how even it is. */
  function sample(img, rect, inset = 0.15) {
    const { width: W, height: H, data } = img;
    const x0 = Math.max(0, Math.floor((rect.x + rect.w * inset) * W)), x1 = Math.min(W, Math.ceil((rect.x + rect.w * (1 - inset)) * W));
    const y0 = Math.max(0, Math.floor((rect.y + rect.h * inset) * H)), y1 = Math.min(H, Math.ceil((rect.y + rect.h * (1 - inset)) * H));
    const n = Math.max(1, (x1 - x0) * (y1 - y0)), step = Math.max(1, Math.floor(Math.sqrt(n / 20000)));
    const R = [], G = [], B = [], L = [];
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4; R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); L.push(luma(data[i], data[i + 1], data[i + 2]));
    }
    if (!L.length) return null;
    const med = a => { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    const mean = L.reduce((a, b) => a + b, 0) / L.length;
    const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) * (b - mean), 0) / L.length);
    return { rgb: [med(R), med(G), med(B)], luma: med(L), cv: mean ? sd / mean : 1, n: L.length };
  }

  /* Is this patch plausibly white paper under some coloured light? */
  /* `scene` is the median brightness of the whole shot: paper has to stand out from the floor it's lying on
     (or be properly bright, e.g. paper on a white sheet), so a grey carpet in the box isn't mistaken for it. */
  function paperLike(s, scene) {
    if (!s) return { ok: false, why: "nothing there" };
    const [r, g, b] = s.rgb, hi = Math.max(r, g, b), lo = Math.max(1, Math.min(r, g, b));
    if (s.luma < 70) return { ok: false, why: "too dark" };
    if (hi / lo > 1.75) return { ok: false, why: "too coloured" };
    if (scene != null && s.luma < scene * 1.25 && s.luma < 170) return { ok: false, why: "no paper" };
    if (s.cv > 0.16) return { ok: false, why: "not even" };
    return { ok: true };
  }

  /* Per-channel gains that turn `ref` into TARGET, capped so a shadowy patch can't blow the photo out. */
  function gainsFrom(ref) {
    let g = ref.map((v, i) => TARGET[i] / Math.max(1, v));
    const top = Math.max(...g);
    if (top > MAX_GAIN) g = g.map(v => v * MAX_GAIN / top);
    return g;
  }
  /* Gentle fallback: nudge the whole picture's average toward neutral (±8%) and its brightness toward mid (±25%). */
  function grayWorldGains(img) {
    const { data } = img; let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 16) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    r /= n; g /= n; b /= n;
    const L = luma(r, g, b) || 1, clamp = (v, a, z) => Math.min(z, Math.max(a, v));
    const exp = clamp(128 / L, 0.85, 1.25);
    return [r, g, b].map(c => clamp(L / Math.max(1, c), 0.92, 1.08) * exp);
  }

  /* Apply gains with a soft shoulder above KNEE so highlights roll off instead of clipping. Returns a new image. */
  function applyGains(img, g) {
    const out = new Uint8ClampedArray(img.data.length), d = img.data, span = 255 - KNEE;
    const lut = g.map(k => { const t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) { const x = v * k; t[v] = x <= KNEE ? x : KNEE + span * (1 - Math.exp(-(x - KNEE) / span)); } return t; });
    for (let i = 0; i < d.length; i += 4) { out[i] = lut[0][d[i]]; out[i + 1] = lut[1][d[i + 1]]; out[i + 2] = lut[2][d[i + 2]]; out[i + 3] = d[i + 3]; }
    return { data: out, width: img.width, height: img.height };
  }

  /* The whole fix. `ref` is where the white reference is ({x,y,w,h} in 0-1), or null for the fallback.
     Returns {img, how: 'paper' | 'auto', why?, gains}. */
  function correct(img, ref) {
    if (ref) {
      const s = sample(img, ref), whole = sample(img, { x: 0, y: 0, w: 1, h: 1 }, 0), p = paperLike(s, whole && whole.luma);
      if (p.ok) { const gains = gainsFrom(s.rgb); return { img: applyGains(img, gains), how: "paper", gains }; }
      const gains = grayWorldGains(img);
      return { img: applyGains(img, gains), how: "auto", why: p.why, gains };
    }
    const gains = grayWorldGains(img);
    return { img: applyGains(img, gains), how: "auto", gains };
  }

  /* A small square around a tapped point (0-1 coords), for "tap something white". */
  const tapRect = (x, y, img) => { const r = 0.03, ar = img.width / img.height; return { x: x - r, y: y - r * ar, w: 2 * r, h: 2 * r * ar }; };

  /* Viewfinder geometry, in 0-1 of a 3:4 portrait frame: where the garment goes and where the paper goes. */
  const FRAME = { aspect: 3 / 4, garment: { x: 0.06, y: 0.05, w: 0.88, h: 0.76 }, paper: { x: 0.7, y: 0.82, w: 0.24, h: 0.15 } };

  const api = { sample, paperLike, gainsFrom, grayWorldGains, applyGains, correct, tapRect, FRAME, TARGET };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.RailPhoto = api;
})(typeof self !== "undefined" ? self : this);
