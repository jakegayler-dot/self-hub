// What he actually did and how his body is (Nov 6). The fixture is his real week: back squat to 155 × 5 at RPE 9.3 on
// Nov 3 in a session with a KB swing and box jump couplet he didn't score, then the Nov 6 plan that started all this.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../server/lib/recovery');

const set = (rpe, extra = {}) => ({ reps: 5, load_lb: 145, rpe, entry: null, ...extra });
const lift = (movement, pattern, sets) => ({ movement, pattern, log_as: 'lift', sets });
const logged = (s) => ({ ...s, entry: { table: 'lifts', id: 1 } });

const NOV3 = { workout_date: '2026-11-03', title: 'Strength A', status: 'planned', session_rpe: null, session_notes: 'Thrusters gassed me', body: { blocks: [
  { kind: 'strength', title: 'Back squat', items: [lift('Back Squat', 'Squat', [logged(set(9.3)), logged(set(7.5))])] },
  { kind: 'accessory', title: 'Single-leg', items: [lift('DB Bulgarian Split Squat', 'Squat', [set(7), set(7)])] },
  { kind: 'metcon', title: '8-minute couplet', result: null, items: [{ movement: 'KB Swings', log_as: 'none', prescription: '10 @ 44 lb', sets: [] }, { movement: 'Box Jumps', log_as: 'none', prescription: '8', sets: [] }] },
] } };
const NOV5_SKIPPED = { workout_date: '2026-11-05', title: 'Swim', status: 'planned', body: { blocks: [{ kind: 'conditioning', title: 'Swim', items: [{ movement: 'Swim', log_as: 'conditioning', sets: [{ distance_m: 400, entry: null }] }] }] } };
const rows = {
  lifts: [
    { entry_date: '2026-11-03', lift: 'Back Squat', load_lb: 135, reps: 5, rpe: 7.5 },
    { entry_date: '2026-11-03', lift: 'Back Squat', load_lb: 155, reps: 5, rpe: 9.3 },
    { entry_date: '2026-11-03', lift: 'Back Squat', load_lb: 115, reps: 5, rpe: 7 },
    { entry_date: '2026-11-03', lift: 'Bench Press', load_lb: 135, reps: 6, rpe: 7 },
    { entry_date: '2026-11-03', lift: 'Bench Press', load_lb: 135, reps: 6, rpe: 7.5 },
  ],
  gymnastics: [{ entry_date: '2026-11-04', movement: 'Strict Pull-Ups', reps: 13 }],
  conditioning: [{ entry_date: '2026-11-03', movement: 'Row', distance_m: 500, duration_seconds: 108, notes: 'Hard' }],
  workouts: [NOV3, NOV5_SKIPPED], soreness: [],
};
const recent = (extra = {}) => R.recentTraining({ ...rows, ...extra }, '2026-11-06');

// The session it actually programmed on Nov 6.
const NOV6_BAD = { blocks: [
  { kind: 'strength', title: 'Back squat 5 x 5', items: [lift('Back Squat', 'Squat', [set(7), set(7), set(7), set(7), set(7)])] },
  { kind: 'accessory', title: 'Front squat and RDL', items: [lift('Front Squat', 'Squat', [set(7), set(7)]), lift('Romanian Deadlift', 'Hinge', [set(7), set(7), set(7)])] },
  { kind: 'metcon', title: 'Light finisher', items: [{ movement: 'KB Swings', log_as: 'none', sets: [] }, { movement: 'Box Jumps', log_as: 'none', sets: [] }] },
] };
const PRESS_DAY = { blocks: [
  { kind: 'strength', title: 'Press', items: [lift('Strict Press', 'Push Vertical', [set(7.5), set(7.5), set(7.5)])] },
  { kind: 'metcon', title: 'Triplet', items: [{ movement: 'Deadlift', log_as: 'none', sets: [] }, { movement: 'Row', log_as: 'none', sets: [] }, { movement: 'Toes-to-Bar', log_as: 'none', sets: [] }] },
] };

