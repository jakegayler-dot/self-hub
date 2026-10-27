// Signing in once (2026-10-26): a login page and a 400-day signed cookie instead of the browser's Basic prompt,
// which phones forget. Sentinel keeps its Basic login.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
Object.assign(process.env, { SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SENTINEL_USER: 'sentinel', SENTINEL_PASS: 'sentinelpass456' });
const { basicAuth, makeToken, checkToken, COOKIE } = require('../server/middleware/basicAuth');

let server; let base;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use(basicAuth);
  app.get('/api/thing', (req, res) => res.json({ ok: true, sentinel: req.isSentinel === true }));
  app.get('/', (req, res) => res.send('<html>app</html>'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));
const go = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('signed out: pages go to the login page, the API answers 401 without the browser prompt', async () => {
  let r = await go('/', { headers: { Accept: 'text/html' } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/login?next=%2F');
  r = await go('/api/thing');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('www-authenticate'), null);
  assert.equal((await r.json()).login, '/login');
  r = await go('/login?next=%2F');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /autocomplete="current-password"/);
});

test('sign in once: a 400-day HttpOnly cookie that opens everything; wrong passwords refused, then slowed', async () => {
  let r = await go('/login', form({ username: 'jake', password: 'nope', next: '/' }));
  assert.equal(r.status, 401);
  assert.match(await r.text(), /Wrong username or password/);
  r = await go('/login', form({ username: 'jake', password: 'testpass123', next: '/?tab=nutrition' }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/?tab=nutrition');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, new RegExp(`^${COOKIE}=v1\\.`));
  assert.match(sc, /Max-Age=34560000/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/);
  assert.doesNotMatch(sc, /Secure/); // plain http here; Railway's https adds it
  const c = cookieOf(r);
  r = await go('/api/thing', { headers: { Cookie: c } });
  assert.equal(r.status, 200);
  r = await go('/', { headers: { Cookie: c, Accept: 'text/html' } });
  assert.equal(r.status, 200);
  // Behind Railway's https proxy the cookie is Secure.
  r = await go('/login', { ...form({ username: 'jake', password: 'testpass123' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' } });
  assert.match(r.headers.get('set-cookie'), /Secure/);
  // Only a path on this site after signing in.
  r = await go('/login', form({ username: 'jake', password: 'testpass123', next: '//evil.example/' }));
  assert.equal(r.headers.get('location'), '/');
  // Sign out.
  r = await go('/logout', { method: 'POST', headers: { Cookie: c } });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('tokens: forged, expired or signed with an old password are refused; renewed as he uses it', () => {
  const now = 1_800_000_000;
  const t = makeToken(now);
  assert.ok(checkToken(t, now + 10) > 0);
  assert.equal(checkToken(t, now + 401 * 86400), 0, 'expired');
  assert.equal(checkToken(t.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')), now), 0, 'tampered');
  assert.equal(checkToken(t.replace(/v1\.\d+/, `v1.${now + 9e9}`), now), 0, 'expiry changed');
  assert.equal(checkToken(t, now, { SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'a-new-password' }), 0, 'password changed: signed out');
  assert.equal(checkToken('junk', now), 0);
});

test('Sentinel and scripts keep Basic; the old Basic prompt gets a cookie; too many wrong passwords wait', async () => {
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  let r = await go('/api/thing', { headers: { Authorization: basic('sentinel', 'sentinelpass456') } });
  assert.deepEqual(await r.json(), { ok: true, sentinel: true });
  assert.equal(r.headers.get('set-cookie'), null);
  r = await go('/api/thing', { headers: { Authorization: basic('sentinel', 'wrong') } });
  assert.equal(r.status, 401);
  r = await go('/', { headers: { Authorization: basic('jake', 'testpass123'), Accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), new RegExp(`^${COOKIE}=`));
  for (let i = 0; i < 10; i++) await go('/login', form({ username: 'jake', password: `x${i}` }));
  r = await go('/login', form({ username: 'jake', password: 'testpass123' }));
  assert.equal(r.status, 429);
});
