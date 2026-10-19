// Sentinel read API: a strictly read-only, human-readable view of everything
// Self Hub stores, for Sentinel's voice agent. Same contract as Jake's other
// apps:
//
//   GET /api/sentinel/read               → catalog of collections
//   GET /api/sentinel/read/:collection   → { collection, rows, count, total, truncated }
//       ?search=&id=&from=YYYY-MM-DD&to=YYYY-MM-DD&month=YYYY-MM&limit=50&<custom>
//
// Rules: GET only; every collection runs fixed queries (nothing from the
// request ever becomes SQL or a column name — filters are applied in JS to
// the formatted rows); names instead of ids; dates YYYY-MM-DD; units in field
// names; long text trimmed; responses kept under ~200 KB. Summary collections
// reuse the same code the app and the Sentinel push use, so numbers match.
// Auth is the app's normal Basic auth (Jake's login or the Sentinel login).
const express = require('express');
const strength = require('../lib/strength');
const { buildSummary, loadStrengthInputs } = require('../lib/sentinel');
const { computeWeeklyLoad, addDays } = require('../lib/weeklyLoad');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT = 1000; // list rows
const MAX_TEXT_FULL = 10000; // a single record fetched by id
const MAX_BYTES = 200 * 1024;

// Same labels the coach prompt uses.
const PHASE_NAMES = ['Phase 0 (Assess)', 'Phase 1 (Foundation Build)', 'Phase 2 (Shape Build)', 'Phase 3 (Sharpen)', 'Maintain'];

const MEASUREMENTS = [
  ['arm_length', 'Arm length'], ['bust', 'Bust / chest'], ['shoulder', 'Shoulder'], ['length', 'Length'],
  ['waist', 'Waist'], ['seat_hips', 'Seat / hips'], ['neck', 'Neck'], ['sleeve', 'Sleeve'],
  ['inseam_low', 'Inseam (low)'], ['inseam_high', 'Inseam (high)'],
];

const PATTERNS = Array.from(new Set([
  ...Object.values(strength.LIFT_PATTERN),
  ...Object.values(strength.GYMNASTICS_PATTERN),
  ...Object.values(strength.GENERATOR_PATTERN),
  'Balance', 'Core', 'Accessory', 'Uncategorized',
])).sort();

// ---- formatting helpers ----

// pg returns DATE as local midnight; pg-mem as UTC midnight. Either way this
// gives the calendar date that was stored.
function ymd(d) {
  if (d == null) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}
