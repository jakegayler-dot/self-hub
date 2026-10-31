// Sentinel's fitness window: the 3D figure inputs and today's workout in the pushed summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

const { runMigrations, pool } = require('../server/db');
const strength = require('../server/lib/strength');
const figure = require('../server/lib/figure');
const { shapeWorkout, pickToday } = require('../server/lib/todayWorkout');
const { buildSummary, msUntilReginaRollover } = require('../server/lib/sentinel');

const NOW = new Date('2026-10-29T18:00:00Z'); // Thursday 12:00 in Regina; week Mon 10-26 to Sun 11-01

// The page's own musclesFor, lifted out of public/index.html, run against strength.js's liftPattern
// (the page's liftPattern is the same table; strength.js is shared with the page).
function pageMusclesFor() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const start = html.indexOf('function musclesFor(name){');
  const end = html.indexOf('function muscleWeek(', start);
  assert.ok(start > 0 && end > start, 'musclesFor found in index.html');
  const ctx = { liftPattern: strength.liftPattern };
  vm.runInNewContext(html.slice(start, end) + '\n;this.musclesFor = musclesFor;', ctx);
  return ctx.musclesFor;
}

const plain = (o) => JSON.parse(JSON.stringify(o));

test('musclesFor: server copy matches the page for every known movement', () => {
  const page = pageMusclesFor();
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const names = new Set();
  html.replace(/'([^'\n]{2,80})':'(Squat|Hinge|Olympic|Push Vertical|Push Horizontal|Pull Vertical|Pull Horizontal|Core|Accessory|Balance|Conditioning)'/g, (m, n) => names.add(n));
  ['Standing Calf Raise', 'Nordic Curl', 'Leg Extension', 'Hip Thrust', 'Good Morning', "Farmer's Carry", 'Suitcase Carry',
    'Rope Climb', 'Pallof Press', 'GHD Sit-Ups', 'Copenhagen Plank', 'Neck Harness', 'Pec Deck', 'Ring Muscle-Up',
    'Walking Lunges', 'Sumo Deadlift', 'RDL', 'Thrusters', 'Wall Balls', 'Split Jerk', 'Clean & Jerk', 'Snatch',
    'Power Clean', 'Weighted Dips', 'Ring Rows', 'Something Unknown'].forEach((n) => names.add(n));
  assert.ok(names.size > 100);
  for (const n of names) assert.deepEqual(plain(figure.musclesFor(n)), plain(page(n)), n);
});

test('musclesFor: the mapping itself', () => {
  assert.deepEqual(figure.musclesFor('Back Squat'), { quads: 1, glutes: 0.5, adductors: 0.5 });
  assert.deepEqual(figure.musclesFor('Deadlift'), { hamstrings: 1, glutes: 1, lowerback: 0.5, traps: 0.5, forearms: 0.5 });
  assert.deepEqual(figure.musclesFor('Bench Press'), { chest: 1, triceps: 0.5, shoulders: 0.5 });
  assert.deepEqual(figure.musclesFor('Weighted Dips'), { chest: 1, triceps: 1, shoulders: 0.5 });
  assert.deepEqual(figure.musclesFor('Strict Pull-Ups'), { lats: 1, biceps: 0.5, midback: 0.5 });
  assert.deepEqual(figure.musclesFor('DB Preacher Curl'), { biceps: 1, forearms: 0.5 });
  assert.deepEqual(figure.musclesFor('Toes-to-Bar'), { abs: 1, obliques: 0.5 });
  assert.deepEqual(figure.musclesFor('Standing Calf Raise'), { calves: 1 });
  assert.deepEqual(figure.musclesFor('Something Unknown'), {});
  // Every group named is one body3d.js knows.
  for (const n of ['Back Squat', 'Deadlift', 'Snatch', 'Clean & Jerk', 'Rope Climb', 'Neck Harness', "Farmer's Carry"]) {
    for (const g of Object.keys(figure.musclesFor(n))) assert.ok(figure.GROUPS.includes(g), g);
  }
});

test('the group names match body3d.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'body3d.js'), 'utf8');
  const block = src.slice(src.indexOf('var GROUPS = {'), src.indexOf('};', src.indexOf('var GROUPS = {')));
  const keys = [...block.matchAll(/^\s{4}(\w+):\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [...figure.GROUPS].sort());
});

test('muscleWeekSets counts this week only, lifts and gymnastics', () => {
  const week = { start: '2026-10-26', end: '2026-11-01' };
  const lifts = [
    { entry_date: '2026-10-25', lift: 'Back Squat' }, // Sunday before: not counted
    { entry_date: '2026-10-26', lift: 'Back Squat' },
    { entry_date: new Date('2026-10-27T00:00:00Z'), lift: 'Back Squat' },
    { entry_date: '2026-11-01', lift: 'Bench Press' },
  ];
  const gym = [{ entry_date: '2026-10-28', movement: 'Toes-to-Bar' }, { entry_date: '2026-11-02', movement: 'Push-Ups' }];
  assert.deepEqual(figure.muscleWeekSets(lifts, gym, week), {
    quads: 2, glutes: 1, adductors: 1, chest: 1, triceps: 0.5, shoulders: 0.5, abs: 1, obliques: 0.5,
  });
});

