// Sentinel summary builder + push scheduler, against an in-memory Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const pgAdapter = mem.adapters.createPg();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return 'pg-mem-shim';
  return origResolve.call(this, request, ...args);
};
require.cache['pg-mem-shim'] = { id: 'pg-mem-shim', filename: 'pg-mem-shim', loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const strength = require('../server/lib/strength');
const { buildSummary, summarize, createSentinelPusher, reginaDate, reginaWeek } = require('../server/lib/sentinel');

const NOW = new Date('2026-09-30T18:00:00Z'); // Wed 12:00 in Regina
const quietLogger = { log() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await runMigrations();
  const lifts = [
    ['2026-09-27', 'Back Squat', 245, 5], // Sunday: previous Regina week
    ['2026-09-28', 'Back Squat', 250, 3],
    ['2026-09-28', 'Bench Press', 185, 5],
    ['2026-09-30', 'Deadlift', 335, 3],
    ['2026-09-30', 'Strict Press', 115, 5],
    ['2026-09-29', 'Barbell Curl 21s', 65, 21], // accessory: counts as a session day, not scored
    ['2026-06-01', 'Deadlift', 405, 1], // outside the 2-month window
  ];
  for (const [d, l, w, r] of lifts) {
    await pool.query('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps) VALUES ($1,$2,$3,$4)', [d, l, w, r]);
  }
  await pool.query("INSERT INTO fitness_benchmark_lifts (lift) VALUES ('Barbell Curl 21s') ON CONFLICT (lift) DO NOTHING");
  for (const [d, w] of [['2026-09-01', 160], ['2026-09-15', 162], ['2026-09-29', 164]]) {
    await pool.query('INSERT INTO fitness_bodyweight (entry_date, weight_lb) VALUES ($1,$2)', [d, w]);
  }
});

test('Regina date and Monday-start week', () => {
  assert.equal(reginaDate(new Date('2026-10-01T03:00:00Z')), '2026-09-30');
  assert.deepEqual(reginaWeek(NOW), { start: '2026-09-28', end: '2026-10-04' });
  // Sunday 21:00 Regina is still the same week
  assert.deepEqual(reginaWeek(new Date('2026-10-05T03:00:00Z')), { start: '2026-09-28', end: '2026-10-04' });
  // Monday 00:30 Regina starts a new one
  assert.deepEqual(reginaWeek(new Date('2026-10-05T06:30:00Z')), { start: '2026-10-05', end: '2026-10-11' });
});

test('buildSummary produces the Sentinel shape', async () => {
  const body = await buildSummary(pool, NOW);
  assert.equal(body.generated_at, NOW.toISOString());
  const s = body.summary.strength;
  assert.equal(s.window, '2 months');
  assert.equal(s.as_of, '2026-09-30');
  assert.equal(s.bodyweight_avg_lb, 162);
  assert.deepEqual(s.lifts.map((l) => l.lift).sort(), ['Back Squat', 'Bench Press', 'Deadlift', 'Strict Press']);
  const dl = s.lifts.find((l) => l.lift === 'Deadlift');
  assert.equal(dl.e1rm_lb, 368.5); // 335 × (1 + 3/30); the 405 from June is outside the window
  assert.equal(dl.ratio, Math.round((368.5 / 162) * 100) / 100);
  assert.equal(dl.score, strength.levelScore(368.5 / 162, strength.STRENGTH_STANDARDS.Deadlift));
  assert.equal(s.by_pattern.length, 4);
  const mean = Math.round(s.by_pattern.reduce((a, p) => a + p.score, 0) / s.by_pattern.length);
  assert.equal(s.overall_score, mean);
  assert.equal(s.level, strength.levelLabel(mean));
  // 09-28, 09-29, 09-30 — not Sunday 09-27
  assert.deepEqual(body.summary.training_week, { sessions_done: 3, sessions_goal: 4 });
  assert.deepEqual(body.summary.needs_input, []);
});

