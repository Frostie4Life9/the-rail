/* rail-api — accounts and storage for The Rail (multi-user).

   The app saves everything as three JSON files (wardrobe.json, fit-log.json, laundry.json) plus photos, written
   with a version ("sha") so two phones can't overwrite each other. This Worker speaks that same shape, so the app's
   sync code is unchanged: it just talks here instead of to GitHub.

   Who can sign in: the owner (OWNER_EMAIL) and anyone the owner has invited by email. Sign-in is Google's
   ID token (the same OAuth client as Playback — both apps live on frostie4life9.github.io). The Worker checks it
   and hands back its own signed token (30 days, refreshed on every GET /me).

   Where data lives:
     - friends: D1 (files + photos tables). A photo is a compressed JPEG of about 100-400 KB.
     - the owner: if the GH_TOKEN secret is set, the owner's files are passed straight through to the private
       GitHub repo OWNER_REPO, so the morning fit-sheet task (which works on that repo) keeps working. Without
       GH_TOKEN the owner is stored in D1 like everyone else.

   Routes (all JSON unless noted; Authorization: Bearer <token> on everything except /health and /auth/google):
     GET    /health                       -> {ok, accounts}
     POST   /auth/google {credential}     -> {token, me}        403 {error:'not invited'} if not on the list
     GET    /me                           -> {me, token}
     DELETE /me                           deletes the account, its files and photos
     GET    /export                       -> {files:{path: json}, photos:[path]}
     GET    /files/<path>                 -> {content (base64), sha}   (a photo path returns the image bytes)
     PUT    /files/<path> {content, sha?} -> {sha}   409 if sha is stale, 422 if a photo already exists
     GET    /invites                      owner: -> {invites:[{email, made, used}], users:[...]}
     POST   /invites {email}              owner
     DELETE /invites?email=               owner: takes the invite back (someone who already signed up keeps their account)

   Variables: GOOGLE_CLIENT_ID, OWNER_EMAIL, OWNER_REPO, ALLOW_ORIGINS (comma list). Secrets: SECRET, GH_TOKEN (optional).
   Binding: DB (D1). */

const FILES = ['wardrobe.json', 'fit-log.json', 'laundry.json'];
const PHOTO_RE = /^photos\/(items|worn)\/[A-Za-z0-9._-]{1,80}\.jpg$/;
const FILE_MAX = 1500 * 1024;          // decoded JSON text per file
const PHOTO_MAX = 1200 * 1024;         // decoded image bytes
const PHOTOS_PER_USER = 1500;
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const TOKEN_DAYS = 30;

let ready = false, gKeys = null, gKeysAt = 0;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(request, env); }
    catch (e) { console.error('rail-api', e && e.stack || e); res = json({ error: 'server error' }, 500); }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allow = String(env.ALLOW_ORIGINS || 'https://frostie4life9.github.io').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allow.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? {
    'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  } : { 'Vary': 'Origin' };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, made INTEGER NOT NULL, seen INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS invites (email TEXT PRIMARY KEY, made INTEGER NOT NULL, used INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS files (uid TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, path))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS photos (uid TEXT NOT NULL, path TEXT NOT NULL, bytes BLOB NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, path))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)')
  ]);
  ready = true;
}