const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v, dp = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const e1rm = (load, reps) => round(Number(load) * (1 + Number(reps) / 30)); // Epley, as everywhere in the app
const slug = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function hms(seconds) {
  if (seconds == null) return null;
  const s = Math.round(Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (Number(b.id) || 0) - (Number(a.id) || 0));

// ---- filter parsers (custom filters) ----
const stringFilter = (field) => ({
  parse: (v) => v,
  match: (row, v) => row[field] != null && String(row[field]).toLowerCase() === v.toLowerCase(),
});
const enumFilter = (field, values) => ({
  parse: (v) => {
    const hit = values.find((x) => x.toLowerCase() === v.toLowerCase());
    if (!hit) throw new Error(`must be one of: ${values.join(', ')}`);
    return hit;
  },
  match: (row, v) => row[field] === v,
});
const boolFilter = (field) => ({
  parse: (v) => {
    const s = v.toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
    throw new Error('must be true or false');
  },
  match: (row, v) => Boolean(row[field]) === v,
});

// ---- queries (fixed per collection) ----
const Q = {
  profile: 'SELECT * FROM fitness_profile WHERE id = 1',
  bodyweight: 'SELECT id, entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC, id ASC',
  lifts: 'SELECT id, entry_date, lift, load_lb, reps, rpe, notes FROM fitness_lifts ORDER BY entry_date ASC, id ASC',
  benchmarkLifts: 'SELECT lift FROM fitness_benchmark_lifts ORDER BY lift ASC',
  benchmarks: 'SELECT id, entry_date, name, result FROM fitness_benchmarks ORDER BY entry_date ASC, id ASC',
  conditioning: 'SELECT id, entry_date, movement, distance_m, duration_seconds, notes FROM fitness_conditioning ORDER BY entry_date ASC, id ASC',
  gymnastics: 'SELECT id, entry_date, movement, reps, notes FROM fitness_gymnastics ORDER BY entry_date ASC, id ASC',
  measurements: `SELECT id, entry_date, ${MEASUREMENTS.map(([f]) => f).join(', ')} FROM fitness_measurements ORDER BY entry_date ASC, id ASC`,
  coachNotes: 'SELECT id, entry_date, source, note FROM fitness_coach_notes ORDER BY entry_date ASC, id ASC',
};
const rowsOf = async (pool, sql) => (await pool.query(sql)).rows;

async function benchmarkSet(pool) {
  return new Set((await rowsOf(pool, Q.benchmarkLifts)).map((r) => r.lift));
}
function inRange(date, ctx) {
  return (!ctx.from || date >= ctx.from) && (!ctx.to || date <= ctx.to);
}

function measurementRow(m) {
  const row = { id: m.id, date: ymd(m.entry_date) };
  for (const [f] of MEASUREMENTS) row[`${f}_in`] = num(m[f]);
  row.shoulder_waist_ratio = m.shoulder && m.waist ? round(Number(m.shoulder) / Number(m.waist), 2) : null;
  return row;
}

// ---- the catalog ----
// kind: 'log' (dated records, newest first), 'list', or 'summary'.
// dateFilters: from/to/month apply to row.date generically, unless
// rangeInLoad (the loader uses from/to itself, e.g. "bests between dates").
const COLLECTIONS = [
  {
    name: 'profile',
    description: "Jake's fitness profile: current training phase, body-fat and bodyweight targets, leaderboard goal, weekly session goals, height. Use for 'what phase am I in' or 'what's my goal'.",
    kind: 'list',
    fields: ['id', 'phase', 'phase_name', 'body_fat_target_pct', 'bodyweight_goal_lb', 'leaderboard_goal', 'weekly_strength_sessions_goal', 'weekly_conditioning_sessions_goal', 'height_in', 'updated_on'],
    async load({ pool }) {
      const p = (await rowsOf(pool, Q.profile))[0];
      if (!p) return [];
      return [{
        id: p.id,
        phase: num(p.phase),
        phase_name: PHASE_NAMES[p.phase] || null,
        body_fat_target_pct: num(p.body_fat_target),
        bodyweight_goal_lb: num(p.bodyweight_goal_lb),
        leaderboard_goal: p.leaderboard_goal,
        weekly_strength_sessions_goal: num(p.weekly_strength_sessions_goal),
        weekly_conditioning_sessions_goal: num(p.weekly_conditioning_sessions_goal),
        height_in: num(p.height_in),
        updated_on: p.updated_at ? ymd(new Date(p.updated_at)) : null,
      }];
    },
  },
  {
    name: 'bodyweight',
    description: 'Every weigh-in (bodyweight in lb, body fat % when taken). Use for "what did I weigh on…" or a list of weigh-ins; for trends use weight_trend.',
    kind: 'log',
    dated: true,
    fields: ['id', 'date', 'weight_lb', 'body_fat_pct'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.bodyweight)).map((r) => ({ id: r.id, date: ymd(r.entry_date), weight_lb: num(r.weight_lb), body_fat_pct: num(r.body_fat_pct) }));
    },
  },
  {
    name: 'body_fat',
    description: 'Body-fat readings only (weigh-ins where body fat % was recorded). Use for "what is my body fat" / body-fat history.',
    kind: 'log',
    dated: true,
    fields: ['id', 'date', 'body_fat_pct', 'weight_lb'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.bodyweight)).filter((r) => r.body_fat_pct != null)
        .map((r) => ({ id: r.id, date: ymd(r.entry_date), body_fat_pct: num(r.body_fat_pct), weight_lb: num(r.weight_lb) }));
    },
  },
  {
    name: 'lifts',
    description: 'Every logged lift set (lift, load lb, reps, RPE) with its estimated 1RM, movement pattern and whether it is a benchmark lift. Use for "what did I squat last week" or a lift\'s history.',
    kind: 'log',
    dated: true,
    search: ['lift', 'pattern'],
    custom: { lift: stringFilter('lift'), pattern: enumFilter('pattern', PATTERNS), benchmark_only: boolFilter('benchmark_lift') },
    fields: ['id', 'date', 'lift', 'load_lb', 'reps', 'rpe', 'notes', 'e1rm_lb', 'pattern', 'benchmark_lift'],
    async load({ pool }) {
      const bench = await benchmarkSet(pool);
      return (await rowsOf(pool, Q.lifts)).map((r) => ({
        id: r.id, date: ymd(r.entry_date), lift: r.lift, load_lb: num(r.load_lb), reps: num(r.reps), rpe: num(r.rpe), notes: r.notes || null,
        e1rm_lb: e1rm(r.load_lb, r.reps), pattern: strength.liftPattern(r.lift), benchmark_lift: bench.has(r.lift),
      }));
    },
  },
  {
    name: 'crossfit_percentiles',
    description: "Where Jake ranks against real populations: % of male CrossFitters he beats on back squat, deadlift, clean & jerk, snatch, max pull-ups, 400 m / 5 km run, Fran, Grace, Helen, Filthy 50 and Fight Gone Bad (2019 Open athlete profiles), rowing 500 m / 2k / 5k vs Concept2 2025 lightweight men, and CrossFit Open rank → percentile. Category rows average their benchmarks. Use for \"how do I compare\" or \"what's my weakest area\".",
    kind: 'summary',
    search: ['category', 'label'],
    custom: { category: enumFilter('category', ['Strength', 'Olympic', 'Gymnastics', 'Cardio', 'Metcon', 'Open']) },
    fields: ['id', 'kind', 'category', 'label', 'your_best', 'date', 'percentile', 'population_median', 'reference', 'bodyweight_level'],
    async load({ pool, now }) {
      const { loadPercentileRows } = require('./percentiles');
      const { computePercentiles } = require('../lib/percentiles');
      const today = new Date(now.getTime() - 6 * 3600e3).toISOString().slice(0, 10);
      const p = computePercentiles(await loadPercentileRows(pool), today, strength);
      return [
        ...p.categories.map((c) => ({ id: `category-${slug(c.category)}`, kind: 'category', category: c.category, label: c.category, your_best: c.basis, date: null, percentile: c.percentile, population_median: null, reference: null, bodyweight_level: null })),
        ...p.benchmarks.map((b) => ({ id: b.id, kind: 'benchmark', category: b.category, label: b.label, your_best: b.display, date: b.date, percentile: b.percentile, population_median: b.median, reference: b.reference, bodyweight_level: b.bodyweight_level ? `${b.bodyweight_level.level} (${b.bodyweight_level.ratio}× bodyweight)` : null })),
        ...p.open.map((o) => ({ id: `open-${o.year}-${slug(o.workout)}`, kind: 'open', category: 'Open', label: `${o.year} Open ${o.workout}`, your_best: `rank ${o.rank} of ${o.total}${o.score ? ` (${o.score})` : ''}`, date: null, percentile: o.percentile, population_median: null, reference: o.division, bodyweight_level: null })),
      ];
    },
  },
  {
    name: 'workouts',
    description: "Generated workouts (planned, done or skipped): title, focus, minutes, whether Sentinel refined it, progress, and the full workout as readable lines (plan). Use for \"what's my workout today\" or \"what's planned this week\".",
    kind: 'log',
    dated: true,
    search: ['title', 'focus', 'plan'],
    custom: { status: enumFilter('status', ['planned', 'done', 'skipped']) },
    fields: ['id', 'date', 'title', 'focus', 'minutes', 'status', 'source', 'refine_status', 'sets_logged', 'sets_total', 'objective', 'intensity', 'systems', 'qualities', 'actual_minutes', 'session_rpe', 'session_load', 'session_notes', 'logged', 'plan'],
    async load({ pool }) {
      const rows = await rowsOf(pool, 'SELECT id, workout_date, title, focus, minutes, status, source, refine_status, body, meta, actual_minutes, session_rpe, session_notes FROM fitness_workouts ORDER BY workout_date ASC, id ASC');
      return rows.map((r) => {
        const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
        // What the session is for, when Sentinel's trainer planned it (meta, 2026-10-18).
        const meta = (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) || {};
        let done = 0; let total = 0;
        const lines = [];
        const logged = []; // what he actually did, set by set (Jake, 2026-10-18: the log goes both ways)
        for (const b of body.blocks || []) {
          lines.push(`${b.title}${b.minutes ? ` (${b.minutes} min)` : ''}${b.notes ? ` — ${b.notes}` : ''}`);
          if (b.kind === 'metcon') { total++; if (b.result) { done++; logged.push(`${b.title}: ${b.result.text}`); } }
          for (const it of b.items || []) {
            lines.push(`  ${it.movement}: ${it.prescription || ''}`);
            if (b.kind === 'metcon' || it.log_as === 'none') continue;
            (it.sets || []).forEach((s, i) => {
              total++;
              if (!s.entry) return;
              done++;
              const e = s.entry;
              const what = e.load_lb != null ? `${e.reps} × ${e.load_lb} lb` : e.output != null ? `${e.output} ${s.unit || ''}`.trim() : e.reps != null ? `${e.reps} reps` : 'done';
              logged.push(`${it.movement} set ${i + 1}${s.extra ? ' (extra)' : ''}: ${what}${e.rpe != null ? ` @ RPE ${e.rpe}` : ''}${e.notes ? ` — ${e.notes}` : ''}`);
            });
          }
        }
        return {
          id: r.id, date: ymd(r.workout_date), title: r.title, focus: r.focus, minutes: num(r.minutes), status: r.status,
          source: r.source, refine_status: r.refine_status, sets_logged: done, sets_total: total,
          objective: meta.objective || null, intensity: meta.intensity || null, systems: meta.systems || null, qualities: meta.qualities || null,
          actual_minutes: num(r.actual_minutes), session_rpe: num(r.session_rpe),
          session_load: r.actual_minutes != null && r.session_rpe != null ? Math.round(Number(r.actual_minutes) * Number(r.session_rpe)) : null,
          session_notes: r.session_notes || null, logged: logged.join('\n'),
          plan: lines.join('\n'),
        };
      });
    },
  },
  {
    name: 'conditioning',
    description: 'Conditioning sessions (row, run, bike, ski…): distance in metres and/or duration, with notes. Use for cardio history.',
    kind: 'log',
    dated: true,
    search: ['movement', 'notes'],
    custom: { movement: stringFilter('movement') },
    fields: ['id', 'date', 'movement', 'distance_m', 'duration_seconds', 'duration', 'notes'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.conditioning)).map((r) => ({
        id: r.id, date: ymd(r.entry_date), movement: r.movement, distance_m: num(r.distance_m),
        duration_seconds: num(r.duration_seconds), duration: hms(r.duration_seconds), notes: r.notes,
      }));
    },
  },
  {
    name: 'gymnastics',
    description: 'Bodyweight / calisthenics sets (push-ups, pull-ups, HSPU, toes-to-bar, handstand walk…) as reps, with pattern and notes.',
    kind: 'log',
    dated: true,
    search: ['movement', 'notes', 'pattern'],
    custom: { movement: stringFilter('movement'), pattern: enumFilter('pattern', PATTERNS) },
    fields: ['id', 'date', 'movement', 'reps', 'pattern', 'notes'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.gymnastics)).map((r) => ({
        id: r.id, date: ymd(r.entry_date), movement: r.movement, reps: num(r.reps), pattern: strength.liftPattern(r.movement), notes: r.notes,
      }));
    },
  },
  {
    name: 'benchmarks',
    description: 'Benchmark workout / test results (e.g. Fran, 2k row) with the result exactly as Jake typed it.',
    kind: 'log',
    dated: true,
    search: ['name', 'result'],
    custom: { name: stringFilter('name') },
    fields: ['id', 'date', 'name', 'result'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.benchmarks)).map((r) => ({ id: r.id, date: ymd(r.entry_date), name: r.name, result: r.result }));
    },
  },
  {
    name: 'measurements',
    description: 'Body / clothing measurement sets in inches (shoulder, waist, chest, arm, neck, sleeve, hips, inseam…) with the shoulder:waist (V-taper) ratio. For latest vs previous use measurements_change.',
    kind: 'log',
    dated: true,
    fields: ['id', 'date', ...MEASUREMENTS.map(([f]) => `${f}_in`), 'shoulder_waist_ratio'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.measurements)).map(measurementRow);
    },
  },
  {
    name: 'coach_notes',
    description: 'Coaching notes left for Jake (by Sentinel or by hand), newest first. Use for "what did my coach say".',
    kind: 'log',
    dated: true,
    search: ['note', 'source'],
    custom: { source: stringFilter('source') },
    fields: ['id', 'date', 'source', 'note'],
    async load({ pool }) {
      return (await rowsOf(pool, Q.coachNotes)).map((r) => ({ id: r.id, date: ymd(r.entry_date), source: r.source, note: r.note }));
    },
  },
  {
    name: 'benchmark_lifts',
    description: 'The indicator lifts that count toward the strength score, with movement pattern, how often each is logged and when last.',
    kind: 'list',
    search: ['lift', 'pattern'],
    custom: { pattern: enumFilter('pattern', PATTERNS) },
    fields: ['id', 'lift', 'pattern', 'has_strength_standard', 'counts_toward_score', 'sets_logged', 'last_logged_on'],
    async load({ pool }) {
      const lifts = await rowsOf(pool, Q.lifts);
      return [...(await benchmarkSet(pool))].sort().map((lift) => {
        const mine = lifts.filter((l) => l.lift === lift);
        const pattern = strength.liftPattern(lift);
        const hasStd = Boolean(strength.standardsFor(lift));
        return {
          id: slug(lift), lift, pattern, has_strength_standard: hasStd,
          counts_toward_score: hasStd && pattern !== 'Accessory' && pattern !== 'Uncategorized',
          sets_logged: mine.length, last_logged_on: mine.length ? ymd(mine[mine.length - 1].entry_date) : null,
        };
      });
    },
  },

  // ---- summaries ----
  {
    name: 'strength_score',
    description: "Current strength score and level, overall and per movement pattern (weakest first), with each benchmark lift's 2-month best e1RM and bodyweight ratio. Same numbers as the Health tab and the Sentinel tile.",
    kind: 'summary',
    custom: { pattern: enumFilter('pattern', ['Overall', ...PATTERNS]) },
    fields: ['id', 'pattern', 'score', 'level', 'lifts', 'bodyweight_avg_lb', 'window', 'as_of', 'needs_input'],
    async load({ pool, now }) {
      const { summary } = await buildSummary(pool, now);
      const s = summary.strength;
      const needs = summary.needs_input.map((n) => `${n.text}. ${n.detail}`);
      const liftOut = (l) => ({ lift: l.lift, e1rm_lb: l.e1rm_lb, bodyweight_ratio: l.ratio, score: l.score, level: l.level });
      const rows = [{
        id: 'overall', pattern: 'Overall', score: s.overall_score, level: s.level, lifts: s.lifts.map(liftOut),
        bodyweight_avg_lb: s.bodyweight_avg_lb, window: '2 months (60 days)', as_of: s.as_of, needs_input: needs,
      }];
      for (const p of s.by_pattern) {
        rows.push({
          id: slug(p.pattern), pattern: p.pattern, score: p.score, level: p.level,
          lifts: s.lifts.filter((l) => strength.liftPattern(l.lift) === p.pattern).map(liftOut),
          bodyweight_avg_lb: s.bodyweight_avg_lb, window: '2 months (60 days)', as_of: s.as_of,
        });
      }
      return rows;
    },
  },
  {
    name: 'strength_trend',
    description: 'Weekly strength score per movement pattern over time (the Health tab "Pattern trend" chart), newest first. Use for "is my squat getting stronger".',
    kind: 'log',
    dated: true,
    custom: { pattern: enumFilter('pattern', PATTERNS) },
    fields: ['id', 'date', 'pattern', 'score', 'level'],
    async load({ pool, now }) {
      const data = await loadStrengthInputs(pool);
      const patterns = new Set(data.benchmarkLifts.map(strength.liftPattern));
      const rows = [];
      for (const pattern of patterns) {
        const pts = strength.computeStrengthTrend(data, pattern, now) || [];
        for (const pt of pts) {
          const date = pt.x.toISOString().slice(0, 10);
          rows.push({ id: `${slug(pattern)}:${date}`, date, pattern, score: pt.y, level: strength.levelLabel(pt.y) });
        }
      }
      return rows.sort((a, b) => a.pattern.localeCompare(b.pattern)); // then newest first (stable)
    },
  },
  {
    name: 'personal_bests',
    description: 'Personal bests per lift: best estimated 1RM (Epley) and the set it came from, heaviest load, sets logged, last done. from/to limit which sets count.',
    kind: 'summary',
    dated: true,
    rangeInLoad: true,
    search: ['lift', 'pattern'],
    custom: { lift: stringFilter('lift'), pattern: enumFilter('pattern', PATTERNS), benchmark_only: boolFilter('benchmark_lift') },
    fields: ['id', 'lift', 'pattern', 'benchmark_lift', 'best_e1rm_lb', 'best_e1rm_set', 'best_e1rm_on', 'heaviest_load_lb', 'heaviest_reps', 'heaviest_on', 'sets_logged', 'last_logged_on'],
    async load({ pool, ...ctx }) {
      const bench = await benchmarkSet(pool);
      const by = new Map();
      for (const r of await rowsOf(pool, Q.lifts)) {
        const date = ymd(r.entry_date);
        if (!inRange(date, ctx)) continue;
        const load = num(r.load_lb); const reps = num(r.reps); const e = e1rm(load, reps);
        let b = by.get(r.lift);
        if (!b) {
          b = { id: slug(r.lift), lift: r.lift, pattern: strength.liftPattern(r.lift), benchmark_lift: bench.has(r.lift),
            best_e1rm_lb: -1, best_e1rm_set: null, best_e1rm_on: null, heaviest_load_lb: -1, heaviest_reps: null, heaviest_on: null, sets_logged: 0, last_logged_on: null };
          by.set(r.lift, b);
        }
        b.sets_logged += 1;
        if (!b.last_logged_on || date > b.last_logged_on) b.last_logged_on = date;
        if (e > b.best_e1rm_lb) { b.best_e1rm_lb = e; b.best_e1rm_set = `${load} lb x ${reps}`; b.best_e1rm_on = date; }
        if (load > b.heaviest_load_lb || (load === b.heaviest_load_lb && reps > b.heaviest_reps)) {
          b.heaviest_load_lb = load; b.heaviest_reps = reps; b.heaviest_on = date;
        }
      }
      return [...by.values()].sort((a, b) => a.lift.localeCompare(b.lift));
    },
  },
  {
    name: 'movement_bests',
    description: 'Bests and totals per gymnastics movement (max reps in a set) and per conditioning movement (longest distance / duration, totals). from/to limit which entries count.',
    kind: 'summary',
    dated: true,
    rangeInLoad: true,
    search: ['movement', 'pattern'],
    custom: { kind: enumFilter('kind', ['gymnastics', 'conditioning']), movement: stringFilter('movement') },
    fields: ['id', 'kind', 'movement', 'pattern', 'max_reps', 'max_reps_on', 'total_reps', 'longest_distance_m', 'longest_distance_on', 'longest_duration', 'longest_duration_seconds', 'longest_duration_on', 'total_distance_m', 'total_minutes', 'entries', 'last_done_on'],
    async load({ pool, ...ctx }) {
      const out = new Map();
      for (const r of await rowsOf(pool, Q.gymnastics)) {
        const date = ymd(r.entry_date);
        if (!inRange(date, ctx)) continue;
        const key = `gymnastics:${slug(r.movement)}`;
        let b = out.get(key);
        if (!b) { b = { id: key, kind: 'gymnastics', movement: r.movement, pattern: strength.liftPattern(r.movement), max_reps: -1, max_reps_on: null, total_reps: 0, entries: 0, last_done_on: null }; out.set(key, b); }
        const reps = num(r.reps);
        b.entries += 1; b.total_reps += reps;
        if (reps > b.max_reps) { b.max_reps = reps; b.max_reps_on = date; }
        if (!b.last_done_on || date > b.last_done_on) b.last_done_on = date;
      }
      for (const r of await rowsOf(pool, Q.conditioning)) {
        const date = ymd(r.entry_date);
        if (!inRange(date, ctx)) continue;
        const key = `conditioning:${slug(r.movement)}`;
        let b = out.get(key);
        if (!b) {
          b = { id: key, kind: 'conditioning', movement: r.movement, longest_distance_m: null, longest_distance_on: null,
            longest_duration: null, longest_duration_seconds: null, longest_duration_on: null, total_distance_m: 0, total_minutes: 0, entries: 0, last_done_on: null };
          out.set(key, b);
        }
        const dist = num(r.distance_m); const dur = num(r.duration_seconds);
        b.entries += 1;
        if (dist != null) { b.total_distance_m = round(b.total_distance_m + dist); if (b.longest_distance_m == null || dist > b.longest_distance_m) { b.longest_distance_m = dist; b.longest_distance_on = date; } }
        if (dur != null) { b.total_minutes = round(b.total_minutes + dur / 60); if (b.longest_duration_seconds == null || dur > b.longest_duration_seconds) { b.longest_duration_seconds = dur; b.longest_duration = hms(dur); b.longest_duration_on = date; } }
        if (!b.last_done_on || date > b.last_done_on) b.last_done_on = date;
      }
      return [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.movement.localeCompare(b.movement));
    },
  },
  {
    name: 'weight_trend',
    description: "Bodyweight trend: current weight vs goal, the app's 7-weigh-in average, and 7/30/90-day and all-time change, average and weekly rate. Use for 'am I gaining'.",
    kind: 'summary',
    fields: ['id', 'window', 'latest_weight_lb', 'latest_on', 'avg_last_7_weighins_lb', 'body_fat_pct', 'body_fat_on', 'goal_lb', 'to_goal_lb',
      'window_days', 'weighins', 'avg_weight_lb', 'start_weight_lb', 'start_on', 'change_lb', 'weekly_rate_lb'],
    async load({ pool, now }) {
      const bw = (await rowsOf(pool, Q.bodyweight)).map((r) => ({ date: ymd(r.entry_date), w: num(r.weight_lb), bf: num(r.body_fat_pct) }));
      const profile = (await rowsOf(pool, Q.profile))[0] || {};
      const goal = num(profile.bodyweight_goal_lb);
      const last = bw[bw.length - 1];
      const last7 = bw.slice(-7);
      const bf = [...bw].reverse().find((r) => r.bf != null);
      const rows = [{
        id: 'current', window: 'current',
        latest_weight_lb: last ? last.w : null, latest_on: last ? last.date : null,
        avg_last_7_weighins_lb: last7.length ? round(last7.reduce((s, r) => s + r.w, 0) / last7.length) : null,
        body_fat_pct: bf ? bf.bf : null, body_fat_on: bf ? bf.date : null,
        goal_lb: goal, to_goal_lb: goal != null && last ? round(goal - last.w) : null,
      }];
      const weekly = (from, to) => {
        if (!from || !to) return null;
        const days = (Date.parse(to.date) - Date.parse(from.date)) / 86400000;
        return days > 0 ? round((to.w - from.w) / (days / 7), 2) : null;
      };
      for (const days of [7, 30, 90]) {
        // Same cutoff rule as the Sentinel tile's 30-day change.
        const cutoff = new Date(now.getTime() - days * 86400e3).toISOString().slice(0, 10);
        const inWin = bw.filter((r) => r.date > cutoff);
        const before = [...bw].reverse().find((r) => r.date <= cutoff);
        rows.push({
          id: `${days}d`, window: `last ${days} days`, window_days: days, weighins: inWin.length,
          avg_weight_lb: inWin.length ? round(inWin.reduce((s, r) => s + r.w, 0) / inWin.length) : null,
          latest_weight_lb: last ? last.w : null, latest_on: last ? last.date : null,
          start_weight_lb: before ? before.w : null, start_on: before ? before.date : null,
          change_lb: before && last ? round(last.w - before.w) : null,
          weekly_rate_lb: weekly(before, last),
        });
      }
      const first = bw[0];
      rows.push({
        id: 'all', window: 'all time', weighins: bw.length,
        avg_weight_lb: bw.length ? round(bw.reduce((s, r) => s + r.w, 0) / bw.length) : null,
        latest_weight_lb: last ? last.w : null, latest_on: last ? last.date : null,
        start_weight_lb: first ? first.w : null, start_on: first ? first.date : null,
        change_lb: first && last && bw.length > 1 ? round(last.w - first.w) : null,
        weekly_rate_lb: bw.length > 1 ? weekly(first, last) : null, // = the app's bodyweight_weekly_rate_lb
      });
      return rows;
    },
  },
  {
    name: 'training_week',
    description: "This week's training vs plan: strength and conditioning sessions done vs weekly goal, tonnage/minutes vs 4-week average, ACWR load status, lifts done this week, plus the days trained. Same as the Health tab's weekly-load panel.",
    kind: 'summary',
    fields: ['id', 'channel', 'week_start', 'week_end', 'sessions_done', 'sessions_goal', 'sessions_remaining', 'tonnage_this_week_lb', 'tonnage_4wk_avg_lb',
      'minutes_this_week', 'minutes_4wk_avg', 'acwr', 'status', 'lifts_this_week', 'days_trained'],
    async load({ pool, now }) {
      const wl = await computeWeeklyLoad(pool, now);
      const weekEnd = addDays(new Date(`${wl.week_start}T00:00:00Z`), 6).toISOString().slice(0, 10);
      const inWeek = (d) => d >= wl.week_start && d <= weekEnd;
      const liftDays = new Set((await rowsOf(pool, Q.lifts)).map((r) => ymd(r.entry_date)).filter(inWeek));
      const condDays = new Set((await rowsOf(pool, Q.conditioning)).map((r) => ymd(r.entry_date)).filter(inWeek));
      const left = (done, goal) => (goal == null ? null : Math.max(0, Number(goal) - done));
      return [
        {
          id: 'strength', channel: 'strength', week_start: wl.week_start, week_end: weekEnd,
          sessions_done: wl.strength.sessions_this_week, sessions_goal: num(wl.strength.sessions_goal),
          sessions_remaining: left(wl.strength.sessions_this_week, wl.strength.sessions_goal),
          tonnage_this_week_lb: wl.strength.tonnage_this_week_lb, tonnage_4wk_avg_lb: wl.strength.tonnage_4wk_avg_lb,
          acwr: wl.strength.acwr, status: wl.strength.status, lifts_this_week: wl.lift_names_this_week, days_trained: [...liftDays].sort(),
        },
        {
          id: 'conditioning', channel: 'conditioning', week_start: wl.week_start, week_end: weekEnd,
          sessions_done: wl.conditioning.sessions_this_week, sessions_goal: num(wl.conditioning.sessions_goal),
          sessions_remaining: left(wl.conditioning.sessions_this_week, wl.conditioning.sessions_goal),
          minutes_this_week: wl.conditioning.minutes_this_week, minutes_4wk_avg: wl.conditioning.minutes_4wk_avg,
          acwr: wl.conditioning.acwr, status: wl.conditioning.status, days_trained: [...condDays].sort(),
        },
      ];
    },
  },
  {
    name: 'measurements_change',
    description: 'Latest vs previous value for each body measurement (inches) and the shoulder:waist ratio, with the change. Use for "has my waist gone down".',
    kind: 'summary',
    search: ['measurement'],
    fields: ['id', 'measurement', 'latest', 'latest_on', 'previous', 'previous_on', 'change', 'unit'],
    async load({ pool }) {
      const sets = (await rowsOf(pool, Q.measurements)).map(measurementRow).reverse(); // newest first
      const rows = [];
      for (const [f, label] of [...MEASUREMENTS, ['shoulder_waist_ratio', 'Shoulder:waist ratio']]) {
        const key = f === 'shoulder_waist_ratio' ? f : `${f}_in`;
        const have = sets.filter((s) => s[key] != null).slice(0, 2);
        if (!have.length) continue;
        const [a, b] = have;
        rows.push({
          id: f, measurement: label, unit: f === 'shoulder_waist_ratio' ? 'ratio' : 'inches',
          latest: a[key], latest_on: a.date, previous: b ? b[key] : null, previous_on: b ? b.date : null,
          change: b ? round(a[key] - b[key], f === 'shoulder_waist_ratio' ? 2 : 1) : null,
        });
      }
      return rows;
    },
  },
];
const BY_NAME = new Map(COLLECTIONS.map((c) => [c.name, c]));

