// CrossFit / Concept2 percentiles: maths, data selection, API, Sentinel read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-pct' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-pct'] = { id: 'pg-mem-shim-pct', filename: 'pg-mem-shim-pct', loaded: true, exports: pgAdapter };
Object.assign(process.env, { DATABASE_URL: 'postgres://fake/fake', SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SENTINEL_USER: 'sentinel', SENTINEL_PASS: 'sentinelpass456' });

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const { createPercentilesRouter } = require('../server/routes/percentiles');
const { createSentinelReadRouter } = require('../server/routes/sentinelRead');
const P = require('../server/lib/percentiles');
const strength = require('../server/lib/strength');

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const BY = Object.fromEntries(P.BENCHMARKS.map((b) => [b.id, b]));
let server; let base;
const call = async (method, path, body, auth = JAKE) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};
const reginaToday = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - 6 * 3600e3 - n * 864e5).toISOString().slice(0, 10);

test.before(async () => {
  await runMigrations();
  const app = express(); app.use(express.json()); app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  app.use('/api/fitness', createPercentilesRouter({ pool }));
  app.use('/api/sentinel', createSentinelReadRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

test('percentiles hit the published anchors exactly and run the right direction', () => {
  assert.equal(P.percentileOf(BY.deadlift, 396.8), 50);
  assert.equal(P.percentileOf(BY.deadlift, 341.7), 25);
  assert.equal(P.percentileOf(BY.deadlift, 440.9), 75);
  assert.equal(P.percentileOf(BY.fran, 262), 50);
  assert.equal(P.percentileOf(BY.fran, 192), 75, 'faster Fran beats more people');
  assert.equal(P.percentileOf(BY.row_2k, 443.7), 75);
  assert.equal(P.percentileOf(BY.row_2k, 417.0), 90);
  assert.equal(P.percentileOf(BY.fgb, 349), 75);
  assert.ok(P.percentileOf(BY.deadlift, 500) > 90 && P.percentileOf(BY.deadlift, 500) <= 99);
  assert.equal(P.percentileOf(BY.fran, 1200), 1);
  for (const b of P.BENCHMARKS) {
    const vals = b.anchors.map((a) => a[0]).sort((x, y) => x - y);
    const lo = P.percentileOf(b, vals[0] * 0.9); const hi = P.percentileOf(b, vals[vals.length - 1] * 1.1);
    if (b.better === 'high') assert.ok(hi > lo, b.id); else assert.ok(lo > hi, b.id);
  }
});

test('result parsing', () => {
  assert.equal(P.parseResult('4:12'), 252);
  assert.equal(P.parseResult('1:02:30'), 3750);
  assert.equal(P.parseResult('7:23.7'), 443.7);
  assert.equal(P.parseResult('312 reps'), 312);
  assert.equal(P.parseResult('5 rounds + 3'), null);
});

test('data selection: best ever with the recent best alongside, Rx-only WODs, conditioning distances, bodyweight level', () => {
  const today = '2026-10-18';
  const rows = {
    lifts: [
      { entry_date: '2026-09-30', lift: 'Deadlift', load_lb: 365, reps: 3 },   // e1RM 401.5: the 60-day best
      { entry_date: '2026-03-01', lift: 'Deadlift', load_lb: 420, reps: 1 },   // the best ever: the headline
      { entry_date: '2025-02-01', lift: 'Snatch', load_lb: 155, reps: 1 },     // over a year old → used, flagged stale
    ],
    gymnastics: [{ entry_date: '2026-10-01', movement: 'Strict Pull-Ups', reps: 22 }],
    conditioning: [{ entry_date: '2026-10-05', movement: 'Row', distance_m: 2000, duration_seconds: 450 }],
    benchmarks: [
      { entry_date: '2026-10-02', name: 'Fran', result: '2:58', rx: false },
      { entry_date: '2026-10-03', name: 'Fran', result: '3:40', rx: true },
      { entry_date: '2026-10-04', name: 'fight gone bad', result: '301', rx: null },
    ],
    bodyweight: [{ entry_date: '2026-10-10', weight_lb: 155 }],
    open: [{ id: 1, year: 2026, workout: 'overall', division: 'Men', rank: 30000, total: 120000, score: null }],
  };
  const r = P.computePercentiles(rows, today, strength);
  const b = Object.fromEntries(r.benchmarks.map((x) => [x.id, x]));
  assert.equal(b.deadlift.value, 420);
  assert.equal(b.deadlift.stale, false, 'under a year old');
  assert.equal(b.deadlift.recent.value, 401.5, 'the 60-day best rides alongside');
  assert.ok(b.deadlift.bodyweight_level && b.deadlift.bodyweight_level.ratio === 2.71);
  assert.equal(b.snatch.stale, true);
  assert.equal(b.snatch.recent, null);
  assert.equal(b.snatch.value, 155, 'a single counts at face value, not Epley-inflated');
  assert.equal(b.fran.display, '3:40', 'the scaled 2:58 is ignored');
  assert.equal(b.fgb.value, 301, 'name matching is case-insensitive; null rx counts as Rx');
  assert.equal(b.row_2k.display, '7:30');
  assert.equal(b.pullups.value, 22);
  assert.equal(b.helen.percentile, null);
  assert.equal(r.categories.find((c) => c.category === 'Open').percentile, 75);
  assert.equal(r.categories.find((c) => c.category === 'Gymnastics').percentile, b.pullups.percentile);
});

// Shaped like Jake's real log (Oct 31, 2026): PRs from 2023-24, light recent
// sets, "Other" benchmark rows carrying the name in the result, and pull-ups
// logged as "Pull-ups (Kipping)". The old 60-day / 12-month windows showed a
// 100 lb back squat (75 x 10 at RPE 3), a 237 lb deadlift and nothing else.
test("Jake's log: names as he logs them, best ever, warm-ups aren't maxes", () => {
  const rows = {
    lifts: [
      { entry_date: '2026-09-17', lift: 'Back Squat', load_lb: 75, reps: 10, rpe: 3 },
      { entry_date: '2024-08-02', lift: 'Back Squat', load_lb: 300, reps: 1, rpe: 0 },
      { entry_date: '2023-09-17', lift: 'Back Squat', load_lb: 328, reps: 1, rpe: 0 },
      { entry_date: '2023-07-17', lift: 'Front Squat + Back Squat', load_lb: 400, reps: 1, rpe: 0 },
      { entry_date: '2026-10-26', lift: 'Deadlift', load_lb: 215, reps: 3, rpe: 8.5 },
      { entry_date: '2026-10-26', lift: 'Deadlift', load_lb: 95, reps: 5, rpe: 3 },
      { entry_date: '2024-08-02', lift: 'Deadlift', load_lb: 335, reps: 1, rpe: 0 },
      { entry_date: '2023-09-15', lift: 'Clean and Jerk', load_lb: 190, reps: 1, rpe: 0 },
      { entry_date: '2024-07-31', lift: 'Snatch', load_lb: 140, reps: 1, rpe: 0 },
      { entry_date: '2026-10-16', lift: 'Pull-up', load_lb: 0, reps: 7, rpe: 0 },
    ],
    gymnastics: [{ entry_date: '2024-07-31', movement: 'Pull-ups (Kipping)', reps: 20 }],
    conditioning: [{ entry_date: '2026-09-12', movement: 'Weighted Vest (25lb) Run', distance_m: 1609.3, duration_seconds: 665 }],
    benchmarks: [
      { entry_date: '2023-07-29', name: 'Fran', result: '7:32', rx: true },
      { entry_date: '2024-11-12', name: 'Fran', result: '10:00', rx: true },
      { entry_date: '2024-08-01', name: 'Grace', result: '5:44', rx: true },
      { entry_date: '2024-07-31', name: 'Helen', result: '8:46', rx: true },
      { entry_date: '2023-09-17', name: '5k run', result: '22:23', rx: true },
      { entry_date: '2024-08-01', name: 'Other', result: 'Row 5k: 20:38', rx: true },
      { entry_date: '2023-11-13', name: 'Other', result: 'Pull-ups (Kipping): Max Reps: 10', rx: true },
      { entry_date: '2025-02-24', name: 'Other', result: 'Run 1 mile: 7:00', rx: true },
      { entry_date: '2025-03-04', name: 'Other', result: 'Amrap 12:: 4+8', rx: true },
      { entry_date: '2026-10-29', name: 'Metcon: 8-minute AMRAP couplet', result: '6 rounds + 8', rx: true },
    ],
    bodyweight: [{ entry_date: '2026-10-20', weight_lb: 147 }],
    open: [],
  };
  const r = P.computePercentiles(rows, '2026-10-31', strength);
  const b = Object.fromEntries(r.benchmarks.map((x) => [x.id, x]));
  assert.equal(b.back_squat.display, '328 lb');
  assert.equal(b.back_squat.date, '2023-09-17');
  assert.equal(b.back_squat.stale, true);
  assert.equal(b.back_squat.recent, null, 'a 75 lb x 10 warm-up at RPE 3 is no estimate of a max');
  assert.equal(b.back_squat.percentile, P.percentileOf(BY.back_squat, 328));
  assert.ok(b.back_squat.percentile > 50);
  assert.equal(b.deadlift.value, 335);
  assert.equal(b.deadlift.recent.value, 236.5, 'e1RM from 215 x 3, the easy sets skipped');
  assert.equal(b.clean_jerk.value, 190, '"Clean and Jerk" is "Clean & Jerk"');
  assert.equal(b.snatch.value, 140);
  assert.equal(b.pullups.value, 20, '"Pull-ups (Kipping)" counts');
  assert.equal(b.pullups.recent.value, 7, 'a bodyweight "Pull-up" set logged as a lift counts');
  assert.equal(b.row_5k.display, '20:38', 'an "Other" row carries the name in its result');
  assert.equal(b.run_5k.display, '22:23');
  assert.equal(b.run_400.percentile, null, 'a weighted-vest mile is not a 400 m run');
  assert.equal(b.fran.display, '7:32', 'fastest, not the latest 10:00');
  assert.ok(b.fran.percentile < 25, 'a slow time sits low');
  assert.equal(b.grace.display, '5:44');
  assert.equal(b.helen.display, '8:46');
  assert.equal(b.row_2k.percentile, null);
  for (const cat of ['Strength', 'Olympic', 'Gymnastics', 'Cardio', 'Metcon']) assert.ok(r.categories.find((c) => c.category === cat).percentile != null, cat);
  // Nothing logged after "today" counts.
  const early = P.computePercentiles(rows, '2023-08-01', strength);
  assert.equal(early.benchmarks.find((x) => x.id === 'back_squat').display, null);
});

test('movement names match however they are written', () => {
  const same = [['Pull-ups (Kipping)', 'Kipping Pull-Ups'], ['Pull-up', 'Pull-Ups'], ['Row 5k', '5k row'], ['5000m row', '5k row'],
    ['2000 m row', '2k row'], ['5 km run', '5k run'], ['Run 400m', '400 m run'], ['Clean and Jerk', 'Clean & Jerk'], ['back squat', 'Back Squat']];
  for (const [a, x] of same) assert.equal(P.canon(a), P.canon(x), `${a} = ${x}`);
  assert.notEqual(P.canon('Front Squat + Back Squat'), P.canon('Back Squat'));
  assert.notEqual(P.canon('Strict Press'), P.canon('Push Press'));
  assert.deepEqual(P.benchmarkEntries({ name: 'Other', result: 'Pull-ups (Kipping): Max Reps: 10' })[1], { name: 'Pull-ups (Kipping)', result: '10' });
});

test('API: benchmarks carry Rx, Open results validate, /percentiles and Sentinel read agree', async () => {
  assert.equal((await call('POST', '/fitness/benchmarks', { entry_date: daysAgo(3), name: 'Grace', result: '2:30', rx: false })).body.rx, false);
  await call('POST', '/fitness/benchmarks', { entry_date: daysAgo(2), name: 'Grace', result: '2:45' });
  const list = (await call('GET', '/fitness/benchmarks')).body;
  assert.ok(list.every((x) => typeof x.rx === 'boolean'));

  assert.equal((await call('POST', '/fitness/open-results', { year: 2026, workout: 'overall', division: 'Men', rank: 10, total: 5 })).status, 400);
  assert.equal((await call('POST', '/fitness/open-results', { year: 2026, workout: '26.1', division: '', rank: 1, total: 5 })).status, 400);
  const o = await call('POST', '/fitness/open-results', { year: 2026, workout: 'Overall', division: 'Men 35-39', rank: 2000, total: 20000, score: '' });
  assert.equal(o.status, 201); assert.equal(o.body.workout, 'overall');

  const p = await call('GET', '/fitness/percentiles');
  assert.equal(p.status, 200);
  assert.equal(p.body.as_of, reginaToday());
  const grace = p.body.benchmarks.find((x) => x.id === 'grace');
  assert.equal(grace.display, '2:45', 'scaled Grace excluded');
  assert.equal(p.body.categories.find((c) => c.category === 'Open').percentile, 90);

  const s = await call('GET', '/sentinel/read/crossfit_percentiles?category=Metcon', null, SENTINEL);
  assert.equal(s.status, 200);
  const sg = s.body.rows.find((x) => x.id === 'grace');
  assert.equal(sg.percentile, grace.percentile);

  assert.equal((await call('DELETE', `/fitness/open-results/${o.body.id}`)).status, 204);
  assert.equal((await call('DELETE', '/fitness/open-results/abc')).status, 404);
});
