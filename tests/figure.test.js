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

const plain = (o) => JSON.parse(JSON.stringify(o));

test('the page counts with the same file (/js/figure.js), not a copy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="/js/figure.js"></script>'));
  assert.ok(html.includes('function musclesFor(name){ return SelfHubFigure.musclesFor(name); }'));
  // It runs in a browser: no require, attaches window.SelfHubFigure from window.SelfHubStrength.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'figure.js'), 'utf8');
  const strSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'strength.js'), 'utf8');
  const win = {};
  vm.runInNewContext(strSrc + '\n' + src, { self: win });
  assert.deepEqual(plain(win.SelfHubFigure.musclesFor('Back Squat')), plain(figure.musclesFor('Back Squat')));
});

test('musclesFor: the mapping itself', () => {
  assert.deepEqual(figure.musclesFor('Back Squat'), { quads: 1, glutes: 1, adductors: 1, lowerback: 0.5 }); // Kubo 2019: glutes and adductors grow as much as quads; hamstrings don't
  assert.deepEqual(figure.musclesFor('Air Squats'), { quads: 1, glutes: 0.5, adductors: 0.5 });
  // Nov 5: what counted for nothing before.
  assert.deepEqual(figure.musclesFor('KB Swings'), { hamstrings: 1, glutes: 1, lowerback: 0.5, forearms: 0.5 });
  assert.deepEqual(figure.musclesFor('Handstand Push-Ups'), { shoulders: 1, triceps: 1, traps: 0.5 });
  assert.deepEqual(figure.musclesFor('Box Jumps'), { quads: 1, glutes: 0.5, calves: 0.5 });
  assert.deepEqual(figure.musclesFor('Double-Unders'), { calves: 1 });
  assert.deepEqual(figure.musclesFor('Chin-Ups'), { lats: 1, biceps: 1, midback: 0.5 });
  assert.deepEqual(figure.musclesFor('Rack Pull'), { lowerback: 1, traps: 1, glutes: 0.5, hamstrings: 0.5, forearms: 0.5 });
  assert.deepEqual(figure.musclesFor('Ring Dips'), { chest: 1, triceps: 1, shoulders: 0.5 });
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
    quads: 2, glutes: 2, adductors: 2, lowerback: 1, chest: 1, triceps: 0.5, shoulders: 0.5, abs: 1, obliques: 0.5,
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
  const { over, ...fig } = summary.figure;
  assert.deepEqual(over, {}, 'nothing worked too hard');
  assert.deepEqual(fig, {
    height_in: 72,
    body: { height: 72, shoulder: 19, bust: 41, waist: 33, hips: 39, neck: 16, sleeve: 25, inseam: 31.5 },
    // The squats and pull-ups, and yesterday's finished session's 12-minute AMRAP of wall balls: 4 sets (Nov 5).
    sets: { quads: 6, glutes: 4, adductors: 2, lowerback: 1, shoulders: 4, triceps: 2, lats: 1, biceps: 0.5, midback: 0.5 },
    week_of: '2026-10-26',
    defaults_used: [],
    // Thursday 10-29: the deadlift 4 days ago, squats 2 days and 1 day ago, pull-ups today.
    load: { hamstrings: 0.43, glutes: 3.71, lowerback: 1, traps: 0.21, forearms: 0.21, quads: 5, adductors: 1.57, shoulders: 3.43, triceps: 1.71, lats: 1, biceps: 0.5, midback: 0.5 },
  });
  assert.equal(summary.today_workout.title, 'Squat + AMRAP');
  assert.equal(summary.today_workout.date, '2026-10-29');
  assert.equal(summary.today_workout.status, 'started');
  assert.ok(summary.strength && summary.training_week && summary.body, 'existing fields still there');
});

test('muscleLoad: a set counts in full today and fades evenly to nothing over 7 days', () => {
  const lifts = [0, 1, 3, 6, 7, 9].map((a) => ({ lift: 'Leg Extension', entry_date: new Date(Date.UTC(2026, 9, 31 - a)) }));
  // ages 0, 1, 3, 6 count 1, 6/7, 4/7, 1/7; 7 and 9 days ago are fully recovered.
  assert.deepEqual(figure.muscleLoad(lifts, [], '2026-10-31'), { quads: 2.57 });
  assert.deepEqual(figure.muscleLoad([{ lift: 'Leg Extension', entry_date: '2026-11-01' }], [], '2026-10-31'), {}, 'nothing from the future');
  assert.deepEqual(figure.muscleLoad([], [{ movement: 'Strict Pull-Ups', entry_date: '2026-10-30' }], '2026-10-31'), { lats: 0.86, biceps: 0.43, midback: 0.43 });
});

test("the page's recovery load matches the server's", () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const start = html.indexOf('  function musclesFor(name){');
  const end = html.indexOf('  var physiqueSelectedKey', start);
  assert.ok(start > 0 && end > start, 'muscleWeek found in index.html');
  const lifts = [{ lift: 'Back Squat', entry_date: '2026-10-31' }, { lift: 'Deadlift', entry_date: '2026-10-28' }, { lift: 'Bench Press', entry_date: '2026-10-24' }];
  const gymnastics = [{ movement: 'Strict Pull-Ups', entry_date: '2026-10-30' }];
  const conditioning = [{ movement: 'Row', entry_date: '2026-10-29', duration_seconds: 108 }];
  const ctx = { SelfHubFigure: figure, cache: { lifts, gymnastics, conditioning, recentWorkouts: [] }, localISO: () => '2026-10-31', weekIndexOf: () => 0 };
  vm.runInNewContext(html.slice(start, end) + '\n;this.out = muscleWeek();', ctx);
  const page = Object.fromEntries(Object.entries(ctx.out.load).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  assert.deepEqual(page, figure.muscleLoad(lifts, gymnastics, '2026-10-31', { conditioning }));
});

