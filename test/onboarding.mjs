// First visit for a friend: the 3-step setup card on Today (add pieces → check rules → first fits), against a fake
// rail-api Worker that starts with an empty account. Pieces are added with the app's own addItem op (the camera flow
// has its own tests); everything else is tapped through.
// Usage: node test/onboarding.mjs <seed-data-dir> <out-dir>
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [seedDir, outDir] = process.argv.slice(2);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
fs.mkdirSync(outDir, { recursive: true });
const seedItems = JSON.parse(fs.readFileSync(path.join(seedDir, "wardrobe.json"))).items.filter(i => !i.avoid);

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

const check = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 100)); } return true; };
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});

async function friend(tag) {
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
      if (req.method() === "GET") return cur ? json(200, { content: cur.b64, sha: cur.sha }) : json(404, { error: "Not found" });
      const b = JSON.parse(req.postData());
      if ((cur && b.sha !== cur.sha) || (!cur && b.sha)) return json(409, { error: "conflict" });
      files.set(p, { b64: b.content, sha: "s" + (++n) }); return json(200, { sha: "s" + n });
    }
    return json(404, { error: "?" });
  });
  const file = p => files.has(p) ? JSON.parse(Buffer.from(files.get(p).b64, "base64").toString()) : null;
  const add = async slot => {
    const it = seedItems.find(i => i.slot === slot && !add.used.has(i.code)); add.used.add(it.code);
    await page.evaluate(x => run("addItem", { item: { code: null, name: x.name, colour: x.colour, type: x.type, slot: x.slot, avoid: false, photo: x.photo, added: todayStr() } }), it);
  };
  add.used = new Set();
  await page.goto(base);
  return { page, errors, file, add, shot: n => page.screenshot({ path: path.join(outDir, tag + "-" + n + ".png"), fullPage: true }) };
}

/* ---------- the whole first visit */
const F = await friend("a");
const { page } = F;
await page.waitForSelector(".setup");
check((await page.textContent(".setup h3")).includes("Jordan"), "greets the friend by first name");
check(await page.isVisible(".setup li.now >> text=Add your pieces"), "step 1 is the current step");
check(await page.isVisible("text=Add your first piece"), "empty closet: 'Add your first piece'");
check(!(await page.isVisible(".setup [data-act=suggest]")), "Suggest fits not offered with an empty closet");
await F.shot("1-empty");

await F.add("top");
await page.waitForSelector(".setup .slots >> text=Tops 1/3");
check(await page.isVisible("text=Add another piece"), "after one piece: 'Add another piece', Tops 1/3");

// Suggest fits from elsewhere with gaps → says what's missing instead of "do laundry"
await page.evaluate(() => suggestSheet()); await page.waitForSelector("#sheet.on");
await page.waitForTimeout(300);
const msg = await page.textContent("#sheet");
check(/Add bottoms, shoes and socks to your closet first/.test(msg) && !/laundry/.test(msg), "Suggest fits names the missing categories");
await page.click("[data-s=close]"); await page.waitForTimeout(400);

for (const s of ["top", "top", "bottom", "bottom", "shoes", "socks", "cap"]) await F.add(s);
await page.waitForSelector(".setup li.now >> text=Check your fit rules");
check(await page.isVisible(".setup li.done >> text=Add your pieces"), "closet step ticks off once top/bottom/shoes/socks are in");
check(await page.isVisible("text=Starting with caps when they help, no lab days, no church fits"), "shows the friend's starting rules");
await F.shot("2-rules-step");

await page.click(".setup [data-tab=settings]");
await page.waitForSelector("text=Your fit rules");
const pressed = async (k, v) => (await page.getAttribute(`[data-act=rule][data-k=${k}][data-v="${v}"]`, "aria-pressed")) === "true";
check(await pressed("cap", "optional") && await pressed("labDays", false) && await pressed("church", false), "friend defaults: caps when they help, no lab, no church");
await F.shot("3-settings");
await page.click("[data-act=rules-ok]");
await page.waitForSelector(".setup li.now >> text=Get your first fits");
check(await until(() => F.file("wardrobe.json")?.rules), "confirming rules saves them");
check(!(await page.isVisible("[data-act=rules-ok]")), "back on Today after confirming");
await F.shot("4-fits-step");

await page.click(".setup [data-act=suggest]"); await page.waitForSelector("#sheet.on");
await page.click("[data-s=wx][data-k=mild]"); await page.waitForSelector("#sheet .fit");
const chips = await page.$$eval('#sheet [aria-label=Occasion] .chip', els => els.map(e => e.dataset.k));
await page.click("[data-s=wx][data-k=mild]"); await page.waitForTimeout(200);
check(await page.isVisible("#sheet .fit"), "tapping the only weather again (no forecast) doesn't blank the sheet");
check(!chips.includes("lab") && !chips.includes("church"), "no Lab / Church buttons for this friend: " + chips);
await F.shot("5-suggest");
await page.click('[data-s=wear][data-i="0"]'); await page.waitForSelector("#w-name");
await page.click("[data-w=save]");
check(await until(() => (F.file("fit-log.json")?.worn || []).length === 1), "first fit logged to their account");
await page.waitForTimeout(600);
check(!(await page.isVisible(".setup")), "setup card gone after the first logged fit");
await F.shot("6-done");
check(!F.errors.length, "no page errors " + F.errors.join(" | "));

/* ---------- skipping it */
const G = await friend("b");
await G.page.waitForSelector(".setup");
await G.page.click("[data-act=skip-setup]");
check(await until(() => G.file("wardrobe.json")?.setup_done === true), "skip is saved to the account (stays hidden on other phones)");
await G.page.waitForSelector("text=Your closet is empty");
check(!(await G.page.isVisible(".setup")), "skipped: plain empty-closet card instead");
check(!G.errors.length, "no page errors " + G.errors.join(" | "));

await browser.close(); server.close();
