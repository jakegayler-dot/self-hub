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
  // Where he ranks against the field goes too (the Dashboard's CrossFit percentiles).
  const pct = asked[0].context.athlete.crossfit_percentiles;
  assert.ok(pct && Array.isArray(pct.by_area) && Array.isArray(pct.benchmarks) && Array.isArray(pct.open), JSON.stringify(pct));
  assert.match(pct.note, /^Percent of male CrossFitters/);
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

test('the trainer gets the target look and objective evidence of where he needs attention, not a remark', async () => {
  const before = await call('GET', '/profile');
  assert.equal(before.body.physique_assessment, null); // the seeded remark is gone
  await call('POST', '/measurements', { entry_date: day(-1), shoulder: 19, bust: 40, waist: 30, seat_hips: 37, neck: 15.5 });
  await call('POST', '/lifts', { entry_date: day(-2), lift: 'Back Squat', load_lb: 185, reps: 5 });
  await call('POST', '/workouts/plan-week', { start_date: day(14), days: 4, minutes: 45, equipment: 'box' });
  const a = asked.filter((x) => x.task === 'week').at(-1).context.athlete;
  assert.match(a.goals.physique_target, /^Daniel Craig in Casino Royale/);
  assert.equal(a.goals.his_own_notes, undefined);
  const ev = a.physique_evidence;
  assert.match(ev.note, /^Decide where he needs attention from this/);
  assert.equal(ev.ratios.chest_to_waist, 1.33);
  assert.ok(ev.lower_vs_upper_strength && Number.isFinite(ev.lower_vs_upper_strength.difference), JSON.stringify(ev));
  assert.ok(ev.not_measured.includes('thigh circumference'));
  assert.doesNotMatch(JSON.stringify(a), /tiny|V-taper/i);
});

