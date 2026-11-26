// Per-person fit rules: the engine honours cap / lab rules, and Settings saves them into wardrobe.json.
// Usage: node test/rules.mjs <seed-data-dir> <out-dir>
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [seedDir, outDir] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
fs.mkdirSync(outDir, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

// in-memory repo
const repo = new Map(); let shaN = 0;
const put = (p, buf) => repo.set(p, { buf, sha: "s" + (++shaN) });
for (const f of ["wardrobe.json", "fit-log.json", "laundry.json"]) put(f, fs.readFileSync(path.join(seedDir, f)));
const today = new Date().toLocaleDateString("en-CA");
const log = JSON.parse(repo.get("fit-log.json").buf);
log.planned = [{ date: today, subtitle: "Provo: 62°F high / 40°F low · sunny · church or chill", fits: [
  { n: 1, name: "Sunday navy", when: "If church", note: "Tuck the button-up; black belt with the Rockports.", items: ["6044", "6106", "6107", "8281"] },
  { n: 2, name: "Olive errands", when: "No church", note: "Push the sleeves so the joggers' cuffs show.", items: ["6077", "6092", "8286", "8249"] },
  { n: 3, name: "Cord date", when: "No church · evening", note: "Jacket open so the brown tee reads.", items: ["6081", "8257", "6085", "8280"] }] }];
put("fit-log.json", Buffer.from(JSON.stringify(log)));
let writes = [], conflictOnce = true, netDown = false;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("console", m => m.type() === "error" && !/Failed to load resource|fonts\./.test(m.text()) && errors.push(m.text()));
await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ status: 200, body: "", contentType: "text/css" }));
await page.route("https://api.github.com/**", async route => {
  if (netDown) return route.abort("internetdisconnected");
  const req = route.request(), u = new URL(req.url());
  if (req.headers().authorization !== "Bearer test-token") return route.fulfill({ status: 401, body: JSON.stringify({ message: "Bad credentials" }) });
  const p = decodeURIComponent(u.pathname.split("/contents/")[1]);
  if (req.method() === "GET") {
    const f = repo.get(p); if (!f) return route.fulfill({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
    if ((req.headers().accept || "").includes("raw")) return route.fulfill({ status: 200, body: f.buf, contentType: "image/jpeg" });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sha: f.sha, content: f.buf.toString("base64") }) });
  }
  const body = JSON.parse(req.postData()); const cur = repo.get(p);
  if (p === "fit-log.json" && conflictOnce) { conflictOnce = false; put(p, cur.buf); return route.fulfill({ status: 409, body: JSON.stringify({ message: "conflict" }) }); }
  if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, body: JSON.stringify({ message: "sha mismatch" }) });
  if (!cur && body.sha) return route.fulfill({ status: 409, body: "{}" });
  put(p, Buffer.from(body.content, "base64")); writes.push(p);
  return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ content: { sha: repo.get(p).sha } }) });
});

const shot = n => page.screenshot({ path: path.join(outDir, n + ".png"), fullPage: true });
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 100)); } return true; };
const logJ = () => JSON.parse(repo.get("fit-log.json").buf);
const check = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };


/* ---------- engine */
const E = createRequire(import.meta.url)("../engine.js");
const data = { wardrobe: JSON.parse(repo.get("wardrobe.json").buf), log: logJ(), laundry: JSON.parse(repo.get("laundry.json").buf) };
const wx = { hi: 50, lo: 34, rain: 0, snow: false, wind: 0 }, occ = { kind: "class", phase: "day" };
const slots = f => f.items.map(c => data.wardrobe.items.find(i => i.code === c).slot);
const run = (rules, o = occ) => E.suggest(data, { today, weather: wx, occasion: o, n: 3, rules });
let r = run(undefined);
check(r.fits.length === 3 && r.fits.every(f => slots(f).includes("cap")), "no rules = owner defaults: cap on every fit");
r = run({ cap: "never" });
check(r.fits.length === 3 && r.fits.every(f => !slots(f).includes("cap")), "cap: never → no caps");
r = run({ cap: "optional" });
check(r.fits.every(f => !slots(f).includes("cap") || f.capOptional), "cap: optional → any cap is marked optional");
check(run({ alwaysCap: false }).fits.every(f => !slots(f).includes("cap") || f.capOptional), "old alwaysCap:false still means optional");
const lab = { kind: "lab", phase: "day" }, longTop = f => f.items.some(c => { const it = data.wardrobe.items.find(i => i.code === c); return it.slot === "top" && E.attrs(it).sleeve === "long"; });
check(run(undefined, lab).fits.every(f => !E.check(data, { weather: wx, occasion: lab }, f.items).some(x => /^lab:/.test(x))), "lab days on → no long sleeve against the skin");
const longCode = data.wardrobe.items.find(i => i.slot === "top" && !i.avoid && E.attrs(i).sleeve === "long").code;
const any = data.wardrobe.items.filter(i => !i.avoid), pick = s => any.find(i => i.slot === s).code;
const fitCodes = [longCode, pick("bottom"), pick("shoes"), pick("socks")];
check(E.check(data, { weather: wx, occasion: lab }, fitCodes).some(x => /^lab:/.test(x)), "check(): owner flags long sleeve on lab day");
check(!E.check(data, { weather: wx, occasion: lab, rules: { labShortSleeve: false } }, fitCodes).some(x => /^lab:/.test(x)), "check(): lab rule off → allowed");
check(E.check(data, { weather: wx, occasion: occ }, fitCodes).includes("no cap"), "check(): owner needs a cap");
check(!E.check(data, { weather: wx, occasion: occ, rules: { cap: "optional" } }, fitCodes).includes("no cap"), "check(): cap optional → capless is fine");