test('bodyFor: measurements, inseam mean, defaults', () => {
  const { body, defaults } = figure.bodyFor({ height_in: '71.5' }, [
    { shoulder: '19.0', bust: '41.0', waist: '33.0', seat_hips: '39.0', neck: '16.0', sleeve: '25.0', inseam_low: '31.0', inseam_high: '32.0' },
  ]);
  assert.deepEqual(body, { height: 71.5, shoulder: 19, bust: 41, waist: 33, hips: 39, neck: 16, sleeve: 25, inseam: 31.5 });
  assert.deepEqual(defaults, []);
  const none = figure.bodyFor(null, []);
  assert.deepEqual(none.body, { height: 70, shoulder: 18, bust: 40, waist: 34, hips: 38, neck: 15, sleeve: 24, inseam: 31 });
  assert.equal(none.defaults.length, 8);
});

const WORKOUT_BODY = {
  blocks: [
    { kind: 'warmup', title: 'Warm-up', minutes: 8, items: [{ movement: 'Row — easy', log_as: 'none', prescription: '3 min, building pace', sets: [] }] },
    { kind: 'strength', title: 'Strength', minutes: 20, items: [
      { movement: 'Back Squat', log_as: 'lift', prescription: '5 × 3 @ 225 lb', sets: [{ reps: 3, load_lb: 225, entry: { table: 'fitness_lifts', id: 1, reps: 3, load_lb: 225 } }, { reps: 3, load_lb: 225 }, { reps: 3, load_lb: 225 }, { reps: 3, load_lb: 225 }, { reps: 3, load_lb: 225 }] },
    ] },
    { kind: 'metcon', title: '12-min AMRAP', minutes: 12, items: [{ movement: 'Wall Balls', log_as: 'none', prescription: '15 reps @ 20 lb', sets: [] }] },
  ],
};

test('today_workout shape and status', () => {
  const row = { id: 7, workout_date: new Date('2026-10-29T00:00:00Z'), title: 'Squat + AMRAP', focus: 'strength', minutes: 45, status: 'planned', body: JSON.stringify(WORKOUT_BODY), meta: { objective: 'Legs' } };
  assert.deepEqual(shapeWorkout(row), {
    id: 7, date: '2026-10-29', title: 'Squat + AMRAP', focus: 'strength', objective: 'Legs', minutes: 45, status: 'started',
    sets_logged: 1, sets_total: 6,
    blocks: [
      { title: 'Warm-up', kind: 'warmup', minutes: 8, items: [{ name: 'Row — easy', detail: '3 min, building pace' }] },
      { title: 'Strength', kind: 'strength', minutes: 20, items: [{ name: 'Back Squat', detail: '5 × 3 @ 225 lb' }] },
      { title: '12-min AMRAP', kind: 'metcon', minutes: 12, items: [{ name: 'Wall Balls', detail: '15 reps @ 20 lb' }] },
    ],
  });
  const fresh = { ...row, body: { blocks: [] } };
  assert.equal(shapeWorkout(fresh).status, 'planned');
  assert.equal(shapeWorkout({ ...row, status: 'done' }).status, 'done');
  // A skipped one and a planned one on the same day: the planned one shows.
  assert.equal(pickToday([{ ...fresh, id: 1, status: 'skipped' }, { ...fresh, id: 2 }]).id, 2);
  assert.equal(pickToday([]), null);
});

test('rollover: next push at 00:01 Regina', () => {
  // 12:00 Regina → 12 h 1 min
  assert.equal(msUntilReginaRollover(NOW), (12 * 60 + 1) * 60 * 1000);
  // 23:59:30 Regina (05:59:30Z) → 1.5 min
  assert.equal(msUntilReginaRollover(new Date('2026-10-30T05:59:30Z')), 90 * 1000);
});

test('buildSummary carries figure and today_workout', async () => {
  await runMigrations();
  await pool.query('UPDATE fitness_profile SET height_in = 72 WHERE id = 1');
  await pool.query("INSERT INTO fitness_measurements (entry_date, shoulder, bust, waist, seat_hips, neck, sleeve, inseam_low, inseam_high) VALUES ('2026-10-01', 19, 41, 33, 39, 16, 25, 31, 32)");
  for (const [d, l] of [['2026-10-25', 'Deadlift'], ['2026-10-27', 'Back Squat'], ['2026-10-28', 'Back Squat']]) {
    await pool.query('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps) VALUES ($1,$2,225,5)', [d, l]);
  }
  await pool.query("INSERT INTO fitness_gymnastics (entry_date, movement, reps) VALUES ('2026-10-29', 'Strict Pull-Ups', 8)");
  await pool.query(
    "INSERT INTO fitness_workouts (workout_date, title, focus, minutes, status, inputs, body) VALUES ('2026-10-28', 'Yesterday', 'mixed', 40, 'done', '{}', $1), ('2026-10-29', 'Squat + AMRAP', 'strength', 45, 'planned', '{}', $1)",
    [JSON.stringify(WORKOUT_BODY)],
  );
  const { summary } = await buildSummary(pool, NOW);
  assert.deepEqual(summary.figure, {
    height_in: 72,
    body: { height: 72, shoulder: 19, bust: 41, waist: 33, hips: 39, neck: 16, sleeve: 25, inseam: 31.5 },
    sets: { quads: 2, glutes: 1, adductors: 1, lats: 1, biceps: 0.5, midback: 0.5 },
    week_of: '2026-10-26',
    defaults_used: [],
  });
  assert.equal(summary.today_workout.title, 'Squat + AMRAP');
  assert.equal(summary.today_workout.date, '2026-10-29');
  assert.equal(summary.today_workout.status, 'started');
  assert.ok(summary.strength && summary.training_week && summary.body, 'existing fields still there');
});
