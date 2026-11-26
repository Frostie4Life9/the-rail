// Background removal for new pieces (cutout.js): pure-function checks in node, then a friend adding a piece from a
// library photo in Chromium with the real model, the "Keep background" choice, and "Remove background" on an old piece.
// The test photo is one of the owner's cut-outs laid on real carpet (patches from tiles/), so we know the true outline.
// Usage: node test/cutout.mjs <out-dir>
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [outDir = "/tmp/rail-cutout"] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
fs.mkdirSync(outDir, { recursive: true });
const RC = createRequire(import.meta.url)(path.join(root, "cutout.js"));
const check = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };

/* ---------- 1. pure functions */
{
  // a red "shirt" (with a sleeve) on noisy grey carpet; the "model" mask is the true shape, blurred and at 320px
  const W = 400, H = 480, data = new Uint8ClampedArray(W * H * 4), truth = new Uint8Array(W * H);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, inS = (x > 110 && x < 290 && y > 90 && y < 400) || (x > 60 && x < 340 && y > 90 && y < 170);
    truth[i] = inS ? 1 : 0;
    const c = inS ? [196, 40, 44] : [92 + rnd() * 18, 94 + rnd() * 18, 87 + rnd() * 18];
    data.set([...c, 255], i * 4);
  }
  const S = RC.S, m = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let s = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor((x + dx + .5) * W / S))), sy = Math.min(H - 1, Math.max(0, Math.floor((y + dy + .5) * H / S)));
      s += truth[sy * W + sx]; n++;
    }
    m[y * S + x] = s / n;
  }
  m[5 * S + 300] = 1; m[5 * S + 301] = 1;            // a speck out in the carpet: must go
  const img = { data, width: W, height: H };
  const r = RC.refine(img, m);
  check(r.ok, "refine: finds the piece");
  let I = 0, U = 0; for (let i = 0; i < W * H; i++) { const a = r.alpha[i] > .5; I += a && truth[i]; U += a || truth[i]; }
  check(I / U > 0.97, `refine: outline matches the true shape (IoU ${(I / U).toFixed(3)})`);
  check(r.alpha[5 * W + Math.floor(300 * W / S)] === 0 && r.alpha[3 * W + 3] === 0, "refine: carpet and specks are clear");
  const [bx, by, bw, bh] = r.box;
  check(bx < 60 && bx > 40 && by < 90 && by > 70 && bx + bw > 340 && bx + bw < 360, "crop hugs the piece with a little room");
  check(r.img.width === bw && r.img.height === bh && r.scale === 1, "small photos aren't scaled up");
  const mid = ((200 - by) * bw + (250 - bx)) * 4;
  check(r.img.data[mid + 3] === 255 && r.img.data[mid] > 180, "inside is solid and keeps its colour");
  const fc = RC.floorColour(img);
  check(fc[0] > 90 && fc[0] < 112 && Math.abs(fc[0] - fc[2]) < 15, "floor colour read from the border");
  check(!RC.refine(img, new Float32Array(S * S)).ok, "empty mask → not ok (keeps plain photo)");
  check(RC.refine(img, new Float32Array(S * S).fill(1)).why === "couldn't tell the piece from the floor", "whole-frame mask → not ok");
  const x = RC.prep(img);
  check(x.length === 3 * S * S && Math.abs(x[0] - (92 / 196 - .485) / .229) < 0.6, "prep: normalised 3x320x320 input");
}

/* ---------- 2. in the app, real model */
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Content-Length": fs.statSync(f).size });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const until = async (fn, ms = 60000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 150)); } return true; };

