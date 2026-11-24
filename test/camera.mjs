// Add-a-piece camera, end to end with Chromium's fake camera playing a synthetic flat lay under warm light
// (tee true colour 60,110,150; white paper in the paper box). Checks the outline, the paper colour fix, the crop,
// tap-to-fix on a library photo, and that the piece + photo are saved.
// Usage: node test/camera.mjs <seed-data-dir> <out-dir> <flatlay.y4m> <library.jpg>
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [seedDir, outDir, y4m, libJpg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;   // localhost counts as a secure origin, so the camera is allowed

const repo = new Map(); let shaN = 0;
const put = (p, buf) => repo.set(p, { buf, sha: "s" + (++shaN) });
for (const f of ["wardrobe.json", "fit-log.json", "laundry.json"]) put(f, fs.readFileSync(path.join(seedDir, f)));

let fail = 0;
const check = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } else console.log("ok:", m); };

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block", permissions: ["camera"] });
await ctx.addInitScript(() => { if (!localStorage.getItem("rail.cfg")) localStorage.setItem("rail.cfg", JSON.stringify({ owner: "Frostie4Life9", repo: "the-rail-data", branch: "main", token: "t" })); });
await ctx.route("https://api.github.com/**", async r => {
  const q = r.request(), p = decodeURIComponent(new URL(q.url()).pathname.split("/contents/")[1] || "");
  const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (q.method() === "GET") {
    const f = repo.get(p); if (!f) return r.fulfill({ status: 404, headers: H, body: '{"message":"Not Found"}' });
    if ((q.headers()["accept"] || "").includes("raw")) return r.fulfill({ status: 200, headers: { "content-type": "image/jpeg", "access-control-allow-origin": "*" }, body: f.buf });
    return r.fulfill({ status: 200, headers: H, body: JSON.stringify({ content: f.buf.toString("base64"), sha: f.sha }) });
  }
  const b = JSON.parse(q.postData()), cur = repo.get(p);
  if (cur && b.sha !== cur.sha) return r.fulfill({ status: 409, headers: H, body: "{}" });
  put(p, Buffer.from(b.content, "base64"));
  return r.fulfill({ status: 200, headers: H, body: JSON.stringify({ content: { sha: repo.get(p).sha } }) });
});
await ctx.route("**/fonts.googleapis.com/**", r => r.abort());
await ctx.route("https://api.open-meteo.com/**", r => r.abort());
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(String(e)));
await page.goto(base);
await page.waitForFunction(() => typeof S !== "undefined" && S.wardrobe);

const truth = [60, 110, 150];
const px = (sel, u, v) => page.evaluate(([sel, u, v]) => { const c = document.querySelector(sel); const d = c.getContext("2d").getImageData(Math.floor(u * c.width), Math.floor(v * c.height), 1, 1).data; return [d[0], d[1], d[2]]; }, [sel, u, v]);
const dist = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

// 1. open the add sheet, pick Hoodie, open the camera
await page.evaluate(() => addItemSheet());
await page.selectOption("#a-type", "hoodie");
await page.click("[data-a=camera]");
await page.waitForFunction(() => { const v = document.querySelector(".cam video"); return v && v.videoWidth > 0 && !v.hidden; });
check(await page.isVisible(".cam .sil"), "viewfinder shows the outline");
check(await page.isVisible(".cam rect.paper"), "viewfinder shows the paper box");
check(await page.getAttribute(".cam [data-ct=hoodie]", "aria-pressed") === "true", "outline matches the type picked in the sheet");
await page.click(".cam [data-ct=collared]");
check(await page.getAttribute(".cam [data-ct=collared]", "aria-pressed") === "true", "switching type swaps the outline");
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, "1-viewfinder.png") });

// 2. shoot: colour fixed from the paper
await page.click(".cam-shut");
await page.waitForSelector(".cam-badge:not([hidden])");
const badge = await page.textContent(".cam-badge");
check(/paper/.test(badge) && !/approximate/.test(badge), `badge: ${badge}`);
const before = [60 * 1.0, 110 * 0.84, 150 * 0.64].map(Math.round), after = await px(".cam canvas", 0.5, 0.42);
const target = truth.map(v => Math.round(v * 241 / 246));
check(dist(after, target) <= 12, `tee colour fixed: shot ${before} → ${after}, true ${target}`);
const paperPx = await px(".cam canvas", 0.82, 0.9);
check(Math.max(...paperPx) - Math.min(...paperPx) <= 8, `paper comes out neutral ${paperPx}`);
await page.screenshot({ path: path.join(outDir, "2-review.png") });

// 3. use it: back in the sheet with a cropped photo
await page.click(".cam-use");
await page.waitForSelector(".photo-pick img");
check(await page.inputValue("#a-type") === "collared", "type picked in the camera comes back to the sheet");
check((await page.textContent(".photo-pick .how")).includes("fixed"), "sheet says the colour was fixed");
const dims = await page.evaluate(() => new Promise(ok => { const i = document.querySelector(".photo-pick img"); const f = () => ok([i.naturalWidth, i.naturalHeight]); i.complete ? f() : i.onload = f; }));
check(Math.abs(dims[0] / dims[1] - (0.88 * 3) / (0.76 * 4)) < 0.02 && Math.max(...dims) <= 900, `photo cropped to the outline ${dims}`);
await page.fill("#a-name", "Test camp shirt"); await page.fill("#a-colour", "slate blue");
await page.screenshot({ path: path.join(outDir, "3-sheet.png") });
await page.click("[data-a=save]");
for (let i = 0; i < 60 && !JSON.parse(repo.get("wardrobe.json").buf).items.some(i => i.name === "Test camp shirt"); i++) await page.waitForTimeout(250);
const w = JSON.parse(repo.get("wardrobe.json").buf), it = w.items.find(i => i.name === "Test camp shirt");
check(it && it.colour_ref === "paper" && it.uncalibrated === false && it.type === "collared", "saved with colour_ref paper");
check(it && repo.has(it.photo) && repo.get(it.photo).buf[0] === 0xFF, "photo uploaded as JPEG");

// 4. library photo: approximate until you tap the paper
await page.waitForTimeout(700);   // let the last sheet finish closing
await page.evaluate(() => addItemSheet());
await page.setInputFiles("#a-photo", libJpg);
await page.waitForSelector(".cam-badge:not([hidden])");
check((await page.textContent(".cam-badge")).includes("approximate"), "library photo starts as approximate");
check(!(await page.isVisible(".cam .sil")), "no outline over a library photo");
const box = await page.locator(".cam canvas").boundingBox();
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.4);   // tap the grey floor: refused
await page.waitForSelector(".toast.on");
check((await page.textContent(".toast")).includes("white"), "tapping the floor is refused");
await page.mouse.click(box.x + box.width * 0.84, box.y + box.height * 0.9);  // tap the paper
await page.waitForFunction(() => document.querySelector(".cam-badge").textContent.includes("tapped"));
const tapped = await px(".cam canvas", 0.5, 0.42);
check(dist(tapped, target) <= 14, `tap-to-fix: tee ${tapped} vs ${target}`);
await page.screenshot({ path: path.join(outDir, "4-library-tapped.png") });
await page.click(".cam-use");
await page.waitForSelector(".photo-pick img");
await page.click("[data-a=cancel]");

check(!errors.length, "no page errors " + errors.join(" | "));
await browser.close(); server.close();
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
