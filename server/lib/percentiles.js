// CrossFit / Concept2 percentiles: where your numbers sit against real
// populations, shown alongside the bodyweight-ratio strength levels.
//
// Reference data (male):
//   CF2019 — ~1.7M CrossFit Games athlete profiles scraped after the 2019
//            Open (leblancfg.com, "CrossFit Open 2019 analysis"): quartiles
//            of the self-reported profile stats. Self-reported and optional,
//            so the population skews optimistic — your percentile reads a
//            little low, if anything. Lifts are in lb (stored from kg), times
//            in seconds. Not bodyweight- or age-adjusted.
//   C2_2025 — Concept2 online rankings, 2025 season, men, lightweight
//            (≤75 kg), all ages: the times at the 10/25/50/75/90% positions,
//            read off log.concept2.com/rankings. A population of people who
//            log rows online — serious-leaning.
//
// Method: each benchmark is a set of anchors (value → % of the population
// you beat). Anchors are converted to normal z-scores and z is interpolated
// linearly in the value (extrapolated with the end slopes beyond the
// outermost anchors). With quartiles only, that is a split-normal fitted to
// the quartiles — exact at the anchors, an estimate in the tails. Results
// are clamped to 1–99.

const REFS = {
  CF2019: { label: 'Male CrossFitters (2019 Open athlete profiles, self-reported)', url: 'https://leblancfg.com/crossfit_open_2019_analysis_exercise_statistics.html' },
  CF2019_WOD: { label: 'Male CrossFitters (2019 Open athlete profiles, self-reported)', url: 'https://leblancfg.com/crossfit_open_2019_analysis_benchmark_workouts.html' },
  SL_PULLUP: { label: 'StrengthLevel strict pull-up standards, men, by bodyweight', url: 'https://strengthlevel.com/strength-standards/pull-ups/lb' },
  C2_2025: { label: 'Concept2 rankings 2025, men lightweight, all ages', url: 'https://log.concept2.com/rankings/2025/rower/2000?gender=M&weight=L' },
};

// quartiles: [value at 25th quantile, median, value at 75th quantile] of the
// raw values. For lower-is-better events the 25th-quantile value is the
// FAST one, i.e. it beats 75% of the field.
function quartiles([q25, q50, q75], better) {
  return better === 'high'
    ? [[q25, 25], [q50, 50], [q75, 75]]
    : [[q25, 75], [q50, 50], [q75, 25]];
}

