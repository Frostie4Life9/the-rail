// Tests for worker/rail-api.js on a local D1 (Miniflare). Signs its own "Google" tokens with a test key.
// Run: node test/worker.mjs   (needs wrangler/miniflare installed; NODE_PATH or a local node_modules)
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const CID = 'test-client.apps.googleusercontent.com';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = b => Buffer.from(b).toString('base64url');
async function gtoken(claims, { key = kp.privateKey, aud = CID } = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims }));
  const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p));
  return h + '.' + p + '.' + b64u(s);
}

const mf = new Miniflare({
  modules: true, scriptPath: 'worker/rail-api.js', script: readFileSync('worker/rail-api.js', 'utf8'),
  compatibilityDate: '2026-08-01', d1Databases: ['DB'],
  bindings: { GOOGLE_CLIENT_ID: CID, OWNER_EMAIL: 'owner@example.com', SECRET: 'test-secret', ALLOW_ORIGINS: 'https://frostie4life9.github.io', __TEST_JWKS: [jwk] }
});

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m); } };
const call = async (method, path, { token, body, origin } = {}) => {
  const r = await mf.dispatchFetch('https://rail.test' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { s: r.status, h: r.headers, j: ct.includes('json') ? await r.json() : null, raw: ct.includes('json') ? null : new Uint8Array(await r.arrayBuffer()) };
};
const enc = o => Buffer.from(JSON.stringify(o)).toString('base64');
const dec = c => JSON.parse(Buffer.from(c, 'base64').toString());

// health + cors
let r = await call('GET', '/health', { origin: 'https://frostie4life9.github.io' });
ok(r.s === 200 && r.j.ok && r.j.signin, 'health');
ok(r.h.get('access-control-allow-origin') === 'https://frostie4life9.github.io', 'cors for the app');
r = await call('GET', '/health', { origin: 'https://evil.example' });
ok(!r.h.get('access-control-allow-origin'), 'no cors for others');

// sign-in rules
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'f1', email: 'friend@example.com', given_name: 'Fran' }) } });
ok(r.s === 403 && r.j.error === 'not invited', 'uninvited friend refused');
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'o1', email: 'owner@example.com' }, { key: other.privateKey }) } });
ok(r.s === 401, 'forged signature refused');
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'o1', email: 'owner@example.com' }, { aud: 'someone-else' }) } });
ok(r.s === 401, 'wrong audience refused');
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'o1', email: 'owner@example.com', exp: 1 }) } });
ok(r.s === 401, 'expired refused');
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'o1', email: 'Owner@Example.com', given_name: 'Sky' }) } });
ok(r.s === 200 && r.j.me.owner && r.j.me.storage === 'account', 'owner signs in (case-insensitive email)');
const OT = r.j.token;

// invites
r = await call('POST', '/invites', { token: OT, body: { email: 'Friend@Example.com' } });
ok(r.s === 200 && r.j.email === 'friend@example.com', 'owner invites');
r = await call('POST', '/invites', { token: OT, body: { email: 'nope' } });
ok(r.s === 400, 'bad email refused');
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'f1', email: 'friend@example.com', given_name: 'Fran' }) } });
ok(r.s === 200 && !r.j.me.owner && r.j.me.name === 'Fran', 'invited friend signs in');
const FT = r.j.token;
r = await call('POST', '/invites', { token: FT, body: { email: 'x@example.com' } });
ok(r.s === 403, 'friend cannot invite');
r = await call('GET', '/invites', { token: OT });
ok(r.s === 200 && r.j.invites[0].used && r.j.users.length === 2, 'invite marked used, users listed');

// tokens
r = await call('GET', '/me', { token: FT.slice(0, -1) + (FT.endsWith('0') ? '1' : '0') });
ok(r.s === 401, 'tampered token refused');
r = await call('GET', '/me', { token: FT });
ok(r.s === 200 && r.j.token && r.j.me.email === 'friend@example.com', 'me + refreshed token');