test('the picture says what he did: logged sets, the unscored metcon, his notes, what never happened', () => {
  const r = recent();
  const nov3 = r.days.find((d) => d.date === '2026-11-03');
  assert.ok(nov3.did.some((x) => x.startsWith('Back Squat:') && x.includes('155×5 @9.3')));
  assert.ok(nov3.did.some((x) => /KB Swings|10 @ 44 lb/.test(x) && x.includes('no score logged')), 'a metcon he did and did not score still shows');
  assert.equal(nov3.sessions[0].notes, 'Thrusters gassed me');
  assert.deepEqual(nov3.sessions[0].left_undone, ['DB Bulgarian Split Squat']);
  assert.deepEqual(r.days.find((d) => d.date === '2026-11-05').not_done, ['Swim']);
  assert.equal(r.patterns.Squat.days_ago, 3);
  assert.equal(r.patterns.Squat.last_top_rpe, 9.3);
  assert.deepEqual(r.metcons[0].movements, ['KB Swings', 'Box Jumps']);
});

test("Nov 6's session is refused on all three counts, and each says what to do", () => {
  const e = R.checkRecovery([{ date: '2026-11-06', body: NOV6_BAD }], recent());
  assert.ok(e.some((x) => /Squat/.test(x) && /3 days after/.test(x) && /needs 4 days/.test(x)), `squat rest: ${e}`);
  assert.ok(e.some((x) => /One heavy lower-body pattern/.test(x)), `stacking: ${e}`);
  assert.ok(e.some((x) => /repeats "8-minute couplet" from 2026-11-03/.test(x)), `metcon: ${e}`);
});

test('a session that respects him passes, and rest runs out', () => {
  assert.deepEqual(R.checkRecovery([{ date: '2026-11-06', body: PRESS_DAY }], recent()), []);
  const squat = { blocks: [{ kind: 'strength', title: 'Squat', items: [lift('Back Squat', 'Squat', [set(7), set(7), set(7)])] }] };
  assert.deepEqual(R.checkRecovery([{ date: '2026-11-07', body: squat }], recent()), [], 'four days after RPE 9.3 is fine');
});

test('under RPE 7 is recovery work and passes; his note asking for it outright is his call', () => {
  const light = { blocks: [{ kind: 'strength', title: 'Squat', items: [lift('Back Squat', 'Squat', [set(6), set(6)])] }] };
  assert.deepEqual(R.checkRecovery([{ date: '2026-11-04', body: light }], recent()), []);
  const heavy = { blocks: [{ kind: 'strength', title: 'Squat', items: [lift('Back Squat', 'Squat', [set(8), set(8)])] }] };
  assert.equal(R.checkRecovery([{ date: '2026-11-06', body: heavy }], recent()).length, 1);
  assert.deepEqual(R.checkRecovery([{ date: '2026-11-06', body: heavy }], recent(), { note: 'I want to squat again today' }), []);
});

test('hard days inside the plan are spaced the same way, and a metcon can not repeat inside it', () => {
  const squat = (t) => ({ blocks: [{ kind: 'strength', title: t, items: [lift('Back Squat', 'Squat', [set(7), set(7), set(7)])] }] });
  const e = R.checkRecovery([{ date: '2026-11-09', body: squat('a') }, { date: '2026-11-10', body: squat('b') }], recent());
  assert.ok(e.some((x) => /2026-11-10/.test(x) && /needs 3 days/.test(x)), String(e));
  const hinge = { blocks: [{ kind: 'strength', title: 'Pull', items: [lift('Deadlift', 'Hinge', [set(7), set(7)])] }] };
  assert.ok(R.checkRecovery([{ date: '2026-11-09', body: squat('a') }, { date: '2026-11-10', body: hinge }], recent()).some((x) => /the legs need a day/.test(x)));
  const m = (t) => ({ blocks: [{ kind: 'metcon', title: t, items: [{ movement: 'Thruster', log_as: 'none', sets: [] }, { movement: 'Burpees', log_as: 'none', sets: [] }] }] });
  assert.ok(R.checkRecovery([{ date: '2026-11-09', body: m('one') }, { date: '2026-11-12', body: m('two') }], recent()).some((x) => /repeats "one"/.test(x)));
});

