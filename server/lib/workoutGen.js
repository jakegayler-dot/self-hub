// Rule-based workout generator.
//
// Builds a session (or a week of sessions) from your actual logged data and
// a few constraints — date, minutes, focus, equipment — and explains every
// choice it makes in `rationale`. It is deliberately deterministic for a
// given seed, so "Regenerate" means "new seed", not "new rules".
//
// How a session is chosen:
//   * Time budget → blocks. Warm-up and cool-down come off the top; the rest
//     is split by focus (e.g. mixed = 40% strength, 40% metcon, 20%
//     accessories). Set counts are trimmed to what fits the minutes.
//   * Movement selection scores every movement your equipment allows:
//       + weekly gap — sets this week in that pattern vs the ≥10 sets/pattern
//         ACSM threshold the dashboard uses (logged sets + sets already planned
//         in other workouts that week)
//       + strength-profile weakness — your weakest patterns (same scores as the
//         Health tab) get the heavy work
//       + physique priority — accessories lean to Jake's gaps (legs and glutes
//         first), not the target's defining features (his shoulders are already broad)
//       − recovery — a pattern trained heavy within a day either side, or the
//         same movement within two days, is pushed down the list
//       + variety, ± a small seeded jitter so regenerating changes things
//   * Loads are % of your best Epley e1RM in the last 60 days (the same window
//     as the strength profile). No max logged → an estimate from a related
//     lift where there's a sensible ratio, else an RPE target.
//   * Gymnastics reps come from your best set in the last 60 days (~60% of it
//     per set for strength work, ~40% for skill EMOMs).
//   * Core work is bodyweight only — heavy loaded oblique work thickens the
//     waist, which is the one measurement you want going down.
const { MOVEMENTS, BY_NAME, hasEquipment, EQUIPMENT_PRESETS, ALL_EQUIPMENT } = require('./movements');
const strength = require('./strength');
const engine = require('./engine');

const MAJOR = ['Squat', 'Hinge', 'Push Vertical', 'Push Horizontal', 'Pull Vertical', 'Pull Horizontal'];
const WEEKLY_SET_TARGET = 10; // ACSM ≥10 sets/muscle group/week — same threshold as the dashboard bar
const REGION = { Squat: 'lower', Hinge: 'lower', 'Push Vertical': 'upper', 'Push Horizontal': 'upper', 'Pull Vertical': 'upper', 'Pull Horizontal': 'upper', Olympic: 'full' };
// Jake's gaps, not the target's features (2026-10-18): legs and glutes are furthest behind; his shoulders
// are already big and broad, so they get maintenance only.
const PHYSIQUE_PRIORITY = { seat_hips: 1.0, bust: 0.5, arms: 0.35, neck: 0.3, shoulder: 0.1 };
const PHYSIQUE_REASON = { shoulder: 'shoulder width', bust: 'chest/back thickness', neck: 'traps/neck', arms: 'arms', seat_hips: 'glutes' };
// Push / pull / legs families — used to keep a session balanced and to avoid
// hammering the same family on back-to-back days.
const DIR = { Squat: 'legs', Hinge: 'legs', Olympic: 'legs', 'Push Vertical': 'push', 'Push Horizontal': 'push', 'Pull Vertical': 'pull', 'Pull Horizontal': 'pull' };
const FOCI = ['mixed', 'strength', 'hypertrophy', 'olympic', 'gymnastics', 'metcon', 'engine'];
const FOCUS_LABEL = { strength: 'Strength', hypertrophy: 'Hypertrophy', olympic: 'Olympic lifting', gymnastics: 'Gymnastics', metcon: 'Metcon', mixed: 'CrossFit mixed', engine: 'Engine' };
const MINUTES = [30, 45, 60, 75, 90];
const E1RM_WINDOW_DAYS = 60;

// ---------- small utils ----------
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round5 = (v) => Math.round(v / 5) * 5;

function ymd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // pg gives DATE as local midnight, pg-mem as UTC midnight — either way the
  // stored calendar date (same trick as server/routes/sentinelRead.js).
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}
const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const fromDayNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
function addDaysStr(s, n) { return fromDayNum(dayNum(s) + n); }
function mondayOfStr(s) {
  const dow = new Date(`${s}T00:00:00Z`).getUTCDay();
  return addDaysStr(s, dow === 0 ? -6 : 1 - dow);
}

// ---------- inputs ----------
function normalizeInputs(raw) {
  const errors = [];
  const out = {};
  out.date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && !Number.isNaN(Date.parse(raw.date)) ? raw.date : null;
  if (!out.date) errors.push('date (YYYY-MM-DD) is required');
  const minutes = Number(raw.minutes);
  out.minutes = Number.isFinite(minutes) ? clamp(Math.round(minutes), 20, 120) : 60;
  out.focus = FOCI.includes(raw.focus) ? raw.focus : 'mixed';
  if (raw.focus != null && !FOCI.includes(raw.focus)) errors.push(`focus must be one of ${FOCI.join(', ')}`);
  let eq = raw.equipment;
  if (typeof eq === 'string' && EQUIPMENT_PRESETS[eq]) eq = EQUIPMENT_PRESETS[eq].equipment;
  if (!Array.isArray(eq)) eq = ALL_EQUIPMENT;
  out.equipment = eq.filter((e) => ALL_EQUIPMENT.includes(e));
  out.engine_modality = ['bike', 'row', 'ski', 'run'].includes(raw.engine_modality) ? raw.engine_modality : 'auto';
  return { inputs: out, errors };
}

