// The physique against its target (lib/physique.js) and the trainer's priorities from the measured gaps.
const test = require('node:test');
const assert = require('node:assert/strict');
const physique = require('../server/lib/physique');
const gen = require('../server/lib/workoutGen');

const today = '2026-11-03';
const profile = { physique_targets: { ...physique.DEFAULT_TARGETS } };
const measurements = [
  { entry_date: '2026-07-01', upper_arm: 12.5, thigh: 19.5, calf: 14.0, waist: 32.0, bust: 37.0, neck: 14.0 },
  { entry_date: '2026-09-01', upper_arm: 12.8, thigh: 19.8 },
  { entry_date: '2026-10-25', upper_arm: 13.0, thigh: 20.0, waist: 31.5 },
];
const bodyweight = [
  { entry_date: '2026-07-01', weight_lb: 150, body_fat_pct: 13 },
  { entry_date: '2026-10-30', weight_lb: 155, body_fat_pct: 12 },
];

test('each measurement uses its own latest reading, with gaps and direction', () => {
  const st = physique.physiqueStatus({ profile, measurements, bodyweight, today });
  assert.equal(st.metrics.upper_arm.current, 13);
  assert.equal(st.metrics.upper_arm.gap, 2.5);
  assert.equal(st.metrics.bust.current, 37); // only in the first entry, not blanked by later ones
  assert.equal(st.metrics.waist.gap, -0.5); // waist still to lose
  assert.equal(st.metrics.waist.lower_is_better, true);
  assert.equal(st.metrics.shoulder_circ.current, null);
  assert.ok(st.measure_due.includes('shoulder_circ'));
  assert.ok(st.metrics.upper_arm.trend_per_30d > 0);
  assert.equal(st.metrics.upper_arm.on_track, true);
  assert.ok(st.metrics.upper_arm.eta > today);
  assert.equal(st.biggest_gaps[0].key, 'upper_arm'); // 2.5 of 15.5 beats 2.5 of 22.5
  assert.equal(st.lean_mass_lb, 136.4);
  assert.equal(st.lean_to_add_lb, 12.1);
  assert.match(physique.physiqueBrief(st), /Arm 13" → 15.5"/);
});

test('a target he has reached is "there", not a gap', () => {
  const st = physique.physiqueStatus({ profile, measurements: [{ entry_date: '2026-10-01', calf: 15.5 }], bodyweight: [], today });
  assert.equal(st.metrics.calf.reached, true);
  assert.equal(st.biggest_gaps.length, 0);
});

test('targets he changes override the defaults; junk is ignored', () => {
  const t = physique.targetsOf({ physique_targets: { waist: 30, neck: 'big' } });
  assert.equal(t.waist, 30);
  assert.equal(t.neck, physique.DEFAULT_TARGETS.neck);
});

test('trend needs two readings at least two weeks apart', () => {
  assert.equal(physique.trendPer30([{ date: '2026-10-30', value: 1 }, { date: '2026-11-01', value: 2 }], today), null);
  assert.ok(Math.abs(physique.trendPer30([{ date: '2026-10-01', value: 10 }, { date: '2026-10-31', value: 11 }], today) - 1) < 0.01);
});

test("the trainer's priorities follow the measured gaps", () => {
  const st = physique.physiqueStatus({ profile, measurements, bodyweight, today });
  const p = gen.physiquePriority(st);
  assert.equal(p.arms, 1); // the biggest share
  assert.ok(p.bust > p.neck);
  assert.equal(p.shoulder, 0.1); // never measured: the fallback (maintenance)
  assert.deepEqual(gen.physiquePriority(null), { seat_hips: 1.0, bust: 0.5, arms: 0.35, neck: 0.3, shoulder: 0.1 });
});
