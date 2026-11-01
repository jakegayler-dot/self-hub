// The trainer's coaching library (Nov 1): every movement the generator uses has form, tension, tempo and what it
// trains; videos are only ever YouTube searches (never a made-up link); warm-ups fit their block.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../server/lib/coaching');
const { MOVEMENTS } = require('../server/lib/movements');
const { GROUPS } = require('../server/lib/figure');

test('every generator movement is coached, with real muscle groups', () => {
  for (const m of MOVEMENTS) {
    const e = C.lookup(m.name, m.pattern);
    assert.ok(e && !e.approx, `${m.name} has its own entry`);
    assert.ok(e.primary.length && e.does && e.cues.length && e.tension && e.mistake !== undefined, m.name);
    for (const g of [...e.primary, ...e.secondary]) assert.ok(GROUPS.includes(g), `${m.name}: ${g}`);
    const v = C.videoUrl(e);
    if (v) assert.match(v, /^https:\/\/www\.youtube\.com\/results\?search_query=/, m.name);
  }
});

test('names as Sentinel writes them still find their coaching; unknown ones fall back to the pattern', () => {
  assert.equal(C.lookup('Pull-ups (Kipping)'), C.MOVES['Butterfly Pull-Ups']);
  assert.equal(C.lookup('pause back squat'), C.MOVES['Back Squat']);
  assert.equal(C.lookup('Zercher Squat', 'Squat').approx, true);
  assert.equal(C.lookup('Zercher Squat'), null);
});

test('tempo follows the rep range and the kind of movement', () => {
  assert.equal(C.tempo(C.MOVES['Back Squat'], 3).code, '2-1-X-1');
  assert.equal(C.tempo(C.MOVES['Back Squat'], 8).code, '3-1-1-0');
  assert.equal(C.tempo(C.MOVES['DB Lateral Raises'], 15).code, '3-0-1-1');
  assert.equal(C.tempo(C.MOVES['Snatch'], 2).code, 'Fast');
  assert.equal(C.tempo(C.MOVES['Row'], 0), null);
});

test('the warm-up is dynamic, fits its block, leads with the main lift, and ramps to the first working weight', () => {
  const g = C.warmup(['Squat', 'Push Vertical'], { movement: 'Back Squat', pattern: 'Squat', load_lb: 265 }, 600);
  assert.equal(g.steps[0].name, 'Easy cardio');
  assert.equal(g.steps[1].name, 'World’s greatest stretch', 'hips first on a squat day');
  assert.ok(g.steps.reduce((s, x) => s + x.seconds, 0) + 180 <= 660, 'drills plus ramp fit about 10 minutes');
  assert.deepEqual(g.ramp.sets.map((s) => [s.load_lb, s.reps]), [[45, 8], [105, 5], [160, 3], [200, 2], [225, 1]]);
  const press = C.warmup(['Push Horizontal', 'Squat'], { movement: 'Bench Press', pattern: 'Push Horizontal' }, 600);
  assert.equal(press.steps[1].name, 'Band pull-aparts', 'shoulders first on a bench day');
  assert.equal(C.warmup(['Pull Vertical'], { movement: 'Strict Pull-Ups', pattern: 'Pull Vertical' }).ramp, null, 'no barbell ramp for pull-ups');
  assert.match(g.note, /static/);
});

test('cool-down stretches follow what was worked; cardio says what it trains', () => {
  assert.deepEqual(C.cooldown(['quads', 'glutes', 'quads', 'chest']).map((s) => s.name), ['Couch stretch', 'Pigeon stretch', 'Doorway pec stretch']);
  assert.match(C.ENERGY.aerobic.for, /Heart health/);
  assert.match(C.ENERGY.vo2.does, /VO2max/);
});