// ---------- context: everything the scorer needs, from logged rows ----------
// rows: { lifts, gymnastics, conditioning, bodyweight, benchmarkLifts,
//         strengthPatterns: {pattern: score}, plannedOther: [{date, body}] }
function makeContext(rows, date) {
  const t = dayNum(date);
  const lifts = (rows.lifts || []).map((l) => ({ date: ymd(l.entry_date), lift: l.lift, load: Number(l.load_lb), reps: Number(l.reps) }));
  const gym = (rows.gymnastics || []).map((g) => ({ date: ymd(g.entry_date), movement: g.movement, reps: Number(g.reps) }));
  const weekStart = mondayOfStr(date);
  const weekEnd = addDaysStr(weekStart, 6);
  const inWeek = (d) => d >= weekStart && d <= weekEnd;

  const weekSets = {};
  const touches = []; // {day, pattern, heavy, movement}
  const lastDone = {}; // movement → nearest day distance
  const noteMovement = (name, d) => {
    const dist = Math.abs(dayNum(d) - t);
    if (lastDone[name] == null || dist < lastDone[name]) lastDone[name] = dist;
  };
  const patternOf = (name) => (BY_NAME.get(name) ? BY_NAME.get(name).pattern : strength.liftPattern(name));

  for (const l of lifts) {
    const p = patternOf(l.lift);
    if (inWeek(l.date)) weekSets[p] = (weekSets[p] || 0) + 1;
    touches.push({ day: dayNum(l.date), pattern: p, heavy: l.reps <= 8 });
    noteMovement(l.lift, l.date);
  }
  for (const g of gym) {
    const p = patternOf(g.movement);
    if (inWeek(g.date)) weekSets[p] = (weekSets[p] || 0) + 1;
    touches.push({ day: dayNum(g.date), pattern: p, heavy: false });
    noteMovement(g.movement, g.date);
  }
  // Sets planned in other saved workouts count as volume already on the way
  // (only sets not yet logged — logged ones are already in the rows above).
  for (const w of rows.plannedOther || []) {
    const wd = ymd(w.date);
    for (const b of (w.body && w.body.blocks) || []) {
      for (const it of b.items || []) {
        if (!it.movement || it.log_as === 'none') continue;
        const p = it.pattern || patternOf(it.movement);
        const pending = (it.sets || []).filter((s) => !s.entry).length;
        if (inWeek(wd)) weekSets[p] = (weekSets[p] || 0) + pending;
        if (pending) {
          touches.push({ day: dayNum(wd), pattern: p, heavy: ['strength', 'olympic'].includes(b.kind) });
          noteMovement(it.movement, wd);
        }
      }
    }
  }

  // Best Epley e1RM per lift in the 60 days up to the date, plus all-time.
  const windowStart = t - E1RM_WINDOW_DAYS;
  const e1rm = {}; const e1rmAll = {};
  for (const l of lifts) {
    const d = dayNum(l.date);
    if (d > t) continue;
    const e = l.load * (1 + l.reps / 30);
    if (!(e1rmAll[l.lift] >= e)) e1rmAll[l.lift] = e;
    if (d >= windowStart && !(e1rm[l.lift] >= e)) e1rm[l.lift] = e;
  }
  const gymBest = {};
  for (const g of gym) {
    const d = dayNum(g.date);
    if (d > t || d < windowStart) continue;
    if (!(gymBest[g.movement] >= g.reps)) gymBest[g.movement] = g.reps;
  }

  // Engine history: engine blocks from saved workouts (logged or planned),
  // for target adaptation and session-type rotation.
  const engineHistory = [];
  for (const w of [...(rows.engineHistory || []), ...(rows.plannedOther || [])]) {
    for (const b of (w.body && w.body.blocks) || []) if (b.engine) engineHistory.push({ date: ymd(w.date), block: b });
  }
  const baselines = engine.computeBaselines(rows.engineTests || [], engineHistory, date);

  return {
    date, t, weekStart, weekEnd, weekSets, touches, lastDone, e1rm, e1rmAll, gymBest,
    strengthPatterns: rows.strengthPatterns || {}, engineHistory, baselines,
  };
}

// Load for a lift at a % of max: own 60-day e1RM → own all-time (flagged) →
// a related lift's e1RM × ratio → null (prescribe by RPE).
function loadFor(ctx, m, pct) {
  const own = ctx.e1rm[m.name];
  if (own) return { load: Math.max(0, round5(own * pct)), source: `${Math.round(pct * 100)}% of your 60-day e1RM (${Math.round(own)} lb)` };
  const stale = ctx.e1rmAll[m.name];
  if (stale) return { load: Math.max(0, round5(stale * pct * 0.95)), source: `${Math.round(pct * 95)}% of your all-time e1RM (${Math.round(stale)} lb) — nothing logged in 60 days, so 5% back off` };
  if (m.loadFrom) {
    const [other, ratio] = m.loadFrom;
    const base = ctx.e1rm[other] || ctx.e1rmAll[other];
    if (base) return { load: Math.max(0, round5(base * ratio * pct)), source: `estimated from your ${other} e1RM (${Math.round(base)} lb × ${ratio}) — log it and this becomes exact` };
  }
  return { load: null, source: null };
}

// ---------- scoring ----------
function gapScore(ctx, pattern) {
  if (!MAJOR.includes(pattern)) return 0;
  const have = ctx.weekSets[pattern] || 0;
  return Math.max(0, WEEKLY_SET_TARGET - have) / WEEKLY_SET_TARGET;
}
function weaknessScore(ctx, pattern) {
  const s = ctx.strengthPatterns[pattern];
  if (s == null) return MAJOR.includes(pattern) || pattern === 'Olympic' ? 0.4 : 0;
  return clamp((100 - s) / 100, 0, 1);
}
function recoveryPenalty(ctx, pattern, heavyOnly) {
  let pen = 0;
  for (const x of ctx.touches) {
    if (x.pattern !== pattern) continue;
    if (heavyOnly && !x.heavy) continue;
    const dist = Math.abs(x.day - ctx.t);
    if (dist === 0) pen = Math.max(pen, 1.2);
    else if (dist === 1) pen = Math.max(pen, 1.0);
    else if (dist === 2) pen = Math.max(pen, 0.3);
  }
  // Same family (e.g. bench yesterday, overhead press today) — smaller hit.
  for (const x of ctx.touches) {
    if (x.pattern === pattern || !x.heavy || !DIR[pattern] || DIR[x.pattern] !== DIR[pattern]) continue;
    if (Math.abs(x.day - ctx.t) <= 1) pen = Math.max(pen, 0.4);
  }
  return pen;
}
function movementRecency(ctx, name) {
  const d = ctx.lastDone[name];
  if (d == null) return 0.3; // not done recently → small variety bonus
  if (d <= 2) return -1.5;
  if (d <= 6) return 0;
  return 0.3;
}
function physiqueScore(m) {
  const base = (m.tags || []).reduce((best, tag) => Math.max(best, PHYSIQUE_PRIORITY[tag] || 0), 0);
  // Dedicated isolation for a physique lever (lateral raises etc.) beats a
  // compound that only touches it.
  return base + (m.physique && base >= 0.5 ? 0.5 : 0);
}
function physiqueReason(m) {
  const top = (m.tags || []).slice().sort((a, b) => (PHYSIQUE_PRIORITY[b] || 0) - (PHYSIQUE_PRIORITY[a] || 0))[0];
  return top ? PHYSIQUE_REASON[top] : null;
}

