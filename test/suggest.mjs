// (suggest test) : serves the app locally, fakes the GitHub contents API with an in-memory repo,
// and walks the daily loop (connect -> today's fits -> wore with swap + photo -> hamper -> laundry -> add item).
// Usage: node test/smoke.mjs <seed-data-dir> <out-dir>
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

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

await page.route("https://api.open-meteo.com/**", r => r.abort());   // no network forecast in tests: today's sheet provides the weather
await page.goto(base);
await page.click("details.gh summary"); await page.fill("#s-token", "test-token"); await page.click("[data-act=save-cfg]");
await page.waitForSelector(".fit");

await page.click("[data-act=suggest] >> nth=0");
await page.waitForSelector("#sheet.on .fit"); await page.waitForTimeout(500);
check((await page.textContent("#sheet .lead")).includes("40–62°F"), "weather read from today's sheet");
check(await page.locator("#sheet .fit").count() === 3, "3 suggestions");
const names = () => page.$$eval("#sheet .fit h2", els => els.map(e => e.textContent));
const codes = () => page.$$eval("#sheet .fit", els => els.map(e => [...e.querySelectorAll(".piece")].map(p => p.dataset.sxKey)));
const first = await codes();
check(first.every(c => c.length >= 5), "every fit has top, bottom, socks, shoes, cap (+layer): " + first.map(c => c.length));
const W = JSON.parse(repo.get("wardrobe.json").buf).items, by = c => W.find(i => i.code === c);
check(first.flat().every(c => !by(c).avoid), "no hidden pieces suggested");
check(first.every(c => c.some(x => by(x).slot === "cap")), "every fit has a cap");
await shot("s1-suggest");

await page.click('[data-s=kind][data-k=lab]'); await page.waitForTimeout(300);
const lab = await codes();
const baseTop = c => { const t = c.map(by).filter(i => i.slot === "top"); return t.find(i => i.type === "tee") || t[0]; };
check(lab.every(c => !/long sleeve|ls$|rugby/i.test(baseTop(c).name) && !["hoodie", "crewneck", "knit"].includes(baseTop(c).type)), "lab: nothing long-sleeved against the skin");
await page.click('[data-s=wx][data-k=cold]'); await page.waitForTimeout(300);
await page.click('[data-s=kind][data-k=class]'); await page.waitForTimeout(300);
const cold = await codes();
check(cold.every(c => c.map(by).some(i => i.slot === "layer" || i.type === "hoodie" || i.type === "crewneck" || i.type === "knit")), "cold: every fit has a warm layer");
await page.click('[data-s=rain]'); await page.waitForTimeout(300);
check((await page.textContent("#sheet .lead")).includes("rain"), "rain chip adds rain");
const before = JSON.stringify(await codes());
await page.click("[data-s=again]"); await page.waitForTimeout(300);
check(JSON.stringify(await codes()) !== before, "Show others gives different fits");

// log one: opens the wear sheet with those pieces, saves to the log
const pick = (await codes())[0];
await page.click('[data-s=wear][data-i="0"]');
await page.waitForSelector("#w-name");
check((await page.$$eval("#sheet .prow .t span", els => els.length)) === pick.length, "wear sheet has the suggested pieces");
await shot("s2-wear");
await page.click("[data-w=save]");
check(await until(() => logJ().worn.some(w => w.date === new Date().toLocaleDateString("en-CA") && w.items.length === pick.length)), "suggested fit logged");
const lw = logJ().worn.find(w => w.date === new Date().toLocaleDateString("en-CA") && w.items.length === pick.length);
check(lw && lw.weather && lw.weather.hi === 38 && lw.kind === "class", "log keeps weather + occasion for learning " + JSON.stringify(lw && [lw.weather, lw.kind]));
check(!errors.length, "no page errors " + errors.join(" | "));
await browser.close(); server.close();