test('the page and the push agree (API rows → shared module vs /sentinel-preview)', async () => {
  const app = express();
  app.use(express.json());
  app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  const server = app.listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api/fitness`;
    const headers = { Authorization: 'Basic ' + Buffer.from('jake:testpass123').toString('base64') };
    const get = async (p) => (await fetch(base + p, { headers })).json();
    assert.equal((await fetch(base + '/sentinel-preview')).status, 401);
    const [lifts, bodyweight, benchmarkLifts, preview] = await Promise.all([
      get('/lifts'), get('/bodyweight'), get('/benchmark-lifts'), get('/sentinel-preview'),
    ]);
    const page = strength.computeStrengthProfile({ lifts, bodyweight, benchmarkLifts }, new Date());
    const s = preview.summary.strength;
    assert.deepEqual(s.by_pattern, page.patterns);
    assert.deepEqual(s.lifts, page.rows.map((r) => ({ lift: r.lift, e1rm_lb: r.e1rm, ratio: Math.round(r.ratio * 100) / 100, score: r.score, level: r.level })));
  } finally {
    server.close();
  }
});

test('needs_input: no bodyweight, stale bodyweight, no lifts', () => {
  const lifts = [{ entry_date: new Date('2026-09-20T00:00:00Z'), lift: 'Back Squat', load_lb: '225.0', reps: 5 }];
  const none = summarize({ data: { lifts, bodyweight: [], benchmarkLifts: ['Back Squat'] }, profileRow: null, sessionsDone: 0, now: NOW });
  assert.equal(none.summary.strength.overall_score, null);
  assert.equal(none.summary.strength.level, null);
  assert.equal(none.summary.strength.bodyweight_avg_lb, null);
  assert.deepEqual(none.summary.strength.by_pattern, []); // page would show "Elite (NaN)"; Sentinel gets nothing
  assert.deepEqual(none.summary.strength.lifts, []);
  assert.deepEqual(none.summary.training_week, { sessions_done: 0, sessions_goal: null });
  assert.equal(none.summary.needs_input.length, 1);
  assert.match(none.summary.needs_input[0].text, /No bodyweight logged — strength can't be scored/);

  const stale = summarize({ data: { lifts, bodyweight: [{ entry_date: new Date('2026-05-01T00:00:00Z'), weight_lb: '158.0' }], benchmarkLifts: ['Back Squat'] }, profileRow: { weekly_strength_sessions_goal: 4 }, sessionsDone: 1, now: NOW });
  assert.equal(stale.summary.strength.bodyweight_avg_lb, 158);
  assert.ok(stale.summary.strength.overall_score > 0);
  assert.equal(stale.summary.needs_input[0].text, 'No bodyweight logged in 2 months');
  assert.match(stale.summary.needs_input[0].detail, /158 lb on 2026-05-01/);

  const noLifts = summarize({ data: { lifts: [], bodyweight: [{ entry_date: new Date('2026-09-20T00:00:00Z'), weight_lb: '160.0' }], benchmarkLifts: ['Back Squat'] }, profileRow: null, sessionsDone: 0, now: NOW });
  assert.equal(noLifts.summary.strength.overall_score, null);
  assert.match(noLifts.summary.needs_input[0].text, /No benchmark lifts logged in 2 months/);
});

test('pusher is a no-op (logs once) without SENTINEL_URL / SENTINEL_API_KEY', () => {
  const lines = [];
  let fetched = 0;
  const p = createSentinelPusher({ env: { SENTINEL_URL: 'https://s.example' }, logger: { log: (m) => lines.push(m), error() {} }, fetchImpl: () => { fetched++; } });
  assert.equal(p.enabled, false);
  p.start(); p.notifyWrite(); p.notifyWrite();
  assert.equal(lines.length, 1);
  assert.equal(p.state.timer, null);
  assert.equal(fetched, 0);
});

test('pusher debounces writes, posts with bearer auth, backs off on failure', async () => {
  const calls = [];
  let fail = true;
  const p = createSentinelPusher({
    env: { SENTINEL_URL: 'https://sentinel.example/', SENTINEL_API_KEY: 'k123' },
    logger: quietLogger,
    build: async () => ({ generated_at: 'x', summary: { ok: true } }),
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return fail ? { ok: false, status: 503, text: async () => 'down' } : { ok: true, status: 202 }; },
    debounceMs: 20, bootDelayMs: 10000, backoffMinMs: 40, backoffMaxMs: 60,
  });
  p.notifyWrite(); p.notifyWrite(); p.notifyWrite();
  await sleep(50);
  assert.equal(calls.length, 1, 'three writes → one debounced push');
  assert.equal(calls[0].url, 'https://sentinel.example/v1/sources/self_hub/summary');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k123');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { generated_at: 'x', summary: { ok: true } });
  assert.equal(p.state.failures, 1);
  assert.match(p.state.lastError, /HTTP 503: down/);

  // a write during backoff does not jump the queue
  p.notifyWrite();
  await sleep(10);
  assert.equal(calls.length, 1);
  fail = false;
  await sleep(60);
  assert.equal(calls.length, 2, 'retried after backoff');
  assert.equal(p.state.failures, 0);
  assert.ok(p.state.lastSuccessAt);
  p.stop();
});

test('pusher survives a throwing build and fetch', async () => {
  const p = createSentinelPusher({
    env: { SENTINEL_URL: 'https://s.example', SENTINEL_API_KEY: 'k' },
    logger: quietLogger,
    build: async () => { throw new Error('db down'); },
    fetchImpl: async () => { throw new Error('unreachable'); },
    debounceMs: 5, backoffMinMs: 100000,
  });
  p.notifyWrite();
  await sleep(30);
  assert.equal(p.state.failures, 1);
  assert.equal(p.state.lastError, 'db down');
  p.stop();
});

test('middleware schedules only after successful POST/PUT/DELETE', async () => {
  const p = createSentinelPusher({ env: { SENTINEL_URL: 'https://s.example', SENTINEL_API_KEY: 'k' }, logger: quietLogger });
  const app = express();
  app.use(express.json());
  app.use('/api', p.middleware);
  app.get('/api/x', (req, res) => res.json({}));
  app.post('/api/x', (req, res) => res.status(201).json({}));
  app.post('/api/bad', (req, res) => res.status(400).json({}));
  app.delete('/api/x', (req, res) => res.status(204).end());
  const server = app.listen(0);
  try {
    const base = `http://localhost:${server.address().port}/api`;
    await fetch(base + '/x');
    assert.equal(p.state.timer, null, 'GET does not schedule');
    await fetch(base + '/bad', { method: 'POST' });
    await sleep(5);
    assert.equal(p.state.timer, null, '4xx does not schedule');
    await fetch(base + '/x', { method: 'POST' });
    await sleep(5);
    assert.ok(p.state.timer, 'successful POST schedules');
    p.stop();
    await fetch(base + '/x', { method: 'DELETE' });
    await sleep(5);
    assert.ok(p.state.timer, 'successful DELETE schedules');
  } finally {
    p.stop();
    server.close();
  }
});