const BENCHMARKS = [
  // ---- Strength ----
  { id: 'back_squat', label: 'Back squat', category: 'Strength', unit: 'lb', better: 'high', ref: 'CF2019', anchors: quartiles([274.9, 315.0, 365.1], 'high'), source: { lift: 'Back Squat' } },
  { id: 'deadlift', label: 'Deadlift', category: 'Strength', unit: 'lb', better: 'high', ref: 'CF2019', anchors: quartiles([341.7, 396.8, 440.9], 'high'), source: { lift: 'Deadlift' } },
  // ---- Olympic ----
  { id: 'clean_jerk', label: 'Clean & jerk', category: 'Olympic', unit: 'lb', better: 'high', ref: 'CF2019', anchors: quartiles([187.4, 225.1, 255.1], 'high'), source: { lift: 'Clean & Jerk' } },
  { id: 'snatch', label: 'Snatch', category: 'Olympic', unit: 'lb', better: 'high', ref: 'CF2019', anchors: quartiles([143.3, 172.0, 200.6], 'high'), source: { lift: 'Snatch' } },
  // ---- Gymnastics ----
  // Strict reps against lifters at his bodyweight (Oct 31). Only sets logged as strict count: the CrossFit row below is
  // any style, and his max there is kipping.
  { id: 'pullups_strict', label: 'Strict pull-ups', category: 'Gymnastics', unit: 'reps', better: 'high', ref: 'SL_PULLUP', anchors: [[0.5, 5], [7, 20], [14, 50], [22, 80], [30, 95]], source: { gym: ['Strict Pull-Ups'], bench: ['Strict Pull-Ups'] }, note: 'Unbroken strict reps; the standard moves with your bodyweight.' },
  { id: 'pullups', label: 'Max pull-ups (any style)', category: 'Gymnastics', unit: 'reps', better: 'high', ref: 'CF2019', anchors: quartiles([20, 30, 41], 'high'), source: { gym: ['Strict Pull-Ups', 'Butterfly Pull-Ups', 'Pull-Ups', 'Kipping Pull-Ups'], bench: ['Pull-Ups', 'Kipping Pull-Ups', 'Strict Pull-Ups', 'Butterfly Pull-Ups', 'Max Pull-Ups'] }, note: 'Profile stat is unbroken max reps, any style — your best single set of pull-ups.' },
  // ---- Cardio ----
  { id: 'run_400', label: '400 m run', category: 'Cardio', unit: 's', better: 'low', ref: 'CF2019', anchors: quartiles([62, 70, 81], 'low'), source: { bench: ['400m run', 'Run 400m'], cond: { movement: 'Run', meters: 400 } } },
  { id: 'run_5k', label: '5 km run', category: 'Cardio', unit: 's', better: 'low', ref: 'CF2019', anchors: quartiles([1229, 1350, 1502], 'low'), source: { bench: ['5k run', '5000m run'], cond: { movement: 'Run', meters: 5000 } } },
  { id: 'row_500', label: '500 m row', category: 'Cardio', unit: 's', better: 'low', ref: 'C2_2025', anchors: [[92.0, 90], [97.7, 75], [105.0, 50], [115.5, 25], [127.8, 10]], source: { bench: ['500m row'], cond: { movement: 'Row', meters: 500 } } },
  { id: 'row_2k', label: '2k row', category: 'Cardio', unit: 's', better: 'low', ref: 'C2_2025', anchors: [[417.0, 90], [443.7, 75], [475.6, 50], [520.5, 25], [577.2, 10]], source: { bench: ['2k row', '2000m row'], cond: { movement: 'Row', meters: 2000 } } },
  { id: 'row_5k', label: '5k row', category: 'Cardio', unit: 's', better: 'low', ref: 'C2_2025', anchors: [[1138.3, 90], [1192.9, 75], [1272.2, 50], [1376.7, 25], [1495.7, 10]], source: { bench: ['5k row', '5000m row'], cond: { movement: 'Row', meters: 5000 } } },
  // ---- Metcon (Rx only) ----
  { id: 'fran', label: 'Fran', category: 'Metcon', unit: 's', better: 'low', ref: 'CF2019_WOD', anchors: quartiles([192, 262, 358], 'low'), source: { bench: ['Fran'] } },
  { id: 'grace', label: 'Grace', category: 'Metcon', unit: 's', better: 'low', ref: 'CF2019_WOD', anchors: quartiles([138, 178, 238], 'low'), source: { bench: ['Grace'] } },
  { id: 'helen', label: 'Helen', category: 'Metcon', unit: 's', better: 'low', ref: 'CF2019_WOD', anchors: quartiles([522, 587, 679], 'low'), source: { bench: ['Helen'] } },
  { id: 'filthy50', label: 'Filthy 50', category: 'Metcon', unit: 's', better: 'low', ref: 'CF2019_WOD', anchors: quartiles([1307, 1531, 1785], 'low'), source: { bench: ['Filthy 50'] } },
  { id: 'fgb', label: 'Fight Gone Bad', category: 'Metcon', unit: 'reps', better: 'high', ref: 'CF2019_WOD', anchors: quartiles([269, 308, 349], 'high'), source: { bench: ['Fight Gone Bad', 'FGB'] } },
];
// StrengthLevel strict pull-ups, men: reps at Beginner, Novice, Intermediate, Advanced, Elite for a bodyweight, which
// beat 5, 20, 50, 80 and 95% of lifters ("<1" read as 0.5). Bodyweights outside 150-180 lb use the nearest row.
const SL_PULLUP_TABLE = [[150, [0.5, 7, 14, 22, 31]], [160, [0.5, 7, 14, 22, 30]], [170, [0.5, 7, 13, 21, 29]], [180, [1, 7, 13, 21, 28]]];
function pullupTiers(bw) {
  const T = SL_PULLUP_TABLE, b = Math.max(T[0][0], Math.min(T[T.length - 1][0], bw || 160));
  let i = 0; while (i < T.length - 2 && b > T[i + 1][0]) i++;
  const f = (b - T[i][0]) / (T[i + 1][0] - T[i][0]);
  return T[i][1].map((v, j) => Math.round((v + f * (T[i + 1][1][j] - v)) * 10) / 10);
}
// Concept2's rankings are split by weight class, so a level read off the lightweight percentile is weight-adjusted.
// The CrossFit profiles aren't (and are self-reported), so they get a percentile but no level.
function levelFromPercentile(p) {
  if (p == null) return null;
  return p < 5 ? 'Below beginner' : p < 20 ? 'Beginner' : p < 50 ? 'Novice' : p < 80 ? 'Intermediate' : p < 95 ? 'Advanced' : 'Elite';
}
const CATEGORIES = ['Strength', 'Olympic', 'Gymnastics', 'Cardio', 'Metcon', 'Open'];