test('a benchmark can be retested; one shared movement is not a repeat', () => {
  const fran = { blocks: [{ kind: 'metcon', title: 'Fran', benchmark: 'Fran', items: [{ movement: 'Thruster', log_as: 'none', sets: [] }, { movement: 'Pull-Ups', log_as: 'none', sets: [] }] }] };
  const before = { ...NOV3, body: { blocks: [fran.blocks[0]] }, status: 'done' };
  assert.deepEqual(R.checkRecovery([{ date: '2026-11-08', body: fran }], recent({ workouts: [before] })), []);
  assert.equal(R.metconClash(['Thruster', 'Box Jumps'], ['KB Swings', 'Box Jumps']), null);
  assert.deepEqual(R.metconClash(['KB Swing', 'Box Jump'], ['KB Swings', 'Box Jumps']), ['kb swing', 'box jump'], 'plurals are the same movement');
});

test('soreness: sore keeps hard work off for 2 days, very sore 3, and only on the muscle it works', () => {
  const dl = { blocks: [{ kind: 'strength', title: 'Pull', items: [lift('Deadlift', 'Hinge', [set(7), set(7)])] }] };
  const sore = (date, level, area = 'hamstrings') => recent({ soreness: [{ entry_date: date, area, level }] });
  assert.ok(R.checkRecovery([{ date: '2026-11-06', body: dl }], sore('2026-11-05', 1)).some((x) => /hamstrings/.test(x) && /sore on 2026-11-05/.test(x)));
  assert.equal(R.checkRecovery([{ date: '2026-11-06', body: dl }], sore('2026-11-03', 1)).length, 0, 'three days after "sore" it has passed');
  assert.ok(R.checkRecovery([{ date: '2026-11-06', body: dl }], sore('2026-11-03', 2)).some((x) => /very sore/.test(x)));
  assert.equal(R.checkRecovery([{ date: '2026-11-06', body: PRESS_DAY }], sore('2026-11-06', 2)).length, 0, 'a press does not work the hamstrings');
  assert.equal(recent({ soreness: [{ entry_date: '2026-11-01', area: 'quads', level: 2 }] }).soreness.length, 0, 'old soreness drops out of the picture');
});

test('too much: the figure counts the unscored metcon, and a plan keeps off a muscle that has not recovered', () => {
  const r = recent();
  assert.ok(r.muscle_load.hamstrings > 0, 'swings in a session he did count on the hamstrings');
  const hammered = Array.from({ length: 14 }, () => ({ entry_date: '2026-11-05', lift: 'Deadlift', load_lb: 200, reps: 5, rpe: 8 }));
  const r2 = recent({ lifts: hammered });
  assert.ok(r2.overworked.hamstrings, JSON.stringify(r2.overworked));
  const hip = { blocks: [{ kind: 'strength', title: 'Glutes', items: [lift('Barbell Hip Thrust', 'Accessory', [set(7), set(7)])] }] };
  assert.ok(R.checkRecovery([{ date: '2026-11-06', body: hip }], r2).some((x) => /had too much/.test(x)));
  assert.equal(R.checkRecovery([{ date: '2026-11-06', body: PRESS_DAY }], r2).filter((x) => /had too much/.test(x)).length, 0);
  assert.equal(R.checkRecovery([{ date: '2026-11-12', body: hip }], r2).filter((x) => /had too much/.test(x)).length, 0, 'it fades as the days pass');
});

test('the words he uses for where it hurts', () => {
  assert.deepEqual(R.soreAreas('low back'), ['lowerback']);
  assert.deepEqual(R.soreAreas('lower back'), ['lowerback']);
  assert.deepEqual(R.soreAreas('upper back'), ['midback']);
  assert.deepEqual(R.soreAreas('back'), ['lats', 'midback']);
  assert.deepEqual(R.soreAreas('hammies'), ['hamstrings']);
  assert.deepEqual(R.soreAreas('Legs'), ['quads', 'hamstrings', 'glutes']);
  assert.deepEqual(R.soreAreas('shoulders'), ['shoulders']);
  assert.deepEqual(R.soreAreas('feelings'), []);
});

test('a past session with anything logged is over; today and untouched ones are not', () => {
  assert.equal(R.effectiveStatus('planned', '2026-11-03', 10, '2026-11-06'), 'done');
  assert.equal(R.effectiveStatus('planned', '2026-11-06', 10, '2026-11-06'), 'planned', 'still going today');
  assert.equal(R.effectiveStatus('planned', '2026-11-03', 0, '2026-11-06'), 'planned', 'never started');
  assert.equal(R.effectiveStatus('skipped', '2026-11-03', 2, '2026-11-06'), 'skipped');
});