async function route(request, env) {
  const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '') || '/', M = request.method;
  if (!env.DB) return json({ error: 'database not bound' }, 500);
  await init(env);

  if (p === '/health' || p === '/') {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ ok: true, app: 'rail-api', accounts: n ? n.n : 0, signin: !!(env.GOOGLE_CLIENT_ID && env.SECRET), owner_repo: !!env.GH_TOKEN });
  }

  if (p === '/auth/google' && M === 'POST') return signIn(request, env);

  const me = await who(request, env);
  if (!me) return json({ error: 'sign in again' }, 401);
  me.owner = isOwner(env, me.email);

  if (p === '/me') {
    if (M === 'GET') {
      await env.DB.prepare('UPDATE users SET seen = ?2 WHERE uid = ?1').bind(me.uid, Date.now()).run();
      return json({ me: meOut(me, env), token: await makeToken(env, me.uid) });
    }
    if (M === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM files WHERE uid = ?1').bind(me.uid),
        env.DB.prepare('DELETE FROM photos WHERE uid = ?1').bind(me.uid),
        env.DB.prepare('DELETE FROM users WHERE uid = ?1').bind(me.uid)
      ]);
      return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  if (p === '/export' && M === 'GET') {
    const files = {};
    for (const r of (await env.DB.prepare('SELECT path, body FROM files WHERE uid = ?1').bind(me.uid).all()).results || []) {
      try { files[r.path] = JSON.parse(r.body); } catch { files[r.path] = r.body; }
    }
    const photos = ((await env.DB.prepare('SELECT path FROM photos WHERE uid = ?1 ORDER BY path').bind(me.uid).all()).results || []).map(r => r.path);
    return json({ exported: new Date().toISOString(), account: { name: me.name, email: me.email }, files, photos });
  }

  if (p.startsWith('/files/')) {
    const path = decodeURIComponent(p.slice(7));
    const kind = FILES.includes(path) ? 'file' : PHOTO_RE.test(path) ? 'photo' : null;
    if (!kind) return json({ error: 'not a Rail file' }, 404);
    if (me.owner && env.GH_TOKEN) return ownerRepo(request, env, path, kind);
    if (M === 'GET') return kind === 'file' ? getFile(env, me, path) : getPhoto(env, me, path);
    if (M === 'PUT') {
      if (!(await limit(env, 'w:' + me.uid, 900, 3600))) return json({ error: 'too many saves, try again soon' }, 429);
      return kind === 'file' ? putFile(request, env, me, path) : putPhoto(request, env, me, path);
    }
    return json({ error: 'method not allowed' }, 405);
  }

  if (p === '/invites') {
    if (!me.owner) return json({ error: 'owner only' }, 403);
    if (M === 'GET') {
      const invites = (await env.DB.prepare('SELECT email, made, used FROM invites ORDER BY made DESC').all()).results || [];
      const users = (await env.DB.prepare(
        'SELECT u.email, u.name, u.made, u.seen, (SELECT COUNT(*) FROM photos ph WHERE ph.uid = u.uid) AS photos FROM users u ORDER BY u.seen DESC').all()).results || [];
      return json({ invites, users });
    }
    if (M === 'POST') {
      const { j, err } = await body(request, 4096); if (err) return err;
      const email = cleanEmail(j.email);
      if (!email) return json({ error: "that doesn't look like an email address" }, 400);
      await env.DB.prepare('INSERT OR IGNORE INTO invites (email, made, used) VALUES (?1, ?2, NULL)').bind(email, Date.now()).run();
      return json({ ok: true, email });
    }
    if (M === 'DELETE') {
      const email = cleanEmail(url.searchParams.get('email'));
      if (!email) return json({ error: 'no email' }, 400);
      await env.DB.prepare('DELETE FROM invites WHERE email = ?1').bind(email).run();
      return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}

/* ---------------- sign-in ---------------- */
async function signIn(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SECRET) return json({ error: 'sign-in is not set up yet' }, 409);
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  if (!(await limit(env, 'login:' + ip, 40, 3600))) return json({ error: 'too many sign-ins, try again later' }, 429);
  const { j, err } = await body(request, 8192); if (err) return err;
  let pay;
  try { pay = await googleVerify(env, j.credential); } catch (e) { return json({ error: "couldn't reach Google, try again" }, 502); }
  if (!pay) return json({ error: 'Google sign-in was not accepted' }, 401);
  const email = cleanEmail(pay.email);
  if (!email || pay.email_verified === false || pay.email_verified === 'false') return json({ error: 'that Google account has no verified email' }, 401);
  const now = Date.now();
  let u = await env.DB.prepare('SELECT uid, email, name FROM users WHERE sub = ?1').bind(String(pay.sub)).first();
  if (!u) {
    const owner = isOwner(env, email);
    const inv = owner ? null : await env.DB.prepare('SELECT email FROM invites WHERE email = ?1').bind(email).first();
    if (!owner && !inv) return json({ error: 'not invited', email }, 403);
    const uid = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    const name = cleanName(pay.given_name || pay.name) || email.split('@')[0];
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (uid, sub, email, name, made, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5)').bind(uid, String(pay.sub), email, name, now),
      env.DB.prepare('UPDATE invites SET used = ?2 WHERE email = ?1').bind(email, now)
    ]);
    u = { uid, email, name };
  } else {
    // An invite taken back after sign-up doesn't lock someone out of their own closet; deleting their account does.
    await env.DB.prepare('UPDATE users SET seen = ?2, email = ?3 WHERE uid = ?1').bind(u.uid, now, email).run();
    u.email = email;
  }
  u.owner = isOwner(env, u.email);
  return json({ token: await makeToken(env, u.uid), me: meOut(u, env) });
}
const isOwner = (env, email) => !!email && cleanEmail(env.OWNER_EMAIL) === cleanEmail(email);
const meOut = (u, env) => ({ name: u.name, email: u.email, owner: !!u.owner, storage: u.owner && env.GH_TOKEN ? 'github' : 'account' });
function cleanEmail(s) { s = String(s || '').trim().toLowerCase(); return /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/.test(s) ? s : ''; }
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);