function choose(candidates, scoreFn, rng) {
  let best = null;
  for (const m of candidates) {
    const s = scoreFn(m) + (rng() - 0.5) * 0.5;
    if (!best || s > best.s) best = { m, s };
  }
  return best ? best.m : null;
}

// ---------- prescriptions ----------
const SCHEMES = {
  main: {
    strength: [{ sets: 5, reps: 3, pct: 0.85 }, { sets: 5, reps: 5, pct: 0.78 }, { sets: 4, reps: 4, pct: 0.82 }, { sets: 6, reps: 2, pct: 0.88 }],
    mixed: [{ sets: 5, reps: 3, pct: 0.82 }, { sets: 5, reps: 5, pct: 0.75 }, { sets: 4, reps: 6, pct: 0.72 }],
  },
  second: [{ sets: 4, reps: 6, pct: 0.72 }, { sets: 4, reps: 8, pct: 0.68 }],
  hyp: [{ sets: 4, reps: 8, pct: 0.7 }, { sets: 4, reps: 10, pct: 0.65 }],
  oly: [{ sets: 6, reps: 2, pct: 0.75 }, { sets: 5, reps: 3, pct: 0.7 }, { sets: 8, reps: 1, pct: 0.8 }],
  oly_support: [{ sets: 4, reps: 3, pct: 0.85 }, { sets: 4, reps: 4, pct: 0.8 }],
};
const REST = { main: 150, second: 120, hyp: 90, oly: 120, oly_support: 120, acc: 60, gstr: 90, skill: 60, core: 45 };

function setsThatFit(minutes, restS, wanted, minSets = 2) {
  const fit = Math.floor((minutes * 60) / (restS + 45));
  return clamp(Math.min(wanted, fit), minSets, wanted);
}

function liftItem(ctx, m, scheme, minutes, slot, rpeFallback) {
  const sets = setsThatFit(minutes, REST[slot], scheme.sets);
  const { load, source } = loadFor(ctx, m, scheme.pct);
  const isAddedWeight = m.name === 'Weighted Pull-Up';
  const rpe = load == null ? rpeFallback : null;
  const setRows = Array.from({ length: sets }, () => ({ reps: scheme.reps, load_lb: load, pct_1rm: load != null ? Math.round(scheme.pct * 100) : null, rpe }));
  const loadText = load != null ? `${load} lb${m.unit && m.unit.includes('hand') ? ' per hand' : ''}${isAddedWeight ? ' added' : ''}` : `RPE ${rpeFallback}`;
  return {
    movement: m.name, log_as: 'lift', pattern: m.pattern, rest_s: REST[slot],
    prescription: `${sets} × ${scheme.reps}${m.unit && m.unit.includes('side') ? ' per side' : ''} @ ${loadText}`,
    load_source: source || (load == null ? 'No logged max yet — pick a load you could do ~2 more reps with; once logged, loads are set from it.' : null),
    notes: m.note || null,
    sets: setRows,
  };
}

function accessoryItem(ctx, m, sets) {
  if (m.kind === 'gym') return gymItem(ctx, m, 'acc', sets * 2);
  const reps = m.tags.includes('shoulder') && m.pattern === 'Accessory' ? 15 : 12;
  const { load, source } = loadFor(ctx, m, 0.6);
  const setRows = Array.from({ length: sets }, () => ({ reps, load_lb: load, pct_1rm: load != null ? 60 : null, rpe: load == null ? 8 : null }));
  return {
    movement: m.name, log_as: 'lift', pattern: m.pattern, rest_s: REST.acc,
    prescription: `${sets} × ${reps}${m.unit && m.unit.includes('side') ? ' per side' : ''} @ ${load != null ? `${load} lb${m.unit && m.unit.includes('hand') ? ' per hand' : ''}` : 'RPE 8'}`,
    load_source: source || 'Pick a load that leaves ~2 reps in the tank on the last set.',
    notes: m.physique || null,
    sets: setRows,
  };
}

function gymItem(ctx, m, slot, minutes) {
  const best = ctx.gymBest[m.name];
  let sets; let reps; let note = null; let source;
  if (slot === 'skill') {
    sets = clamp(Math.floor(minutes), 5, 10);
    reps = best ? Math.max(1, Math.round(best * 0.4)) : Math.max(1, Math.round((m.gymDefault || 3) * 0.6));
    source = best ? `EMOM at ~40% of your best set (${best}) in the last 60 days — crisp reps, no grinding` : 'EMOM practice — no history yet, keep every rep clean';
  } else if (slot === 'core') {
    sets = 3; reps = m.gymDefault || 12;
    source = 'Bodyweight core only — loaded oblique work thickens the waist';
  } else {
    sets = setsThatFit(minutes, REST.gstr, 5, 3);
    reps = best ? Math.max(2, Math.round(best * 0.6)) : (m.gymDefault || 5);
    source = best ? `~60% of your best set (${best}) in the last 60 days` : 'No history yet — stop 2 reps short of failure, and the next workout sets reps from what you log';
  }
  if (m.setNote) note = m.setNote;
  return {
    movement: m.name, log_as: 'gymnastics', pattern: m.pattern, rest_s: REST[slot] || 60,
    prescription: slot === 'skill' ? `EMOM ${sets}: ${reps}${note ? ` (${note})` : ''}` : `${sets} × ${reps}${m.unit && m.unit.includes('side') ? ' per side' : ''}${note ? ` (${note})` : ''}`,
    load_source: source, notes: note,
    sets: Array.from({ length: sets }, () => ({ reps, load_lb: null, pct_1rm: null, rpe: null })),
  };
}

