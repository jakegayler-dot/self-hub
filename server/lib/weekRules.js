// What a planned week has to respect beyond format and volume (Jake, 2026-11-02: "it is quintessential to look at
// where i am on my periodization table, and if it is a deload week… check the weather for each day and not to
// schedule things like rucks or running on days that are cold or snowing… targeting the whole body at some point
// through the week — albeit with a focus on the weaknesses").
//
//   Periodization: 6-week blocks, 5 build weeks then a deload (his choice). One date stores it: block_start, the
//     Monday of build week 1. "Deload this week" sets the block so this week is week 6; the next block starts after.
//   Weather: an outdoor run or ruck only on a day whose feels-like gets to 3 °C, with no snow or freezing rain. A
//     session that breaks it goes back to the trainer to move it to a fit day that week, else onto the bike/rower/ski.
//   Whole body: every major pattern trained during the week; the weakest get at least as much as the typical one.

const strength = require('./strength');

const BLOCK_WEEKS = 6; // 5 build + 1 deload
const BUILD_WEEKS = BLOCK_WEEKS - 1;
const DELOAD = { sets_factor: 0.5, rpe_cap: 7 };
// Build weeks climb in effort across the block: the highest RPE a working set should reach, by week.
const BUILD_RPE = [7.5, 8, 8, 8.5, 9];

const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Where a week (its Monday) sits in the block. block_start null → this week is week 1 (the first block starts here).
function blockInfo(weekStart, blockStart, rpeCapForLevel = 9.5) {
  const start = blockStart ? ymd(blockStart) : weekStart;
  let n = Math.floor((dayNum(weekStart) - dayNum(start)) / 7);
  if (n < 0) n = 0; // a week before the block started: count it as week 1
  const week = (n % BLOCK_WEEKS) + 1;
  const deload = week === BLOCK_WEEKS;
  const block = Math.floor(n / BLOCK_WEEKS) + 1;
  const rpe_cap = deload ? DELOAD.rpe_cap : Math.min(BUILD_RPE[week - 1], rpeCapForLevel);
  return {
    block, week, of: BLOCK_WEEKS, deload, block_start: start, rpe_cap,
    label: deload ? `Deload (week ${week} of ${BLOCK_WEEKS})` : `Build week ${week} of ${BUILD_WEEKS}`,
    guidance: deload
      ? `Deload week: about half the hard sets of the last build week, every working set at RPE ${DELOAD.rpe_cap} or under, no tests or max efforts, keep the movement patterns and some easy aerobic work. Recover so the next block starts fresh.`
      : `Build week ${week} of ${BUILD_WEEKS} (deload in week ${BLOCK_WEEKS}): ${week === 1 ? 'start the block at the low end of the volume level' : 'add a set or two per pattern on last week, within the ramp'}; working sets up to RPE ${rpe_cap}.${week === BUILD_WEEKS ? ' Last build week: the hardest of the block, tests fit well here.' : ''}`,
  };
}
// The block_start that makes weekStart a given week (1-6) of a block.
const blockStartFor = (weekStart, week) => addDays(weekStart, -7 * (Math.max(1, Math.min(BLOCK_WEEKS, Math.round(week))) - 1));

