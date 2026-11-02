// The week's rules (Nov 2): where it sits in the block, the weather for runs and rucks, the whole body trained.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../server/lib/weekRules');

test('6-week blocks: 5 build weeks rising in effort, then a deload; then the next block', () => {
  const s = '2026-09-28';
  const at = (w) => R.blockInfo(w, s);
  assert.deepEqual([at('2026-09-28').week, at('2026-09-28').rpe_cap, at('2026-09-28').deload], [1, 7.5, false]);
  assert.deepEqual([at('2026-10-26').week, at('2026-10-26').rpe_cap, at('2026-10-26').label], [5, 9, 'Build week 5 of 5']);
  assert.deepEqual([at('2026-11-02').week, at('2026-11-02').deload, at('2026-11-02').rpe_cap], [6, true, 7]);
  assert.deepEqual([at('2026-11-09').block, at('2026-11-09').week], [2, 1]);
  assert.equal(R.blockInfo('2026-10-12', s, 8).rpe_cap, 8, 'never above the volume level\'s cap');
  assert.equal(R.blockInfo('2026-11-02', null).week, 1, 'no block yet: this week starts one');
  assert.equal(R.blockStartFor('2026-11-02', 6), '2026-09-28', 'deload this week');
  assert.equal(R.blockStartFor('2026-11-02', 1), '2026-11-02');
});

test('outside or not: feels-like 3 °C at the warmest, no snow, no freezing rain', () => {
  assert.equal(R.outdoorDay({ feels_high_c: 3, snow_cm: 0, code: 3 }).ok, true);
  assert.deepEqual(R.outdoorDay({ feels_high_c: 2.4, snow_cm: 0, code: 3 }), { ok: false, why: 'feels like 2 °C at its warmest' });
  assert.equal(R.outdoorDay({ feels_high_c: 10, snow_cm: 1, code: 71 }).ok, false);
  assert.equal(R.outdoorDay({ feels_high_c: 10, snow_cm: 0, code: 66 }).why, 'freezing rain');
  assert.equal(R.outdoorDay(null).ok, null, 'no forecast: no verdict, no block');
});

test('runs and rucks are found wherever they are written; the treadmill and machines are indoors', () => {
  const body = (items, extra = {}) => ({ blocks: [{ kind: 'conditioning', items, ...extra }] });
  assert.deepEqual(R.outdoorItems(body([{ movement: 'Ruck' }, { movement: '400 m Run' }, { movement: 'Row' }])), ['Ruck', '400 m Run']);
  assert.deepEqual(R.outdoorItems(body([{ movement: 'Treadmill Run' }, { movement: 'Bike Erg' }])), []);
  assert.deepEqual(R.outdoorItems(body([{ movement: '8 km ruck test', test: 'ruck_8km' }])), ['8 km ruck test']);
  assert.deepEqual(R.outdoorItems(body([], { title: 'Run threshold', engine: { modality: 'run', type: 'threshold' } })), ['Run threshold']);
  assert.deepEqual(R.outdoorItems(body([{ movement: 'Running Man Burpees' }])), [], 'a gym movement, not a run');
});

const lift = (pattern, n, extra = {}) => ({ movement: `${pattern} lift`, pattern, log_as: 'lift', sets: Array.from({ length: n }, () => ({ reps: 5, load_lb: 100, ...extra })) });
const day = (date, items) => ({ date, body: { blocks: [{ kind: 'strength', items }] } });

