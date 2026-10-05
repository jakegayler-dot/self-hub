// Sentinel read API (GET /api/sentinel/read…), against an in-memory Postgres.
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
process.env.SENTINEL_USER = 'sentinel';
process.env.SENTINEL_PASS = 'sentinelpass456';

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const { createSentinelReadRouter } = require('../server/routes/sentinelRead');
const { buildSummary } = require('../server/lib/sentinel');
const { computeWeeklyLoad } = require('../server/lib/weeklyLoad');

const NOW = new Date('2026-09-30T18:00:00Z'); // Wed 12:00 in Regina
const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const LONG_NOTE = 'Eat more. '.repeat(300); // 3000 chars
let server;
let base;

async function get(path, auth = SENTINEL) {
  const r = await fetch(base + path, { headers: auth ? { Authorization: auth } : {} });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text };
}

test.before(async () => {
  await runMigrations();
  const q = (sql, p) => pool.query(sql, p);
  const lifts = [
    ['2026-06-01', 'Deadlift', 405, 1],
    ['2026-09-27', 'Back Squat', 245, 5],
    ['2026-09-28', 'Back Squat', 250, 3],
    ['2026-09-28', 'Bench Press', 185, 5],
    ['2026-09-29', 'Barbell Curl 21s', 65, 21],
    ['2026-09-30', 'Deadlift', 335, 3],
    ['2026-09-30', 'Strict Press', 115, 5],
  ];
  for (const [d, l, w, r] of lifts) await q('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps, rpe) VALUES ($1,$2,$3,$4,8)', [d, l, w, r]);
  for (const [d, w, bf] of [['2026-07-01', 158, 12.5], ['2026-09-01', 160, null], ['2026-09-15', 162, 11.8], ['2026-09-29', 164, null]]) {
    await q('INSERT INTO fitness_bodyweight (entry_date, weight_lb, body_fat_pct) VALUES ($1,$2,$3)', [d, w, bf]);
  }
  await q('UPDATE fitness_profile SET bodyweight_goal_lb = 175, phase = 1 WHERE id = 1');
  await q("INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ('2026-09-29','Row',2000,445,'2k test'), ('2026-09-10','Row',5000,1260,null)");
  await q("INSERT INTO fitness_benchmarks (entry_date, name, result) VALUES ('2026-09-20','Fran','4:12 Rx')");
  await q("INSERT INTO fitness_measurements (entry_date, shoulder, waist, neck) VALUES ('2026-08-01', 47, 32, 15), ('2026-09-25', 48, 31.5, null)");
  await q("INSERT INTO fitness_coach_notes (entry_date, source, note) VALUES ('2026-09-28','sentinel',$1), ('2026-09-29','manual','Deload next week')", [LONG_NOTE]);
  // 250 push-up sets with ~1.1 KB notes: drives the limit cap and the 200 KB cap.
  for (let i = 0; i < 250; i++) {
    const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    await q('INSERT INTO fitness_gymnastics (entry_date, movement, reps, notes) VALUES ($1,$2,$3,$4)', [d, 'Push-Ups', 10 + (i % 30), 'x'.repeat(1100)]);
  }

  const app = express();
  app.use(express.json());
  app.use(basicAuth);
  app.use('/api/sentinel', createSentinelReadRouter({ pool, now: () => NOW }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://localhost:${server.address().port}/api/sentinel`;
});

test.after(() => server && server.close());

test('auth: no or wrong credentials get 401; Jake and Sentinel logins both work', async () => {
  assert.equal((await get('/read', null)).status, 401);
  assert.equal((await get('/read', 'Basic ' + Buffer.from('jake:nope').toString('base64'))).status, 401);
  assert.equal((await get('/read/lifts', null)).status, 401);
  assert.equal((await get('/read', JAKE)).status, 200);
  assert.equal((await get('/read', SENTINEL)).status, 200);
});

test('catalog lists every collection with description, filters and fields', async () => {
  const { body } = await get('/read');
  assert.equal(body.app, 'self_hub');
  const names = body.collections.map((c) => c.name);
  for (const n of ['profile', 'bodyweight', 'body_fat', 'lifts', 'conditioning', 'gymnastics', 'benchmarks', 'measurements', 'coach_notes',
    'benchmark_lifts', 'strength_score', 'strength_trend', 'personal_bests', 'movement_bests', 'weight_trend', 'training_week', 'measurements_change']) {
    assert.ok(names.includes(n), n);
  }
  for (const c of body.collections) {
    assert.ok(c.description.length > 20, c.name);
    assert.ok(c.filters.includes('id'), c.name);
    assert.ok(c.fields.includes('id'), c.name);
    for (const f of c.fields) assert.doesNotMatch(f, /password|token|secret|api_?key|^session(_id)?$|cookie/i);
  }
  assert.deepEqual(body.collections.find((c) => c.name === 'lifts').filters, ['search', 'id', 'from', 'to', 'month', 'lift', 'pattern', 'benchmark_only']);
});

test('every collection reads with defaults and leaks no credentials', async () => {
  const { body } = await get('/read');
  for (const c of body.collections) {
    const r = await get(`/read/${c.name}`);
    assert.equal(r.status, 200, c.name);
    assert.equal(r.body.collection, c.name);
    assert.equal(r.body.count, r.body.rows.length);
    assert.ok(r.body.count <= 50);
    assert.ok(r.body.total >= r.body.count);
    assert.ok(r.text.length < 200 * 1024, c.name);
    assert.doesNotMatch(r.text, /testpass123|sentinelpass456/);
    for (const row of r.body.rows) assert.ok('id' in row, c.name);
  }
});

test('lifts: newest first, readable fields, e1RM and pattern', async () => {
  const { body } = await get('/read/lifts');
  assert.equal(body.total, 7);
  assert.equal(body.truncated, false);
  const dates = body.rows.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const dl = body.rows.find((r) => r.lift === 'Deadlift' && r.date === '2026-09-30');
  assert.deepEqual(Object.keys(dl), ['id', 'date', 'lift', 'load_lb', 'reps', 'rpe', 'e1rm_lb', 'pattern', 'benchmark_lift']);
  assert.equal(dl.load_lb, 335);
  assert.equal(dl.e1rm_lb, 368.5);
  assert.equal(dl.pattern, 'Hinge');
  assert.equal(dl.benchmark_lift, true);
  assert.equal(body.rows.find((r) => r.lift === 'Barbell Curl 21s').benchmark_lift, false);
});

test('filters: search, custom filters, from/to, month', async () => {
  let r = await get('/read/lifts?search=SQUAT');
  assert.deepEqual(r.body.rows.map((x) => x.lift), ['Back Squat', 'Back Squat']);
  r = await get('/read/lifts?search=back%20squat');
  assert.equal(r.body.total, 2);
  r = await get('/read/lifts?lift=deadlift');
  assert.equal(r.body.total, 2);
  r = await get('/read/lifts?pattern=push%20horizontal');
  assert.deepEqual(r.body.rows.map((x) => x.lift), ['Bench Press']);
  r = await get('/read/lifts?benchmark_only=true');
  assert.equal(r.body.total, 6);
  r = await get('/read/lifts?from=2026-09-28&to=2026-09-29');
  assert.equal(r.body.total, 3);
  r = await get('/read/lifts?month=2026-06');
  assert.deepEqual(r.body.rows.map((x) => x.date), ['2026-06-01']);
  r = await get('/read/coach_notes?search=deload');
  assert.deepEqual(r.body.rows.map((x) => x.note), ['Deload next week']);
  r = await get('/read/conditioning?movement=row');
  assert.equal(r.body.rows[0].duration, '7:25');
  r = await get('/read/body_fat');
  assert.deepEqual(r.body.rows.map((x) => x.body_fat_pct), [11.8, 12.5]);
  // personal_bests: from/to limit which sets count
  r = await get('/read/personal_bests?lift=Deadlift');
  assert.equal(r.body.rows[0].best_e1rm_lb, 418.5);
  assert.equal(r.body.rows[0].best_e1rm_set, '405 lb x 1');
  r = await get('/read/personal_bests?lift=Deadlift&from=2026-08-01');
  assert.equal(r.body.rows[0].best_e1rm_lb, 368.5);
});

test('id returns one record in full; long text is trimmed in lists only', async () => {
  const all = await get('/read/coach_notes');
  const long = all.body.rows.find((x) => x.source === 'sentinel');
  assert.ok(long.note.length < 1100 && long.note.endsWith('[trimmed]'));
  const one = await get(`/read/coach_notes?id=${long.id}`);
  assert.equal(one.body.count, 1);
  assert.equal(one.body.rows[0].note, LONG_NOTE);
  const none = await get('/read/coach_notes?id=99999');
  assert.deepEqual([none.status, none.body.count, none.body.total], [200, 0, 0]);
  const pattern = await get('/read/strength_score?id=hinge');
  assert.equal(pattern.body.rows[0].pattern, 'Hinge');
});

test('limit: default 50, max 200, truncated flag, 200 KB cap', async () => {
  let r = await get('/read/gymnastics');
  assert.deepEqual([r.body.count, r.body.total, r.body.truncated], [50, 250, true]);
  assert.equal(r.body.rows[0].date, '2025-09-07'); // newest first
  r = await get('/read/gymnastics?limit=2');
  assert.deepEqual([r.body.count, r.body.truncated], [2, true]);
  r = await get('/read/gymnastics?limit=1000'); // clamped to 200, then the size cap bites
  assert.ok(r.body.count <= 200 && r.body.count > 50);
  assert.equal(r.body.truncated, true);
  assert.ok(r.text.length <= 200 * 1024);
  r = await get('/read/lifts?limit=200');
  assert.deepEqual([r.body.count, r.body.truncated], [7, false]);
});

test('404 for an unknown collection, 422 for bad filters', async () => {
  const nf = await get('/read/passwords');
  assert.equal(nf.status, 404);
  assert.ok(nf.body.collections.includes('lifts'));
  for (const qs of ['lifts?sql=select', 'lifts?from=2026-13-01', 'lifts?from=yesterday', 'lifts?pattern=Legs', 'lifts?limit=0',
    'lifts?limit=abc', 'lifts?month=2026-9', 'lifts?from=2026-10-01&to=2026-09-01', 'lifts?benchmark_only=maybe',
    'profile?search=x', 'weight_trend?from=2026-01-01', 'lifts?lift=a&lift=b']) {
    const r = await get(`/read/${qs}`);
    assert.equal(r.status, 422, qs);
    assert.ok(r.body.error, qs);
  }
});

test('read only: writes are refused and change nothing', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await fetch(`${base}/read/lifts`, { method, headers: { Authorization: SENTINEL, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 405, method);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM fitness_lifts')).rows[0].n, 7);
});

test('summaries match the app and Sentinel tile calculations', async () => {
  const tile = (await buildSummary(pool, NOW)).summary;

  const ss = (await get('/read/strength_score')).body.rows;
  assert.equal(ss[0].id, 'overall');
  assert.equal(ss[0].score, tile.strength.overall_score);
  assert.equal(ss[0].level, tile.strength.level);
  assert.deepEqual(ss.slice(1).map((p) => [p.pattern, p.score]), tile.strength.by_pattern.map((p) => [p.pattern, p.score]));
  assert.equal(ss.find((p) => p.pattern === 'Hinge').lifts[0].e1rm_lb, 368.5);

  const wt = (await get('/read/weight_trend')).body.rows;
  const byId = Object.fromEntries(wt.map((r) => [r.id, r]));
  assert.equal(byId.current.latest_weight_lb, 164);
  assert.equal(byId.current.to_goal_lb, 11);
  assert.equal(byId.current.body_fat_pct, 11.8);
  assert.equal(byId.current.avg_last_7_weighins_lb, 161);
  assert.equal(byId['30d'].change_lb, tile.body.weight_change_30d_lb);
  assert.equal(byId['30d'].change_lb, 6); // 164 vs 158 on 07-01 (last weigh-in on/before the cutoff)
  assert.equal(byId['7d'].change_lb, 2);
  assert.equal(byId.all.change_lb, 6);

  const wl = await computeWeeklyLoad(pool, NOW);
  const tw = Object.fromEntries((await get('/read/training_week')).body.rows.map((r) => [r.id, r]));
  assert.equal(tw.strength.sessions_done, wl.strength.sessions_this_week);
  assert.equal(tw.strength.sessions_done, 3); // Mon-Wed of this week (was 2: Sun + Mon before the week-index fix)
  assert.equal(tw.strength.tonnage_this_week_lb, 4620);
  assert.equal(tw.strength.tonnage_4wk_avg_lb, 306); // 245 x 5 on Sun 09-27 / 4
  assert.equal(tw.strength.sessions_goal, 4);
  assert.equal(tw.strength.sessions_remaining, 1);
  assert.equal(tw.strength.tonnage_this_week_lb, wl.strength.tonnage_this_week_lb);
  assert.deepEqual(tw.strength.days_trained, ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(tw.conditioning.sessions_done, 1);

  const mc = Object.fromEntries((await get('/read/measurements_change')).body.rows.map((r) => [r.id, r]));
  assert.deepEqual([mc.waist.latest, mc.waist.previous, mc.waist.change], [31.5, 32, -0.5]);
  assert.deepEqual([mc.neck.latest, mc.neck.latest_on, mc.neck.previous], [15, '2026-08-01', null]);
  assert.equal(mc.shoulder_waist_ratio.latest, 1.52);

  const mb = (await get('/read/movement_bests?kind=conditioning')).body.rows[0];
  assert.deepEqual([mb.movement, mb.longest_distance_m, mb.total_distance_m, mb.entries], ['Row', 5000, 7000, 2]);

  const trend = (await get('/read/strength_trend?pattern=Hinge&limit=1')).body.rows[0];
  assert.equal(trend.pattern, 'Hinge');
  assert.ok(Number.isFinite(trend.score));

  const prof = (await get('/read/profile')).body.rows[0];
  assert.equal(prof.phase_name, 'Phase 1 (Foundation Build)');
  assert.equal(prof.bodyweight_goal_lb, 175);
});