// ---------- block builders ----------
function warmupBlock(minutes, avail, mainItem, engineB) {
  const have = new Set(avail.map((m) => m.name));
  const mono = engineB ? engineB.items[0].movement
    : have.has('Row') ? 'Row' : have.has('Bike') ? 'Bike' : have.has('Ski Erg') ? 'Ski Erg' : have.has('Double-Unders') ? 'Jump rope' : 'Jog';
  const items = [
    { movement: `${mono} — easy`, log_as: 'none', prescription: `${Math.max(3, Math.round(minutes * 0.35))} min, building pace`, sets: [] },
    { movement: 'Dynamic mobility', log_as: 'none', prescription: '2 rounds: 10 air squats, 10 PVC pass-throughs, 10 good mornings, 5 inchworms', sets: [] },
  ];
  if (mainItem && mainItem.log_as === 'lift' && mainItem.sets[0] && mainItem.sets[0].load_lb) {
    const w = mainItem.sets[0].load_lb;
    items.push({ movement: `${mainItem.movement} ramp-up`, log_as: 'none', prescription: `Empty bar × 8, ${round5(w * 0.5)} × 5, ${round5(w * 0.7)} × 3, ${round5(w * 0.85)} × 1–2`, sets: [] });
  }
  if (engineB) {
    items.push({ movement: `${mono} primer`, log_as: 'none', prescription: engineB.engine.type === 'test' ? '3 × 0:15 hard / 0:45 easy, then 2 min easy before the test' : '3 × 0:20 at today\'s target pace / 0:40 easy — find the pace before it counts', sets: [] });
  }
  return { kind: 'warmup', title: 'Warm-up', minutes, items };
}
function cooldownBlock(minutes, patterns) {
  const areas = new Set();
  patterns.forEach((p) => {
    if (p === 'Squat' || p === 'Hinge') { areas.add('hips'); areas.add('hamstrings'); }
    if (p.startsWith('Push')) { areas.add('pecs'); areas.add('shoulders'); }
    if (p.startsWith('Pull')) { areas.add('lats'); areas.add('forearms'); }
    if (p === 'Olympic') { areas.add('hips'); areas.add('wrists'); areas.add('T-spine'); }
  });
  return { kind: 'cooldown', title: 'Cool-down', minutes, items: [{ movement: 'Easy flush + stretch', log_as: 'none', prescription: `${minutes} min — easy spin/walk, then ${[...areas].slice(0, 4).join(', ') || 'full body'}`, sets: [] }] };
}

function metconBlock(ctx, avail, minutes, rng, avoidPatterns, why) {
  const D = clamp(Math.round(minutes), 6, 25);
  const formats = D <= 10 ? ['AMRAP', 'EMOM'] : D <= 20 ? ['AMRAP', 'For time'] : ['AMRAP', 'For time', 'Intervals'];
  const format = pick(rng, formats);
  const pieces = [];
  const used = new Set();
  const pickOne = (filter, scoreFn) => {
    const c = avail.filter((m) => !used.has(m.name) && filter(m));
    const m = choose(c, scoreFn, rng);
    if (m) { used.add(m.name); pieces.push(m); }
    return m;
  };
  const avoid = (m) => !avoidPatterns.includes(m.pattern);
  const sameFamily = (m) => (pieces.some((p) => DIR[p.pattern] && DIR[p.pattern] === DIR[m.pattern]) ? 0.9 : 0);
  pickOne((m) => m.roles.includes('mono'), (m) => movementRecency(ctx, m.name));
  pickOne((m) => m.roles.includes('metcon') && m.kind === 'gym' && avoid(m), (m) => gapScore(ctx, m.pattern) + movementRecency(ctx, m.name));
  if (D > 8) {
    pickOne((m) => m.roles.includes('metcon') && m.kind === 'lift' && avoid(m), (m) => gapScore(ctx, m.pattern) + movementRecency(ctx, m.name) - sameFamily(m))
      || pickOne((m) => m.roles.includes('metcon') && avoid(m), (m) => gapScore(ctx, m.pattern) - sameFamily(m));
  }
  if (pieces.length < 2) pickOne((m) => m.roles.includes('metcon'), () => 0);
  if (!pieces.length) return null;

  const scale = format === 'EMOM' ? 0.8 : 1;
  const items = pieces.map((m) => {
    const mc = m.metcon || {};
    let text;
    const modKey = { Row: 'row', Bike: 'bike', 'Ski Erg': 'ski', Run: 'run' }[m.name];
    if (mc.cal || mc.meters) {
      const amount = mc.cal ? Math.round(mc.cal * scale) : mc.meters;
      const pace = modKey ? engine.metconPieceTarget(ctx.baselines, modKey, amount, mc.cal ? 'cal' : 'm') : null;
      text = `${amount}${mc.cal ? ' cal' : ' m'} ${m.name}${pace ? ` — ${pace}` : ''}`;
    }
    else {
      let reps = mc.reps || 10;
      const best = ctx.gymBest[m.name];
      if (m.kind === 'gym' && best && m.pattern !== 'Conditioning') reps = Math.min(reps, Math.max(3, Math.round(best * 0.5)));
      reps = Math.max(1, Math.round(reps * scale));
      let load = '';
      if (m.kind === 'lift') {
        const base = mc.from ? (ctx.e1rm[mc.from] || ctx.e1rmAll[mc.from]) : null;
        const lb = base && mc.pct ? round5(base * mc.pct) : mc.load;
        if (lb) load = ` @ ${lb} lb`;
      }
      text = `${reps} ${m.name}${load}${mc.note ? ` (${mc.note})` : ''}`;
    }
    return { movement: m.name, log_as: 'none', pattern: m.pattern, prescription: text, sets: [] };
  });

  let title; let detail;
  if (format === 'AMRAP') { title = `AMRAP ${D}`; detail = `As many rounds + reps as possible in ${D} min:`; }
  else if (format === 'EMOM') { title = `EMOM ${D}`; detail = `Every minute on the minute, rotating through ${items.length} stations (${Math.floor(D / items.length)} rounds):`; }
  else if (format === 'For time') {
    const rounds = clamp(Math.round(D / 3), 3, 7);
    title = `${rounds} rounds for time`; detail = `${rounds} rounds for time, ${D} min cap:`;
  } else {
    const rounds = clamp(Math.floor(D / 5), 3, 5);
    title = `${rounds} × 4 min intervals`; detail = `${rounds} rounds: 4 min AMRAP, 1 min rest — score total rounds:`;
  }
  why.push(`Metcon (${title}) ${avoidPatterns.length ? `steers clear of ${avoidPatterns.join(' / ')} so it doesn't fight today's heavy work` : 'mixes a cyclical piece with gymnastics and a loaded movement'}.`);
  return { kind: 'metcon', title, minutes: D, format, notes: detail, items, result: null };
}

