// Engine (conditioning) programming, built the way The Gains Lab works:
//
//   1. Test — time trials on each machine measure three things:
//        endurance     10-min max effort  → your sustainable pace
//        speed         1-min max effort   → your top-end pace
//        repeatability 6 × 0:30 max / 0:30 rest → how well you hold output
//                      under fatigue (average ÷ best interval)
//   2. Prescribe — every interval of every engine session gets a target
//      output computed from YOUR test paces (e.g. Threshold = 92% of your
//      10-min pace for 4 min), never a generic "row hard".
//   3. Adapt — the results you log against those targets nudge the next
//      session's targets (±6% max), so training moves with you between tests.
//   4. Retest — a test older than 8 weeks is flagged and the next engine
//      day becomes a time trial.
//   5. Weaknesses — the ratio between your speed and endurance pace, and
//      your repeatability score, pick which energy system gets priority.
//
// The Gains Lab's exact formulas aren't published. The intensities below are
// standard energy-system targets expressed as % of time-trial pace, and the
// limiter thresholds are rules of thumb — treat them as such and tune them
// here if your results say otherwise.

const MODALITIES = {
  bike: { name: 'Bike', equip: 'bike', unit: 'cal' },
  row: { name: 'Row', equip: 'rower', unit: 'cal' },
  ski: { name: 'Ski Erg', equip: 'ski', unit: 'cal' },
  run: { name: 'Run', equip: null, unit: 'm' },
};
const TESTS = {
  tt10: { label: '10-min time trial', what: 'endurance', work_s: 600, sets: 1, rest_s: 0, instructions: 'Max total output in 10:00. Pace it evenly — this sets every aerobic, threshold and VO2 target.' },
  sprint60: { label: '1-min max', what: 'speed', work_s: 60, sets: 1, rest_s: 0, instructions: 'All-out 1:00 from a rolling start. Sets speed and repeatability targets.' },
  repeat: { label: 'Repeatability 6 × 0:30', what: 'repeatability', work_s: 30, sets: 6, rest_s: 30, instructions: '6 × 0:30 all-out, 0:30 rest. Scored as average ÷ best interval.' },
};
const RETEST_DAYS = 56;

