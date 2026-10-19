// What the training plan needs to know about Jake, and how fresh each thing is (Jake, 2026-10-18: "how do you
// intend to include testing, missing data points"). Three kinds:
//   - tests: done in a session and scheduled by the trainer when due (the Navy SEAL PRT every 6-8 weeks,
//     a swim and a ruck test, engine baselines, CrossFit benchmarks, a lift untested for 60 days);
//   - measurements: entered by him (thigh, calf, upper arm, waist, body fat), monthly;
//   - facts: asked once (age, fins, a pull buoy).
// Nothing is guessed: what's missing is listed, and the trainer or the Train page asks for it.

const DAY = 86400000;

// Tests logged into fitness_tests. A planned set flagged with one of these ids (item.test) records the result
// when it's logged. better: which way is an improvement.
const TESTS = {
  prt_pullups: { label: 'PRT pull-ups (max, no time limit)', unit: 'reps', better: 'higher', group: 'prt', retest_days: 49 },
  prt_situps: { label: 'PRT sit-ups (3 min)', unit: 'reps', better: 'higher', group: 'prt', retest_days: 49 },
  prt_pushups: { label: 'PRT push-ups (3 min)', unit: 'reps', better: 'higher', group: 'prt', retest_days: 49 },
  prt_run_3mi: { label: 'PRT 3-mile run', unit: 's', better: 'lower', group: 'prt', retest_days: 49 },
  prt_swim_half_mi: { label: 'PRT 0.5-mile pool swim', unit: 's', better: 'lower', group: 'prt', retest_days: 49 },
  swim_400m: { label: '400 m swim (timed)', unit: 's', better: 'lower', group: 'swim', retest_days: 49 },
  ruck_8km: { label: '8 km ruck (timed, pack weight in the note)', unit: 's', better: 'lower', group: 'ruck', retest_days: 56 },
};
// The PRT is one session (pull-ups, sit-ups, push-ups, then the run and the swim, as the guide sets it out).
const PRT = ['prt_pullups', 'prt_situps', 'prt_pushups', 'prt_run_3mi', 'prt_swim_half_mi'];

// CrossFit benchmarks worth retesting (they feed the percentiles), every ~8 weeks each, one or two at a time.
const BENCHMARKS = ['Fran', 'Grace', 'Helen', 'Filthy 50', 'Fight Gone Bad'];
const BENCHMARK_RETEST_DAYS = 56;
// Main lifts: an e1RM older than 60 days needs a heavy top set.
const MAIN_LIFTS = ['Back Squat', 'Deadlift', 'Bench Press', 'Strict Press', 'Clean & Jerk', 'Snatch'];
const LIFT_RETEST_DAYS = 60;

const MEASURES = {
  thigh: { label: 'Thigh circumference (in, mid-thigh, relaxed)', every_days: 30 },
  calf: { label: 'Calf circumference (in, widest point)', every_days: 30 },
  upper_arm: { label: 'Upper-arm circumference (in, flexed)', every_days: 30 },
  waist: { label: 'Waist circumference (in, at the navel)', every_days: 30 },
  body_fat: { label: 'Body fat %', every_days: 30 },
};
const FACTS = {
  age: { label: 'Age' },
  fins: { label: 'Do you have swim fins?' },
  swim_gear: { label: 'Do you have a pull buoy / kickboard / paddles (or does the pool lend them)?' },
};

const ymd = (d) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(d).slice(0, 10));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

// Age now from what he gave and when.
function ageOf(profile, today) {
  if (profile.age_years == null) return null;
  const since = profile.age_recorded_on ? daysBetween(ymd(profile.age_recorded_on), today) : 0;
  return Number(profile.age_years) + Math.max(0, Math.floor(since / 365.25));
}