// ---------- session ----------
const TEMPLATES = {
  strength: [['main', 0.42], ['second', 0.25], ['acc', 0.33]],
  hypertrophy: [['hyp', 0.35], ['acc', 0.65]],
  olympic: [['oly', 0.45], ['oly_support', 0.3], ['acc', 0.25]],
  gymnastics: [['skill', 0.35], ['gstr', 0.4], ['metcon', 0.25]],
  metcon: [['skill', 0.25], ['metcon', 0.6], ['core', 0.15]],
  mixed: [['main', 0.4], ['metcon', 0.4], ['acc', 0.2]],
  engine: [['engine', 1.0]],
};
const BLOCK_TITLE = { engine: 'Engine', main: 'Strength', second: 'Secondary strength', hyp: 'Compound lifts', oly: 'Olympic lifting', oly_support: 'Strength (oly support)', acc: 'Accessories', skill: 'Gymnastics skill', gstr: 'Gymnastics strength', metcon: 'Metcon', core: 'Core' };
const BLOCK_KIND = { engine: 'conditioning', main: 'strength', second: 'strength', hyp: 'strength', oly: 'olympic', oly_support: 'strength', acc: 'accessory', skill: 'skill', gstr: 'gymnastics', metcon: 'metcon', core: 'core' };

function generateSession(rows, rawInputs, seed = 0) {
  const { inputs, errors } = normalizeInputs(rawInputs);
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const ctx = makeContext(rows, inputs.date);
  const rng = mulberry32(hashString(`${inputs.date}|${inputs.focus}|${inputs.minutes}|${seed}`));
  const avail = MOVEMENTS.filter((m) => hasEquipment(m, inputs.equipment));
  const why = [];
  const usedNames = new Set();
  const usedPatterns = [];
  const heavyPatterns = [];

  const W = inputs.minutes <= 30 ? 6 : inputs.minutes <= 60 ? 10 : 12;
  const C = inputs.minutes >= 60 ? 5 : 0;
  const work = inputs.minutes - W - C;
  const blocks = [];
  let mainItem = null;
  let focus = inputs.focus;

  const hasBarbell = inputs.equipment.includes('barbell');
  if ((focus === 'olympic') && !avail.some((m) => m.roles.includes('oly'))) {
    why.push('Olympic focus needs a barbell or dumbbells — none selected, so this is a gymnastics session instead.');
    focus = 'gymnastics';
  }

  const label = (m) => {
    const have = ctx.weekSets[m.pattern] || 0;
    const parts = [];
    if (MAJOR.includes(m.pattern)) parts.push(`${m.pattern} at ${have}/${WEEKLY_SET_TARGET} sets this week`);
    const sp = ctx.strengthPatterns[m.pattern];
    if (sp != null) parts.push(`strength score ${sp}`);
    return parts.join(', ');
  };

  for (const [slot, frac] of TEMPLATES[focus]) {
    const mins = Math.max(4, Math.round(work * frac));
    const title = BLOCK_TITLE[slot];
    const kind = BLOCK_KIND[slot];
    const free = (m) => !usedNames.has(m.name);

    if (slot === 'main' || slot === 'second' || slot === 'hyp') {
      const roleOk = (m) => (slot === 'main' ? m.roles.includes('main') : (m.roles.includes('second') || m.roles.includes('main'))) && m.kind === 'lift';
      const count = slot === 'hyp' ? 2 : 1;
      const items = [];
      for (let i = 0; i < count; i++) {
        const cand = avail.filter((m) => roleOk(m) && free(m) && !usedPatterns.includes(m.pattern));
        const m = choose(cand, (x) => {
          let s = gapScore(ctx, x.pattern) * 1.5 + weaknessScore(ctx, x.pattern) * (slot === 'main' ? 1.2 : 0.6)
            - recoveryPenalty(ctx, x.pattern, true) * 2 + movementRecency(ctx, x.name);
          if (heavyPatterns.length && REGION[x.pattern] !== REGION[heavyPatterns[0]]) s += 0.5; // pair upper with lower
          if (heavyPatterns.some((p) => DIR[p] && DIR[p] === DIR[x.pattern])) s -= 0.8; // not two pushes
          if (x.roles.includes('main') && slot !== 'hyp') s += 0.2;
          return s;
        }, rng);
        if (!m) continue;
        const scheme = slot === 'main' ? pick(rng, SCHEMES.main[focus === 'strength' ? 'strength' : 'mixed']) : pick(rng, SCHEMES[slot]);
        const item = liftItem(ctx, m, scheme, mins / count, slot, slot === 'main' ? 8 : 7);
        items.push(item);
        usedNames.add(m.name); usedPatterns.push(m.pattern); heavyPatterns.push(m.pattern);
        if (slot === 'main' && !mainItem) mainItem = item;
        why.push(`${m.name} (${title.toLowerCase()}): ${label(m) || m.pattern}${recoveryPenalty(ctx, m.pattern, true) ? ' — trained recently, but the best fit with what you have' : ''}.`);
      }
      if (!items.length) {
        // No barbell/DB strength option — fall back to gymnastics strength.
        const cand = avail.filter((m) => m.roles.includes('gstr') && free(m));
        const m = choose(cand, (x) => gapScore(ctx, x.pattern) * 1.5 - recoveryPenalty(ctx, x.pattern, false) + movementRecency(ctx, x.name)
          - (usedPatterns.some((p) => DIR[p] && DIR[p] === DIR[x.pattern]) ? 0.8 : 0), rng);
        if (m) {
          items.push(gymItem(ctx, m, 'gstr', mins));
          usedNames.add(m.name); usedPatterns.push(m.pattern);
          why.push(`No loaded ${title.toLowerCase()} option with this equipment — ${m.name} instead (${label(m) || m.pattern}).`);
        }
      }
      if (items.length) blocks.push({ kind, title, minutes: mins, items });
    } else if (slot === 'oly' || slot === 'oly_support') {
      const role = slot;
      let cand = avail.filter((m) => m.roles.includes(role) && free(m));
      if (slot === 'oly_support') cand = cand.concat(avail.filter((m) => m.name === 'Front Squat' || m.name === 'Back Squat').filter(free));
      const m = choose(cand, (x) => gapScore(ctx, x.pattern) + weaknessScore(ctx, x.pattern) - recoveryPenalty(ctx, x.pattern, true) * 1.5 + movementRecency(ctx, x.name) * 1.5, rng);
      if (m) {
        const item = liftItem(ctx, m, pick(rng, SCHEMES[slot]), mins, slot, 7);
        blocks.push({ kind, title, minutes: mins, items: [item] });
        usedNames.add(m.name); usedPatterns.push(m.pattern); heavyPatterns.push(m.pattern);
        if (!mainItem) mainItem = item;
        why.push(`${m.name} (${title.toLowerCase()}): ${label(m) || m.pattern}${ctx.lastDone[m.name] != null && ctx.lastDone[m.name] <= 6 ? '' : ' — not done in the last week'}.`);
      }
    } else if (slot === 'acc') {
      const n = clamp(Math.floor(mins / 5), 1, 4);
      const items = [];
      for (let i = 0; i < n; i++) {
        const cand = avail.filter((m) => m.roles.includes('acc') && free(m) && m.pattern !== 'Core');
        const m = choose(cand, (x) => {
          let s = physiqueScore(x) * 1.6 + gapScore(ctx, x.pattern) * 0.8 - recoveryPenalty(ctx, x.pattern, false) * 0.6 + movementRecency(ctx, x.name);
          if (usedPatterns.includes(x.pattern) && x.pattern !== 'Accessory') s -= 0.8;
          if (items.some((it) => it.pattern === x.pattern)) s -= 1.2;
          return s;
        }, rng);
        if (!m) break;
        items.push(accessoryItem(ctx, m, 3));
        usedNames.add(m.name); usedPatterns.push(m.pattern);
      }
      if (items.length) {
        blocks.push({ kind, title, minutes: mins, notes: items.length > 1 ? 'Superset in pairs — alternate movements, rest after each pair.' : null, items });
        const parts = items.map((it) => {
          const m = BY_NAME.get(it.movement);
          const r = m && physiqueReason(m);
          return r ? `${it.movement} (${r})` : it.movement;
        });
        why.push(`Accessories lean on the physique gaps (legs and glutes first; shoulders are already there): ${parts.join(', ')}.`);
      } else {
        const core = choose(avail.filter((m) => m.roles.includes('core') && free(m)), (x) => movementRecency(ctx, x.name), rng);
        if (core) {
          blocks.push({ kind: 'core', title: 'Core', minutes: mins, items: [gymItem(ctx, core, 'core', mins)] });
          usedNames.add(core.name);
          why.push('No accessory options with this equipment — core work fills the slot.');
        }
      }
    } else if (slot === 'skill') {
      const cand = avail.filter((m) => m.roles.includes('skill') && free(m));
      const m = choose(cand, (x) => movementRecency(ctx, x.name) * 1.2 + physiqueScore(x) * 0.3 - recoveryPenalty(ctx, x.pattern, false) * 0.4, rng);
      if (m) {
        blocks.push({ kind, title, minutes: mins, items: [gymItem(ctx, m, 'skill', mins)] });
        usedNames.add(m.name); usedPatterns.push(m.pattern);
        why.push(`${m.name} as skill work${ctx.lastDone[m.name] == null || ctx.lastDone[m.name] > 6 ? ' — not practiced in the last week' : ''}.`);
      } else if (avail.some((x) => x.roles.includes('oly'))) {
        const o = choose(avail.filter((x) => x.roles.includes('oly') && free(x)), (x) => movementRecency(ctx, x.name), rng);
        if (o) {
          blocks.push({ kind: 'olympic', title: 'Olympic technique', minutes: mins, items: [liftItem(ctx, o, { sets: 6, reps: 2, pct: 0.65 }, mins, 'oly', 6)] });
          usedNames.add(o.name);
          why.push(`No pull-up bar/rings selected, so the skill slot is ${o.name} technique at a light load.`);
        }
      }
    } else if (slot === 'gstr') {
      const items = [];
      for (let i = 0; i < 2; i++) {
        const cand = avail.filter((m) => m.roles.includes('gstr') && free(m) && !items.some((it) => it.pattern === m.pattern));
        const m = choose(cand, (x) => gapScore(ctx, x.pattern) * 1.5 + physiqueScore(x) * 0.5 - recoveryPenalty(ctx, x.pattern, false) + movementRecency(ctx, x.name)
          - (items.some((it) => DIR[it.pattern] && DIR[it.pattern] === DIR[x.pattern]) ? 1.0 : 0), rng);
        if (!m) break;
        items.push(gymItem(ctx, m, 'gstr', mins / 2));
        usedNames.add(m.name); usedPatterns.push(m.pattern);
        why.push(`${m.name}: ${label(m) || m.pattern}.`);
      }
      if (items.length) blocks.push({ kind, title, minutes: mins, notes: items.length > 1 ? 'Alternate the two movements.' : null, items });
    } else if (slot === 'metcon') {
      const b = metconBlock(ctx, avail.filter(free), mins, rng, heavyPatterns.filter((p) => MAJOR.includes(p)), why);
      if (b) { blocks.push(b); b.items.forEach((it) => usedNames.add(it.movement)); }
    } else if (slot === 'engine') {
      const ebs = engine.engineBlocks(ctx.baselines, { equipment: inputs.equipment, date: inputs.date, minutes: mins, history: ctx.engineHistory, requested: inputs.engine_modality }, rng, why);
      ebs.forEach((b) => blocks.push(b));
      if (!ebs.length) why.push('No conditioning machine selected and running is off — no engine work possible today.');
    } else if (slot === 'core') {
      const cand = avail.filter((m) => m.roles.includes('core') && free(m));
      const m = choose(cand, (x) => movementRecency(ctx, x.name), rng);
      if (m) blocks.push({ kind, title, minutes: mins, items: [gymItem(ctx, m, 'core', mins)] });
    }
  }

  blocks.unshift(warmupBlock(W, avail, mainItem, blocks.find((b) => b.engine)));
  if (C) blocks.push(cooldownBlock(C, usedPatterns));
  blocks.forEach((b, i) => {
    b.id = `b${i + 1}`;
    b.items.forEach((it, j) => {
      it.id = `${b.id}i${j + 1}`;
      it.sets.forEach((s) => { s.entry = null; });
    });
  });

  const gaps = MAJOR.filter((p) => (ctx.weekSets[p] || 0) < WEEKLY_SET_TARGET && !usedPatterns.includes(p));
  if (gaps.length) why.push(`Still short this week (not in today's session): ${gaps.map((p) => `${p} ${ctx.weekSets[p] || 0}/${WEEKLY_SET_TARGET}`).join(', ')}.`);
  if (!hasBarbell && ['strength', 'mixed', 'hypertrophy'].includes(inputs.focus)) why.push('No barbell selected — heavy strength options are limited to dumbbells/bodyweight.');
  const metcon = blocks.find((b) => b.kind === 'metcon');
  const engineB = blocks.find((b) => b.engine);
  const mainName = focus === 'engine' && engineB ? engineB.title
    : focus === 'metcon' && metcon ? metcon.title
    : mainItem ? mainItem.movement
    : (blocks.find((b) => b.kind !== 'warmup' && b.items.length) || { items: [{ movement: '' }] }).items[0].movement;

  return {
    version: 1,
    date: inputs.date,
    title: `${FOCUS_LABEL[focus]}${mainName ? ` — ${mainName}` : ''}`,
    focus,
    minutes: inputs.minutes,
    equipment: inputs.equipment,
    blocks,
    rationale: why,
  };
}