// ---- weather ----
const OUTDOOR_MIN_FEELS_C = 3;
// WMO weather codes: snow, snow grains and showers; freezing drizzle and rain.
const SNOW_CODES = [71, 73, 75, 77, 85, 86];
const FREEZING_CODES = [56, 57, 66, 67];
// Is a day fit for running or rucking outside? Judged at its warmest (when he'd go out): the feels-like high.
function outdoorDay(w) {
  if (!w) return { ok: null, why: 'no forecast' };
  const feels = w.feels_high_c ?? w.high_c;
  const why = [];
  if (feels != null && feels < OUTDOOR_MIN_FEELS_C) why.push(`feels like ${Math.round(feels)} °C at its warmest`);
  if ((w.snow_cm || 0) >= 0.5 || SNOW_CODES.includes(w.code)) why.push(w.snow_cm ? `${w.snow_cm} cm of snow` : 'snow');
  if (FREEZING_CODES.includes(w.code)) why.push('freezing rain');
  return why.length ? { ok: false, why: why.join(', ') } : { ok: true, why: feels != null ? `feels like ${Math.round(feels)} °C at its warmest` : 'no snow' };
}
// The Open-Meteo daily forecast → { date: weather } for the dates asked (wardrobe's reader, the same farm point).
function weatherByDay(data, dates, read) {
  const out = {};
  for (const d of dates) { const w = read(data, d); if (w) out[d] = w; }
  return out;
}

// Items done outside: runs and rucks (a treadmill or indoor track is fine), run engine blocks, run/ruck tests.
const OUTDOOR_RE = /\b(run|runs|running|jog|jogging|ruck|rucking|sprints?|hill repeats?|shuttle runs?|road work)\b/i;
const INDOOR_RE = /treadmill|indoor|assault runner|curve|ski erg|skierg|row|bike|erg\b|running man/i;
function outdoorItems(body) {
  const out = [];
  for (const b of (body && body.blocks) || []) {
    if (b.engine && b.engine.modality === 'run' && !INDOOR_RE.test(`${b.title || ''} ${b.notes || ''}`)) { out.push(b.title || 'run intervals'); continue; }
    for (const it of b.items || []) {
      const name = String(it.movement || '');
      const isTest = it.test && /run|ruck/.test(it.test);
      if ((OUTDOOR_RE.test(name) || isTest) && !INDOOR_RE.test(`${name} ${it.notes || ''}`)) out.push(name || it.test);
    }
  }
  return [...new Set(out)];
}

// ---- whole body ----
const MAJOR = ['Squat', 'Hinge', 'Push Horizontal', 'Push Vertical', 'Pull Horizontal', 'Pull Vertical'];
// Hard sets per pattern across the week's sessions (lifts and gymnastics; Core counted too).
function setsByPattern(bodies) {
  const n = {};
  for (const body of bodies) {
    for (const b of (body && body.blocks) || []) {
      if (['warmup', 'cooldown'].includes(b.kind)) continue;
      for (const it of b.items || []) {
        if (!['lift', 'gymnastics'].includes(it.log_as) || !it.pattern) continue;
        n[it.pattern] = (n[it.pattern] || 0) + (it.sets || []).length;
      }
    }
  }
  return n;
}
// The weakest major patterns first (lowest strength score; unscored ones aren't ranked).
function weakest(strengthPatterns, k = 2) {
  return MAJOR.filter((p) => Number.isFinite(strengthPatterns && strengthPatterns[p]))
    .sort((a, b) => strengthPatterns[a] - strengthPatterns[b]).slice(0, k);
}

// A lift's e1RM from { name: lb }, ignoring case.
function e1rmFor(map, name) {
  if (map[name]) return map[name];
  const k = String(name || '').trim().toLowerCase();
  for (const [n, v] of Object.entries(map)) if (n.trim().toLowerCase() === k) return v;
  return null;
}