// rows: { tests, benchmarks, lifts (latest per lift), measurements ({ thigh: { value, date }, … } latest each),
//         bodyFat (latest), profile, engineDue }
function computeLedger(rows, today) {
  const p = rows.profile || {};
  const snoozed = (p.ledger_snoozed && typeof p.ledger_snoozed === 'object') ? p.ledger_snoozed : {};
  const asleep = (id) => snoozed[id] && snoozed[id] >= today;
  const due = []; const missing = []; const unknown = []; const latest = {};

  const lastTest = {};
  for (const t of rows.tests || []) {
    const d = ymd(t.entry_date);
    if (!lastTest[t.test] || d > lastTest[t.test].date) lastTest[t.test] = { date: d, value: Number(t.value), unit: t.unit, notes: t.notes || null };
  }
  for (const [id, t] of Object.entries(TESTS)) {
    const last = lastTest[id];
    latest[id] = last || null;
    const age = last ? daysBetween(last.date, today) : null;
    if (!last || age > t.retest_days) due.push({ id, kind: 'test', label: t.label, group: t.group, last: last || null, reason: last ? `last tested ${age} days ago` : 'never tested' });
  }
  // The PRT goes as one session: if any of it is due, it's all due.
  if (due.some((d) => d.group === 'prt')) for (const id of PRT) if (!due.some((d) => d.id === id)) due.push({ id, kind: 'test', label: TESTS[id].label, group: 'prt', last: latest[id], reason: 'with the rest of the PRT' });

  const lastBench = {};
  for (const b of rows.benchmarks || []) {
    if (b.rx === false) continue;
    const d = ymd(b.entry_date);
    if (!lastBench[b.name] || d > lastBench[b.name].date) lastBench[b.name] = { date: d, result: b.result };
  }
  for (const name of BENCHMARKS) {
    const last = lastBench[name];
    const age = last ? daysBetween(last.date, today) : null;
    if (!last || age > BENCHMARK_RETEST_DAYS) due.push({ id: `benchmark:${name}`, kind: 'benchmark', label: `${name} (Rx, logged as a metcon titled "${name}")`, last: last || null, reason: last ? `last done ${age} days ago` : 'never logged' });
  }
  for (const name of MAIN_LIFTS) {
    const last = (rows.lifts || []).find((l) => l.lift === name);
    const age = last ? daysBetween(ymd(last.entry_date), today) : null;
    if (last && age > LIFT_RETEST_DAYS) due.push({ id: `lift:${name}`, kind: 'lift', label: `${name}: a heavy top set (single to triple) for a fresh e1RM`, last: { date: ymd(last.entry_date) }, reason: `no ${name} for ${age} days` });
  }
  for (const e of rows.engineDue || []) due.push({ id: `engine:${e.machine}:${e.test}`, kind: 'engine', label: `${e.machine} ${e.test} (engine baseline)`, last: null, reason: e.reason || 'due' });

  const m = rows.measurements || {};
  for (const [id, mm] of Object.entries(MEASURES)) {
    if (asleep(id)) continue;
    const v = id === 'body_fat' ? (rows.bodyFat ? { value: Number(rows.bodyFat.body_fat_pct), date: ymd(rows.bodyFat.entry_date) } : null)
      : (m[id] && m[id].value != null ? { value: Number(m[id].value), date: m[id].date ? ymd(m[id].date) : null } : null);
    latest[id] = v;
    if (!v) missing.push({ id, kind: 'measure', label: mm.label, reason: 'never measured' });
    else if (v.date && daysBetween(v.date, today) > mm.every_days) missing.push({ id, kind: 'measure', label: mm.label, last: v, reason: `last measured ${daysBetween(v.date, today)} days ago` });
  }
  const gear = (p.gear && typeof p.gear === 'object') ? p.gear : {};
  const age = ageOf(p, today);
  if (age == null && !asleep('age')) unknown.push({ id: 'age', kind: 'fact', label: FACTS.age.label });
  for (const id of ['fins', 'swim_gear']) if (gear[id] == null && !asleep(id)) unknown.push({ id, kind: 'fact', label: FACTS[id].label });

  return { as_of: today, age, max_hr_est: age != null ? 220 - age : null, gear, due_tests: due, missing_measurements: missing, unknown_facts: unknown, latest };
}

module.exports = { TESTS, PRT, BENCHMARKS, MAIN_LIFTS, MEASURES, FACTS, computeLedger, ageOf };
