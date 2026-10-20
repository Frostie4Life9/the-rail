// Smoke test: serves the app locally, fakes the GitHub contents API with an in-memory repo,
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

await page.goto(base);
await page.fill("#s-token", "wrong"); await page.click("[data-act=save-cfg]");
await page.waitForSelector("#cfg-msg:not([hidden])"); check((await page.textContent("#cfg-msg")).includes("rejected"), "bad token explained");
await page.fill("#s-token", "test-token"); await page.click("[data-act=save-cfg]");
await page.waitForSelector(".fit"); check((await page.locator(".fit").count()) === 3, "today shows 3 fits");
await page.waitForTimeout(400); await shot("1-today");

const cdp = await ctx.newCDPSession(page);
const swipe = async (x, y1, y2, steps = 8) => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y1 }] });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y1 + (y2 - y1) * i / steps }] }); await page.waitForTimeout(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

// swipe-to-dismiss on an item sheet
await page.click('[data-tab=closet]');
await page.waitForSelector("[data-act=item]");
await page.click('[data-act=item][data-code="6035"]');
await page.waitForSelector("#sheet.on"); await page.waitForTimeout(300);
const box = await page.locator("#sheet").boundingBox();
await swipe(195, box.y + 20, box.y + 60, 4);   // short drag: should spring back
await page.waitForTimeout(400);
check(await page.locator("#sheet.on").count() === 1, "short drag springs back");
await swipe(195, box.y + 20, box.y + 300);
await page.waitForTimeout(400);
check(await page.locator("#sheet").isHidden(), "swipe down closes item sheet");

// builder: yesterday, pick across slots, log it
await page.click('[data-tab=today]');
await page.waitForSelector("[data-act=log-own]");
await page.click("[data-act=log-own]");
await page.waitForSelector("#sheet.on [data-b=pick]"); await page.waitForTimeout(300);
await page.click('[data-b=day] >> nth=1');
for (const c of ["8280", "6039", "8483", "9001", "6081"]) await page.click(`[data-b=pick][data-code="${c}"]`);
await page.click('[data-b=pick][data-code="6081"]');  // toggle off
await shot("b1-builder");
check(await page.locator(".picked button").count() === 4, "4 pieces picked after toggle");
check((await page.textContent("[data-b=next]")).includes("4"), "next shows count");
await page.click("[data-b=next]");
await page.waitForSelector("#w-name");
check((await page.textContent("#sheet .lead")).includes("yesterday"), "wear sheet shows yesterday");
const order = await page.$$eval("#sheet .prow .t span", els => els.map(e => e.textContent.split(" ")[0]));
check(JSON.stringify(order) === JSON.stringify(["6039", "8483", "9001", "8280"]), "pieces ordered top→bottom→socks→shoes " + order);
await page.fill("#w-name", "Own fit test"); await shot("b2-wear");
await page.click("[data-w=save]");
const yday = new Date(Date.now() - 864e5).toLocaleDateString("en-CA");
check(await until(() => logJ().worn.some(w => w.name === "Own fit test" && w.date === yday && w.items.length === 4)), "builder fit logged for yesterday");
check(!errors.length, "no page errors " + errors.join(" | "));
await browser.close(); server.close();