/* ---------- app */
await page.route("https://api.open-meteo.com/**", r => r.abort());
await page.goto(base);
await page.click("details.gh summary"); await page.fill("#s-token", "test-token"); await page.click("[data-act=save-cfg]");
await page.waitForSelector(".fit");
await page.click(".gear >> nth=0"); await page.waitForSelector("text=Your fit rules");
const pressed = async (k, v) => (await page.getAttribute(`[data-act=rule][data-k=${k}][data-v="${v}"]`, "aria-pressed")) === "true";
check(await pressed("cap", "always") && await pressed("labDays", true) && await pressed("church", true), "owner with no saved rules sees his originals");
await shot("settings-rules");
await page.click('[data-act=rule][data-k=cap][data-v=never]');
await page.click('[data-act=rule][data-k=church][data-v=false]');
check(await until(() => { const w = JSON.parse(repo.get("wardrobe.json").buf); return w.rules?.cap === "never" && w.rules?.church === false; }), "rules saved to wardrobe.json");
check(JSON.parse(repo.get("wardrobe.json").buf).items.length === data.wardrobe.items.length, "closet untouched by a rules change");
await page.click('.tabbar [data-tab=today], nav [data-tab=today] >> nth=0').catch(() => {});
await page.evaluate(() => { tab = "today"; render(); });
await page.click("[data-act=suggest] >> nth=0"); await page.waitForSelector("#sheet.on .fit"); await page.waitForTimeout(400);
const W = data.wardrobe.items, by = c => W.find(i => i.code === c);
const got = await page.$$eval("#sheet .fit", els => els.map(e => [...e.querySelectorAll(".piece")].map(p => p.dataset.sxKey)));
check(got.length && got.every(c => !c.some(x => by(x)?.slot === "cap")), "Suggest fits: no caps after choosing Never");
const chips = await page.$$eval('#sheet [aria-label=Occasion] .chip', els => els.map(e => e.dataset.k));
check(!chips.includes("church") && chips.includes("lab"), "church chip gone, lab still there: " + chips);
await shot("suggest-no-caps");
await page.click("[data-s=close]");

/* pooled pieces anyone can set up */
const sock = W.find(i => i.slot === "socks" && !(+i.qty > 1) && !i.avoid);
if (sock) {
  await page.evaluate(c => itemSheet(c), sock.code); await page.waitForSelector("[data-i=pool]");
  await page.click("[data-i=pool]"); await page.waitForSelector("[data-i='qty+']");
  await page.click("[data-i='qty+']");
  check(await until(() => +JSON.parse(repo.get("wardrobe.json").buf).items.find(i => i.code === sock.code).qty === 3), "single socks → pool of 3");
  await page.waitForTimeout(400); await page.click("[data-i='qty-']");
  check(await until(() => +JSON.parse(repo.get("wardrobe.json").buf).items.find(i => i.code === sock.code).qty === 2), "one fewer → 2");
  await page.waitForTimeout(400); await shot("sock-pool"); await page.click("[data-i='qty-']");
  check(await until(() => +JSON.parse(repo.get("wardrobe.json").buf).items.find(i => i.code === sock.code).qty === 1), "back down to just one");
} else console.log("skip: no single socks in seed");
check(!errors.length, "no page errors " + errors.join(" | "));
await browser.close(); server.close();