// limit is accepted everywhere but, per the shared contract, not listed.
function filtersOf(c) {
  return [...(c.search ? ['search'] : []), 'id', ...(c.dated ? ['from', 'to', 'month'] : []), ...Object.keys(c.custom || {})];
}

// ---- request handling ----
class BadFilter extends Error {}

function parseQuery(c, query) {
  const allowed = new Set([...filtersOf(c), 'limit']);
  const q = {};
  for (const [k, raw] of Object.entries(query)) {
    if (!allowed.has(k)) throw new BadFilter(`unknown filter "${k}" for ${c.name}; allowed: ${[...allowed].join(', ')}`);
    if (Array.isArray(raw) || typeof raw !== 'string') throw new BadFilter(`filter "${k}" must be given once, as plain text`);
    q[k] = raw.trim();
  }
  const out = { limit: DEFAULT_LIMIT, custom: {} };
  if (q.limit !== undefined && q.limit !== '') {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1) throw new BadFilter('limit must be a whole number from 1 to 200');
    out.limit = Math.min(MAX_LIMIT, Number(q.limit));
  }
  const date = (k) => {
    const v = q[k];
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
      throw new BadFilter(`${k} must be a date YYYY-MM-DD`);
    }
    return v;
  };
  out.from = date('from');
  out.to = date('to');
  if (q.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(q.month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new BadFilter('month must be YYYY-MM');
    const first = `${q.month}-01`;
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
    if (!out.from || first > out.from) out.from = first;
    if (!out.to || last < out.to) out.to = last;
  }
  if (out.from && out.to && out.from > out.to) throw new BadFilter('from must be on or before to');
  if (q.id) out.id = q.id;
  if (q.search) out.search = q.search.toLowerCase().split(/\s+/).filter(Boolean);
  for (const [k, f] of Object.entries(c.custom || {})) {
    if (!q[k]) continue;
    try { out.custom[k] = f.parse(q[k]); } catch (e) { throw new BadFilter(`${k} ${e.message}`); }
  }
  return out;
}

