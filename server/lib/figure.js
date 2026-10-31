// The physique figure for Sentinel (2026-10-31): everything public/js/body3d.js needs to draw Jake's figure,
// computed the same way the Health tab does it (public/index.html computeBodyProfile, musclesFor, muscleWeek).
// The page keeps its own copy of musclesFor; tests/figure.test.js runs the page's copy against this one so they
// can't drift. Lift patterns come from server/lib/strength.js, which is the same file the page loads.
const strength = require('./strength');

// Population averages the page uses for anything not yet measured (inches).
const BODY_DEFAULTS = { height_in: 70, shoulder: 18, bust: 40, waist: 34, seat_hips: 38, neck: 15, sleeve: 24, length: 16, inseam: 31 };

// The 17 muscle groups of body3d.js (SelfHubBody3D.GROUPS), the keys of `sets`.
const GROUPS = ['chest', 'shoulders', 'traps', 'lats', 'midback', 'lowerback', 'biceps', 'triceps', 'forearms', 'abs',
  'obliques', 'glutes', 'quads', 'adductors', 'hamstrings', 'calves', 'neck'];

// Which muscles a set works: the main movers count a full set, helpers half. Same rules as the page.
function musclesFor(name) {
  const s = String(name || '').toLowerCase();
  const p = strength.liftPattern(String(name || ''));
  if (/calf/.test(s)) return { calves: 1 };
  if (/shrug/.test(s)) return { traps: 1, forearms: 0.5 };
  if (/curl/.test(s) && /leg|nordic|hamstring/.test(s)) return { hamstrings: 1 };
  if (/curl/.test(s)) return { biceps: 1, forearms: 0.5 };
  if (/tricep|skull|pushdown|push-down|french press|overhead extension/.test(s)) return { triceps: 1 };
  if (/lateral raise|side raise|rear.?delt|face pull|reverse fly|y.?raise|upright row/.test(s)) return { shoulders: 1, traps: 0.5 };
  if (/leg extension/.test(s)) return { quads: 1 };
  if (/hip thrust|glute|kickback|bridge/.test(s)) return { glutes: 1, hamstrings: 0.5 };
  if (/good morning|back extension|hyperextension|superman/.test(s)) return { lowerback: 1, hamstrings: 0.5, glutes: 0.5 };
  if (/farmer|suitcase|carry|dead hang|wrist/.test(s)) return { forearms: 1, traps: 0.5, obliques: /suitcase/.test(s) ? 0.5 : 0 };
  if (/rope climb/.test(s)) return { lats: 1, biceps: 1, forearms: 1 };
  if (/pallof|side plank|russian twist|woodchop|oblique/.test(s)) return { obliques: 1, abs: 0.5 };
  if (/sit-?up|toes.?to.?bar|knees.?to|leg raise|crunch|plank|ab wheel|rollout|v-?up|hollow|l-?sit|ghd/.test(s)) return { abs: 1, obliques: 0.5 };
  if (/copenhagen|adduct/.test(s)) return { adductors: 1 };
  if (/neck/.test(s)) return { neck: 1 };
  if (/fly|flye|pec deck/.test(s)) return { chest: 1, shoulders: 0.5 };
  if (/muscle-?up/.test(s)) return { lats: 1, chest: 0.5, triceps: 0.5, biceps: 0.5 };
  if (/lunge|step-?up|split squat|pistol/.test(s)) return { quads: 1, glutes: 1, adductors: 0.5 };
  if (/sumo/.test(s) && /deadlift/.test(s)) return { glutes: 1, hamstrings: 0.5, adductors: 1, quads: 0.5, lowerback: 0.5, forearms: 0.5 };
  if (/romanian|rdl|stiff/.test(s)) return { hamstrings: 1, glutes: 1, lowerback: 0.5 };
  if (/thruster|wall ball/.test(s)) return { quads: 1, glutes: 0.5, shoulders: 1, triceps: 0.5 };
  if (/jerk/.test(s) && !/clean/.test(s)) return { shoulders: 1, triceps: 0.5, quads: 0.5 };
  switch (p) {
    case 'Squat': return { quads: 1, glutes: 0.5, adductors: 0.5 };
    case 'Hinge': return { hamstrings: 1, glutes: 1, lowerback: 0.5, traps: 0.5, forearms: 0.5 };
    case 'Push Vertical': return { shoulders: 1, triceps: 0.5, traps: 0.5 };
    case 'Push Horizontal': return /dip/.test(s) ? { chest: 1, triceps: 1, shoulders: 0.5 } : { chest: 1, triceps: 0.5, shoulders: 0.5 };
    case 'Pull Vertical': return { lats: 1, biceps: 0.5, midback: 0.5 };
    case 'Pull Horizontal': return { midback: 1, lats: 0.5, biceps: 0.5, shoulders: 0.5 };
    case 'Olympic': return /clean.*jerk/.test(s) ? { quads: 1, glutes: 0.5, traps: 1, shoulders: 0.5, triceps: 0.5, lowerback: 0.5 }
      : { quads: 0.5, glutes: 1, hamstrings: 0.5, traps: 1, lowerback: 0.5, shoulders: /snatch/.test(s) ? 0.5 : 0 };
    case 'Core': return { abs: 1, obliques: 0.5 };
    case 'Accessory': return {};
    default: return {};
  }
}

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// This week's working sets per muscle group (each logged lift or gymnastics row is one set), Monday to Sunday.
// week = { start, end } as YYYY-MM-DD. Only groups with sets appear, as on the page.
function muscleWeekSets(lifts, gymnastics, week) {
  const sets = {};
  const count = (name, date) => {
    const d = ymd(date);
    if (d < week.start || d > week.end) return;
    const m = musclesFor(name);
    for (const g of Object.keys(m)) if (m[g]) sets[g] = (sets[g] || 0) + m[g];
  };
  for (const l of lifts || []) count(l.lift, l.entry_date);
  for (const g of gymnastics || []) count(g.movement, g.entry_date);
  return sets;
}

