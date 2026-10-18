// Workout generator: engine maths, the rule engine, and the full API
// (generate → one-tap log → Sentinel refine round-trip → engine tests and
// adaptation) against an in-memory Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const pgAdapter = mem.adapters.createPg();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return 'pg-mem-shim-workouts';
  return origResolve.call(this, request, ...args);
};
require.cache['pg-mem-shim-workouts'] = { id: 'pg-mem-shim-workouts', filename: 'pg-mem-shim-workouts', loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';
process.env.SENTINEL_USER = 'sentinel';
process.env.SENTINEL_PASS = 'sentinelpass456';

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const { createWorkoutsRouter } = require('../server/routes/workouts');
const gen = require('../server/lib/workoutGen');
const engine = require('../server/lib/engine');
const { MOVEMENTS, BY_NAME, hasEquipment } = require('../server/lib/movements');

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
let server; let base;

async function call(method, path, body, auth = JAKE) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));

test.before(async () => {
  await runMigrations();
  const app = express();
  app.use(express.json());
  app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  app.use('/api/fitness', createWorkoutsRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/fitness`;
  // Some history to generate from.
  for (const [d, lift, load, reps] of [[daysAgo(20), 'Back Squat', 255, 5], [daysAgo(12), 'Deadlift', 315, 3], [daysAgo(9), 'Strict Press', 115, 5], [daysAgo(30), 'Bench Press', 185, 5]]) {
    await call('POST', '/lifts', { entry_date: d, lift, load_lb: load, reps });
  }
  await call('POST', '/gymnastics', { entry_date: daysAgo(10), movement: 'Strict Pull-Ups', reps: 12 });
  await call('POST', '/bodyweight', { entry_date: daysAgo(5), weight_lb: 162 });
});
test.after(() => new Promise((r) => server.close(r)));

// ---------- pure engine maths ----------
test('engine baselines: paces, speed reserve, repeatability, limiter', () => {
  const b = engine.computeBaselines([
    { entry_date: '2026-09-20', modality: 'bike', test: 'tt10', output: 180 },
    { entry_date: '2026-09-21', modality: 'bike', test: 'sprint60', output: 40 },
    { entry_date: '2026-09-22', modality: 'bike', test: 'repeat', output: 9.5, intervals: [12, 11, 10, 9, 8, 7] },
  ], [], '2026-10-01').bike;
  assert.equal(b.enduranceRate, 18);
  assert.equal(b.speedRate, 40);
  assert.equal(b.speedReserve, 2.22);
  assert.equal(b.repeatability, 0.79); // 9.5 / 12
  assert.equal(b.limiter.key, 'repeat');
  assert.deepEqual(b.testsDue, []);
  const later = engine.computeBaselines([{ entry_date: '2026-01-01', modality: 'row', test: 'tt10', output: 150 }], [], '2026-10-01').row;
  assert.ok(later.tt10.stale, 'a 9-month-old test is stale');
  assert.ok(later.testsDue.includes('tt10'));
});

test('engine targets are % of your own test pace, and adapt to logged results', () => {
  const tests = [{ entry_date: '2026-09-20', modality: 'row', test: 'tt10', output: 150 }]; // 15 cal/min
  const base = engine.computeBaselines(tests, [], '2026-10-01');
  const why = [];
  const b = engine.engineBlock(base, { equipment: ['rower'], date: '2026-10-01', minutes: 30, history: [], noTest: true, onlyEndurance: true }, () => 0.5, why);
  const ST = engine.SESSION_TYPES[b.engine.type];
  const set = b.items[0].sets[0];
  assert.equal(set.target, Math.round(15 * ST.pct * (set.duration_s / 60)), `${b.engine.type} target`);
  // Two sessions at ~110% of target → targets go up, capped at +6%.
  const done = (d) => ({ date: d, block: { engine: { modality: 'row', type: 'threshold' }, items: [{ sets: [{ target: 55, actual: 61 }, { target: 55, actual: 60 }] }] } });
  const adapted = engine.computeBaselines(tests, [done('2026-09-25'), done('2026-09-28')], '2026-10-01').row;
  assert.equal(adapted.adjEndurance.factor, 1.06);
  const missed = (d) => ({ date: d, block: { engine: { modality: 'row', type: 'vo2' }, items: [{ sets: [{ target: 30, actual: 27 }] }] } });
  assert.equal(engine.computeBaselines(tests, [missed('2026-09-25'), missed('2026-09-28')], '2026-10-01').row.adjEndurance.factor, 0.94);
});

test('no test on the machine → the engine session is the time trial', () => {
  const w = gen.generateSession({ lifts: [], gymnastics: [], engineTests: [] }, { date: '2026-10-01', minutes: 45, focus: 'engine', equipment: ['bike'] }, 1);
  const testBlock = w.blocks.find((b) => b.engine);
  assert.equal(testBlock.engine.type, 'test');
  assert.equal(testBlock.engine.test, 'tt10');
  assert.equal(testBlock.items[0].log_as, 'test');
});

// ---------- rule engine ----------
test('every focus generates a schema-valid session that respects equipment and time', () => {
  const rows = { lifts: [{ entry_date: '2026-09-25', lift: 'Back Squat', load_lb: 255, reps: 5 }], gymnastics: [], engineTests: [{ entry_date: '2026-09-20', modality: 'bike', test: 'tt10', output: 180 }] };
  for (const eq of ['box', 'home', 'dumbbells', 'bodyweight']) {
    const kit = require('../server/lib/movements').EQUIPMENT_PRESETS[eq].equipment;
    for (const focus of gen.FOCI) {
      for (const minutes of [30, 60, 90]) {
        const w = gen.generateSession(rows, { date: '2026-10-01', minutes, focus, equipment: eq }, 7);
        const { errors } = gen.sanitizeBody(w, { date: w.date });
        assert.deepEqual(errors, [], `${eq}/${focus}/${minutes}`);
        for (const b of w.blocks) for (const it of b.items) {
          const m = BY_NAME.get(it.movement);
          if (m) assert.ok(hasEquipment(m, kit), `${it.movement} needs kit not in ${eq}`);
        }
        const planned = w.blocks.reduce((s, b) => s + (b.minutes || 0), 0);
        assert.ok(planned <= minutes + 8, `${eq}/${focus}/${minutes}: ${planned} min planned`);
      }
    }
  }
});

test('loads come from the 60-day e1RM; core work is never loaded', () => {
  const rows = { lifts: [{ entry_date: '2026-09-25', lift: 'Back Squat', load_lb: 300, reps: 1 }], gymnastics: [] };
  for (let seed = 0; seed < 40; seed++) {
    const w = gen.generateSession(rows, { date: '2026-10-01', minutes: 60, focus: 'strength', equipment: 'box' }, seed);
    for (const b of w.blocks) for (const it of b.items) {
      if (it.movement === 'Back Squat') {
        const s = it.sets[0];
        assert.equal(s.load_lb, Math.round((310 * s.pct_1rm) / 100 / 5) * 5); // 300 × (1 + 1/30) = 310
      }
      if (it.pattern === 'Core') assert.ok(it.sets.every((s) => s.load_lb == null), 'core is bodyweight');
    }
  }
});

test('library names classify into the same patterns the app uses', () => {
  const strength = require('../server/lib/strength');
  for (const m of MOVEMENTS) {
    if (m.pattern === 'Conditioning' && m.kind === 'cond') continue;
    assert.equal(strength.liftPattern(m.name), m.pattern, m.name);
  }
});

// ---------- API ----------
test('generate → log a lift set → unlog → regenerate guard', async () => {
  const opts = await call('GET', '/workout-options');
  assert.equal(opts.status, 200);
  assert.ok(opts.body.foci.some((f) => f.id === 'engine'));

  const g = await call('POST', '/workouts/generate', { date: TODAY, minutes: 60, focus: 'strength', equipment: 'box', seed: 3 });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const w = g.body;
  assert.equal(w.status, 'planned');
  const block = w.body.blocks.find((b) => b.kind === 'strength');
  const item = block.items[0];
  const before = (await call('GET', '/lifts')).body.length;
  const logged = await call('POST', `/workouts/${w.id}/log`, { block_id: block.id, item_id: item.id, set_index: 0, load_lb: 200, reps: 3 });
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  assert.equal((await call('GET', '/lifts')).body.length, before + 1);
  assert.equal(logged.body.progress.done, 1);
  assert.equal((await call('POST', `/workouts/${w.id}/log`, { block_id: block.id, item_id: item.id, set_index: 0 })).status, 409);
  assert.equal((await call('POST', `/workouts/${w.id}/regenerate`)).status, 409, 'cannot regenerate once logging started');
  const un = await call('POST', `/workouts/${w.id}/unlog`, { block_id: block.id, item_id: item.id, set_index: 0 });
  assert.equal(un.body.progress.done, 0);
  assert.equal((await call('GET', '/lifts')).body.length, before);
  const re = await call('POST', `/workouts/${w.id}/regenerate`);
  assert.equal(re.status, 200);
  assert.equal(re.body.seed, 4);
  assert.equal((await call('DELETE', `/workouts/${w.id}`)).status, 204);
});

test('metcon result logs a conditioning row and a benchmark row, and can be undone', async () => {
  let w = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 60, focus: 'metcon', equipment: 'box', seed: 1 })).body;
  const mb = w.body.blocks.find((b) => b.kind === 'metcon');
  assert.ok(mb, 'metcon block');
  const bm = (await call('GET', '/benchmarks')).body.length;
  const r = await call('POST', `/workouts/${w.id}/metcon`, { block_id: mb.id, result: '6 rounds + 4' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', '/benchmarks')).body.length, bm + 1);
  w = (await call('DELETE', `/workouts/${w.id}/metcon/${mb.id}`)).body;
  assert.equal((await call('GET', '/benchmarks')).body.length, bm);
  await call('DELETE', `/workouts/${w.id}`);
});

test('engine: time trial → baseline → personal targets', async () => {
  const w = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 45, focus: 'engine', equipment: ['rower'], engine_modality: 'row', seed: 1 })).body;
  const tb = w.body.blocks.find((b) => b.engine);
  assert.equal(tb.engine.test, 'tt10');
  const it = tb.items[0];
  assert.equal((await call('POST', `/workouts/${w.id}/log`, { block_id: tb.id, item_id: it.id, set_index: 0 })).status, 400, 'a test needs a real output');
  const r = await call('POST', `/workouts/${w.id}/log`, { block_id: tb.id, item_id: it.id, set_index: 0, output: 160 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const eng = (await call('GET', '/engine')).body;
  const row = eng.baselines.find((b) => b.modality === 'row');
  assert.equal(row.enduranceRate, 16);
  assert.equal(row.endurance_pace, '16 cal/min');

  const next = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 45, focus: 'engine', equipment: ['rower'], engine_modality: 'row', seed: 2 })).body;
  const blocks = next.body.blocks.filter((b) => b.engine);
  // tt10 exists, so it's either intervals or the (short) 1-min test followed by intervals
  const intervals = blocks.find((b) => b.engine.type !== 'test');
  assert.ok(intervals, JSON.stringify(blocks.map((b) => b.title)));
  const ST = engine.SESSION_TYPES[intervals.engine.type];
  const s = intervals.items[0].sets[0];
  assert.equal(s.target, Math.round(16 * ST.pct * (s.duration_s / 60)));

  // Manual test entry + repeatability
  const rep = await call('POST', '/engine-tests', { entry_date: TODAY, modality: 'row', test: 'repeat', intervals: [10, 10, 9, 9, 8, 8] });
  assert.equal(rep.status, 201);
  assert.equal(rep.body.output, 9);
  assert.equal((await call('POST', '/engine-tests', { entry_date: TODAY, modality: 'row', test: 'repeat', intervals: [] })).status, 400);
});

test('generate-week: N days, replaces untouched plans, keeps started ones', async () => {
  const start = TODAY;
  const wk = await call('POST', '/workouts/generate-week', { start_date: start, days: 4, minutes: 60, focus: 'mixed', equipment: 'box', seed: 11 });
  assert.equal(wk.status, 201, JSON.stringify(wk.body));
  assert.equal(wk.body.workouts.length, 4);
  const dates = wk.body.workouts.map((w) => w.date);
  assert.deepEqual(dates, [0, 1, 3, 4].map((o) => gen.addDaysStr(start, o)));
  // start one, then regenerate the week
  const first = wk.body.workouts.find((w) => w.body.blocks.some((b) => b.items.some((i) => i.log_as === 'gymnastics' || i.log_as === 'lift')));
  const b = first.body.blocks.find((x) => x.items.some((i) => i.log_as === 'gymnastics' || i.log_as === 'lift'));
  const i = b.items.find((x) => x.log_as === 'gymnastics' || x.log_as === 'lift');
  assert.equal((await call('POST', `/workouts/${first.id}/log`, { block_id: b.id, item_id: i.id, set_index: 0, load_lb: 100, reps: 5 })).status, 200);
  const again = await call('POST', '/workouts/generate-week', { start_date: start, days: 4, minutes: 60, focus: 'mixed', equipment: 'box', seed: 12 });
  assert.deepEqual(again.body.kept_existing, [first.id]);
  const all = (await call('GET', `/workouts?from=${start}&to=${gen.addDaysStr(start, 6)}`)).body;
  const planned = all.filter((w) => w.status === 'planned');
  assert.equal(planned.length, 5, 'four new plus the started one (earlier untouched plans were replaced)');
  assert.ok(planned.some((w) => w.id === first.id));
});

test('Sentinel refine round-trip: queue → context → validated write-back → revert', async () => {
  const w = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 60, focus: 'mixed', equipment: 'box', seed: 5 })).body;
  const q = await call('POST', `/workouts/${w.id}/refine`, { note: 'shoulder is a bit cranky' });
  assert.equal(q.body.refine.status, 'pending');

  const queue = await call('GET', '/workouts/refine-queue', null, SENTINEL);
  assert.equal(queue.status, 200);
  const reqd = queue.body.requests.find((r) => r.id === w.id);
  assert.ok(reqd, 'request is in the queue');
  assert.equal(reqd.jake_note, 'shoulder is a bit cranky');
  assert.ok(reqd.athlete.e1rm_60d_lb['Strict Press'], 'context carries his e1RMs');
  assert.ok(Array.isArray(reqd.known_movements) && reqd.known_movements.includes('Back Squat'));
  assert.ok(reqd.response_schema.body.blocks);
  assert.equal(reqd.submit.path, `/api/fitness/workouts/${w.id}/refined`);

  const bad = await call('PUT', `/workouts/${w.id}/refined`, { body: { blocks: [{ kind: 'nope', items: [{ log_as: 'lift', sets: [] }] }] } }, SENTINEL);
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.length >= 2);

  const refined = JSON.parse(JSON.stringify(w.body));
  refined.title = 'Mixed — shoulder-friendly';
  refined.rationale = ['Swapped overhead work for landmine-free pulling because of the shoulder.'];
  refined.blocks[1].items[0].sets[0].entry = { table: 'lifts', id: 999 }; // must be ignored
  const ok = await call('PUT', `/workouts/${w.id}/refined`, { body: refined, notes: 'Pulled overhead pressing.' }, SENTINEL);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.source, 'sentinel');
  assert.equal(ok.body.refine.status, 'done');
  assert.equal(ok.body.title, 'Mixed — shoulder-friendly');
  assert.equal(ok.body.has_rules_version, true);
  assert.equal(ok.body.body.blocks[1].items[0].sets[0].entry, null, 'logging state is never accepted from outside');

  const rv = await call('POST', `/workouts/${w.id}/revert`);
  assert.equal(rv.body.source, 'rules');
  assert.equal(rv.body.title, w.title);
  assert.equal(rv.body.has_rules_version, false);
});

// ---------- regressions from the independent review ----------
test('two sets logged at the same moment both stick (no lost write, no orphan row)', async () => {
  const w = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 60, focus: 'strength', equipment: 'box', seed: 21 })).body;
  const b = w.body.blocks.find((x) => x.kind === 'strength');
  const it = b.items[0];
  const before = (await call('GET', '/lifts')).body.length;
  const [a, c] = await Promise.all([0, 1].map((i) => call('POST', `/workouts/${w.id}/log`, { block_id: b.id, item_id: it.id, set_index: i, load_lb: 150, reps: 3 })));
  assert.equal(a.status, 200); assert.equal(c.status, 200);
  const after = (await call('GET', `/workouts/${w.id}`)).body;
  const sets = after.body.blocks.find((x) => x.id === b.id).items[0].sets;
  assert.ok(sets[0].entry && sets[1].entry, 'both sets recorded on the workout');
  assert.equal((await call('GET', '/lifts')).body.length, before + 2);
  await call('POST', `/workouts/${w.id}/unlog`, { block_id: b.id, item_id: it.id, set_index: 0 });
  await call('POST', `/workouts/${w.id}/unlog`, { block_id: b.id, item_id: it.id, set_index: 1 });
  assert.equal((await call('GET', '/lifts')).body.length, before, 'undo removes both rows');
  await call('DELETE', `/workouts/${w.id}`);
});

test('adaptation is stable when you keep hitting the same pace', () => {
  const tests = [{ entry_date: '2026-09-01', modality: 'row', test: 'tt10', output: 150 }];
  const history = [];
  const factors = [];
  for (let i = 0; i < 6; i++) {
    const date = gen.addDaysStr('2026-09-05', i * 3);
    const base = engine.computeBaselines(tests, history, date);
    const blk = engine.engineBlock(base, { equipment: ['rower'], date, minutes: 30, history, noTest: true, onlyEndurance: true, exclude: 'aerobic' }, () => 0.5, []);
    const raw = 15 * engine.SESSION_TYPES[blk.engine.type].pct * (blk.items[0].sets[0].duration_s / 60);
    blk.items[0].sets.forEach((s) => { s.actual = raw * 1.05; }); // always 105% of the un-adjusted pace
    history.push({ date, block: blk });
    factors.push(engine.computeBaselines(tests, history, gen.addDaysStr(date, 1)).row.adjEndurance.factor);
  }
  const settled = factors.slice(1);
  // Whole-calorie rounding of targets leaves ~±1% noise; what must not
  // happen is the old swing back to 1.0 every other session.
  assert.ok(settled.every((f) => f > 1.03 && f <= 1.06), `factor should hold above 1.03, got ${factors.join(', ')}`);
  assert.ok(Math.max(...settled) - Math.min(...settled) < 0.015, `factor should settle, got ${factors.join(', ')}`);
});

test('a 0 time-trial result is rejected and never counts as a baseline', async () => {
  const b = engine.computeBaselines([{ entry_date: '2026-09-01', modality: 'ski', test: 'tt10', output: 0 }], [], '2026-09-05').ski;
  assert.equal(b.tt10, null);
  assert.ok(b.testsDue.includes('tt10'));
  const w = (await call('POST', '/workouts/generate', { date: TODAY, minutes: 45, focus: 'engine', equipment: ['ski'], engine_modality: 'ski', seed: 1 })).body;
  const tb = w.body.blocks.find((x) => x.engine);
  assert.equal(tb.engine.test, 'tt10');
  assert.equal((await call('POST', `/workouts/${w.id}/log`, { block_id: tb.id, item_id: tb.items[0].id, set_index: 0, output: 0 })).status, 400);
  await call('DELETE', `/workouts/${w.id}`);
});

test('manual "done" survives later logging; bad ids are 404; week regen keeps refined plans', async () => {
  const w = (await call('POST', '/workouts/generate', { date: gen.addDaysStr(TODAY, 30), minutes: 60, focus: 'gymnastics', equipment: 'box', seed: 2 })).body;
  await call('PUT', `/workouts/${w.id}/status`, { status: 'done' });
  const b = w.body.blocks.find((x) => x.items.some((i) => i.log_as === 'gymnastics'));
  const it = b.items.find((i) => i.log_as === 'gymnastics');
  const r = await call('POST', `/workouts/${w.id}/log`, { block_id: b.id, item_id: it.id, set_index: 0 });
  assert.equal(r.body.status, 'done');
  assert.equal((await call('GET', '/workouts/abc')).status, 404);

  const start = gen.addDaysStr(TODAY, 40);
  const wk = (await call('POST', '/workouts/generate-week', { start_date: start, days: 2, minutes: 45, focus: 'strength', equipment: 'box', seed: 3 })).body;
  const target = wk.workouts[0];
  await call('POST', `/workouts/${target.id}/refine`, {});
  await call('PUT', `/workouts/${target.id}/refined`, { body: target.body, notes: 'kept' }, SENTINEL);
  const again = (await call('POST', '/workouts/generate-week', { start_date: start, days: 2, minutes: 45, focus: 'strength', equipment: 'box', seed: 4 })).body;
  assert.ok(again.kept_existing.includes(target.id), 'refined plan kept');
});
