// End-to-end: a friend's first visit, against the real Worker (worker/rail-api.js on a local D1 via Miniflare).
// Google sign-in is stubbed with a test-signed ID token; everything else is the real app and the real Worker.
// Usage: node test/accounts.mjs <out-dir>     (needs playwright + miniflare@4)
import { chromium } from "playwright";
import { Miniflare } from "miniflare";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { webcrypto as crypto } from "node:crypto";

const [outDir = "/tmp/accounts"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CID = "961476018828-tkjmdic1fnrtr7jtfmb7ta9alrupn8km.apps.googleusercontent.com";

const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const b64u = b => Buffer.from(b).toString("base64url");
async function gtoken(claims) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const p = b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: CID, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims }));
  return h + "." + p + "." + b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(h + "." + p)));
}

const mf = new Miniflare({
  modules: true, scriptPath: "worker/rail-api.js", script: fs.readFileSync(path.join(root, "worker/rail-api.js"), "utf8"),
  compatibilityDate: "2026-08-01", d1Databases: ["DB"],
  bindings: { GOOGLE_CLIENT_ID: CID, OWNER_EMAIL: "owner@example.com", SECRET: "s", ALLOW_ORIGINS: "http://127.0.0.1", __TEST_JWKS: [jwk] }
});

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

let fail = 0;
const check = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } else console.log("ok:", m); };

const browser = await chromium.launch();
async function phone(email, sub, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: "block" });
  const cred = await gtoken({ sub, email, given_name: name });
  // Google's script, stubbed: a button that hands the app a (test-signed) credential.
  await ctx.route("https://accounts.google.com/gsi/client", r => r.fulfill({ contentType: "text/javascript", body: `
    window.google = { accounts: { id: { initialize(o) { window.__gcb = o.callback; }, disableAutoSelect() {},
      renderButton(el) { el.innerHTML = '<button id="fake-google" type="button">Sign in with Google</button>'; el.firstChild.onclick = () => window.__gcb({ credential: ${JSON.stringify(cred)} }); } } } };` }));
  await ctx.route("https://rail-api.skyfro04.workers.dev/**", async r => {
    const q = r.request(), u = new URL(q.url());
    const res = await mf.dispatchFetch("https://rail.test" + u.pathname + u.search, { method: q.method(), headers: { ...q.headers(), origin: "http://127.0.0.1" }, body: q.postDataBuffer() || undefined });
    const buf = Buffer.from(await res.arrayBuffer()), headers = {};
    res.headers.forEach((v, k) => headers[k] = v);
    headers["access-control-allow-origin"] = "*";
    await r.fulfill({ status: res.status, headers, body: buf });
  });
  await ctx.route("**/fonts.googleapis.com/**", r => r.abort());
  await ctx.route("https://api.open-meteo.com/**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify({ daily: { time: [new Date().toLocaleDateString("en-CA")], temperature_2m_max: [52], temperature_2m_min: [34], precipitation_probability_max: [10], snowfall_sum: [0], wind_speed_10m_max: [8] } }) }));
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(base);
  return { ctx, page, errors };
}

// 1. A friend who hasn't been invited
let A = await phone("friend@example.com", "f1", "Fran");
await A.page.waitForSelector("#fake-google");
check(await A.page.isVisible("text=invite-only"), "first visit lands on sign-in, says invite-only");
check(!(await A.page.isVisible("#s-token")), "GitHub token form is tucked away");
await A.page.screenshot({ path: path.join(outDir, "1-signin.png") });
await A.page.click("#fake-google");
await A.page.waitForSelector("#acct-msg:not([hidden])");
check((await A.page.textContent("#acct-msg")).includes("invite list"), "uninvited friend told why");