// files: separate per person, versioned
r = await call('GET', '/files/wardrobe.json', { token: FT });
ok(r.s === 404, 'new person has no wardrobe yet');
r = await call('PUT', '/files/wardrobe.json', { token: FT, body: { content: enc({ next_code: 9001, items: [{ code: '9001', name: 'Tee' }] }) } });
ok(r.s === 200 && r.j.sha, 'first write');
const sha1 = r.j.sha;
r = await call('PUT', '/files/wardrobe.json', { token: FT, body: { content: enc({ items: [] }) } });
ok(r.s === 409, 'write without sha over an existing file refused');
r = await call('PUT', '/files/wardrobe.json', { token: FT, body: { content: enc({ items: [1] }), sha: 'stale' } });
ok(r.s === 409, 'stale sha refused');
r = await call('PUT', '/files/wardrobe.json', { token: FT, body: { content: enc({ next_code: 9002, items: [{ code: '9001', name: 'Tee' }, { code: '9002', name: 'Hoodie' }] }), sha: sha1 } });
ok(r.s === 200 && r.j.sha !== sha1, 'write with current sha');
r = await call('GET', '/files/wardrobe.json', { token: FT });
ok(r.s === 200 && dec(r.j.content).items.length === 2, 'read back');
r = await call('GET', '/files/wardrobe.json', { token: OT });
ok(r.s === 404, "owner can't see friend's wardrobe");
r = await call('PUT', '/files/secrets.json', { token: FT, body: { content: enc({}) } });
ok(r.s === 404, 'unknown file refused');
r = await call('PUT', '/files/fit-log.json', { token: FT, body: { content: Buffer.from('not json').toString('base64') } });
ok(r.s === 400, 'non-JSON refused');

// photos
const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 0xFF, 0xD9]);
r = await call('PUT', '/files/photos/items/2026-11-24_abc.jpg', { token: FT, body: { content: Buffer.from(jpg).toString('base64') } });
ok(r.s === 200, 'photo upload');
r = await call('PUT', '/files/photos/items/2026-11-24_abc.jpg', { token: FT, body: { content: Buffer.from(jpg).toString('base64') } });
ok(r.s === 422, 'second upload of same photo = 422 (app treats as done)');
r = await call('GET', '/files/photos/items/2026-11-24_abc.jpg', { token: FT });
ok(r.s === 200 && r.raw && r.raw.length === jpg.length && r.h.get('content-type') === 'image/jpeg', 'photo read back');
r = await call('GET', '/files/photos/items/2026-11-24_abc.jpg', { token: OT });
ok(r.s === 404, "owner can't see friend's photo");
r = await call('PUT', '/files/photos/items/x.jpg', { token: FT, body: { content: Buffer.from('<svg/>').toString('base64') } });
ok(r.s === 400, 'non-JPEG refused');
r = await call('PUT', '/files/photos/../wardrobe.jpg', { token: FT, body: { content: Buffer.from(jpg).toString('base64') } });
ok(r.s === 404, 'path trick refused');

// export + delete
r = await call('GET', '/export', { token: FT });
ok(r.s === 200 && r.j.files['wardrobe.json'].items.length === 2 && r.j.photos.length === 1, 'export');
r = await call('DELETE', '/me', { token: FT });
ok(r.s === 200, 'delete account');
r = await call('GET', '/me', { token: FT });
ok(r.s === 401, 'deleted account token dead');
r = await call('GET', '/invites', { token: OT });
ok(r.j.users.length === 1, 'deleted user gone from list');
r = await call('POST', '/auth/google', { body: { credential: await gtoken({ sub: 'f1', email: 'friend@example.com' }) } });
ok(r.s === 200, 'still-invited friend can come back fresh');
r = await call('GET', '/files/wardrobe.json', { token: r.j.token });
ok(r.s === 404, '...with an empty closet');
r = await call('DELETE', '/invites?email=friend@example.com', { token: OT });
ok(r.s === 200, 'invite removed');

await mf.dispose();
console.log(`worker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
