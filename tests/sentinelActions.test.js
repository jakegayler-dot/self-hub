// Sentinel API bridge (/api/sentinel/actions/*), against a small Express app
// built the same way server/index.js builds the real one. No database.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://fake/fake'; // pool is lazy; never queried here
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';
process.env.SENTINEL_USER = 'sentinel';
process.env.SENTINEL_PASS = 'sentinelpass456';

const express = require('express');
const { basicAuth } = require('../server/middleware/basicAuth');
const { createSentinelActionsRouter, trackMountPaths, matchesRoute } = require('../server/routes/sentinelActions');

trackMountPaths();
const fitnessRouter = require('../server/routes/fitness');

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const seen = [];
const logs = [];
let server;
let base;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(basicAuth);

  const things = express.Router();
  const nested = express.Router();
  nested.get('/:thingId/notes', (req, res) => res.json({ thing: req.params.thingId }));
  things.use('/deep', nested);
  things.get('/', (req, res) => {
    seen.push({ auth: req.headers.authorization, isSentinel: !!req.isSentinel, query: req.query });
    res.json({ items: [1, 2], q: req.query });
  });
  things.post('/', (req, res) => {
    seen.push({ auth: req.headers.authorization, isSentinel: !!req.isSentinel, body: req.body });
    res.status(201).json({ created: req.body });
  });
  things.delete('/:id', (req, res) => res.json({ deleted: req.params.id }));
  things.get('/big', (req, res) => res.type('text').send('x'.repeat(300 * 1024)));
  things.get('/broken', (req, res) => res.status(400).json({ error: 'bad thing' }));
  app.use('/api/things', things);
  app.get('/api/things', (req, res) => res.json({ dup: true })); // duplicate, listed once

  app.use('/api/fitness', fitnessRouter);
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  app.get('/api/user/profile', (req, res) => res.json({ ok: true }));
  app.put('/api/password', (req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ ok: true }));
  const sentinelRead = express.Router();
  sentinelRead.get('/read', (req, res) => res.json({ ok: true }));
  app.use('/api/sentinel', sentinelRead);
  app.use('/api/sentinel', createSentinelActionsRouter({ log: (l) => logs.push(l) }));
  app.get('/js/strength.js', (req, res) => res.send(''));
  app.get('/*splat', (req, res) => res.send('index'));
  return app;
}

async function call(method, path, { auth = SENTINEL, body } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: parsed };
}
const bridge = (payload, auth) => call('POST', '/api/sentinel/actions/api', { auth, body: payload });

