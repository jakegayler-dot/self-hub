// The coached week (2026-10-18): plan a week with Sentinel's trainer, see what each session is for, log, get the
// week reviewed and the rest of it adjusted, refine a session straight away. A stand-in Sentinel answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const pgAdapter = mem.adapters.createPg();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return 'pg-mem-shim-coach';
  return origResolve.call(this, request, ...args);
};
require.cache['pg-mem-shim-coach'] = { id: 'pg-mem-shim-coach', filename: 'pg-mem-shim-coach', loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';
process.env.SELF_HUB_NO_AUTO_REVIEW = '1';

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const { createWorkoutsRouter } = require('../server/routes/workouts');

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
let server; let base; let sentinel; const asked = [];
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => iso(new Date(Date.now() - 6 * 3600e3 + n * 86400000));
const START = day(0);

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: JAKE }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// A session in Self Hub's format, as the trainer would write it.
const session = (date, title, extra = {}) => ({
  date, title, focus: 'strength', minutes: 45, objective: `${title}: build top-set strength`, intensity: 'Heavy: RPE 8',
  systems: { phosphagen: 70, glycolytic: 20, oxidative: 10 }, qualities: { max_strength: 3, power: 1, hypertrophy: 2 }, muscles: ['Chest', 'Triceps'],
  why: 'Bench is the weakest pattern', ...extra,
  body: { title, rationale: ['Weakest pattern first'], blocks: [{ kind: 'strength', title: 'Bench', minutes: 30, items: [{ movement: 'Bench Press', log_as: 'lift', prescription: '4 × 4 @ 165 lb', load_source: '80% of 205 lb e1RM', sets: [{ reps: 4, load_lb: 165 }, { reps: 4, load_lb: 165 }] }] }] },
});
let weekAnswer;