const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
async function googleKeys(env, force) {
  if (env.__TEST_JWKS) return env.__TEST_JWKS;                      // tests only (never set in production)
  if (!force && gKeys && Date.now() - gKeysAt < 3600 * 1000) return gKeys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('google keys ' + r.status);
  gKeys = (await r.json()).keys || []; gKeysAt = Date.now();
  return gKeys;
}
/* signature, issuer, audience (this app's client id) and expiry */
async function googleVerify(env, cred) {
  const parts = String(cred || '').split('.');
  if (parts.length !== 3 || String(cred).length > 4096) return null;
  let head, pay;
  try { head = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); pay = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); }
  catch { return null; }
  if (head.alg !== 'RS256') return null;
  let jwk = (await googleKeys(env, false)).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  if (!GOOGLE_ISS.includes(pay.iss) || pay.aud !== String(env.GOOGLE_CLIENT_ID).trim() || !(pay.exp > Date.now() / 1000) || !pay.sub) return null;
  return pay;
}

async function hmac(env, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode('rail:' + String(env.SECRET).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function makeToken(env, uid) { const b = uid + '.' + (Date.now() + TOKEN_DAYS * 86400000); return 'rl1.' + b + '.' + await hmac(env, b); }
/* the signed-in person, or null. A deleted account's token stops working at once. */
async function who(request, env) {
  if (!env.SECRET) return null;
  const m = /^Bearer rl1\.([0-9a-f]{16})\.(\d{10,14})\.([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '');
  if (!m || !(Number(m[2]) > Date.now()) || !same(m[3], await hmac(env, m[1] + '.' + m[2]))) return null;
  return await env.DB.prepare('SELECT uid, email, name FROM users WHERE uid = ?1').bind(m[1]).first();
}

async function limit(env, k, max, secs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT n, exp FROM rl WHERE k = ?1').bind(k).first();
  if (!row || row.exp < now) { await env.DB.prepare('INSERT OR REPLACE INTO rl (k, n, exp) VALUES (?1, 1, ?2)').bind(k, now + secs * 1000).run(); return true; }
  if (row.n >= max) return false;
  await env.DB.prepare('UPDATE rl SET n = n + 1 WHERE k = ?1').bind(k).run();
  return true;
}
async function body(request, max) {
  const t = await request.text();
  if (t.length > max) return { err: json({ error: 'too large' }, 413) };
  try { return { j: JSON.parse(t || '{}') }; } catch { return { err: json({ error: 'not valid JSON' }, 400) }; }
}

/* ---------------- files (D1) ---------------- */
const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
function fromB64(s) { try { return Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0)); } catch { return null; } }
async function shaOf(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''); }