test('the log: actual RPE and a note per set, extra sets, the session time/RPE/notes, and logging by movement (as Sentinel does)', async () => {
  const w = (await call('GET', `/workouts?from=${day(5)}&to=${day(5)}`)).body[0]; // Accessories: Bench Press × 2 sets
  const it = w.body.blocks[0].items[0];
  const b = { block_id: w.body.blocks[0].id, item_id: it.id };
  let r = await call('POST', `/workouts/${w.id}/log`, { ...b, set_index: 0, reps: 4, load_lb: 170, rpe: 8.5, notes: 'bar speed slow on rep 4' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = r.body.body.blocks[0].items[0].sets[0].entry;
  assert.deepEqual([e.load_lb, e.rpe, e.notes], [170, 8.5, 'bar speed slow on rep 4']);
  assert.equal((await call('POST', `/workouts/${w.id}/log`, { ...b, set_index: 1, reps: 4, rpe: 11 })).status, 400); // RPE 1-10
  // + set, and an unlogged extra set can come off again.
  r = await call('POST', `/workouts/${w.id}/sets`, b);
  assert.equal(r.body.body.blocks[0].items[0].sets.length, 3);
  assert.equal(r.body.body.blocks[0].items[0].sets[2].extra, true);
  r = await call('DELETE', `/workouts/${w.id}/sets`, { ...b, set_index: 2 });
  assert.equal(r.body.body.blocks[0].items[0].sets.length, 2);
  // Sentinel logs by movement: the next open set; then an extra one once they're all in.
  r = await call('POST', '/workouts/log-entry', { date: day(5), movement: 'bench press', reps: 3, load_lb: 175, rpe: 9 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.logged.into, r.body.logged.set, r.body.logged.extra], ['workout', 2, false]);
  r = await call('POST', '/workouts/log-entry', { date: day(5), movement: 'Bench Press', reps: 6, load_lb: 135, notes: 'back-off' });
  assert.deepEqual([r.body.logged.set, r.body.logged.of, r.body.logged.extra], [3, 3, true]);
  // Nothing planned matches: straight into the history.
  r = await call('POST', '/workouts/log-entry', { date: day(5), movement: 'Farmer Carry', reps: 4, load_lb: 100 });
  assert.equal(r.body.logged.into, 'history');
  // The session: time, RPE, notes; load = RPE × minutes; done.
  r = await call('POST', '/workouts/log-entry', { date: day(5), minutes: 52, session_rpe: 7, session_notes: 'left shoulder tight', done: true });
  assert.deepEqual([r.body.session.minutes, r.body.session.rpe, r.body.session.load, r.body.session.status], [52, 7, 364, 'done']);
  const lifts = (await call('GET', '/lifts')).body.filter((l) => l.lift === 'Bench Press' && Number(l.load_lb) === 170);
  assert.equal(Number(lifts[0].rpe), 8.5);
  r = await call('PUT', `/workouts/${w.id}/session`, { rpe: 0 });
  assert.equal(r.status, 400);
});

test('a Sentinel restart (the platform 502s, or the connection drops) is retried once', async () => {
  const { callTrainer } = require('../server/lib/coach');
  const env = { SENTINEL_URL: 'https://sentinel.test', SENTINEL_API_KEY: 'k' };
  const ok = new Response(JSON.stringify({ result: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
  let n = 0;
  const flaky = async () => (++n === 1 ? new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/html' } }) : ok);
  assert.deepEqual((await callTrainer('week', {}, { env, fetchImpl: flaky, retryMs: 1 })).result, { ok: true });
  assert.equal(n, 2);
  n = 0;
  const dropped = async () => { if (++n === 1) throw new TypeError('fetch failed'); return new Response(JSON.stringify({ result: { ok: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  assert.equal((await callTrainer('week', {}, { env, fetchImpl: dropped, retryMs: 1 })).result.ok, 1);
  // Sentinel's own 502 (its JSON error) isn't a restart: no retry, its message comes through.
  n = 0;
  const refused = async () => { n++; return new Response(JSON.stringify({ error: { message: 'The trainer declined this request' } }), { status: 502, headers: { 'content-type': 'application/json' } }); };
  await assert.rejects(callTrainer('week', {}, { env, fetchImpl: refused, retryMs: 1 }), /The trainer declined this request/);
  assert.equal(n, 1);
  const down = async () => new Response('Service Unavailable', { status: 503 });
  await assert.rejects(callTrainer('week', {}, { env, fetchImpl: down, retryMs: 1 }), /restarting/);
});

test('swims: the pool, fins and swim gear are equipment, swim strokes are movements, and a swim logs as distance and time', async () => {
  const { EQUIPMENT_PRESETS, BY_NAME } = require('../server/lib/movements');
  assert.ok(!EQUIPMENT_PRESETS.box.equipment.includes('pool')); // the box has no pool
  assert.deepEqual(EQUIPMENT_PRESETS.pool.equipment, ['pool', 'fins', 'swim_gear']);
  assert.ok(BY_NAME.get('Sidestroke with fins'));
  const r = await call('POST', '/workouts/log-entry', { date: day(6), movement: 'Swim with fins', distance_m: 400, duration_s: 480, notes: 'sidestroke legs burning' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.logged.table, 'conditioning');
  const c = (await call('GET', '/conditioning')).body.find((x) => x.movement === 'Swim with fins');
  assert.equal(Number(c.distance_m), 400);
  assert.equal(Number(c.duration_seconds), 480);
});

test('planning a week runs in the background: the page starts it and checks back (no long request for the phone to drop)', async () => {
  const r = await call('POST', '/workouts/plan-week', { start_date: day(0), days: 4, minutes: 45, equipment: 'box', background: true });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.job.status, 'running');
  assert.equal((await call('POST', '/workouts/plan-week', { start_date: day(0), days: 4, minutes: 45, equipment: 'box', background: true })).status, 409);
  let job;
  for (let i = 0; i < 100; i++) { job = (await call('GET', '/workouts/plan-week/status')).body.job; if (job.status !== 'running') break; await new Promise((ok) => setTimeout(ok, 50)); }
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.sessions, 4);
  assert.equal(job.week_start, day(0));
  assert.equal((await call('GET', `/workouts/week?start=${day(0)}`)).body.week.week_start, day(0));
});

test('the data ledger: tests due, measurements and facts missing, filled in from the Train page or Sentinel, and a planned test set records the result', async () => {
  let L = (await call('GET', `/ledger?date=${day(0)}`)).body;
  assert.equal(L.age, 34); // he told Sentinel (migration 015)
  assert.equal(L.max_hr_est, 186);
  const due = L.due_tests.map((d) => d.id);
  for (const id of ['prt_pullups', 'prt_situps', 'prt_pushups', 'prt_run_3mi', 'prt_swim_half_mi', 'swim_400m', 'ruck_8km', 'benchmark:Fran']) assert.ok(due.includes(id), id);
  assert.ok(L.missing_measurements.some((m) => m.id === 'thigh'));
  assert.deepEqual(L.unknown_facts.map((f) => f.id), ['fins', 'swim_gear']);
  // He fills some in; one is snoozed.
  let r = await call('POST', '/body-data', { thigh: 22.5, calf: 15, resting_hr: 52, fins: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', '/body-data', { thigh: 99 })).status, 400);
  await call('POST', '/ledger/snooze', { id: 'swim_gear', days: 30 });
  L = (await call('GET', `/ledger?date=${day(0)}`)).body;
  assert.ok(!L.missing_measurements.some((m) => m.id === 'thigh' || m.id === 'calf'));
  assert.deepEqual(L.unknown_facts, []);
  assert.equal(L.gear.fins, true);
  assert.equal(L.resting_hr_recent[0].bpm, 52);
  // A planned PRT pull-up set records the test when he logs it; undoing it takes the test back off.
  const body = { title: 'PRT', blocks: [{ id: 'b1', kind: 'gymnastics', title: 'PRT', items: [{ id: 'b1i1', movement: 'Pull-up', log_as: 'gymnastics', test: 'prt_pullups', sets: [{ reps: 15, entry: null }] }] }] };
  const w = (await pool.query(`INSERT INTO fitness_workouts (workout_date, title, focus, minutes, inputs, body, seed, source) VALUES ($1, 'PRT', 'gymnastics', 45, '{}'::jsonb, $2::jsonb, 0, 'sentinel') RETURNING id`, [day(0), JSON.stringify(body)])).rows[0];
  r = await call('POST', `/workouts/${w.id}/log`, { block_id: 'b1', item_id: 'b1i1', set_index: 0, reps: 17 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = (await call('GET', '/tests')).body.find((x) => x.test === 'prt_pullups');
  assert.equal(Number(t.value), 17);
  L = (await call('GET', `/ledger?date=${day(0)}`)).body;
  assert.ok(!L.due_tests.some((d) => d.id === 'prt_pullups' && d.reason === 'never tested'));
  await call('POST', `/workouts/${w.id}/unlog`, { block_id: 'b1', item_id: 'b1i1', set_index: 0 });
  assert.ok(!(await call('GET', '/tests')).body.some((x) => x.test === 'prt_pullups'));
  // A time typed as m:ss.
  r = await call('POST', '/tests', { test: 'swim_400m', value: '8:05' });
  assert.equal(Number(r.body.value), 485);
});

test('his days and volume are kept: a truck or off day the plan ignores goes back, volume is counted and capped by level and ramp', async () => {
  const vol = require('../server/lib/volume');
  // The stand-in trainer always puts a heavy bench day on day(0): on a truck day that's refused (twice), so no plan.
  const r = await call('POST', '/workouts/plan-week', { start_date: day(0), days: 4, minutes: 45, equipment: 'box', volume_level: 'beginner', availability: { [day(0)]: 'truck', [day(2)]: 'off' } });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.ok(r.body.errors.some((e) => /is a truck day \(harvest: no gym.*\): Bench Press needs a gym$/.test(e)), JSON.stringify(r.body.errors));
  assert.ok(r.body.errors.some((e) => e.includes(`(${day(2)}): he's off that day`)));
  const ask = asked.filter((a) => a.task === 'week').at(-1);
  assert.equal(ask.context.volume.level, 'beginner');
  assert.equal(ask.context.volume.start_cap_hard_sets, 30);
  assert.deepEqual(ask.context.availability, { [day(0)]: 'truck', [day(2)]: 'off' });
  // Volume per session and the week's checks.
  const body = { blocks: [{ kind: 'strength', items: [{ log_as: 'lift', pattern: 'Squat', sets: [{ reps: 5, load_lb: 200 }, { reps: 5, load_lb: 200, entry: { reps: 5, load_lb: 205 } }] }] },
    { kind: 'conditioning', items: [{ log_as: 'conditioning', sets: [{ distance_m: 400, duration_s: 600 }] }] }] };
  assert.deepEqual(vol.sessionVolume(body), { hard_sets: 2, by_pattern: { Squat: 2 }, tonnage_lb: 2000, conditioning_min: 10, distance_m: 400 });
  assert.equal(vol.sessionVolume(body, { logged: true }).tonnage_lb, 1025);
  const many = (n, pattern) => ({ blocks: [{ kind: 'strength', items: [{ log_as: 'lift', pattern, sets: Array.from({ length: n }, () => ({ reps: 5, load_lb: 100 })) }] }] });
  assert.match(vol.checkWeekVolume([many(12, 'Squat')], 'beginner', 0)[0], /^Squat: 12 hard sets this week; at Beginner level the most is 10/);
  assert.match(vol.checkWeekVolume([many(8, 'Squat'), many(8, 'Hinge'), many(8, 'Push Horizontal'), many(8, 'Pull Vertical')], 'beginner', 0)[0], /^32 hard sets this week with nothing logged last week: start at about 30/);
  assert.deepEqual(vol.checkWeekVolume([many(8, 'Squat'), many(8, 'Hinge'), many(8, 'Push Horizontal'), many(8, 'Pull Vertical')], 'beginner', 40), []);
  // Workouts and the week show volume.
  const w = (await call('GET', '/workouts')).body[0];
  assert.ok(w.volume && Number.isFinite(w.volume.planned.hard_sets));
  const wk = (await call('GET', `/workouts/week?start=${day(0)}`)).body.week;
  assert.ok(wk.volume && Number.isFinite(wk.volume.planned.hard_sets) && Number.isFinite(wk.volume.last_week_hard_sets));
});
