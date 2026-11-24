// Unit tests for photo.js colour correction. Builds synthetic flat lays under coloured light and checks the fix.
// Run: node test/photo.mjs
import { createRequire } from "node:module";
const P = createRequire(import.meta.url)("../photo.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL", m); } };

// A 300x400 "photo": grey floor, a garment in the middle, white paper in the paper box, all under a light cast.
function scene({ cast = [1, 1, 1], paper = true, garment = [70, 110, 90], floor = [120, 120, 118], noise = 0 }) {
  const W = 300, H = 400, data = new Uint8ClampedArray(W * H * 4), F = P.FRAME;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H; let c = floor;
    if (u > 0.3 && u < 0.7 && v > 0.2 && v < 0.65) c = garment;
    if (paper && u > F.paper.x - 0.02 && v > F.paper.y - 0.02) c = [245, 245, 245];
    const i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) data[i + k] = c[k] * cast[k] + noise * rnd();
    data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}
const at = (img, u, v) => { const i = (Math.floor(v * img.height) * img.width + Math.floor(u * img.width)) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const ratio = c => Math.max(...c) / Math.min(...c);

// 1. Warm indoor light (tungsten-ish): paper reads orange. Fix should bring the garment back to its true colour.
const truth = [70, 110, 90];
let img = scene({ cast: [1.0, 0.86, 0.66], noise: 6 });
let r = P.correct(img, P.FRAME.paper);
ok(r.how === "paper", "warm light: paper found");
const paperAfter = at(r.img, 0.82, 0.9);
ok(ratio(paperAfter) < 1.03, `warm light: paper comes out neutral ${paperAfter}`);
const g = at(r.img, 0.5, 0.4), scaled = truth.map((v, i) => v * P.TARGET[i] / 245);
ok(near(g, scaled, 8), `warm light: garment back to true colour ${g} vs ${scaled.map(Math.round)}`);

// 2. Cool shade (bluish) and dim
img = scene({ cast: [0.62, 0.7, 0.82], noise: 4 });
r = P.correct(img, P.FRAME.paper);
ok(r.how === "paper" && ratio(at(r.img, 0.82, 0.9)) < 1.03, "cool dim light: corrected from paper");
ok(near(at(r.img, 0.5, 0.4), scaled, 9), "cool dim light: garment back to true colour");

// 3. No paper in the box: falls back gently and says so
img = scene({ cast: [1.0, 0.86, 0.66], paper: false });
r = P.correct(img, P.FRAME.paper);
ok(r.how === "auto" && r.why, `no paper: falls back (${r.why})`);
ok(r.gains.every(k => k > 0.75 && k < 1.4), "no paper: fallback stays gentle");

// 4. Something coloured in the box (a red sock) is not treated as paper
img = scene({});
for (let y = 340; y < 400; y++) for (let x = 205; x < 300; x++) { const i = (y * 300 + x) * 4; img.data[i] = 200; img.data[i + 1] = 40; img.data[i + 2] = 40; }
r = P.correct(img, P.FRAME.paper);
ok(r.how === "auto" && r.why === "too coloured", "red thing in the box is not paper");

// 5. Highlights roll off instead of clipping
img = scene({ cast: [1, 1, 1], garment: [235, 235, 235] });
r = P.correct(img, P.FRAME.paper);
const hi = at(r.img, 0.5, 0.4);
ok(hi.every(v => v < 255 && v > 225), `white tee keeps detail, no clipping ${hi}`);

// 6. Very dark paper patch can't blow the picture out
img = scene({ cast: [0.33, 0.3, 0.27] });
r = P.correct(img, P.FRAME.paper);
ok(Math.max(...r.gains) <= 2.4 + 1e-9, "gain capped in the dark");

// 7. Tap-to-fix rect stays inside a square-ish area
const t = P.tapRect(0.5, 0.5, { width: 300, height: 400 });
ok(t.w > 0 && t.h > 0 && Math.abs(t.w * 300 - t.h * 400) < 1, "tap rect is square on screen");

console.log(`photo: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
