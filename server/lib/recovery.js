// What he actually did and how his body is (Jake, Nov 6: "It's not factoring in previous workouts or soreness. It is
// also showing workouts that have already been completed... I did back squats last day, then I asked it to program for
// me today and it did back squats front squats and deadlifts, then repeated the metcon from Monday").
//
// recentTraining is the true picture the trainer reads: what he logged, day by day, with the metcons of the sessions he
// started (a metcon logs as one result, so one he did and didn't score left no trace), his session RPE and notes, how
// long since each pattern was trained and how hard, and the soreness he reported. checkRecovery holds a plan to it:
// Self Hub sends what breaks back to the trainer, so a repeat can't get through on the trainer's word.
const figure = require('./figure');
const strength = require('./strength');
const { BY_NAME } = require('./movements');

const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
const ymd = (d) => {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return d.toISOString().slice(0, 10);
};
const patternOf = (name) => (BY_NAME.get(name) ? BY_NAME.get(name).pattern : strength.liftPattern(name));

const LOWER = ['Squat', 'Hinge'];
const UPPER = ['Push Horizontal', 'Push Vertical', 'Pull Horizontal', 'Pull Vertical'];
const MAJOR = [...LOWER, ...UPPER, 'Olympic'];
const LOWER_REST = 3; // days between hard squats, or hard hinges
const VERY_HARD = 9; // a top set at this RPE or above needs a day more
const HARD_RPE = 7; // sets under this are recovery work and don't count against a pattern's rest
const METCON_LOOKBACK = 21;

// ---- sessions ----
function loggedCount(body) {
  let n = 0;
  for (const b of (body && body.blocks) || []) {
    if (b.kind === 'metcon' && b.result) n++;
    if (b.kind === 'metcon') continue;
    for (const it of b.items || []) for (const s of it.sets || []) if (s.entry) n++;
  }
  return n;
}
// A session from before today that he logged anything in is over, however much of it he logged: it isn't still to do.
function effectiveStatus(status, date, logged, today) {
  return status === 'planned' && logged > 0 && date < today ? 'done' : status;
}

// ---- soreness ----
const AREA_WORDS = [
  [/\blegs?\b/, ['quads', 'hamstrings', 'glutes']],
  [/quad|thigh/, ['quads']],
  [/hamstring|hammie/, ['hamstrings']],
  [/glute|\bbutt\b|\bass\b|\bhips?\b/, ['glutes']],
  [/low(er)?.?back|lumbar|erector/, ['lowerback']],
  [/upper.?back|mid.?back|rhomboid/, ['midback']],
  [/\blats?\b/, ['lats']],
  [/\bback\b/, ['lats', 'midback']],
  [/chest|pec/, ['chest']],
  [/shoulder|delt/, ['shoulders']],
  [/trap/, ['traps']],
  [/neck/, ['neck']],
  [/\barms?\b/, ['biceps', 'triceps', 'forearms']],
  [/bicep/, ['biceps']],
  [/tricep/, ['triceps']],
  [/forearm|grip|wrist/, ['forearms']],
  [/\bcore\b|\babs?\b|stomach/, ['abs', 'obliques']],
  [/oblique/, ['obliques']],
  [/calf|calves/, ['calves']],
  [/adductor|groin/, ['adductors']],
];
// A word he might say ("low back", "hammies", "legs") → the figure's muscle groups. [] when it isn't a body part.
function soreAreas(word) {
  const w = String(word || '').toLowerCase().trim();
  if (figure.GROUPS.includes(w)) return [w];
  for (const [re, out] of AREA_WORDS) if (re.test(w)) return out;
  return [];
}
// Sore (1) keeps hard work off that muscle for 2 days after he said so; very sore (2) for 3.
const soreDays = (level) => (Number(level) >= 2 ? 3 : 2);
const LEVEL_WORD = { 1: 'sore', 2: 'very sore' };