test.before(async () => {
  await runMigrations();
  // The stand-in Sentinel: the first week answer has a broken day, fixed when Self Hub sends the errors back.
  const s = express(); s.use(express.json({ limit: '5mb' }));
  s.post('/v1/selfhub/trainer', (req, res) => {
    asked.push({ auth: req.headers.authorization, ...req.body });
    const { task, errors } = req.body;
    if (task === 'week') {
      weekAnswer = { objective: 'Pressing strength and aerobic base', weekly_targets: { push_sets: 12 }, progression: '+5 lb on top sets when all reps land at RPE 8', watch: ['Bench top set'],
        days: [session(day(0), 'Heavy bench'), session(day(2), 'Pull + engine'), session(day(4), 'Squat'),
          errors ? session(day(5), 'Accessories') : { ...session(day(5), 'Accessories'), body: { blocks: [] } }] };
      return res.json({ result: weekAnswer, calendar: [{ date: day(0), harvest_day: 'yes: combining 11:00-22:00' }] });
    }
    if (task === 'review') {
      return res.json({ result: { summary: 'Bench landed; squat day moves lighter', readiness: { score: 3, why: 'Bench RPE ran high' },
        sessions: [{ date: day(0), verdict: 'on target', vs_prescription: '4×4 @165 done' }],
        adjustments: [{ ...session(day(4), 'Squat (lighter)'), change: 'Dropped to 75% after a hard bench day' }],
        weak_points: [{ area: 'Hinge', evidence: 'Deadlift e1RM 1.4× bodyweight', priority: 1, prescription: 'RDLs twice a week', why_it_matters: 'Leaderboard lifts' }],
        next_week: 'Lean towards the hinge' } });
    }
    if (task === 'refine') return res.json({ result: { ...session(day(2), 'Pull (refined)'), notes: 'Swapped rows for pull-ups' } });
    res.status(422).json({ error: { message: 'unknown task' } });
  });
  await new Promise((r) => { sentinel = s.listen(0, r); });
  process.env.SENTINEL_URL = `http://127.0.0.1:${sentinel.address().port}`;
  process.env.SENTINEL_API_KEY = 'sh-key';

  const app = express();
  app.use(express.json());
  app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  app.use('/api/fitness', createWorkoutsRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/fitness`;
  await call('POST', '/lifts', { entry_date: day(-10), lift: 'Bench Press', load_lb: 185, reps: 5 });
  await call('POST', '/bodyweight', { entry_date: day(-3), weight_lb: 162 });
});
test.after(() => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => sentinel.close(r))]));

test('plan a week with Sentinel: what each session is for, every set loggable, errors sent back once to be fixed', async () => {
  const r = await call('POST', '/workouts/plan-week', { start_date: START, days: 9, minutes: 45, equipment: 'box' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.week.days, 6); // 4 to 6
  assert.equal(r.body.workouts.length, 4);
  // The trainer got the athlete, the format and Jake's numbers, with Self Hub's key.
  assert.equal(asked[0].auth, 'Bearer sh-key');
  assert.equal(asked[0].task, 'week');
  assert.equal(asked[0].context.week_start, START);
  assert.ok(asked[0].context.athlete.e1rm_60d_lb['Bench Press'] || Object.keys(asked[0].context.athlete.e1rm_60d_lb).length);
  assert.ok(asked[0].context.schema.body);
  // The broken day went back with its errors and came back fixed.
  assert.equal(asked[1].previous.days.length, 4);
  assert.match(asked[1].errors[0], /^days\[3\]\.body\.blocks must be an array/);
  const w = r.body.workouts[0];
  assert.equal(w.source, 'sentinel');
  assert.equal(w.meta.objective, 'Heavy bench: build top-set strength');
  assert.deepEqual(w.meta.systems, { phosphagen: 70, glycolytic: 20, oxidative: 10 });
  assert.deepEqual(w.meta.qualities, { max_strength: 3, power: 1, hypertrophy: 2 });
  assert.equal(w.body.blocks[0].items[0].sets[0].load_lb, 165);
  const wk = await call('GET', `/workouts/week?start=${START}`);
  assert.equal(wk.body.week.plan.objective, 'Pressing strength and aerobic base');
  assert.equal(wk.body.week.plan.calendar[0].harvest_day, 'yes: combining 11:00-22:00');
});

test('log, then review: what he did against the plan, the rest of the week adjusted, where to work', async () => {
  const ws = (await call('GET', `/workouts?from=${START}`)).body.sort((a, b) => (a.date < b.date ? -1 : 1));
  const bench = ws[0];
  await call('POST', `/workouts/${bench.id}/log`, { block_id: 'b1', item_id: 'b1i1', set_index: 0, reps: 4, load_lb: 165 });
  const r = await call('POST', '/workouts/review-week', { start_date: START });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ask = asked.at(-1);
  assert.equal(ask.task, 'review');
  assert.equal(ask.context.sessions[0].started, true);
  assert.equal(r.body.review.weak_points[0].area, 'Hinge');
  assert.deepEqual(r.body.review.applied.map((a) => a.title), ['Squat (lighter)']);
  const squat = (await call('GET', `/workouts?from=${day(4)}&to=${day(4)}`)).body[0];
  assert.equal(squat.title, 'Squat (lighter)');
  assert.equal(squat.meta.change, 'Dropped to 75% after a hard bench day');
  assert.equal((await call('GET', `/workouts/week?start=${START}`)).body.week.review.summary, 'Bench landed; squat day moves lighter');
});

test('refine runs straight away through Sentinel (no more waiting)', async () => {
  const pull = (await call('GET', `/workouts?from=${day(2)}&to=${day(2)}`)).body[0];
  const r = await call('POST', `/workouts/${pull.id}/refine`, { note: 'shoulder is cranky' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, 'Pull (refined)');
  assert.equal(r.body.refine.status, 'done');
  assert.equal(r.body.refine.notes, 'Swapped rows for pull-ups');
  assert.equal(asked.at(-1).task, 'refine');
  assert.equal(asked.at(-1).context.jake_note, 'shoulder is cranky');
});
