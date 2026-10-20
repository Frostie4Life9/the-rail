// Tests the new-version bar: no bar when up to date, exactly one bar when the live copy is newer
// (even after many checks), none for an OLDER live copy, Reload lands on the new version with no bar,
// and Not now keeps it hidden for that version.
// Usage: node test/update-bar.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const orig = fs.readFileSync(path.join(root, "index.html"), "utf8");
const cur = orig.match(/const VERSION = "([^"]+)"/)[1];
let live = orig;
const withVer = v => orig.replace(`const VERSION = "${cur}"`, `const VERSION = "${v}"`);

const server = http.createServer((req, res) => {
  let p = new URL(req.url, "http://x").pathname;
  if (p.endsWith("/")) p += "index.html";
  if (p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(live); }
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": p.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const bars = () => page.locator(".updbar").count();
const shown = () => page.locator(".updbar.up").count();
const check = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

await page.goto(base);
await page.waitForTimeout(3200);
ok(await shown() === 0, "up to date: no bar");

live = withVer("2000.01.01-a");                     // older live copy (stale CDN)
await page.reload(); await page.waitForTimeout(3200);
ok(await shown() === 0, "older live copy: no bar");

// load the current page, then publish a newer one; the first check finds it, extra checks must not add a second bar
const next = "2099.12.31-z";
live = orig; await page.goto(base); live = withVer(next); await page.waitForTimeout(3200);
for (let i = 0; i < 5; i++) await check();
await page.waitForTimeout(600);
ok(await bars() === 1, "only one bar element in the page");
ok(await shown() === 1, "bar shown once for newer version");
ok((await page.textContent("#updtxt")).includes(next), "bar names the new version");

await page.click("#updx"); await page.waitForTimeout(500);
ok(await shown() === 0, "Not now hides it");

live = orig; await page.goto(base); live = withVer(next); await page.waitForTimeout(3200);
await page.click("#updgo");
await page.waitForLoadState("load"); await page.waitForTimeout(3200);
ok(await page.evaluate(() => VERSION) === next, "Reload loaded the new version");
ok(await shown() === 0, "no bar after reloading onto the new version");
ok(!/[?&]v=/.test(page.url()), "address tidied after reload");

await browser.close(); server.close();
process.exit(fails ? 1 : 0);