async function getFile(env, me, path) {
  const r = await env.DB.prepare('SELECT body, sha FROM files WHERE uid = ?1 AND path = ?2').bind(me.uid, path).first();
  if (!r) return json({ error: 'not found' }, 404);
  return json({ content: toB64(new TextEncoder().encode(r.body)), sha: r.sha });
}
async function putFile(request, env, me, path) {
  const { j, err } = await body(request, Math.ceil(FILE_MAX * 4 / 3) + 4096); if (err) return err;
  const bytes = fromB64(j.content);
  if (!bytes || bytes.length > FILE_MAX) return json({ error: 'file is too large or not base64' }, 413);
  const text = new TextDecoder().decode(bytes);
  try { JSON.parse(text); } catch { return json({ error: 'not valid JSON' }, 400); }
  const sha = await shaOf(bytes), now = Date.now();
  const cur = await env.DB.prepare('SELECT sha FROM files WHERE uid = ?1 AND path = ?2').bind(me.uid, path).first();
  if (cur) {
    if (!j.sha || j.sha !== cur.sha) return json({ error: 'changed on another device' }, 409);
    // Only write if nobody changed it between the read above and now.
    const r = await env.DB.prepare('UPDATE files SET body = ?3, sha = ?4, at = ?5 WHERE uid = ?1 AND path = ?2 AND sha = ?6').bind(me.uid, path, text, sha, now, cur.sha).run();
    if (!r.meta || r.meta.changes !== 1) return json({ error: 'changed on another device' }, 409);
  } else {
    if (j.sha) return json({ error: 'changed on another device' }, 409);
    try { await env.DB.prepare('INSERT INTO files (uid, path, body, sha, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.uid, path, text, sha, now).run(); }
    catch { return json({ error: 'changed on another device' }, 409); }
  }
  return json({ sha });
}
async function getPhoto(env, me, path) {
  const r = await env.DB.prepare('SELECT bytes FROM photos WHERE uid = ?1 AND path = ?2').bind(me.uid, path).first();
  if (!r) return json({ error: 'not found' }, 404);
  return new Response(new Uint8Array(r.bytes), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
}
async function putPhoto(request, env, me, path) {
  const { j, err } = await body(request, Math.ceil(PHOTO_MAX * 4 / 3) + 4096); if (err) return err;
  const bytes = fromB64(j.content);
  if (!bytes || bytes.length > PHOTO_MAX) return json({ error: 'photo is too large' }, 413);
  if (!(bytes[0] === 0xFF && bytes[1] === 0xD8)) return json({ error: 'photos must be JPEG' }, 400);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE uid = ?1').bind(me.uid).first();
  if (n && n.n >= PHOTOS_PER_USER) return json({ error: 'photo limit reached' }, 507);
  try { await env.DB.prepare('INSERT INTO photos (uid, path, bytes, size, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.uid, path, bytes, bytes.length, Date.now()).run(); }
  catch { return json({ error: 'already uploaded' }, 422); }
  return json({ sha: await shaOf(bytes) });
}

/* ---------------- the owner's GitHub repo (pass-through) ---------------- */
async function ownerRepo(request, env, path, kind) {
  const repo = String(env.OWNER_REPO || '').trim(), branch = String(env.OWNER_BRANCH || 'main').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: 'OWNER_REPO is not set' }, 500);
  const gh = `https://api.github.com/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const H = raw => ({ Authorization: `Bearer ${String(env.GH_TOKEN).trim()}`, 'User-Agent': 'rail-api', 'X-GitHub-Api-Version': '2022-11-28',
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' });
  if (request.method === 'GET') {
    const r = await fetch(`${gh}?ref=${encodeURIComponent(branch)}`, { headers: H(kind === 'photo') });
    if (!r.ok) return json({ error: 'github ' + r.status }, r.status === 404 ? 404 : 502);
    if (kind === 'photo') return new Response(r.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    const j = await r.json();
    return json({ content: String(j.content || '').replace(/\n/g, ''), sha: j.sha });
  }
  if (request.method === 'PUT') {
    const { j, err } = await body(request, Math.ceil(Math.max(FILE_MAX, PHOTO_MAX) * 4 / 3) + 4096); if (err) return err;
    const out = { message: String(j.message || `rail: ${path}`).slice(0, 200), content: String(j.content || ''), branch };
    if (j.sha) out.sha = String(j.sha);
    const r = await fetch(gh, { method: 'PUT', headers: { ...H(false), 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
    if (r.status === 409 || r.status === 422) return json({ error: 'changed on another device' }, r.status);
    if (!r.ok) return json({ error: 'github ' + r.status }, 502);
    return json({ sha: (await r.json()).content.sha });
  }
  return json({ error: 'method not allowed' }, 405);
}