// The figure's "too much" that still matters for what's next: not recovered now, or a huge session in the last 2 days.
// (A huge session 6 days ago stays violet on the figure until it fades, but it has had its rest.)
function tooMuch(over, date) {
  const out = {};
  for (const [g, o] of Object.entries(over || {})) {
    if (o.why !== 'session' || dayNum(date) - dayNum(o.day) <= 2) out[g] = o;
  }
  return out;
}

// ---- the true picture ----
// rows: lifts, gymnastics, conditioning (log rows), workouts ({ workout_date, title, status, body, session_rpe,
// actual_minutes, session_notes }), soreness ({ entry_date, area, level, note }). date: the day being planned.
function recentTraining(rows, date, { days = 14, upcoming = [] } = {}) {
  const from = addDays(date, -days);
  const inWindow = (d) => d >= from && d <= date;
  const byDay = {};
  const day = (d) => (byDay[d] = byDay[d] || { date: d, days_ago: dayNum(date) - dayNum(d), did: [], sessions: [], not_done: [] });
  const patternDays = {}; // pattern → date → { sets, top_rpe }
  const touch = (p, d, rpe) => {
    if (!MAJOR.includes(p)) return;
    const pd = patternDays[p] = patternDays[p] || {};
    const x = pd[d] = pd[d] || { sets: 0, top_rpe: null };
    x.sets += 1;
    if (rpe != null && (x.top_rpe == null || Number(rpe) > x.top_rpe)) x.top_rpe = Number(rpe);
  };

  const grouped = {};
  for (const l of rows.lifts || []) {
    const d = ymd(l.entry_date);
    if (!inWindow(d)) continue;
    touch(patternOf(l.lift), d, l.rpe);
    const k = `${d}|${l.lift}`;
    (grouped[k] = grouped[k] || []).push(`${Number(l.load_lb)}×${l.reps}${l.rpe != null ? ` @${Number(l.rpe)}` : ''}`);
  }
  for (const g of rows.gymnastics || []) {
    const d = ymd(g.entry_date);
    if (!inWindow(d)) continue;
    touch(patternOf(g.movement), d, null);
    const k = `${d}|${g.movement}`;
    (grouped[k] = grouped[k] || []).push(`×${g.reps}`);
  }
  for (const [k, sets] of Object.entries(grouped)) {
    const [d, name] = k.split('|');
    day(d).did.push(`${name}: ${sets.join(', ')}`);
  }
  for (const c of rows.conditioning || []) {
    const d = ymd(c.entry_date);
    if (!inWindow(d) || c.movement === 'Metcon') continue; // metcons come with their session, below
    const secs = c.duration_seconds == null ? null : Number(c.duration_seconds);
    day(d).did.push(`${c.movement}${c.distance_m != null ? ` ${Number(c.distance_m)} m` : ''}${secs != null ? ` in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}${c.notes ? ` (${String(c.notes).slice(0, 80)})` : ''}`);
  }

  const metcons = [];
  const metconFrom = addDays(date, -METCON_LOOKBACK);
  for (const w of rows.workouts || []) {
    const d = ymd(w.workout_date || w.date);
    const body = typeof w.body === 'string' ? JSON.parse(w.body) : w.body;
    if (!body || d > date) continue;
    const logged = loggedCount(body);
    const started = logged > 0 || w.status === 'done';
    if (started && d >= metconFrom) {
      for (const b of body.blocks || []) {
        if (b.kind !== 'metcon') continue;
        metcons.push({ date: d, title: b.title, movements: (b.items || []).map((it) => it.movement).filter(Boolean), result: b.result ? b.result.text : null, benchmark: b.benchmark || undefined });
      }
    }
    if (!inWindow(d)) continue;
    if (started) {
      const x = { title: w.title, session_rpe: w.session_rpe == null ? undefined : Number(w.session_rpe), minutes: w.actual_minutes == null ? undefined : Number(w.actual_minutes), notes: w.session_notes || undefined };
      const left = [];
      for (const b of body.blocks || []) {
        if (['warmup', 'cooldown'].includes(b.kind)) continue;
        if (b.kind === 'metcon') {
          const what = (b.items || []).map((it) => it.prescription || it.movement).join(' + ');
          day(d).did.push(`Metcon "${b.title}" (${what})${b.result ? `: ${b.result.text}` : ': in a session he did, no score logged'}`);
          continue;
        }
        for (const it of b.items || []) {
          if (it.log_as !== 'none' && (it.sets || []).length && !(it.sets || []).some((s) => s.entry)) left.push(it.movement);
        }
      }
      if (left.length) x.left_undone = [...new Set(left)];
      day(d).sessions.push(x);
    } else if (d < date || w.status === 'skipped') {
      day(d).not_done.push(w.title);
    }
  }

  const patterns = {};
  for (const p of MAJOR) {
    const pd = patternDays[p];
    if (!pd) continue;
    const list = Object.keys(pd).sort();
    const last = list[list.length - 1];
    patterns[p] = {
      last_date: last, days_ago: dayNum(date) - dayNum(last), last_hard_sets: pd[last].sets, last_top_rpe: pd[last].top_rpe,
      hard_sets_last_7_days: list.filter((d) => dayNum(date) - dayNum(d) < 7).reduce((a, d) => a + pd[d].sets, 0),
    };
  }

  // What counts as work on a muscle: everything the figure counts, a past part-logged session's metcon included.
  const more = { conditioning: rows.conditioning || [], workouts: (rows.workouts || []).map((w) => {
    const d = ymd(w.workout_date || w.date);
    const body = typeof w.body === 'string' ? JSON.parse(w.body) : w.body;
    return { date: d, body, status: d > date ? 'planned' : effectiveStatus(w.status, d, loggedCount(body), date) };
  }) };
  const soreness = (rows.soreness || []).map((s) => ({ date: ymd(s.entry_date), area: s.area, level: Number(s.level), word: LEVEL_WORD[Number(s.level)] || 'sore', note: s.note || undefined }))
    .filter((s) => s.level > 0 && dayNum(date) - dayNum(s.date) >= 0 && dayNum(date) - dayNum(s.date) <= soreDays(s.level));

  return {
    as_of: date,
    days: Object.values(byDay).sort((a, b) => (a.date < b.date ? 1 : -1)),
    patterns,
    muscle_load: figure.muscleLoad(rows.lifts, rows.gymnastics, date, more),
    // Worked too hard, the violet on the figure (lib/figure.js): the muscles a plan has to keep off for now.
    overworked: tooMuch(figure.overworked(rows.lifts, rows.gymnastics, date, more), date),
    soreness,
    metcons: metcons.sort((a, b) => (a.date < b.date ? 1 : -1)),
    upcoming: upcoming.length ? upcoming : undefined,
    pattern_days: patternDays,
    rules: RULES,
  };
}
const RULES = [
  `Squat and Hinge rest ${LOWER_REST} days between hard sessions of that pattern, a day more after a top set at RPE ${VERY_HARD}+. Presses and pulls rest 2 days, a day more after RPE ${VERY_HARD}+. A session under RPE ${HARD_RPE} is recovery work and doesn't count. Squat and Hinge share the legs: never hard on consecutive days.`,
  'No hard work on a muscle in overworked: it has had too much and has not recovered. Train something else.',
  'One heavy lower-body pattern a session: not squats and deadlifts together, Romanian deadlifts included.',
  `No muscle he reported sore gets hard work: 2 days after "sore", 3 after "very sore". Train something else, or move it, and say so.`,
  `No metcon from the last ${METCON_LOOKBACK} days again (2 or more of the same movements). A benchmark retest is fine.`,
  'days lists what he actually did, newest first. not_done sessions did not happen: they count for nothing. Read his session notes and RPE before you choose.',
];

// ---- the checks ----
function hardByPattern(body) {
  const out = {};
  for (const b of (body && body.blocks) || []) {
    if (['warmup', 'cooldown', 'metcon'].includes(b.kind)) continue;
    for (const it of b.items || []) {
      if (!['lift', 'gymnastics'].includes(it.log_as)) continue;
      const hard = (it.sets || []).filter((s) => s.rpe == null || Number(s.rpe) >= HARD_RPE);
      if (!hard.length) continue;
      const p = it.pattern || patternOf(it.movement);
      const x = out[p] = out[p] || { sets: 0, top_rpe: null, movements: [] };
      x.sets += hard.length;
      if (!x.movements.includes(it.movement)) x.movements.push(it.movement);
      for (const s of hard) if (s.rpe != null && (x.top_rpe == null || Number(s.rpe) > x.top_rpe)) x.top_rpe = Number(s.rpe);
    }
  }
  return out;
}
const restNeeded = (pattern, topRpe) => {
  const base = LOWER.includes(pattern) ? LOWER_REST : 2;
  return base + (topRpe != null && topRpe >= VERY_HARD ? 1 : 0);
};
const moveKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(\w+?)s\b/g, '$1').replace(/\s+/g, ' ').trim();
function metconClash(a, b) {
  const A = new Set(a.map(moveKey)); const B = new Set(b.map(moveKey));
  const same = [...A].filter((x) => B.has(x));
  return same.length >= 2 && same.length >= Math.min(A.size, B.size) * 0.66 ? same : null;
}
// What his note asks for outright is his call ("squat again today"): his word beats these rules.
const NOTE_WORDS = { Squat: /squat/i, Hinge: /deadlift|hinge|rdl/i, 'Push Horizontal': /bench|press/i, 'Push Vertical': /press|hspu|handstand/i, 'Pull Horizontal': /row|pull/i, 'Pull Vertical': /pull/i, Olympic: /clean|snatch|jerk/i };