// Session types: which test pace they key off, % of it, interval shape.
const SESSION_TYPES = {
  aerobic: { label: 'Aerobic base', basis: 'endurance', pct: 0.75, system: 'aerobic capacity — long, conversational-hard' },
  threshold: { label: 'Threshold', basis: 'endurance', pct: 0.92, system: 'lactate threshold — the pace you can hold in a 10–20 min metcon' },
  vo2: { label: 'VO2 max', basis: 'endurance', pct: 1.05, system: 'maximal aerobic power — above your 10-min pace, equal rest' },
  speed: { label: 'Speed', basis: 'speed', pct: 0.9, system: 'top-end power — short, near-max, full recovery' },
  repeat: { label: 'Repeatability', basis: 'speed', pct: 0.8, system: 'repeat-sprint ability — holding output with short rest' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
function ymd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}
function roundOut(v, unit) { return unit === 'm' ? Math.round(v / 5) * 5 : Math.round(v); }
function mmss(s) { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function rateText(rate, unit) {
  // rate is output per minute
  if (unit === 'm') return `${mmss(1000 / rate * 60)}/km`;
  return `${(Math.round(rate * 10) / 10)} cal/min`;
}

// tests: rows from fitness_engine_tests; history: engine blocks from saved
// workouts [{date, block}] with logged sets (actual vs target).
function computeBaselines(tests, history, date) {
  const t = dayNum(date);
  const out = {};
  for (const [key, mod] of Object.entries(MODALITIES)) {
    const mine = tests.filter((x) => x.modality === key && dayNum(ymd(x.entry_date)) <= t)
      .sort((a, b) => (ymd(a.entry_date) < ymd(b.entry_date) ? 1 : -1));
    const latest = (test) => {
      const r = mine.find((x) => x.test === test && Number(x.output) > 0); // a 0 result is not a test
      if (!r) return null;
      const d = ymd(r.entry_date);
      return { output: Number(r.output), date: d, age_days: t - dayNum(d), intervals: r.intervals || null, stale: t - dayNum(d) > RETEST_DAYS };
    };
    const tt10 = latest('tt10');
    const sprint60 = latest('sprint60');
    const repeat = latest('repeat');
    const enduranceRate = tt10 ? tt10.output / 10 : null;
    const speedRate = sprint60 ? sprint60.output : null;
    let repeatability = null;
    if (repeat && Array.isArray(repeat.intervals) && repeat.intervals.length) {
      const v = repeat.intervals.map(Number).filter((n) => n > 0);
      if (v.length) repeatability = Math.round((v.reduce((s, n) => s + n, 0) / v.length / Math.max(...v)) * 100) / 100;
    }
    const speedReserve = enduranceRate && speedRate ? Math.round((speedRate / enduranceRate) * 100) / 100 : null;

    // Adaptation: hit rate (actual ÷ target) of engine sessions logged since
    // the test each basis keys off. Needs ≥2 sessions; capped at ±6%.
    const adj = (basis, since) => {
      const sessions = history
        .filter((h) => h.block.engine && h.block.engine.modality === key && SESSION_TYPES[h.block.engine.type] && SESSION_TYPES[h.block.engine.type].basis === basis)
        .filter((h) => !since || h.date >= since)
        .map((h) => {
          // Compare against the target *before* that session's adjustment —
          // the factor below is applied to the raw test pace, so measuring
          // against an already-adjusted target would make targets oscillate.
          const prevAdj = Number(h.block.engine.adj) > 0 ? Number(h.block.engine.adj) : 1;
          let tgt = 0; let act = 0;
          for (const it of h.block.items || []) for (const s of it.sets || []) {
            if (s.actual != null && s.target) { tgt += Number(s.target) / prevAdj; act += Number(s.actual); }
          }
          return tgt ? { date: h.date, hit: act / tgt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, 3);
      if (sessions.length < 2) return { factor: 1, sessions: sessions.length, hit: sessions.length ? sessions[0].hit : null };
      const mean = sessions.reduce((s, x) => s + x.hit, 0) / sessions.length;
      // Hitting targets comfortably (>103%) pushes them up; missing (<95%) pulls them down.
      const factor = mean > 1.03 ? Math.min(1.06, mean) : mean < 0.95 ? Math.max(0.94, mean) : 1;
      return { factor: Math.round(factor * 1000) / 1000, sessions: sessions.length, hit: Math.round(mean * 100) / 100 };
    };
    const adjEndurance = adj('endurance', tt10 && tt10.date);
    const adjSpeed = adj('speed', sprint60 && sprint60.date);

    let limiter = null;
    if (speedReserve != null && speedReserve > 2.0) limiter = { key: 'aerobic', text: `Your 1-min pace is ${speedReserve}× your 10-min pace — lots of top end, not much aerobic base to sustain it. Priority: aerobic + threshold.` };
    else if (speedReserve != null && speedReserve < 1.5) limiter = { key: 'speed', text: `Your 1-min pace is only ${speedReserve}× your 10-min pace — a strong engine with little top gear. Priority: speed + VO2.` };
    if (repeatability != null && repeatability < 0.85) limiter = { key: 'repeat', text: `Repeatability ${Math.round(repeatability * 100)}% — output drops off fast with short rest. Priority: repeat-effort work.${limiter ? ` (Also: ${limiter.text})` : ''}` };
    if (!limiter && (speedReserve != null || repeatability != null)) limiter = { key: 'balanced', text: 'No standout limiter from your tests — rotating threshold, VO2 and speed.' };

    const missing = [];
    if (!tt10) missing.push('tt10'); else if (tt10.stale) missing.push('tt10');
    if (!sprint60) missing.push('sprint60'); else if (sprint60.stale) missing.push('sprint60');
    if (!repeat) missing.push('repeat'); else if (repeat.stale) missing.push('repeat');

    out[key] = {
      modality: key, name: mod.name, unit: mod.unit,
      tt10, sprint60, repeat,
      enduranceRate, speedRate, speedReserve, repeatability,
      adjEndurance, adjSpeed, limiter, testsDue: missing,
    };
  }
  return out;
}

function availableModalities(equipment) {
  return Object.entries(MODALITIES).filter(([, m]) => !m.equip || equipment.includes(m.equip)).map(([k]) => k);
}

// Pick the machine: requested one if available; else one with a current
// test, least recently used; else a machine to test.
function chooseModality(baselines, equipment, requested, history, rng) {
  const avail = availableModalities(equipment);
  if (requested && requested !== 'auto' && avail.includes(requested)) return requested;
  const lastUsed = (k) => {
    const d = history.filter((h) => h.block.engine && h.block.engine.modality === k).map((h) => h.date).sort().pop();
    return d || '0000-00-00';
  };
  const tested = avail.filter((k) => baselines[k].tt10 && !baselines[k].tt10.stale);
  const pool = tested.length ? tested : avail;
  const order = ['bike', 'row', 'ski', 'run'];
  return pool.slice().sort((a, b) => (lastUsed(a) < lastUsed(b) ? -1 : lastUsed(a) > lastUsed(b) ? 1 : order.indexOf(a) - order.indexOf(b)))[0];
}

function chooseType(b, history, date, rng, onlyEndurance, exclude) {
  const t = dayNum(date);
  const priority = {
    aerobic: { aerobic: 1.0, threshold: 0.9, vo2: 0.5, repeat: 0.3, speed: 0.2 },
    speed: { speed: 1.0, vo2: 0.9, repeat: 0.5, threshold: 0.4, aerobic: 0.2 },
    repeat: { repeat: 1.0, vo2: 0.7, speed: 0.6, threshold: 0.5, aerobic: 0.3 },
    balanced: { threshold: 0.8, vo2: 0.8, speed: 0.6, repeat: 0.6, aerobic: 0.6 },
  }[(b.limiter && b.limiter.key) || 'balanced'];
  let best = null;
  for (const [type, w] of Object.entries(priority)) {
    if (SESSION_TYPES[type].basis === 'speed' && (!b.speedRate || onlyEndurance)) continue;
    if (type === exclude) continue;
    const recent = history.filter((h) => h.block.engine && h.block.engine.type === type).map((h) => t - dayNum(h.date)).filter((d) => d >= 0);
    const since = recent.length ? Math.min(...recent) : 99;
    const s = w - (since <= 3 ? 0.8 : since <= 7 ? 0.35 : 0) + (rng() - 0.5) * 0.2;
    if (!best || s > best.s) best = { type, s };
  }
  return best.type;
}

// One engine block (conditioning intervals) filling `minutes`.
function engineBlock(baselines, opts, rng, why) {
  const { equipment, date, minutes, history = [], requested } = opts;
  const key = chooseModality(baselines, equipment, requested, history, rng);
  if (!key) return null;
  const b = baselines[key];
  const mod = MODALITIES[key];

  // No current test on this machine → this session IS the test.
  const due = b.testsDue;
  if (!opts.noTest && (due.includes('tt10') || (minutes >= 20 && due.includes('sprint60')) || (b.speedRate && due.includes('repeat') && minutes >= 20))) {
    const test = due.includes('tt10') ? 'tt10' : due.includes('sprint60') ? 'sprint60' : 'repeat';
    const T = TESTS[test];
    why.push(`Engine test on the ${mod.name}: ${b[test] ? `your last ${T.label} is ${b[test].age_days} days old (retest every ${RETEST_DAYS})` : `no ${T.label} logged on the ${mod.name} yet`} — every future target on this machine is built from it.`);
    return {
      kind: 'conditioning', title: `Engine test — ${T.label} (${mod.name})`, minutes: Math.round((T.sets * (T.work_s + T.rest_s)) / 60) + 2,
      notes: T.instructions,
      engine: { modality: key, type: 'test', test, unit: mod.unit },
      items: [{
        movement: mod.name, log_as: 'test', pattern: 'Conditioning', rest_s: T.rest_s,
        prescription: T.sets > 1 ? `${T.sets} × ${mmss(T.work_s)} max, ${mmss(T.rest_s)} rest — log each interval` : `${mmss(T.work_s)} max effort — log total ${mod.unit === 'cal' ? 'calories' : 'meters'}`,
        sets: Array.from({ length: T.sets }, () => ({ duration_s: T.work_s, rest_s: T.rest_s, target: null, unit: mod.unit, actual: null })),
      }],
    };
  }

  const type = chooseType(b, history, date, rng, opts.onlyEndurance, opts.exclude);
  const ST = SESSION_TYPES[type];
  const baseRate = ST.basis === 'endurance' ? b.enduranceRate : b.speedRate;
  if (!baseRate) return null;
  const adj = ST.basis === 'endurance' ? b.adjEndurance : b.adjSpeed;
  const rate = baseRate * ST.pct * adj.factor;
  const M = Math.max(8, minutes);
  let shape; // {n, work_s, rest_s, groups}
  if (type === 'aerobic') {
    const n = M >= 36 ? 3 : 2;
    const work = clamp(Math.floor((M - (n - 1) * 2) / n), 6, 15) * 60;
    shape = { n, work_s: work, rest_s: 120 };
  } else if (type === 'threshold') {
    shape = { n: clamp(Math.floor((M + 2) / 6), 3, 6), work_s: 240, rest_s: 120 };
  } else if (type === 'vo2') {
    shape = { n: clamp(Math.floor((M + 2) / 4), 4, 8), work_s: 120, rest_s: 120 };
  } else if (type === 'speed') {
    shape = { n: clamp(Math.floor((M * 60) / 120), 6, 10), work_s: 20, rest_s: 100 };
  } else {
    const groups = clamp(Math.floor((M + 3) / 8), 1, 3);
    shape = { n: groups * 5, work_s: 30, rest_s: 30, groups, groupRest_s: 180 };
  }
  const target = roundOut(rate * (shape.work_s / 60), mod.unit);
  const sets = Array.from({ length: shape.n }, (_, i) => ({
    duration_s: shape.work_s,
    rest_s: shape.groups && (i + 1) % 5 === 0 && i + 1 < shape.n ? shape.groupRest_s : (i + 1 === shape.n ? 0 : shape.rest_s),
    target, unit: mod.unit, pct_1rm: null, actual: null,
  }));
  const basisText = ST.basis === 'endurance'
    ? `${Math.round(ST.pct * 100)}% of your 10-min pace (${rateText(b.enduranceRate, mod.unit)}, ${b.tt10.date})`
    : `${Math.round(ST.pct * 100)}% of your 1-min pace (${rateText(b.speedRate, mod.unit)}, ${b.sprint60.date})`;
  const adjText = adj.factor !== 1 ? `, ${adj.factor > 1 ? '+' : ''}${Math.round((adj.factor - 1) * 100)}% because you averaged ${Math.round(adj.hit * 100)}% of target over your last ${adj.sessions} sessions` : '';
  why.push(`Engine: ${ST.label} on the ${mod.name} — ${ST.system}. Targets are ${basisText}${adjText}.${b.limiter && !opts.noTest ? ` ${b.limiter.text}` : ''}`);
  const outWord = mod.unit === 'cal' ? 'cal' : 'm';
  const shapeText = shape.groups
    ? `${shape.groups} sets of 5 × ${mmss(shape.work_s)} on / ${mmss(shape.rest_s)} easy, ${mmss(shape.groupRest_s)} between sets`
    : `${shape.n} × ${mmss(shape.work_s)}${shape.rest_s ? `, ${mmss(shape.rest_s)} rest` : ''}`;
  return {
    kind: 'conditioning', title: `${ST.label} — ${mod.name}`,
    minutes: Math.round(sets.reduce((s, x) => s + x.duration_s + x.rest_s, 0) / 60),
    notes: `${shapeText}. Hit ${target} ${outWord} every interval (${rateText(rate, mod.unit)}). Log what you actually did — next session's targets move with it.`,
    engine: { modality: key, type, unit: mod.unit, pct: Math.round(ST.pct * 100), adj: adj.factor, rate: Math.round(rate * 100) / 100 },
    items: [{
      movement: mod.name, log_as: 'engine', pattern: 'Conditioning', rest_s: shape.rest_s,
      prescription: `${shapeText} @ ${target} ${outWord} each`,
      sets,
    }],
  };
}

// Engine slot → one or two blocks. A speed or repeatability test only takes
// a few minutes, so when it's due the rest of the slot becomes intervals
// keyed off the 10-min pace you already have.
function engineBlocks(baselines, opts, rng, why) {
  const first = engineBlock(baselines, opts, rng, why);
  if (!first) return [];
  const out = [first];
  let left = opts.minutes - first.minutes - 3; // 3 min transition
  if (left >= 10 && !(first.engine.type === 'test' && first.engine.test === 'tt10')) {
    // Fill the rest of the slot with a second, endurance-keyed piece (never a
    // second test, never the same type twice).
    const second = engineBlock(baselines, { ...opts, minutes: left, requested: first.engine.modality, noTest: true, onlyEndurance: true, exclude: first.engine.type }, rng, why);
    if (second) { out.push(second); left -= second.minutes + 3; }
  }
  if (left >= 8) {
    out.push({
      kind: 'conditioning', title: 'Aerobic flush', minutes: Math.min(15, left),
      notes: 'Easy, nose-breathing pace. Not logged against a target — it just adds aerobic minutes.',
      items: [{ movement: `${MODALITIES[first.engine.modality].name} — easy`, log_as: 'none', prescription: `${Math.min(15, left)} min conversational`, sets: [] }],
    });
  }
  return out;
}

// Pace target for a cyclical piece inside a metcon (e.g. "15 cal Row").
function metconPieceTarget(baselines, modalityKey, amount, unit) {
  const b = baselines && baselines[modalityKey];
  if (!b || !b.enduranceRate || unit !== b.unit) return null;
  const rate = b.enduranceRate * 0.95 * b.adjEndurance.factor; // just under 10-min pace — sustainable across rounds
  return `target ≤ ${mmss((amount / rate) * 60)} per round (~95% of your 10-min pace)`;
}

module.exports = {
  MODALITIES, TESTS, SESSION_TYPES, RETEST_DAYS,
  computeBaselines, engineBlock, engineBlocks, metconPieceTarget, availableModalities, rateText, mmss,
};