// 2. The owner signs in (no GitHub token on this phone) and invites them
const O = await phone("owner@example.com", "o1", "Skyler");
await O.page.waitForSelector("#fake-google"); await O.page.click("#fake-google");
await O.page.waitForSelector("text=Your closet is empty");
await O.page.click(".gear, [data-tab=settings]").catch(() => {});
await O.page.waitForSelector("#inv-email");
await O.page.fill("#inv-email", "Friend@Example.com"); await O.page.click("[data-act=invite]");
await O.page.waitForSelector("text=friend@example.com");
check(await O.page.isVisible("text=Hasn't signed in yet"), "owner sees the invite");
await O.page.screenshot({ path: path.join(outDir, "2-owner-invites.png"), fullPage: true });

// 3. Now the friend gets in, to an empty closet
await A.page.click("#fake-google");
await A.page.waitForSelector("text=Your closet is empty");
check(true, "invited friend signs in and lands on an empty closet");
await A.page.screenshot({ path: path.join(outDir, "3-friend-empty.png") });

// 4. Friend adds a piece with a photo; it saves to their account
await A.page.click("[data-act=add-item]");
await A.page.waitForSelector("#a-photo", { state: "attached" });
const jpg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
await A.page.setInputFiles("#a-photo", { name: "tee.jpg", mimeType: "image/jpeg", buffer: jpg });
await A.page.waitForSelector(".photo-pick img");
await A.page.fill("#a-name", "Waffle henley"); await A.page.fill("#a-colour", "oatmeal");
await A.page.click("[data-a=save]");
await A.page.waitForFunction(() => !document.querySelector("#sync")?.textContent.includes("to sync"), null, { timeout: 15000 }).catch(() => {});
await A.page.waitForTimeout(1500);
const friendTok = await A.page.evaluate(() => JSON.parse(localStorage.getItem("rail.cfg")).session);
let r = await mf.dispatchFetch("https://rail.test/export", { headers: { authorization: "Bearer " + friendTok } });
let ex = await r.json();
check(ex.files["wardrobe.json"]?.items?.[0]?.name === "Waffle henley" && ex.photos.length === 1, "piece + photo saved to the friend's own account");

// 5. Owner's account can't see it
const ownerTok = await O.page.evaluate(() => JSON.parse(localStorage.getItem("rail.cfg")).session);
r = await mf.dispatchFetch("https://rail.test/export", { headers: { authorization: "Bearer " + ownerTok } });
ex = await r.json();
check(!ex.files["wardrobe.json"], "owner's closet stays separate");

// 6. A second phone for the same friend sees the piece
const A2 = await phone("friend@example.com", "f1", "Fran");
await A2.page.waitForSelector("#fake-google"); await A2.page.click("#fake-google");
await A2.page.waitForSelector("text=No looks yet today"); await A2.page.click("nav.tabs [data-tab=closet]");
await A2.page.waitForTimeout(2500); await A2.page.screenshot({ path: path.join(outDir, "4-friend-closet.png") }); await A2.page.waitForSelector("text=Waffle henley", { state: "attached" });
check(true, "same friend on another phone sees their closet");
await A2.page.screenshot({ path: path.join(outDir, "4-friend-closet.png") });

// 7. Sign out wipes the phone; delete removes the account
await A2.page.click(".gear, [data-tab=settings]").catch(() => {});
await A2.page.waitForSelector("[data-act=signout]"); await A2.page.click("[data-act=signout]");
await A2.page.waitForSelector("#fake-google");
check(await A2.page.evaluate(() => !JSON.parse(localStorage.getItem("rail.state")).wardrobe), "sign out clears this phone");
await A.page.click(".gear, [data-tab=settings]").catch(() => {});
await A.page.waitForSelector("[data-act=delete-acct]", { state: "attached" });
await A.page.click("details.zap summary");
await A.page.screenshot({ path: path.join(outDir, "5-friend-settings.png"), fullPage: true });
await A.page.click("[data-act=delete-acct]"); await A.page.click("[data-act=delete-acct]");
await A.page.waitForSelector("#fake-google");
r = await mf.dispatchFetch("https://rail.test/me", { headers: { authorization: "Bearer " + friendTok } });
check(r.status === 401, "delete removes the account");

for (const x of [A, O, A2]) check(!x.errors.length, "no page errors " + x.errors.join(" | "));
await browser.close(); server.close(); await mf.dispose();
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