// days: [{ date, body }]; recent: recentTraining(). Returns what's wrong, in words the trainer can act on.
function checkRecovery(days, recent, { note = '', label = 'session' } = {}) {
  const errors = [];
  if (!recent) return errors;
  const sorted = [...days].filter((d) => d && d.body).sort((a, b) => (a.date < b.date ? -1 : 1));
  const asked = (p) => !!(note && NOTE_WORDS[p] && NOTE_WORDS[p].test(note));
  const planned = {}; // pattern → [{ date, top_rpe }] earlier in this same plan
  const plannedMetcons = [];
  for (const d of sorted) {
    const hard = hardByPattern(d.body);
    for (const [p, x] of Object.entries(hard)) {
      if (!MAJOR.includes(p) || x.sets < 2 || asked(p)) continue;
      // Rest since the last time, logged or earlier in this plan.
      const before = [
        ...Object.entries((recent.pattern_days && recent.pattern_days[p]) || {}).filter(([, v]) => v.sets >= 2).map(([date, v]) => ({ date, top_rpe: v.top_rpe, did: true, sets: v.sets })),
        ...(planned[p] || []),
      ].filter((b) => b.date <= d.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (before) {
        const gap = dayNum(d.date) - dayNum(before.date);
        const need = restNeeded(p, before.top_rpe);
        if (gap < need) errors.push(`${label} ${d.date}: ${x.movements.join(', ')} (${p}, ${x.sets} hard sets) comes ${gap} day${gap === 1 ? '' : 's'} after ${before.did ? `the ${before.sets} hard sets he did` : 'the hard sets planned'} on ${before.date}${before.top_rpe != null ? ` (top set RPE ${before.top_rpe})` : ''}. ${p} needs ${need} days: train another pattern that day, or keep it under RPE ${HARD_RPE} as recovery work.`);
      }
      // Squat and Hinge share the legs: not hard on consecutive days.
      const sibling = p === 'Squat' ? 'Hinge' : p === 'Hinge' ? 'Squat' : null;
      if (sibling && !asked(sibling)) {
        const near = [
          ...Object.entries((recent.pattern_days && recent.pattern_days[sibling]) || {}).filter(([, v]) => v.sets >= 2).map(([date]) => date),
          ...(planned[sibling] || []).map((b) => b.date),
        ].filter((date) => date < d.date && dayNum(d.date) - dayNum(date) === 1);
        if (near.length) errors.push(`${label} ${d.date}: hard ${p} the day after hard ${sibling} (${near[0]}): the legs need a day between.`);
      }
    }
    for (const [p, x] of Object.entries(hard)) (planned[p] = planned[p] || []).push({ date: d.date, top_rpe: x.top_rpe });
    // One heavy lower-body pattern a session.
    if (hard.Squat && hard.Hinge && hard.Squat.sets >= 3 && hard.Hinge.sets >= 3 && !(asked('Squat') && asked('Hinge'))) {
      errors.push(`${label} ${d.date}: ${hard.Squat.movements.join(', ')} (${hard.Squat.sets} hard sets) and ${hard.Hinge.movements.join(', ')} (${hard.Hinge.sets}) in one session. One heavy lower-body pattern a session: move one to another day.`);
    }
    // Soreness.
    for (const s of recent.soreness || []) {
      const gap = dayNum(d.date) - dayNum(s.date);
      if (gap < 0 || gap > soreDays(s.level)) continue;
      for (const b of d.body.blocks || []) {
        if (['warmup', 'cooldown', 'metcon'].includes(b.kind)) continue;
        for (const it of b.items || []) {
          if (!['lift', 'gymnastics'].includes(it.log_as)) continue;
          if (!(it.sets || []).some((x) => x.rpe == null || Number(x.rpe) >= HARD_RPE)) continue;
          if (figure.musclesFor(it.movement)[s.area] === 1 && !asked(it.pattern || patternOf(it.movement))) {
            errors.push(`${label} ${d.date}: ${it.movement} works his ${s.area} hard, and he said it was ${s.word} on ${s.date}. Train something else, or keep it under RPE ${HARD_RPE}.`);
          }
        }
      }
    }
    // Worked too hard: not on top of that. Only the first couple of days of a plan: it fades as the days pass.
    if (dayNum(d.date) - dayNum(recent.as_of || d.date) <= 2) {
      for (const g of Object.keys(recent.overworked || {})) {
        for (const b of d.body.blocks || []) {
          if (['warmup', 'cooldown', 'metcon'].includes(b.kind)) continue;
          for (const it of b.items || []) {
            if (!['lift', 'gymnastics'].includes(it.log_as)) continue;
            if (!(it.sets || []).some((x) => x.rpe == null || Number(x.rpe) >= HARD_RPE)) continue;
            if (figure.musclesFor(it.movement)[g] === 1 && !asked(it.pattern || patternOf(it.movement))) {
              errors.push(`${label} ${d.date}: ${it.movement} works his ${g} hard, and it has had too much already (${recent.overworked[g].load} sets still counting). Train something else, or keep it under RPE ${HARD_RPE}.`);
            }
          }
        }
      }
    }
    // Metcons: not one he's just done, nor the same one twice in this plan.
    for (const b of d.body.blocks || []) {
      if (b.kind !== 'metcon' || b.benchmark) continue;
      const moves = (b.items || []).map((it) => it.movement).filter(Boolean);
      if (!/repeat|same (metcon|wod)/i.test(note)) {
        const clash = [...(recent.metcons || []).filter((m) => !m.benchmark), ...plannedMetcons].find((m) => m.date <= d.date && metconClash(moves, m.movements));
        if (clash) errors.push(`${label} ${d.date}: the metcon (${moves.join(', ')}) repeats "${clash.title}" from ${clash.date} (${clash.movements.join(', ')}). Write a different one.`);
      }
      plannedMetcons.push({ date: d.date, title: b.title, movements: moves });
    }
  }
  return [...new Set(errors)];
}

module.exports = { recentTraining, checkRecovery, effectiveStatus, loggedCount, soreAreas, soreDays, hardByPattern, metconClash, ymd, VERY_HARD, HARD_RPE };