const files = new Map(); let n = 0;
const me = { name: "Jordan Lee", email: "jordan@example.com", owner: false, storage: "account" };
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
await ctx.addInitScript(m => { if (!localStorage.getItem("rail.cfg")) localStorage.setItem("rail.cfg", JSON.stringify({ mode: "account", session: "sess", me: m, owner: "", repo: "", token: "", branch: "main" })); }, me);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => m.type() === "error" && !/Failed to load resource|fonts\./.test(m.text()) && errors.push(m.text()));
await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ status: 200, body: "", contentType: "text/css" }));
await page.route("https://api.open-meteo.com/**", r => r.abort());
await page.route("https://rail-api.skyfro04.workers.dev/**", async route => {
  const req = route.request(), u = new URL(req.url()), json = (s, b) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
  if (u.pathname === "/me") return json(200, { token: "sess", me });
  if (u.pathname.startsWith("/files/")) {
    const p = decodeURIComponent(u.pathname.slice(7)), cur = files.get(p);
    if (req.method() === "GET") {
      if (!cur) return json(404, { error: "Not found" });
      if (p.startsWith("photos/")) return route.fulfill({ status: 200, contentType: p.endsWith(".jpg") ? "image/jpeg" : "image/png", body: Buffer.from(cur.b64, "base64") });
      return json(200, { content: cur.b64, sha: cur.sha });
    }
    const b = JSON.parse(req.postData());
    if (p.startsWith("photos/")) { if (cur) return json(422, { error: "already uploaded" }); files.set(p, { b64: b.content }); return json(200, { sha: "p" }); }
    if ((cur && b.sha !== cur.sha) || (!cur && b.sha)) return json(409, { error: "conflict" });
    files.set(p, { b64: b.content, sha: "s" + (++n) }); return json(200, { sha: "s" + n });
  }
  return json(404, { error: "?" });
});
const wardrobe = () => files.has("wardrobe.json") ? JSON.parse(Buffer.from(files.get("wardrobe.json").b64, "base64").toString()) : null;
await page.goto(base);
await page.waitForSelector(".setup");

// the test photo: the owner's striped rugby cut-out on real carpet, 1200px like a phone library shot
const comp = await page.evaluate(async () => {
  const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const [shirt, ...tiles] = await Promise.all(["cut/6047.webp", "tiles/6012.jpg", "tiles/6039.jpg", "tiles/6044.jpg", "tiles/6048.jpg"].map(load));
  const c = document.createElement("canvas"); c.width = 960; c.height = 1200; const g = c.getContext("2d");
  for (let y = 0; y < c.height; y += 36) for (let x = 0; x < c.width; x += 36) { const t = tiles[(x * 7 + y * 3) % tiles.length]; g.drawImage(t, (x % 3) * 4, (y % 3) * 4, 36, 36, x, y, 36, 36); }
  g.filter = "blur(1px)"; g.drawImage(c, 0, 0); g.filter = "none";
  const k = Math.min(800 / shirt.width, 1000 / shirt.height), w = shirt.width * k, h = shirt.height * k;
  g.drawImage(shirt, (960 - w) / 2, (1200 - h) / 2, w, h);
  const m = document.createElement("canvas"); m.width = 960; m.height = 1200; const mg = m.getContext("2d"); mg.drawImage(shirt, (960 - w) / 2, (1200 - h) / 2, w, h);
  const a = mg.getImageData(0, 0, 960, 1200).data, truth = []; let solid = 0;
  for (let i = 3; i < a.length; i += 4) solid += a[i] > 127;
  return { jpg: c.toDataURL("image/jpeg", .9).split(",")[1], solid, box: [(960 - w) / 2, (1200 - h) / 2, w, h] };
});
const photo = path.join(outDir, "rugby-on-carpet.jpg");
fs.writeFileSync(photo, Buffer.from(comp.jpg, "base64"));
await page.evaluate(j => { window.__testPhoto = "data:image/jpeg;base64," + j; }, comp.jpg);