// ---- maths ----
function normCdf(z) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
function normInv(p) {
  // Acklam's rational approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// % of the population your value beats (1–99).
function percentileOf(bm, value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const pts = bm.anchors.map(([v, p]) => [v, normInv(p / 100)]).sort((x, y) => x[0] - y[0]);
  const x = Number(value);
  let i = 0;
  if (x <= pts[0][0]) i = 0;
  else if (x >= pts[pts.length - 1][0]) i = pts.length - 2;
  else while (!(x >= pts[i][0] && x <= pts[i + 1][0])) i++;
  const [x0, z0] = pts[i]; const [x1, z1] = pts[i + 1];
  const z = z0 + ((x - x0) * (z1 - z0)) / (x1 - x0);
  return Math.max(1, Math.min(99, Math.round(normCdf(z) * 100)));
}

// "4:12", "1:02:30", "4:12.5" → seconds; "312" → 312.
function parseResult(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/,/g, '');
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?$/.exec(s);
  if (m) return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  const n = /^(\d+(?:\.\d+)?)\s*(reps?|lb|lbs|s|sec)?$/i.exec(s);
  return n ? Number(n[1]) : null;
}
function fmt(bm, v) {
  if (v == null) return null;
  if (bm.unit === 's') {
    const s = Math.round(v * 10) / 10; const h = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); const ss = s % 60;
    const sec = (Number.isInteger(ss) ? String(ss) : ss.toFixed(1)).padStart(Number.isInteger(ss) ? 2 : 4, '0');
    return h ? `${h}:${String(mm).padStart(2, '0')}:${sec}` : `${mm}:${sec}`;
  }
  return `${Math.round(v)} ${bm.unit}`;
}

function ymd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}
const dayNum = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86400000);

// Movement names as Jake actually logs them: "Pull-ups (Kipping)" is
// "Kipping Pull-Ups", "Row 5k" is "5k row", "2000 m" is "2k", "Clean and
// Jerk" is "Clean & Jerk". Lowercase words, hyphens joined, plurals dropped,
// "and" dropped, distances unified, word order ignored.
function canon(name) {
  const words = String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(?<=\w)-(?=\w)/g, '')
    .replace(/(\d)\s*km\b/g, '$1k')
    .replace(/\b(\d+)000\s*m\b/g, '$1k')
    .replace(/(\d)\s+(m|k)\b/g, '$1$2')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'and')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return words.sort().join(' ');
}

// A benchmark-log row as (name, result) pairs. "Other" rows carry the name in
// the result ("Row 5k: 20:38", "Pull-ups (Kipping): Max Reps: 10"), so those
// also count as ("Row 5k", "20:38") and ("Pull-ups (Kipping)", "10").
function benchmarkEntries(b) {
  const out = [{ name: b.name, result: b.result }];
  const parts = String(b.result || '').split(/:\s+/);
  if (parts.length >= 2 && parts[0].trim()) out.push({ name: parts[0].trim(), result: parts[parts.length - 1].trim() });
  return out;
}

const LIFT_WINDOW_DAYS = 60; // the strength profile's window
const YEAR = 365;