// The body passed to setBody(), from his height and latest tape measurements (defaults where not measured).
function bodyFor(profile, measurements) {
  const p = profile || {};
  const m = (measurements && measurements.length ? measurements[measurements.length - 1] : null) || {};
  const d = BODY_DEFAULTS;
  const defaults = [];
  const pick = (val, key) => { if (val != null) return Number(val); defaults.push(key); return d[key]; };
  const height = pick(p.height_in, 'height_in');
  const shoulder = pick(m.shoulder, 'shoulder');
  const bust = pick(m.bust, 'bust');
  const waist = pick(m.waist, 'waist');
  const hips = pick(m.seat_hips, 'seat_hips');
  const neck = pick(m.neck, 'neck');
  const sleeve = pick(m.sleeve, 'sleeve');
  let inseam;
  if (m.inseam_low != null && m.inseam_high != null) inseam = (Number(m.inseam_low) + Number(m.inseam_high)) / 2;
  else if (m.inseam_low != null) inseam = Number(m.inseam_low);
  else if (m.inseam_high != null) inseam = Number(m.inseam_high);
  else { inseam = d.inseam; defaults.push('inseam'); }
  return { body: { height, shoulder, bust, waist, hips, neck, sleeve, inseam }, defaults };
}

// Recovery (Jake, Oct 31): what colours the figure. Each set counts in full the day it's done and fades evenly to
// nothing over 7 days. 0 = fresh (pale yellow); 6 or more (body3d.js FULL_LOAD) = worked hard just now (deep red). Same rule as the page's
// muscleWeek(). today = YYYY-MM-DD in Regina. Rounded to 0.01.
const RECOVERY_DAYS = 7;
function muscleLoad(lifts, gymnastics, today) {
  const load = {};
  const t = Date.parse(`${today}T00:00:00Z`);
  const count = (name, date) => {
    const age = Math.round((t - Date.parse(`${ymd(date)}T00:00:00Z`)) / 86400000);
    if (!(age >= 0 && age < RECOVERY_DAYS)) return;
    const m = musclesFor(name);
    for (const g of Object.keys(m)) if (m[g]) load[g] = (load[g] || 0) + m[g] * (1 - age / RECOVERY_DAYS);
  };
  for (const l of lifts || []) count(l.lift, l.entry_date);
  for (const g of gymnastics || []) count(g.movement, g.entry_date);
  for (const g of Object.keys(load)) load[g] = Math.round(load[g] * 100) / 100;
  return load;
}

function buildFigure({ profile, measurements, lifts, gymnastics, week, today }) {
  const { body, defaults } = bodyFor(profile, measurements);
  const out = {
    height_in: profile && profile.height_in != null ? Number(profile.height_in) : null,
    body,
    sets: muscleWeekSets(lifts, gymnastics, week),
    week_of: week.start,
    defaults_used: defaults,
  };
  // body3d.js setLoad(load): the colours. sets stays for the 10-a-week count.
  if (today) out.load = muscleLoad(lifts, gymnastics, today);
  return out;
}

module.exports = { GROUPS, BODY_DEFAULTS, RECOVERY_DAYS, musclesFor, muscleWeekSets, muscleLoad, bodyFor, buildFigure };