function trimText(value, max) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… [trimmed]` : value;
  if (Array.isArray(value)) return value.map((v) => trimText(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimText(v, max)]));
  return value;
}

async function readCollection(c, query, { pool, now }) {
  const f = parseQuery(c, query);
  let rows = await c.load({ pool, now, from: f.from, to: f.to });
  if (c.kind === 'log') rows = [...rows].sort(byDateDesc); // newest first
  if (f.id) rows = rows.filter((r) => String(r.id).toLowerCase() === f.id.toLowerCase());
  if (c.dated && !c.rangeInLoad && (f.from || f.to)) rows = rows.filter((r) => r.date && inRange(r.date, f));
  if (f.search) {
    rows = rows.filter((r) => {
      const hay = c.search.map((k) => (r[k] == null ? '' : String(r[k]))).join(' ').toLowerCase();
      return f.search.every((w) => hay.includes(w));
    });
  }
  for (const [k, v] of Object.entries(f.custom)) rows = rows.filter((r) => c.custom[k].match(r, v));

  const total = rows.length;
  let out = rows.slice(0, f.limit).map((r) => trimText(r, f.id ? MAX_TEXT_FULL : MAX_TEXT));
  let truncated = total > out.length;
  const body = () => ({ collection: c.name, rows: out, count: out.length, total, truncated });
  while (out.length > 1 && Buffer.byteLength(JSON.stringify(body())) > MAX_BYTES) {
    out = out.slice(0, Math.max(1, Math.floor(out.length * 0.8)));
    truncated = true;
  }
  return body();
}

function createSentinelReadRouter({ pool, now = () => new Date() }) {
  const router = express.Router();

  // Read only: anything but GET/HEAD is refused before it reaches a handler.
  router.use('/read', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET');
      return res.status(405).json({ error: 'read only: GET only' });
    }
    next();
  });

  router.get('/read', (req, res) => {
    res.json({
      app: 'self_hub',
      collections: COLLECTIONS.map((c) => ({ name: c.name, description: c.description, filters: filtersOf(c), fields: c.fields })),
    });
  });

  router.get('/read/:collection', async (req, res) => {
    const c = BY_NAME.get(req.params.collection);
    if (!c) return res.status(404).json({ error: `unknown collection "${req.params.collection}"`, collections: COLLECTIONS.map((x) => x.name) });
    try {
      res.json(await readCollection(c, req.query, { pool, now: now() }));
    } catch (err) {
      if (err instanceof BadFilter) return res.status(422).json({ error: err.message, filters: filtersOf(c) });
      console.error(`sentinel read ${c.name} failed:`, err && err.message);
      res.status(500).json({ error: 'read failed' });
    }
  });

  return router;
}

module.exports = { createSentinelReadRouter, COLLECTIONS };