// ---------- week ----------
const DAY_OFFSETS = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5], 7: [0, 1, 2, 3, 4, 5, 6] };
const MIXED_ROTATION = ['mixed', 'engine', 'strength', 'gymnastics', 'olympic', 'engine', 'hypertrophy'];

function generateWeek(rows, raw, seed = 0) {
  const days = clamp(Math.round(Number(raw.days) || 4), 1, 7);
  const { inputs, errors } = normalizeInputs({ ...raw, date: raw.start_date || raw.date });
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const planned = [...(rows.plannedOther || [])];
  const out = [];
  DAY_OFFSETS[days].forEach((off, i) => {
    const date = addDaysStr(inputs.date, off);
    const focus = inputs.focus === 'mixed' ? MIXED_ROTATION[i % MIXED_ROTATION.length] : inputs.focus;
    const body = generateSession({ ...rows, plannedOther: planned }, { ...inputs, date, focus }, seed + i);
    planned.push({ date, body });
    out.push(body);
  });
  return out;
}

// ---------- validation for bodies coming back from Sentinel ----------
const BLOCK_KINDS = ['warmup', 'strength', 'olympic', 'accessory', 'skill', 'gymnastics', 'metcon', 'core', 'conditioning', 'cooldown'];
const LOG_AS = ['lift', 'gymnastics', 'conditioning', 'engine', 'test', 'none'];
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const numOrNull = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : undefined));