test('the whole body every week, the weakest at least as much as the typical pattern', () => {
  const full = (squat) => [day('2026-11-02', [lift('Squat', squat), lift('Hinge', 4), lift('Push Horizontal', 4)]),
    day('2026-11-04', [lift('Push Vertical', 4), lift('Pull Horizontal', 4), lift('Pull Vertical', 4)])];
  assert.deepEqual(R.checkWeek(full(4), { strengthPatterns: { Squat: 30, Hinge: 60, 'Push Horizontal': 50, 'Push Vertical': 55, 'Pull Horizontal': 70, 'Pull Vertical': 65 } }), []);
  assert.deepEqual(R.checkWeek(full(2), { strengthPatterns: { Squat: 30, Hinge: 60, 'Push Horizontal': 50, 'Push Vertical': 55, 'Pull Horizontal': 70, 'Pull Vertical': 65 } }),
    ["Squat is one of his weakest patterns but gets 2 hard sets, under the typical pattern's 4: give it at least that"]);
  const errs = R.checkWeek([day('2026-11-02', [lift('Push Horizontal', 8)])]);
  assert.match(errs[0], /^the week must train the whole body: Squat has 0 hard sets, Hinge has 0 hard sets, Push Vertical has 0 hard sets, Pull Horizontal has 0 hard sets, Pull Vertical has 0 hard sets \(at least 2 each\)$/);
  assert.deepEqual(R.checkWeek([day('2026-11-02', [lift('Push Horizontal', 8)])], { coverage: false }), [], 'a review changing one day is not held to the whole week');
});

test('a deload: half the sets, nothing over RPE 7 (stated or by load on his e1RM), no tests', () => {
  const block = R.blockInfo('2026-11-02', '2026-09-28');
  const all = (extra) => R.MAJOR.map((p) => lift(p, 2, extra));
  assert.deepEqual(R.checkWeek([day('2026-11-02', all({ rpe: 7 }))], { block, deloadCap: 12 }), []);
  assert.match(R.checkWeek([day('2026-11-02', all({ rpe: 7 }))], { block, deloadCap: 10 })[0], /^deload week: 12 hard sets planned, at most 10/);
  assert.ok(R.checkWeek([day('2026-11-02', [...all(), lift('Squat', 1, { rpe: 8.5 })])], { block, deloadCap: 20 }).some((e) => /Squat lift has sets at RPE 8.5; a deload caps working sets at RPE 7/.test(e)));
  // 5 × 100 lb on an e1RM of 110 is near-max: not a deload. On 160 it's fine (5 @ RPE 7 = 78.6% = 126).
  const heavy = R.checkWeek([day('2026-11-02', all())], { block, deloadCap: 20, e1rm: { 'squat lift': 110 } });
  assert.match(heavy[0], /^days\[0\] \(2026-11-02\): Squat lift 5 × 100 lb is over RPE 7 on his e1RM of 110 lb \(at most about 85 lb in a deload\)$/);
  assert.deepEqual(R.checkWeek([day('2026-11-02', all())], { block, deloadCap: 20, e1rm: { 'Squat lift': 160 } }), []);
  const t = R.checkWeek([day('2026-11-02', [...all(), { movement: '2k row', log_as: 'conditioning', test: 'row_2k', sets: [{}] }])], { block, deloadCap: 20 });
  assert.ok(t.some((e) => /no tests in a deload week \(2k row\)/.test(e)));
});

test('weather: a run on a cold day is sent back with the days it could move to', () => {
  const wx = { '2026-11-02': { feels_high_c: -12, snow_cm: 3, code: 73 }, '2026-11-03': { feels_high_c: 5, snow_cm: 0, code: 3 }, '2026-11-04': { feels_high_c: 6, snow_cm: 0, code: 2 } };
  const run = { date: '2026-11-02', body: { blocks: [{ kind: 'conditioning', items: [{ movement: 'Ruck', log_as: 'conditioning', sets: [{}] }] }] } };
  const errs = R.checkWeek([run], { weather: wx, coverage: false, weekDates: Object.keys(wx), availability: { '2026-11-04': 'off' } });
  assert.deepEqual(errs, ["days[0] (2026-11-02): Ruck outside, but feels like -12 °C at its warmest, 3 cm of snow (under 3 °C feels-like, or snow, is too cold for him) — move it to a day that's fit outside (2026-11-03), or do it on the bike, rower or ski erg"]);
  assert.deepEqual(R.checkWeek([{ ...run, date: '2026-11-03' }], { weather: wx, coverage: false }), []);
  assert.deepEqual(R.checkWeek([{ ...run, date: '2026-11-09' }], { weather: wx, coverage: false }), [], 'no forecast that far: not blocked');
});
