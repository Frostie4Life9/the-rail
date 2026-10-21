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

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
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

// wore fit 2, swap the Le Fleurs for the pink ones, add a mirror pic, feedback
await page.click(".fit:nth-of-type(2) [data-act=wear]");
await page.waitForSelector("#sheet.on"); await page.waitForTimeout(300); await shot("2-wear-sheet");
await page.click('#sheet .prow:nth-child(3) [data-w=swap]');
await page.waitForSelector("[data-pick]"); await shot("3-swap-picker");
await page.click('[data-pick="8282"]');
await page.waitForSelector("#w-good");
await page.setInputFiles("#w-photo", path.join(root, "tiles", "6077.jpg"));
await page.waitForSelector(".photo-pick img");
await page.fill("#w-good", "Olive and pink flowers popped");
await page.click("[data-w=save]");
await until(() => logJ().worn.length === 1);
const saved = JSON.parse(repo.get("fit-log.json").buf);
const rec = saved.worn[0];
check(rec && rec.items.join() === "6077,6092,8282,8249", "worn record has the swap");
check(rec.worked === "Olive and pink flowers popped" && rec.from_plan === `${today}#2`, "feedback + plan link saved");
check(rec.photo && repo.has(rec.photo), "mirror pic uploaded to photos/worn");
check(saved.planned.length === 1, "conflict retry kept the morning plan intact");
await page.waitForTimeout(300); await shot("4-after-log");

// hamper: the hoodie limit is 4, joggers 3 — log two more fits by hand to push joggers over
for (const nm of ["Gym", "Study"]) {
  await page.click("[data-act=log-own]"); await page.waitForSelector("#w-name");
  await page.fill("#w-name", nm); await page.click("[data-w=add]"); await page.click('[data-pf="bottom"]'); await page.click('[data-pick="6092"]');
  await page.waitForSelector("#w-name"); await page.click("[data-w=save]"); await page.waitForTimeout(150);
}
await until(() => logJ().worn.length === 3);
await page.waitForTimeout(300);
check((await page.textContent(".hamper")).includes("in the hamper"), "joggers hit the hamper after 3 wears");
await shot("5-hamper");
await page.click("[data-act=laundry]"); await page.click("[data-act=laundry]");
await until(() => JSON.parse(repo.get("laundry.json").buf).last_full); await page.waitForTimeout(300);
check(JSON.parse(repo.get("laundry.json").buf).last_full, "laundry reset written");
check((await page.textContent(".hamper")).includes("empty"), "hamper empty after laundry");

// closet + add a piece
await page.click("[data-tab=closet]"); await page.waitForSelector(".grid .piece"); await shot("6-closet");
await page.click("[data-act=add-item]"); await page.setInputFiles("#a-photo", path.join(root, "tiles", "6070.jpg"));
await page.waitForSelector(".photo-pick img"); await page.fill("#a-name", "Waffle henley"); await page.fill("#a-colour", "oatmeal");
await page.selectOption("#a-type", "knit"); await page.click("[data-a=save]");
await until(() => JSON.parse(repo.get("wardrobe.json").buf).items.some(i => i.name === "Waffle henley"));
const w = JSON.parse(repo.get("wardrobe.json").buf); const added = w.items.find(i => i.name === "Waffle henley");
check(added && added.code === "9001" && added.slot === "top" && repo.has(added.photo), "new piece gets tag 9001 + photo");

await page.click("[data-tab=worn]"); await page.waitForSelector(".entry"); await page.waitForTimeout(300); await shot("7-worn");
await page.click("[data-tab=today]"); await page.waitForTimeout(200);

// offline: log while offline, comes back and syncs
await ctx.setOffline(true); netDown = true;
await page.evaluate(() => window.dispatchEvent(new Event("offline")));
await page.click(".fit:nth-of-type(1) [data-act=wear]"); await page.waitForSelector("[data-w=save]"); await page.click("[data-w=save]");
await page.waitForTimeout(500);
check(JSON.parse(await page.evaluate(() => localStorage.getItem("rail.queue"))).length === 1, "offline log waits in the queue");
await shot("8-offline");
await ctx.setOffline(false); netDown = false; await page.evaluate(() => window.dispatchEvent(new Event("online")));
await until(() => logJ().worn.some(x => x.name === "Sunday navy"));
check(JSON.parse(repo.get("fit-log.json").buf).worn.some(x => x.name === "Sunday navy"), "offline log synced when back online");

check(!errors.length, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
console.log("writes:", writes.join(", "));
await browser.close(); server.close();