// Rebuilds a workout body from only the fields the app understands. Returns
// { body, errors }. Logging state is never accepted from outside.
function sanitizeBody(input, fallback = {}) {
  const errors = [];
  if (!input || typeof input !== 'object') return { body: null, errors: ['body must be an object'] };
  if (!Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 12) return { body: null, errors: ['body.blocks must be an array of 1–12 blocks'] };
  const blocks = input.blocks.map((b, bi) => {
    const where = `blocks[${bi}]`;
    if (!b || typeof b !== 'object') { errors.push(`${where} must be an object`); return null; }
    const kind = BLOCK_KINDS.includes(b.kind) ? b.kind : (errors.push(`${where}.kind must be one of ${BLOCK_KINDS.join(', ')}`), 'strength');
    if (!Array.isArray(b.items) || b.items.length > 15) errors.push(`${where}.items must be an array of up to 15 items`);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 15).map((it, ii) => {
      const w = `${where}.items[${ii}]`;
      const movement = str(it && it.movement, 80);
      if (!movement) errors.push(`${w}.movement is required`);
      let logAs = it && it.log_as;
      if (!LOG_AS.includes(logAs)) { errors.push(`${w}.log_as must be one of ${LOG_AS.join(', ')}`); logAs = 'none'; }
      if (kind === 'metcon' && logAs !== 'none') { errors.push(`${w}: metcon items must be log_as "none" (the metcon logs as one result)`); logAs = 'none'; }
      const rawSets = Array.isArray(it && it.sets) ? it.sets : [];
      if (rawSets.length > 20) errors.push(`${w}.sets: at most 20`);
      if (logAs !== 'none' && !rawSets.length) errors.push(`${w}.sets is required when log_as is "${logAs}"`);
      const sets = rawSets.slice(0, 20).map((s, si) => {
        const ws = `${w}.sets[${si}]`;
        const o = {
          reps: numOrNull(s && s.reps, 0, 1000), load_lb: numOrNull(s && s.load_lb, 0, 2000), pct_1rm: numOrNull(s && s.pct_1rm, 0, 120),
          rpe: numOrNull(s && s.rpe, 1, 10), distance_m: numOrNull(s && s.distance_m, 0, 100000), duration_s: numOrNull(s && s.duration_s, 0, 36000),
          rest_s: numOrNull(s && s.rest_s, 0, 3600), target: numOrNull(s && s.target, 0, 100000),
          unit: s && ['cal', 'm'].includes(s.unit) ? s.unit : null,
          actual: null, entry: null,
        };
        for (const k of Object.keys(o)) if (o[k] === undefined) { errors.push(`${ws}.${k} out of range`); o[k] = null; }
        if (logAs === 'lift' && (o.reps == null)) errors.push(`${ws}.reps is required for lifts`);
        if (logAs === 'gymnastics' && (o.reps == null)) errors.push(`${ws}.reps is required for gymnastics`);
        if (logAs === 'conditioning' && o.distance_m == null && o.duration_s == null) errors.push(`${ws} needs distance_m or duration_s for conditioning`);
        if ((logAs === 'engine' || logAs === 'test') && (o.duration_s == null || !o.unit)) errors.push(`${ws} needs duration_s and unit ("cal" or "m") for engine intervals`);
        if (logAs === 'engine' && o.target == null) errors.push(`${ws}.target is required for engine intervals`);
        return o;
      });
      return {
        id: `b${bi + 1}i${ii + 1}`, movement: movement || '?', log_as: logAs,
        pattern: str(it && it.pattern, 40) || (BY_NAME.get(movement) ? BY_NAME.get(movement).pattern : strength.liftPattern(movement || '')),
        prescription: str(it && it.prescription, 200), rest_s: numOrNull(it && it.rest_s, 0, 900) ?? null,
        load_source: str(it && it.load_source, 300), notes: str(it && it.notes, 300), sets,
      };
    });
    let eng = null;
    if (b.engine && typeof b.engine === 'object') {
      const e = b.engine;
      if (engine.MODALITIES[e.modality] && (engine.SESSION_TYPES[e.type] || (e.type === 'test' && engine.TESTS[e.test]))) {
        eng = { modality: e.modality, type: e.type, unit: engine.MODALITIES[e.modality].unit };
        if (e.type === 'test') eng.test = e.test;
        if (numOrNull(e.pct, 0, 200) != null) eng.pct = Number(e.pct);
      } else errors.push(`${where}.engine: modality must be one of ${Object.keys(engine.MODALITIES).join(', ')} and type one of ${Object.keys(engine.SESSION_TYPES).join(', ')}, test`);
    }
    if (items.some((it) => it.log_as === 'engine' || it.log_as === 'test') && !eng) errors.push(`${where}: engine/test items need block.engine { modality, type }`);
    return {
      id: `b${bi + 1}`, kind, title: str(b.title, 80) || kind, minutes: numOrNull(b.minutes, 0, 180) ?? null,
      format: str(b.format, 40), notes: str(b.notes, 400), engine: eng, items, result: null,
    };
  }).filter(Boolean);
  const rationale = Array.isArray(input.rationale) ? input.rationale.filter((r) => typeof r === 'string').slice(0, 20).map((r) => r.slice(0, 400)) : [];
  return {
    body: {
      version: 1, date: fallback.date, title: str(input.title, 120) || fallback.title || 'Workout',
      focus: FOCI.includes(input.focus) ? input.focus : fallback.focus, minutes: numOrNull(input.minutes, 10, 240) ?? fallback.minutes,
      equipment: fallback.equipment, blocks, rationale,
    },
    errors,
  };
}