// ---- the checks on a whole planned week ----
// days: [{ date, body }]; weather: { date: w }; block: blockInfo; strengthPatterns; deloadCap: max hard sets in a deload;
// weekDates: the week's 7 dates and availability ({ date: gym|truck|off }), to say which days a run could move to.
// coverage: false skips the whole-body checks (a review changing only some days); label names the list in messages.
function checkWeek(days, { weather = {}, block = null, strengthPatterns = {}, deloadCap = null, weekDates = [], availability = {}, coverage = true, label = 'days', e1rm = null } = {}) {
  const errors = [];
  // Weather: no run or ruck outside on a cold or snowy day.
  const fit = weekDates.filter((d) => outdoorDay(weather[d]).ok && availability[d] !== 'off');
  for (const [i, d] of days.entries()) {
    const out = outdoorItems(d.body);
    if (!out.length) continue;
    const v = outdoorDay(weather[d.date]);
    if (v.ok !== false) continue;
    const others = fit.filter((x) => x !== d.date);
    errors.push(`${label}[${i}] (${d.date}): ${out.join(', ')} outside, but ${v.why} (under ${OUTDOOR_MIN_FEELS_C} °C feels-like, or snow, is too cold for him)` +
      (others.length ? ` — move it to a day that's fit outside (${others.join(', ')}), or do it on the bike, rower or ski erg` : ' — no day this week is fit outside: do it on the bike, rower or ski erg'));
  }
  // Whole body, weakest first.
  const sets = setsByPattern(days.map((d) => d.body));
  const min = block && block.deload ? 1 : 2;
  const missing = coverage ? MAJOR.filter((p) => (sets[p] || 0) < min) : [];
  if (missing.length) errors.push(`the week must train the whole body: ${missing.map((p) => `${p} has ${sets[p] || 0} hard sets`).join(', ')} (at least ${min} each${block && block.deload ? ' in a deload' : ''})`);
  if (coverage && !missing.length && !(block && block.deload)) {
    const counts = MAJOR.map((p) => sets[p] || 0).sort((a, b) => a - b);
    const median = (counts[2] + counts[3]) / 2;
    for (const p of weakest(strengthPatterns)) {
      if ((sets[p] || 0) < median) errors.push(`${p} is one of his weakest patterns but gets ${sets[p] || 0} hard sets, under the typical pattern's ${median}: give it at least that`);
    }
  }
  // Deload: volume about half, effort capped.
  if (block && block.deload) {
    const total = Object.entries(sets).reduce((a, [, n]) => a + n, 0);
    if (coverage && deloadCap != null && total > deloadCap) errors.push(`deload week: ${total} hard sets planned, at most ${deloadCap} (about half the last build week)`);
    for (const [i, d] of days.entries()) {
      for (const b of (d.body && d.body.blocks) || []) {
        for (const it of b.items || []) {
          if (it.test) errors.push(`${label}[${i}] (${d.date}): no tests in a deload week (${it.movement || it.test})`);
          const hot = (it.sets || []).filter((s) => s.rpe != null && Number(s.rpe) > DELOAD.rpe_cap);
          if (hot.length) errors.push(`${label}[${i}] (${d.date}): ${it.movement} has sets at RPE ${hot[0].rpe}; a deload caps working sets at RPE ${DELOAD.rpe_cap}`);
          // A load heavier than RPE 7 for its reps on his own e1RM (the RTS chart) isn't a deload either.
          const max = it.log_as === 'lift' && e1rm ? e1rmFor(e1rm, it.movement) : null;
          if (max && !hot.length) {
            const heavy = (it.sets || []).find((s) => Number(s.load_lb) > 0 && Number(s.reps) >= 1 && Number(s.reps) <= 10
              && Number(s.load_lb) > max * strength.pctFor(Number(s.reps), DELOAD.rpe_cap) * 1.05);
            if (heavy) errors.push(`${label}[${i}] (${d.date}): ${it.movement} ${heavy.reps} × ${heavy.load_lb} lb is over RPE ${DELOAD.rpe_cap} on his e1RM of ${Math.round(max)} lb (at most about ${Math.round(max * strength.pctFor(Number(heavy.reps), DELOAD.rpe_cap) / 5) * 5} lb in a deload)`);
          }
        }
      }
    }
  }
  return errors;
}

module.exports = {
  BLOCK_WEEKS, BUILD_WEEKS, DELOAD, BUILD_RPE, OUTDOOR_MIN_FEELS_C, MAJOR,
  blockInfo, blockStartFor, outdoorDay, weatherByDay, outdoorItems, setsByPattern, weakest, checkWeek,
};
