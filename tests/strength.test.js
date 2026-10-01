// The shared strength module must return exactly what the Health tab used to
// compute client-side. tests/fixtures/legacy-strength-client.js is a frozen
// copy of that old client code; both are run on the same fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const strength = require('../server/lib/strength');
const legacy = require('./fixtures/legacy-strength-client');

// Shaped like the JSON the page receives: DATE → ISO string, NUMERIC → string.
function d(s) { return s + 'T00:00:00.000Z'; }
const BENCHMARK_LIFTS = [
  'Back Squat', 'Bench Press', 'Bent Over Row', 'Clean & Jerk', 'Deadlift', 'Front Squat',
  'Hex Press', 'Power Clean', 'Power Snatch', 'Snatch', 'Split Jerk', 'Strict Press',
  'Strict Pull-Ups', 'Sumo Deadlift', 'Barbell Curl 21s', 'Mystery Lift', 'Farmer Carry Row',
];
const LIFTS = [
  ['2026-05-02', 'Back Squat', '225.0', 5], ['2026-06-10', 'Back Squat', '235.0', 3],
  ['2026-08-15', 'Back Squat', '245.0', 5], ['2026-09-20', 'Back Squat', '250.0', 2],
  ['2026-08-20', 'Front Squat', '185.0', 3], ['2026-09-01', 'Deadlift', '315.0', 3],
  ['2026-06-01', 'Deadlift', '335.0', 1], ['2026-09-12', 'Sumo Deadlift', '295.0', 5],
  ['2026-08-28', 'Bench Press', '185.0', 5], ['2026-09-25', 'Hex Press', '60.0', 10],
  ['2026-09-03', 'Strict Press', '115.0', 5], ['2026-09-18', 'Strict Press', '120.0', 3],
  ['2026-08-05', 'Strict Pull-Ups', '25.0', 5], ['2026-09-10', 'Bent Over Row', '155.0', 8],
  ['2026-09-14', 'Clean & Jerk', '185.0', 1], ['2026-09-14', 'Power Clean', '175.0', 2],
  ['2026-07-01', 'Snatch', '135.0', 1], ['2026-09-22', 'Power Snatch', '125.0', 1],
  ['2026-09-26', 'Split Jerk', '205.0', 1], ['2026-09-10', 'Barbell Curl 21s', '65.0', 21],
  ['2026-09-11', 'Mystery Lift', '100.0', 5], ['2026-09-11', 'Farmer Carry Row', '100.0', 5],
].map(([date, lift, load, reps], i) => ({ id: i + 1, entry_date: d(date), lift, load_lb: load, reps, rpe: null }));
const BODYWEIGHT = [
  ['2026-05-01', '158.0'], ['2026-06-15', '160.4'], ['2026-08-01', '161.2'],
  ['2026-08-20', '162.0'], ['2026-09-05', '162.8'], ['2026-09-25', '163.5'],
].map(([date, w], i) => ({ id: i + 1, entry_date: d(date), weight_lb: w, body_fat_pct: null }));

const DATA = { lifts: LIFTS, bodyweight: BODYWEIGHT, benchmarkLifts: BENCHMARK_LIFTS };
const NOWS = [
  new Date('2026-09-30T18:00:00Z'), // normal
  new Date('2026-06-20T12:00:00Z'), // earlier: fewer lifts in window
  new Date('2027-01-15T12:00:00Z'), // no bodyweight in window → falls back to last weigh-in
  new Date('2026-04-01T12:00:00Z'), // nothing in window at all
];

function compareProfile(data, now) {
  const old = legacy(JSON.parse(JSON.stringify(data)), now);
  const cur = strength.computeStrengthProfile(data, now);
  assert.equal(cur.avgBW, old.avgBW, 'avg bodyweight');
  assert.deepEqual(cur.rows, old.rows, 'breakdown rows');
  assert.deepEqual(cur.patterns, old.patterns, 'pattern cards');
  return { old, cur };
}

test('strength profile matches the old client code on the fixture', () => {
  for (const now of NOWS) compareProfile(DATA, now);
  const { cur } = compareProfile(DATA, NOWS[0]);
  // sanity: the fixture really exercises the scoring
  assert.ok(cur.rows.length >= 8);
  assert.ok(!cur.rows.some((r) => r.lift === 'Barbell Curl 21s'), 'accessory excluded');
  assert.ok(!cur.rows.some((r) => r.lift === 'Mystery Lift'), 'uncategorized excluded');
  assert.ok(cur.rows.some((r) => r.lift === 'Hex Press'), 'pattern fallback standard used');
  assert.ok(!cur.rows.some((r) => r.lift === 'Snatch'), 'lift outside 2-month window excluded');
});

test('matches with no bodyweight at all, and with no data', () => {
  compareProfile({ ...DATA, bodyweight: [] }, NOWS[0]);
  compareProfile({ lifts: [], bodyweight: [], benchmarkLifts: [] }, NOWS[0]);
  const cur = strength.computeStrengthProfile({ ...DATA, bodyweight: [] }, NOWS[0]);
  assert.equal(cur.avgBW, null);
  assert.ok(cur.rows.every((r) => r.score === null && r.level === '—'));
  // Faithful to the old page: with no bodyweight a pattern card still exists
  // but its score is NaN (the page shows "Elite (NaN)"). The Sentinel summary
  // drops these; see tests/sentinel.test.js.
  assert.ok(cur.patterns.length > 0 && cur.patterns.every((p) => Number.isNaN(p.score)));
});

test('falls back to the last weigh-in when none is inside the window', () => {
  const cur = strength.computeStrengthProfile(DATA, NOWS[2]);
  assert.equal(cur.bwFromWindow, false);
  assert.equal(cur.avgBW, 163.5);
});

test('pattern trend chart points match the old client code', () => {
  const old = legacy(JSON.parse(JSON.stringify(DATA)), NOWS[0]);
  for (const pattern of ['Squat', 'Hinge', 'Push Vertical', 'Push Horizontal', 'Pull Vertical', 'Pull Horizontal', 'Olympic', 'Core']) {
    const oldPts = old.trend(pattern);
    const cur = strength.computeStrengthTrend(DATA, pattern, NOWS[0]);
    const curPts = cur === null ? [] : cur.map((p) => ({ x: p.x.toISOString(), y: p.y }));
    assert.deepEqual(curPts, oldPts, pattern);
  }
  assert.equal(strength.computeStrengthTrend(DATA, 'Core', NOWS[0]), null, 'no lifts in pattern → null');
});

test('liftPattern / levelScore / levelLabel agree with the old code', () => {
  const old = legacy({ lifts: [], bodyweight: [], benchmarkLifts: [] }, NOWS[0]);
  const names = Object.keys(strength.LIFT_PATTERN).concat(Object.keys(strength.GYMNASTICS_PATTERN),
    ['Handstand Push', 'L-Sit', 'Ring Muscle-Up', 'Walking Lunge', 'Trap Bar Deadlift', 'Hang Snatch',
     'Ring Dip', 'Landmine Press', 'Chin-Up Pullup', 'Pendlay Row', 'Hammer Curl', 'Farmer Carry']);
  for (const n of names) assert.equal(strength.liftPattern(n), old.liftPattern(n), n);
  assert.equal(strength.levelScore(0.75, strength.STRENGTH_STANDARDS['Back Squat']), 20);
  assert.equal(strength.levelScore(2.6, strength.STRENGTH_STANDARDS['Back Squat']), 100);
  assert.equal(strength.levelLabel(59), 'Novice');
  assert.equal(strength.levelLabel(100), 'Elite');
});