// The contract handed to Sentinel's trainer agent with every refine request.
const REFINE_SCHEMA = {
  body: {
    title: 'string ≤120',
    focus: FOCI.join(' | '),
    minutes: 'number — keep within the requested minutes',
    rationale: ['string — why you changed what you changed (shown to Jake)'],
    blocks: [{
      kind: BLOCK_KINDS.join(' | '),
      title: 'string',
      minutes: 'number',
      format: 'string, metcons only — e.g. "AMRAP"',
      notes: 'string — e.g. the metcon description',
      items: [{
        movement: 'string — use an existing name from known_movements when one fits, so it logs into the same history',
        log_as: `${LOG_AS.join(' | ')} — lift (load × reps), gymnastics (reps), conditioning (distance/time), none (warm-up text, metcon pieces)`,
        prescription: 'string — human-readable, e.g. "5 × 3 @ 225 lb"',
        rest_s: 'number',
        notes: 'string',
        sets: [{ reps: 'number', load_lb: 'number|null', pct_1rm: 'number|null', rpe: 'number|null', distance_m: 'number|null', duration_s: 'number|null — engine: interval length', rest_s: 'number|null', target: 'number|null — engine: output to hit this interval', unit: '"cal" | "m" | null' }],
      }],
      engine: 'object, conditioning blocks only: { modality: bike|row|ski|run, type: aerobic|threshold|vo2|speed|repeat|test, test?: tt10|sprint60|repeat, pct?: number }. Engine targets must come from engine_baselines in the context — keep them personal.',
    }],
  },
  notes: 'string — a short note to Jake about the refinement',
};

module.exports = {
  generateSession, generateWeek, sanitizeBody, normalizeInputs, makeContext,
  REFINE_SCHEMA, FOCI, FOCUS_LABEL, MINUTES, MAJOR, WEEKLY_SET_TARGET,
  ymd, mondayOfStr, addDaysStr,
};
