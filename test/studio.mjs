// Studio look: walks every tab on a phone, light and dark, with a fake GitHub repo. Checks the flat lays,
// looks carousel, hamper, diary and closet colour bar, and that no item numbers show anywhere.
// Usage: node test/studio.mjs <seed-data-dir> <out-dir> [fonts-dir]   (fonts-dir: local .ttf files, optional)
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [seedDir, outDir, fontDir] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
fs.mkdirSync(outDir, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const repo = new Map(); let shaN = 0;
const put = (p, buf) => repo.set(p, { buf, sha: "s" + (++shaN) });
for (const f of ["wardrobe.json", "fit-log.json", "laundry.json"]) put(f, fs.readFileSync(path.join(seedDir, f)));
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
for (const f of walk(path.join(seedDir, "photos"))) put(path.relative(seedDir, f).split(path.sep).join("/"), fs.readFileSync(f));
const today = new Date().toLocaleDateString("en-CA");
const log = JSON.parse(repo.get("fit-log.json").buf);
if (!log.planned.some(p => p.date === today)) log.planned.unshift({ ...log.planned[0], date: today });
put("fit-log.json", Buffer.from(JSON.stringify(log)));
const W = JSON.parse(repo.get("wardrobe.json").buf).items;

let fails = 0; const check = (ok, msg) => { console.log((ok ? "ok   " : "FAIL ") + msg); if (!ok) fails++; };
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block", colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.route("https://fonts.googleapis.com/**", r => {
    if (!fontDir) return r.fulfill({ status: 200, body: "", contentType: "text/css" });
    const face = (fam, file, extra = "") => `@font-face{font-family:"${fam}";src:url(https://fonts.gstatic.com/${file});${extra}}`;
    r.fulfill({ status: 200, contentType: "text/css", body: face("Anybody", "Anybody.ttf", "font-weight:100 900;font-stretch:50% 150%") +
      face("Hanken Grotesk", "HankenGrotesk.ttf", "font-weight:100 900") + face("IBM Plex Mono", "IBMPlexMono.ttf.ttf", "font-weight:400 500") + face("Manrope", "Manrope.ttf", "font-weight:200 800") });
  });
  await page.route("https://fonts.gstatic.com/**", r => {
    const f = fontDir && path.join(fontDir, path.basename(new URL(r.request().url()).pathname));
    return f && fs.existsSync(f) ? r.fulfill({ status: 200, body: fs.readFileSync(f), contentType: "font/ttf" }) : r.abort();
  });
  await page.route("https://api.open-meteo.com/**", r => r.abort());
  await page.route("https://api.github.com/**", async route => {
    const req = route.request(), u = new URL(req.url()), p = decodeURIComponent(u.pathname.split("/contents/")[1]);
    if (req.method() === "GET") {
      const f = repo.get(p); if (!f) return route.fulfill({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
      if ((req.headers().accept || "").includes("raw")) return route.fulfill({ status: 200, body: f.buf, contentType: "image/jpeg" });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sha: f.sha, content: f.buf.toString("base64") }) });
    }
    const body = JSON.parse(req.postData()); put(p, Buffer.from(body.content, "base64"));
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ content: { sha: repo.get(p).sha } }) });
  });
  const shot = (n, full = false) => page.screenshot({ path: path.join(outDir, `${scheme}-${n}.png`), fullPage: full });
  const tag = scheme + ": ";

  await page.goto(base);
  await page.click("details.gh summary"); await page.fill("#s-token", "t"); await page.click("[data-act=save-cfg]");
  await page.waitForSelector(".looks .fit"); await page.waitForTimeout(900);
  const plan = log.planned.find(p => p.date === today);
  check(await page.locator(".looks .fit").count() === plan.fits.length, tag + "one look per planned fit");
  const lay = await page.$$eval(".looks .fit", els => els.map(e => e.querySelectorAll(".lay .lp").length));
  check(lay.every((n, i) => n === plan.fits[i].items.filter(c => W.some(w => w.code === c)).length), tag + "every piece is on its flat lay " + lay);
  const fc = await page.$$eval(".looks .fit", els => els.map(e => getComputedStyle(e).backgroundColor));
  check(new Set(fc).size > 1 || fc.length === 1, tag + "each look gets its own backdrop " + fc.join(" | "));
  const txt = await page.innerText("#view");
  check(!W.some(i => new RegExp(`\\b${i.code}\\b`).test(txt)), tag + "no item numbers on Today");
  await shot("1-today");
  await shot("1-today-full", true);
  if (plan.fits.length > 1) {
    await page.click("[data-look='1']"); await page.waitForTimeout(700);
    check(await page.getAttribute("[data-look='1']", "aria-current") === "true", tag + "dot follows the look");
    await shot("2-look2");
    await page.click("[data-look='0']"); await page.waitForTimeout(500);
  }
  await page.click(".fit:nth-of-type(1) [data-act=wear]"); await page.waitForSelector("#sheet.on"); await page.waitForTimeout(400);
  const sheetTxt = await page.textContent("#sheet");
  check(!W.some(i => new RegExp(`\\b${i.code}\\b`).test(sheetTxt)), tag + "no item numbers on the wear sheet");
  await shot("3-wear");
  await page.click("[data-w=cancel]"); await page.waitForTimeout(400);
  await page.click(".looks .fit:nth-of-type(1) .lp >> nth=0"); await page.waitForSelector("#sheet.on .item-hero"); await page.waitForTimeout(300);
  await shot("4-item"); await page.keyboard.press("Escape"); await page.waitForTimeout(350);

  await page.click("nav.tabs [data-tab=closet]"); await page.waitForSelector(".grid .piece"); await page.waitForTimeout(500);
  check(await page.locator(".cbar button").count() > 3, tag + "closet colour bar");
  await shot("5-closet");
  await page.click(".cbar button >> nth=0"); await page.waitForTimeout(500);
  const shown = await page.locator(".grid .piece").count();
  check(shown > 0 && shown < W.length, tag + `colour filter narrows the closet (${shown})`);
  await page.click(".cbar button >> nth=0"); await page.waitForTimeout(300);

  await page.click("nav.tabs [data-tab=hamper]"); await page.waitForTimeout(500);
  check(await page.locator(".mast h1").textContent() === "Hamper", tag + "hamper tab");
  await shot("6-hamper"); await shot("6-hamper-full", true);

  await page.click("nav.tabs [data-tab=worn]"); await page.waitForSelector(".cal"); await page.waitForTimeout(500);
  check(await page.locator(".cal .d.has").count() > 0, tag + "diary calendar shows worn days");
  await shot("7-diary"); await shot("7-diary-full", true);

  await page.click("nav.tabs [data-tab=today]"); await page.waitForTimeout(300);
  await page.click("[data-act=suggest] >> nth=0"); await page.waitForSelector("#sheet.on .fit"); await page.waitForTimeout(600);
  await shot("8-suggest");
  check(!errors.length, tag + "no page errors " + errors.join(" | "));
  await ctx.close();
}
await browser.close(); server.close();
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