// rows: { lifts, gymnastics, conditioning, benchmarks, open, bodyweight }
// The reference populations are lifetime bests (CrossFit profile stats,
// Concept2 season bests), so each benchmark uses your BEST logged result,
// however old: the best single or Epley e1RM for lifts, the most reps, the
// fastest Rx time. A best older than 12 months is flagged stale, and the best
// of the last 12 months (60 days for lifts) is given alongside as `recent`.
// Easy sets (logged RPE 1-6 with more than one rep) aren't max efforts and
// don't count as e1RM estimates.
function computePercentiles(rows, today, strength) {
  const t = dayNum(today);
  const ageDays = (d) => t - dayNum(ymd(d));
  const results = [];
  const bwRows = (rows.bodyweight || []);
  const bwEnd = new Date(`${today}T23:59:59Z`);
  let bw = strength ? strength.windowedAvgBodyweight(bwRows, new Date(bwEnd.getTime() - 60 * 86400e3), bwEnd) : null;
  if (bw == null && bwRows.length) bw = Number(bwRows[bwRows.length - 1].weight_lb);

  for (const BM of BENCHMARKS) {
    // Strict pull-ups: the standard for his bodyweight (it moves a rep or so between 150 and 180 lb).
    const bm = BM.id === 'pullups_strict' ? (() => { const tiers = pullupTiers(bw); return { ...BM, tiers, anchors: tiers.map((v, i) => [v, [5, 20, 50, 80, 95][i]]) }; })() : BM;
    const src = bm.source;
    const candidates = []; // { value, date, detail }
    if (src.lift) {
      const want = canon(src.lift);
      for (const l of rows.lifts || []) {
        if (canon(l.lift) !== want) continue;
        const load = Number(l.load_lb); const reps = Number(l.reps); const rpe = Number(l.rpe);
        if (!(load > 0) || !(reps >= 1)) continue;
        if (reps > 1 && rpe >= 1 && rpe <= 6) continue;
        // A single is a real 1RM — Epley would add 3.3% to it. Reps > 1 are estimated.
        const e = reps === 1 ? load : load * (1 + reps / 30);
        candidates.push({ value: e, date: ymd(l.entry_date), detail: reps === 1 ? `${load} lb single` : `e1RM from ${load} × ${reps}` });
      }
    }
    if (src.gym) {
      const names = src.gym.map(canon);
      for (const g of rows.gymnastics || []) {
        if (!names.includes(canon(g.movement))) continue;
        const v = Number(g.reps);
        if (v > 0) candidates.push({ value: v, date: ymd(g.entry_date), detail: g.movement });
      }
      // Bodyweight sets logged as lifts (load 0, e.g. "Pull-up" 0 × 7).
      for (const l of rows.lifts || []) {
        if (!names.includes(canon(l.lift)) || Number(l.load_lb) !== 0) continue;
        const v = Number(l.reps);
        if (v > 0) candidates.push({ value: v, date: ymd(l.entry_date), detail: l.lift });
      }
    }
    if (src.bench) {
      const names = src.bench.map(canon);
      for (const b of rows.benchmarks || []) {
        if (b.rx === false) continue; // percentiles are Rx
        for (const e of benchmarkEntries(b)) {
          if (!names.includes(canon(e.name))) continue;
          const v = parseResult(e.result);
          if (v == null || v <= 0) continue;
          candidates.push({ value: v, date: ymd(b.entry_date), detail: 'benchmark log' });
          break;
        }
      }
    }
    if (src.cond) {
      const want = canon(src.cond.movement);
      for (const c of rows.conditioning || []) {
        if (canon(c.movement) !== want || c.distance_m == null || c.duration_seconds == null) continue;
        if (Math.abs(Number(c.distance_m) - src.cond.meters) > src.cond.meters * 0.01) continue;
        const v = Number(c.duration_seconds);
        if (v > 0) candidates.push({ value: v, date: ymd(c.entry_date), detail: 'conditioning log' });
      }
    }
    const pick = (list) => list.reduce((a, c) => (a == null || (bm.better === 'high' ? c.value > a.value : c.value < a.value) ? c : a), null);
    const valid = candidates.filter((c) => ageDays(c.date) >= 0); // nothing logged after "today"
    const best = pick(valid);
    if (best) best.stale = ageDays(best.date) > YEAR;
    const recentDays = src.lift ? LIFT_WINDOW_DAYS : YEAR;
    const recentBest = pick(valid.filter((c) => ageDays(c.date) <= recentDays));
    const pct = best ? percentileOf(bm, best.value) : null;
    const row = {
      id: bm.id, label: bm.label, category: bm.category, unit: bm.unit, better: bm.better,
      value: best ? Math.round(best.value * 10) / 10 : null, display: best ? fmt(bm, best.value) : null,
      date: best ? best.date : null, detail: best ? best.detail : null, stale: !!(best && best.stale),
      percentile: pct, median: fmt(bm, bm.anchors.find((a) => a[1] === 50)[0]),
      reference: REFS[bm.ref].label, reference_url: REFS[bm.ref].url, note: bm.note || null,
      // Your best of the last 12 months (60 days for lifts) when it isn't the headline best.
      recent: recentBest && recentBest !== best ? {
        value: Math.round(recentBest.value * 10) / 10, display: fmt(bm, recentBest.value), date: recentBest.date,
        detail: recentBest.detail, percentile: percentileOf(bm, recentBest.value), window_days: recentDays,
      } : null,
    };
    // Alongside: the bodyweight-ratio level for lifts (same maths as the Health tab).
    if (src.lift && best && strength) {
      const tiers = strength.standardsFor(src.lift);
      if (tiers && bw) {
        const score = strength.levelScore(best.value / bw, tiers);
        row.bodyweight_level = { ratio: Math.round((best.value / bw) * 100) / 100, score, level: strength.levelLabel(score) };
      }
    }
    // A level only where a real standard exists: lifts by bodyweight ratio, strict pull-ups by the reps standard at his
    // bodyweight, rows by Concept2's lightweight class. Runs, WODs and any-style pull-ups are against self-reported
    // CrossFit profiles that aren't weight-adjusted, so they get the percentile and no level.
    if (best) {
      if (row.bodyweight_level) row.level = { level: row.bodyweight_level.level, basis: `${row.bodyweight_level.ratio}× bodyweight` };
      else if (bm.tiers) {
        const score = strength ? strength.levelScore(best.value, bm.tiers) : null;
        row.level = { level: score != null ? strength.levelLabel(score) : levelFromPercentile(row.percentile), basis: `standard at ${Math.round(bw || 160)} lb` };
      } else if (bm.ref === 'C2_2025' && row.percentile != null) row.level = { level: levelFromPercentile(row.percentile), basis: 'lightweight men (75 kg and under)' };
    }
    results.push(row);
  }

  // Open: rank / total from the official leaderboard → exact percentile.
  const open = (rows.open || []).map((o) => {
    const rank = Number(o.rank); const total = Number(o.total);
    const pct = rank > 0 && total >= rank ? Math.max(1, Math.min(99, Math.round(((total - rank) / total) * 100))) : null;
    return { id: o.id, year: o.year, workout: o.workout, division: o.division, rank, total, score: o.score, percentile: pct };
  }).sort((a, b) => (b.year - a.year) || (a.workout === 'overall' ? -1 : b.workout === 'overall' ? 1 : String(a.workout).localeCompare(String(b.workout))));

  const categories = CATEGORIES.map((cat) => {
    if (cat === 'Open') {
      const overall = open.find((o) => o.workout === 'overall' && o.percentile != null);
      return { category: cat, percentile: overall ? overall.percentile : null, basis: overall ? `${overall.year} Open overall, ${overall.division}` : null, count: overall ? 1 : 0 };
    }
    const have = results.filter((r) => r.category === cat && r.percentile != null);
    return {
      category: cat,
      percentile: have.length ? Math.round(have.reduce((s, r) => s + r.percentile, 0) / have.length) : null,
      basis: have.map((r) => r.label).join(', ') || null,
      count: have.length,
    };
  });

  return { as_of: today, categories, benchmarks: results, open, calisthenics_note: 'Strict pull-ups are judged against lifters at your bodyweight; any-style pull-ups against self-reported CrossFit profiles, a pool that skews well above a typical box. HSPU, toes-to-bar, muscle-ups and handstand walk have no population data yet.' };
}

module.exports = { pullupTiers, levelFromPercentile, BENCHMARKS, CATEGORIES, REFS, percentileOf, parseResult, computePercentiles, normCdf, normInv, canon, benchmarkEntries };