// Nov 5: "my lower back, biceps, upper back, and hamstrings are all sore from my workout two days ago, but the physique
// model shows them as not being worked". His Tuesday, as logged: squats to RPE 9.3, presses, bench, two sets of 12
// pull-ups, toes-to-bar, HSPU, ring dips, a hard 500 m row; an 8-minute AMRAP of KB swings and box jumps.
test('Tuesday counts: squats load the low back, the row and a finished metcon count', () => {
  const lifts = ['Back Squat', 'Back Squat', 'Back Squat', 'Back Squat'].map((lift) => ({ lift, entry_date: '2026-11-03' }));
  const gymnastics = ['Pull-Ups', 'Pull-Ups', 'Toes-to-Bar', 'Handstand Push-Ups', 'Ring Dips'].map((movement) => ({ movement, entry_date: '2026-11-03' }));
  const conditioning = [{ movement: 'Row', entry_date: '2026-11-03', duration_seconds: 108 }];
  const metcon = { kind: 'metcon', minutes: 8, result: null, items: [{ movement: 'KB Swings', log_as: 'none' }, { movement: 'Box Jumps', log_as: 'none' }] };
  const workout = (extra) => ({ date: '2026-11-03', status: 'planned', body: { blocks: [metcon] }, ...extra });
  // Score not logged and the session not marked done: the metcon can't be counted (nothing says it was done).
  let L = figure.muscleLoad(lifts, gymnastics, '2026-11-05', { conditioning, workouts: [workout()] });
  assert.equal(L.lowerback, 1.61, 'four squat sets and the row');
  assert.equal(L.hamstrings, 0.18, 'only the row');
  assert.equal(L.biceps, 0.89, 'pull-ups and the row');
  assert.equal(L.midback, 1.07);
  // With the score logged: 2 sets each of swings and box jumps.
  L = figure.muscleLoad(lifts, gymnastics, '2026-11-05', { conditioning, workouts: [workout({ body: { blocks: [{ ...metcon, result: { rounds: 7 } }] } })] });
  assert.equal(L.hamstrings, 1.61);
  assert.equal(L.lowerback, 2.32);
  // Marked done counts too; skipped never does.
  assert.equal(figure.muscleLoad([], [], '2026-11-05', { workouts: [workout({ status: 'done' })] }).hamstrings, 1.43);
  assert.deepEqual(figure.muscleLoad([], [], '2026-11-05', { workouts: [workout({ status: 'skipped', body: { blocks: [{ ...metcon, result: {} }] } })] }), {});
  // A machine in a metcon is the machine, not a barbell row; logged items aren't counted twice.
  assert.deepEqual(figure.conditioningMuscles('Row'), { quads: 0.5, glutes: 0.25, hamstrings: 0.25, lowerback: 0.25, lats: 0.5, midback: 0.5, biceps: 0.25 });
  assert.equal(figure.conditioningMuscles('Barbell Row'), null);
  assert.equal(figure.conditioningMuscles('Double-Unders'), null);
  assert.deepEqual(figure.credits({ workouts: [workout({ status: 'done', body: { blocks: [{ kind: 'metcon', minutes: 12, items: [{ movement: 'Row', log_as: 'none' }, { movement: 'Thrusters', log_as: 'lift' }] }] } })] }).map((c) => [c.name, c.n]), [['Row', 4]], 'one movement, 12 minutes: capped at 4 sets');
});

// Nov 5: "it should highlight areas that are being worked too hard". Past ~11 sets on a muscle in one session growth
// levels off (Remmert/Pelland 2024); or trained again and again before it recovered (load 1.5 × a hard session).
test('too much: over 11 sets in one day, or not recovered', () => {
  const sets = (lift, n, date) => Array.from({ length: n }, () => ({ lift, entry_date: date }));
  // 12 bench sets today: chest 12 (too much in a session); triceps and shoulders 6 each (fine).
  let o = figure.overworked(sets('Bench Press', 12, '2026-11-05'), [], '2026-11-05');
  assert.deepEqual(o, { chest: { why: 'both', day: '2026-11-05', day_sets: 12, load: 12 } }); // and today's 12 are still all counting
  // 11 is at the ceiling, not past it; and a light single session isn't unrecovered.
  assert.deepEqual(figure.overworked(sets('Bench Press', 11, '2026-11-03'), [], '2026-11-05').chest, undefined);
  // 6 curls on each of the last three days: never past 11 in a day, but 6 + 5.14 + 4.29 = 15.4 still counting.
  o = figure.overworked([...sets('DB Curl', 6, '2026-11-05'), ...sets('DB Curl', 6, '2026-11-04'), ...sets('DB Curl', 6, '2026-11-03')], [], '2026-11-05');
  assert.equal(o.biceps.why, 'unrecovered');
  assert.equal(o.biceps.load, 15.43);
  assert.equal(o.forearms, undefined, 'curls give forearms half: 7.7, under 9');
  // A week ago no longer counts.
  assert.deepEqual(figure.overworked(sets('Bench Press', 14, '2026-10-29'), [], '2026-11-05'), {});
});
