// Glow + bob cards: no rod or hooks, each card has a glow from its own photo, only on-screen cards on Today/Worn bob (staggered),
// Closet glows but stays still, Reduce Motion stops all of it, hamper cards keep their dashed outline.
// Usage: node test/glow.mjs <seed-data-dir> <out-dir>   (seed should include some worn history)
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block", reducedMotion: process.env.RM ? "reduce" : "no-preference" });
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
const rm = !!process.env.RM, tag = rm ? "[reduce motion] " : "";

await page.goto(base);
await page.fill("#s-token", "test-token"); await page.click("[data-act=save-cfg]");
await page.waitForSelector(".fit"); await page.waitForTimeout(600);

const look = sel => page.$$eval(sel, els => els.map(el => {
  const ph = el.querySelector(".ph"), amb = el.querySelector(".amb"), r = el.getBoundingClientRect();
  const cs = amb && getComputedStyle(amb), ps = ph && getComputedStyle(ph);
  return { on: el.classList.contains("on"), dirty: el.classList.contains("dirty"), vis: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    amb: !!amb, ambImg: !!amb?.querySelector("img"), ambHidden: amb?.getAttribute("aria-hidden"), filter: cs?.filter, opacity: +cs?.opacity,
    phAnim: ps?.animationName, ambAnim: cs?.animationName, delay: getComputedStyle(el).getPropertyValue("--d"), outline: ps?.outlineStyle,
    cl: el.querySelector(".cl")?.textContent, before: getComputedStyle(el, "::before").content };
}));

// Today
const t = await look(".fit .rail .piece");
check(t.length > 0, tag + "today has cards");
check(t.every(p => p.amb && p.ambImg && p.ambHidden === "true"), tag + "every card has a glow made from its own photo (hidden from screen readers)");
check(t.every(p => /blur\(16px\)/.test(p.filter) && /saturate\(1\.4\)/.test(p.filter)), tag + "glow is blurred + saturated");
check(t.every(p => p.before === "none" || p.before === "normal"), tag + "no hanger hooks");
check(await page.$$eval(".rail", rs => rs.every(r => ["none", "normal"].includes(getComputedStyle(r, "::before").content))), tag + "no rod");
check((await page.locator(".tag").count()) === 0, tag + "no item-number tags");
if (rm) {
  check(t.every(p => !p.on && p.phAnim === "none" && p.ambAnim === "none"), tag + "nothing moves on Today");
} else {
  const vis = t.filter(p => p.vis), off = t.filter(p => !p.vis);
  check(vis.length && vis.every(p => p.on && p.phAnim === "rail-bob" && p.ambAnim === "rail-breathe"), "on-screen Today cards bob, glow breathes");
  check(off.length > 0 && off.every(p => !p.on && p.phAnim === "none"), `off-screen cards stay still (${off.length} off-screen)`);
  check(new Set(t.slice(0, 4).map(p => p.delay)).size === Math.min(4, t.length), "bob is staggered within a fit");
  const k = await page.evaluate(() => [...document.getAnimations()].filter(a => a.animationName === "rail-bob").length);
  check(k === vis.length, `running bob animations = on-screen cards (${k})`);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(400);
  const t2 = await look(".fit .rail .piece");
  check(t2.filter(p => p.vis).every(p => p.on) && t2.filter(p => !p.vis).every(p => !p.on), "scrolling hands the bob to the cards now on screen");
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(300);
}
await page.waitForTimeout(rm ? 0 : 2100); await shot(rm ? "today-reduced" : "today");

// Closet: glow, no motion
await page.click('nav.tabs [data-tab=closet]'); await page.waitForSelector(".grid .piece"); await page.waitForTimeout(400);
const c = await look(".grid .piece");
check(c.every(p => p.amb && p.ambImg), tag + "closet cards have the glow");
check(c.every(p => !p.on && p.phAnim === "none" && p.ambAnim === "none"), tag + "closet cards don't move");
const hit = await page.$eval(".grid .piece .hit", b => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + 40); return e === b; });
check(hit, tag + "closet photo is still tappable");
const dirty = c.filter(p => p.dirty);
if (dirty.length) check(dirty.every(p => p.outline === "dashed" && p.cl === "In the hamper"), tag + `hamper cards keep dashed outline + label (${dirty.length})`);
else console.log("note: no hamper items in this seed");
await shot(rm ? "closet-reduced" : "closet");

// Worn: Most worn bobs
await page.click('nav.tabs [data-tab=worn]'); await page.waitForTimeout(500);
const w = await look(".rail.bob .piece");
if (!w.length) console.log("note: no Most worn rail in this seed");
else if (rm) check(w.every(p => !p.on && p.phAnim === "none"), tag + "Most worn doesn't move");
else check(w.filter(p => p.vis).every(p => p.on && p.phAnim === "rail-bob"), "Most worn cards bob");
await shot(rm ? "worn-reduced" : "worn");

check(errors.length === 0, tag + "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
await browser.close(); server.close();
