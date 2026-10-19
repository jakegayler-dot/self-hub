// Training volume (Jake, 2026-10-19: "volume is not being shown, which is a big part of ensuring I avoid burnout…
// training volume should ramp up, not be at a huge level right off the hop"). Per session and per week: hard sets
// (by movement pattern), tonnage, conditioning minutes and distance; a volume level sets the weekly ceiling and the
// ramp (no more than about 20% over what he actually did the week before).

// Weekly hard sets per major pattern, by level (the low end is where a level starts; the trainer builds within it).
const LEVELS = {
  beginner: { label: 'Beginner', sets_per_pattern: [6, 10], conditioning_hard_min: 40, rpe_cap: 8 },
  intermediate: { label: 'Intermediate', sets_per_pattern: [10, 14], conditioning_hard_min: 70, rpe_cap: 8.5 },
  advanced: { label: 'Advanced', sets_per_pattern: [14, 18], conditioning_hard_min: 100, rpe_cap: 9 },
  elite: { label: 'Elite', sets_per_pattern: [18, 22], conditioning_hard_min: 140, rpe_cap: 9.5 },
};
const RAMP = 1.2; // at most 20% more hard sets than he actually did the week before
// A first week (or one after a week off): the low end of the level across about five major patterns.
const startCap = (L) => L.sets_per_pattern[0] * 5;

const PATTERNS = ['Squat', 'Hinge', 'Push Horizontal', 'Push Vertical', 'Pull Horizontal', 'Pull Vertical', 'Olympic'];

// One session's planned volume (from its body), or what he logged (logged: true).
function sessionVolume(body, { logged = false } = {}) {
  const v = { hard_sets: 0, by_pattern: {}, tonnage_lb: 0, conditioning_min: 0, distance_m: 0 };
  for (const b of (body && body.blocks) || []) {
    if (b.kind === 'metcon') { v.conditioning_min += Number(b.minutes) || 0; continue; }
    if (['warmup', 'cooldown'].includes(b.kind)) continue;
    for (const it of b.items || []) {
      if (it.log_as === 'none') continue;
      for (const s of it.sets || []) {
        if (logged && !s.entry) continue;
        const e = logged ? s.entry : s;
        if (it.log_as === 'lift' || it.log_as === 'gymnastics') {
          v.hard_sets += 1;
          const p = it.pattern && PATTERNS.includes(it.pattern) ? it.pattern : 'Other';
          v.by_pattern[p] = (v.by_pattern[p] || 0) + 1;
          if (it.log_as === 'lift' && e.reps != null && e.load_lb != null) v.tonnage_lb += Number(e.reps) * Number(e.load_lb);
        } else if (it.log_as === 'conditioning' || it.log_as === 'engine' || it.log_as === 'test') {
          const secs = (logged ? e.duration_s : null) ?? s.duration_s;
          if (secs) v.conditioning_min += secs / 60;
          const d = (logged ? e.distance_m : null) ?? s.distance_m;
          if (d) v.distance_m += Number(d);
        }
      }
    }
  }
  v.tonnage_lb = Math.round(v.tonnage_lb);
  v.conditioning_min = Math.round(v.conditioning_min);
  v.distance_m = Math.round(v.distance_m);
  return v;
}

function addVolume(a, b) {
  const out = { hard_sets: a.hard_sets + b.hard_sets, by_pattern: { ...a.by_pattern }, tonnage_lb: a.tonnage_lb + b.tonnage_lb, conditioning_min: a.conditioning_min + b.conditioning_min, distance_m: a.distance_m + b.distance_m };
  for (const [k, n] of Object.entries(b.by_pattern)) out.by_pattern[k] = (out.by_pattern[k] || 0) + n;
  return out;
}
const emptyVolume = () => ({ hard_sets: 0, by_pattern: {}, tonnage_lb: 0, conditioning_min: 0, distance_m: 0 });

// Checks a planned week against the level and the ramp. lastWeekSets: hard sets he actually logged the 7 days before.
function checkWeekVolume(days, level, lastWeekSets) {
  const L = LEVELS[level];
  if (!L) return [];
  const errors = [];
  const total = days.reduce((acc, d) => addVolume(acc, sessionVolume(d.body || d)), emptyVolume());
  for (const [p, n] of Object.entries(total.by_pattern)) {
    if (p !== 'Other' && n > L.sets_per_pattern[1]) errors.push(`${p}: ${n} hard sets this week; at ${L.label} level the most is ${L.sets_per_pattern[1]} (start near ${L.sets_per_pattern[0]})`);
  }
  const cap = lastWeekSets > 0 ? Math.max(Math.round(lastWeekSets * RAMP), startCap(L)) : startCap(L);
  if (total.hard_sets > cap) errors.push(lastWeekSets > 0
    ? `${total.hard_sets} hard sets this week against ${lastWeekSets} logged last week: ramp up, at most about ${cap} (20% more)`
    : `${total.hard_sets} hard sets this week with nothing logged last week: start at about ${cap} or fewer (the low end of ${L.label}) and build`);
  return errors;
}

module.exports = { LEVELS, RAMP, startCap, PATTERNS, sessionVolume, addVolume, emptyVolume, checkWeekVolume };
