// e1RM from reps AND RPE (Nov 1: "last week i lifted 145 x 6 at 8.5 rpe, which would infer a larger 1RM than
// what's on record"), and loads prescribed from the same chart.
const test = require('node:test');
const assert = require('node:assert/strict');
const strength = require('../server/lib/strength');
const gen = require('../server/lib/workoutGen');

test('the RTS chart: % of 1RM by reps and RPE', () => {
  assert.equal(strength.pctFor(1, 10), 1);
  assert.equal(strength.pctFor(6, 8.5), 0.7985); // 7.5 reps to failure, between 78.6 and 81.1
  assert.equal(strength.pctFor(5, 8), 0.811);
  assert.equal(strength.pctFor(3, 9), 0.892);
  assert.equal(strength.pctFor(10, 10), 0.739);
  assert.equal(strength.pctFor(5, 6), null, 'below RPE 6.5 the chart says nothing');
  assert.equal(strength.pctFor(5, null), null);
});

test('e1RM: chart with an RPE, Epley without, easy sets are not maxes', () => {
  assert.equal(Math.round(strength.e1rmOf(145, 6, 8.5) * 10) / 10, 181.6, '145 × 6 @ 8.5');
  assert.equal(Math.round(strength.e1rmOf(145, 6) * 10) / 10, 174, 'no RPE: Epley, a floor');
  assert.equal(strength.e1rmOf(225, 1), 225, 'a single with no RPE is its load');
  assert.equal(strength.e1rmOf(95, 5, 3), null, 'a warm-up');
  assert.equal(strength.e1rmOf(0, 5, 8), null);
  // windowedBestE1RM reads RPE too
  const lifts = [{ lift: 'Back Squat', entry_date: '2026-10-25', load_lb: 145, reps: 6, rpe: 8.5 }];
  const best = strength.windowedBestE1RM(lifts, 'Back Squat', new Date('2026-09-01'), new Date('2026-11-01'));
  assert.equal(Math.round(best), 182);
});

const rows = (lift, load, reps, rpe) => ({
  lifts: [{ entry_date: '2026-10-25', lift, load_lb: load, reps, rpe }], gymnastics: [], engineTests: [],
});

test('the generator reads last week\'s RPE and prescribes reps @ RPE from the same chart', () => {
  const lifts = [];
  for (const lift of ['Back Squat', 'Front Squat', 'Deadlift', 'Bench Press', 'Strict Press', 'Barbell Row', 'Romanian Deadlift', 'Push Press']) {
    lifts.push({ entry_date: '2026-10-25', lift, load_lb: 145, reps: 6, rpe: 8.5 });
  }
  const ctx = gen.makeContext({ lifts, gymnastics: [], engineTests: [] }, '2026-11-01');
  assert.equal(Math.round(ctx.e1rm['Back Squat']), 182);
  assert.equal(ctx.e1rmFrom['Back Squat'], '145 × 6 @ RPE 8.5 on 2026-10-25');
  let checked = 0;
  for (let seed = 0; seed < 12; seed++) {
    for (const focus of ['strength', 'mixed', 'hypertrophy']) {
      const w = gen.generateSession({ lifts, gymnastics: [], engineTests: [] }, { date: '2026-11-01', minutes: 60, focus, equipment: ['barbell', 'rack', 'bench', 'dumbbells'] }, seed);
      for (const b of w.blocks) {
        if (b.kind !== 'strength') continue;
        for (const it of b.items) {
          const e = ctx.e1rm[it.movement];
          const s = it.sets[0];
          if (!e || !s || s.load_lb == null || !s.rpe) continue;
          const want = Math.round((e * strength.pctFor(s.reps, s.rpe)) / 5) * 5;
          assert.equal(s.load_lb, want, `${it.movement} ${s.reps} @ ${s.rpe}`);
          assert.match(it.prescription, new RegExp(`@ ${want} lb, RPE ${s.rpe}$`));
          assert.match(it.load_source, /from 145 × 6 @ RPE 8\.5 on 2026-10-25/);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 5, `checked ${checked} prescriptions`);
  // The old prescription for 4 × 6 was 72% of Epley's 174 = 125 lb. Now 6 @ RPE 7.5 = 77.4% of 182 = 140.
  assert.equal(Math.round((ctx.e1rm['Back Squat'] * strength.pctFor(6, 7.5)) / 5) * 5, 140);
});

test('calibrateLoads: a trainer load well under the chart is raised, a fair one is left, Olympic lifts alone', () => {
  const ctx = gen.makeContext(rows('Back Squat', 145, 6, 8.5), '2026-11-01');
  const body = { blocks: [
    { kind: 'strength', items: [{ movement: 'back squat', log_as: 'lift', prescription: '4 × 6 @ 125 lb', sets: [{ reps: 6, load_lb: 125 }, { reps: 6, load_lb: 125 }] }] },
    { kind: 'strength', items: [{ movement: 'Back Squat', log_as: 'lift', prescription: '3 × 5 @ 140 lb', sets: [{ reps: 5, load_lb: 140, rpe: 7 }] }] },
    { kind: 'strength', items: [{ movement: 'Back Squat', log_as: 'lift', sets: [{ reps: 5, load_lb: 95, rpe: 4 }] }] },
    { kind: 'olympic', items: [{ movement: 'Back Squat', log_as: 'lift', sets: [{ reps: 2, load_lb: 100 }] }] },
  ] };
  const { changes } = gen.calibrateLoads(body, ctx);
  const it = body.blocks[0].items[0];
  assert.deepEqual(it.sets.map((s) => s.load_lb), [145, 145], '6 @ RPE 8 of 182 = 78.6% → 145');
  assert.equal(it.prescription, '4 × 6 @ 145 lb');
  assert.match(it.load_source, /^Raised to 145 lb: your e1RM is 182 lb \(from 145 × 6 @ RPE 8\.5 on 2026-10-25\)/);
  assert.equal(body.blocks[1].items[0].sets[0].load_lb, 140, '5 @ RPE 7 = 78.6% → 143: 140 is within 7.5%');
  assert.equal(body.blocks[2].items[0].sets[0].load_lb, 95, 'a warm-up set stays');
  assert.equal(body.blocks[3].items[0].sets[0].load_lb, 100, 'Olympic blocks are speed work, left alone');
  assert.equal(changes.length, 1);
});