test('body: latest weigh-in, 30-day change and latest measurements', () => {
  const NOW2 = new Date('2026-09-30T18:00:00Z');
  const bodyweight = [
    { entry_date: new Date('2026-08-20T00:00:00Z'), weight_lb: '205.0', body_fat_pct: '19.0' },
    { entry_date: new Date('2026-09-28T00:00:00Z'), weight_lb: '201.4', body_fat_pct: '17.5' },
  ];
  const measurements = [
    { entry_date: new Date('2026-06-01T00:00:00Z'), waist: '36.0' },
    { entry_date: new Date('2026-09-15T00:00:00Z'), waist: '34.5', neck: '16.0', inseam_low: '29.0', inseam_high: '30.0', bust: null },
  ];
  const out = summarize({ data: { lifts: [], bodyweight, benchmarkLifts: [] }, profileRow: null, sessionsDone: 0, now: NOW2, measurements });
  assert.deepEqual(out.summary.body, {
    weight_lb: 201.4, body_fat_pct: 17.5, weighed_on: '2026-09-28', weight_change_30d_lb: -3.6,
    measurements: { as_of: '2026-09-15', inches: { waist: 34.5, neck: 16, inseam_low: 29, inseam_high: 30 } },
  });
  const empty = summarize({ data: { lifts: [], bodyweight: [], benchmarkLifts: [] }, profileRow: null, sessionsDone: 0, now: NOW2 });
  assert.deepEqual(empty.summary.body, { weight_lb: null, body_fat_pct: null, weighed_on: null, weight_change_30d_lb: null, measurements: null });
});