test.before(async () => {
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('routes: lists every /api route incl. nested routers, sorted and de-duplicated', async () => {
  const r = await call('GET', '/api/sentinel/actions/routes');
  assert.equal(r.status, 200);
  const keys = r.body.routes.map((x) => `${x.method} ${x.path}`);
  for (const k of [
    'GET /api/things', 'POST /api/things', 'DELETE /api/things/:id', 'GET /api/things/deep/:thingId/notes',
    'GET /api/fitness/profile', 'PUT /api/fitness/profile', 'POST /api/fitness/lifts', 'DELETE /api/fitness/lifts/:id',
    'DELETE /api/fitness/benchmark-lifts/:lift', 'GET /api/fitness/coach-prompt',
  ]) assert.ok(keys.includes(k), `missing ${k}`);
  assert.equal(keys.filter((k) => k === 'GET /api/things').length, 1);
  const sorted = [...r.body.routes].sort((a, b) => (a.path + ' ' + a.method).localeCompare(b.path + ' ' + b.method));
  assert.deepEqual(r.body.routes.map((x) => x.path), sorted.map((x) => x.path));
});

test('routes: excludes sentinel, auth/login/session/user/password and non-/api routes', async () => {
  const r = await call('GET', '/api/sentinel/actions/routes');
  for (const x of r.body.routes) {
    assert.ok(x.path.startsWith('/api/'), x.path);
    assert.ok(!x.path.startsWith('/api/sentinel'), x.path);
    assert.ok(!/login|auth|session|user|password/i.test(x.path), x.path);
  }
});

test('unauthenticated or wrong password → 401', async () => {
  assert.equal((await call('GET', '/api/sentinel/actions/routes', { auth: null })).status, 401);
  assert.equal((await bridge({ method: 'GET', path: '/api/things' }, null)).status, 401);
  const wrong = 'Basic ' + Buffer.from('sentinel:nope').toString('base64');
  assert.equal((await bridge({ method: 'GET', path: '/api/things' }, wrong)).status, 401);
  const noColon = 'Basic ' + Buffer.from('sentinel').toString('base64');
  assert.equal((await call('GET', '/api/sentinel/actions/routes', { auth: noColon })).status, 401);
});

test('refused paths and methods → 422', async () => {
  const bad = [
    { method: 'GET', path: '/api/sentinel/read' },
    { method: 'POST', path: '/api/sentinel/actions/api' },
    { method: 'GET', path: '/API/Sentinel/read' },
    { method: 'GET', path: '/api/Sentinel/read' },
    { method: 'GET', path: '/api/things/../sentinel/read' },
    { method: 'GET', path: '/api/things/%2e%2e/sentinel/read' },
    { method: 'GET', path: '/api//things' },
    { method: 'GET', path: '/healthz' },
    { method: 'GET', path: 'http://example.com/api/things' },
    { method: 'POST', path: '/api/auth/login' },
    { method: 'GET', path: '/api/user/profile' },
    { method: 'GET', path: '/api/nope' },
    { method: 'PATCH', path: '/api/things' },
    { method: 'HEAD', path: '/api/things' },
    { method: 'GET', path: '/api/things?x=1' },
    { method: 'GET' },
    {},
  ];
  for (const p of bad) {
    const r = await bridge(p);
    assert.equal(r.status, 422, JSON.stringify(p));
    assert.ok(r.body.error);
  }
  assert.equal((await bridge({ method: 'GET', path: '/api/things', query: 'x=1' })).status, 422);
});

test('proxied GET reaches the route as the owner, with query', async () => {
  seen.length = 0;
  const r = await bridge({ method: 'get', path: '/api/things', query: { a: 'b', n: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 200, body: { items: [1, 2], q: { a: 'b', n: '2' } } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, JAKE); // owner login, not Sentinel's
  assert.equal(seen[0].isSentinel, false);
  assert.ok(logs.some((l) => l.startsWith('sentinel bridge: GET /api/things -> 200')));
});

test('proxied POST carries the body; params and nested routes work; inner status is mirrored', async () => {
  const p = await bridge({ method: 'POST', path: '/api/things', body: { name: 'squat' } });
  assert.equal(p.status, 201);
  assert.deepEqual(p.body, { status: 201, body: { created: { name: 'squat' } } });

  const d = await bridge({ method: 'DELETE', path: '/api/things/42' });
  assert.deepEqual(d.body, { status: 200, body: { deleted: '42' } });

  const n = await bridge({ method: 'GET', path: '/api/things/deep/Back%20Squat/notes' });
  assert.deepEqual(n.body, { status: 200, body: { thing: 'Back Squat' } });

  const b = await bridge({ method: 'GET', path: '/api/things/broken' });
  assert.equal(b.status, 400);
  assert.deepEqual(b.body, { status: 400, body: { error: 'bad thing' } });
});

test('large responses are truncated to ~200 KB text', async () => {
  const r = await bridge({ method: 'GET', path: '/api/things/big' });
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, true);
  assert.equal(r.body.body.length, 200 * 1024);
});

test('matchesRoute', () => {
  assert.ok(matchesRoute('/api/a/:id', '/api/a/5'));
  assert.ok(!matchesRoute('/api/a/:id', '/api/a/'));
  assert.ok(!matchesRoute('/api/a/:id', '/api/a/5/6'));
  assert.ok(matchesRoute('/api/a/*rest', '/api/a/5/6'));
  assert.ok(!matchesRoute('/api/a', '/api/b'));
});