// add it
await page.evaluate(() => addItemSheet()); await page.waitForSelector("#sheet.on #a-photo", { state: "attached" });
await page.setInputFiles("#a-photo", photo);
await page.waitForSelector(".cam [data-c=use]");
await page.click(".cam [data-c=use]");
check(await until(async () => await page.isVisible("text=Cutting out the background") || await page.isVisible(".photo-pick img.cut"), 15000), "shows progress while the cut-out runs");
const t0 = Date.now();
check(await until(() => page.isVisible(".photo-pick img.cut"), 90000), `cut-out preview appears (${((Date.now() - t0) / 1000).toFixed(1)}s incl. one-time load)`);
await page.screenshot({ path: path.join(outDir, "1-preview.png") });
check(await page.isVisible("[data-a=cut-off]"), "offers 'Keep background'");
// how good is it? compare the cut-out's alpha against the true outline, in the original photo's frame
const q = await page.evaluate(async ({ box }) => {
  const u = document.querySelector(".photo-pick img.cut").src, b = await (await fetch(u)).blob(), bmp = await createImageBitmap(b);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  return { type: b.type, w: bmp.width, h: bmp.height, corner: d[3], centre: d[((c.height >> 1) * c.width + (c.width >> 1)) * 4 + 3], opaque: [...d].filter((v, i) => i % 4 === 3 && v > 127).length };
}, comp);
check(/image\/(png|webp)/.test(q.type) && Math.max(q.w, q.h) <= 640, `cut-out is a ${q.type} no bigger than 640px (${q.w}x${q.h})`);
check(q.corner === 0 && q.centre === 255, "corners clear, middle solid");
// accuracy: run the same cut on the photo directly and compare its outline with the true shirt (IoU)
const iou = await page.evaluate(async () => {
  const load = src => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
  const ph = await load(window.__testPhoto), sh = await load("cut/6047.webp"), W = 720, H = 900;
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d", {willReadFrequently: true}); g.drawImage(ph, 0, 0, W, H);
  const r = await RailCut.cut(g.getImageData(0, 0, W, H));
  const m = document.createElement("canvas"); m.width = W; m.height = H; const mg = m.getContext("2d");
  const k = Math.min(800 / sh.width, 1000 / sh.height) * .75, w = sh.width * k, h = sh.height * k; mg.drawImage(sh, (W - w) / 2, (H - h) / 2, w, h);
  const t = mg.getImageData(0, 0, W, H).data; let I = 0, U = 0;
  for (let i = 0; i < W * H; i++) { const a = r.alpha[i] > .5, b = t[i * 4 + 3] > 127; I += a && b; U += a || b; }
  return I / U;
});
check(iou > 0.95, `cut-out outline matches the real shirt (IoU ${iou.toFixed(3)})`);

await page.fill("#a-name", "Striped rugby"); await page.fill("#a-colour", "red / black"); await page.selectOption("#a-type", "collared");
await page.click("[data-a=save]");
check(await until(() => { const w = wardrobe(); return w && w.items.length === 1 && [...files.keys()].filter(k => k.startsWith("photos/")).length === 2; }, 20000), "saved: item plus two photos uploaded");
const it = wardrobe().items[0];
check(/^photos\/items\/.*\.cut\.(png|webp)$/.test(it.photo) && /\.jpg$/.test(it.photo_full) && files.has(it.photo) && files.has(it.photo_full), "item shows the cut-out, keeps the original as photo_full");
await page.evaluate(() => { tab = "closet"; render(); }); await page.waitForTimeout(500);
check(await page.$eval(".tile .ph img", i => !i.classList.contains("raw")), "closet shows it as a cut-out (no photo box)");
await page.screenshot({ path: path.join(outDir, "2-closet.png") });
check(!(await page.evaluate(() => document.body.innerHTML.includes(">9001<"))), "no item code shown");

// 'Keep background' → plain photo only
await page.evaluate(() => addItemSheet()); await page.waitForSelector("#sheet.on #a-photo", { state: "attached" });
await page.setInputFiles("#a-photo", photo); await page.waitForSelector(".cam [data-c=use]"); await page.click(".cam [data-c=use]");
check(await until(() => page.isVisible(".photo-pick img.cut"), 30000), "second piece: cut-out is quick once loaded");
await page.click("[data-a=cut-off]");
check(!(await page.isVisible(".photo-pick img.cut")), "Keep background shows the plain photo");
await page.fill("#a-name", "Rugby, plain"); await page.fill("#a-colour", "red"); await page.click("[data-a=save]");
check(await until(() => wardrobe()?.items.length === 2, 20000), "saved the second piece");
const it2 = wardrobe().items[1];
check(/\.jpg$/.test(it2.photo) && !it2.photo_full, "kept-background piece is just the photo");

// Remove background later, from the piece sheet
await page.evaluate(c => itemSheet(c), it2.code); await page.waitForSelector("[data-i=recut]");
await page.click("[data-i=recut]");
check(await until(() => /\.cut\.(png|webp)$/.test(wardrobe()?.items[1].photo || ""), 30000), "Remove background cuts out an older piece");
check(wardrobe().items[1].photo_full === it2.photo, "…and keeps its original");
await page.waitForSelector("[data-i=uncut]");
await page.click("[data-i=uncut]");
check(await until(() => /\.jpg$/.test(wardrobe()?.items[1].photo || ""), 10000), "Use the original photo switches back");
await page.waitForSelector("[data-i=recut]"); await page.click("[data-i=recut]");
check(await until(() => /\.cut\./.test(wardrobe()?.items[1].photo || ""), 10000), "…and back to the cut-out without re-running");
await page.screenshot({ path: path.join(outDir, "3-piece.png") });

check(!errors.length, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close(); server.close();
