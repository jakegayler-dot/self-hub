'use strict';
// The physique, measured (Jake, 2026-11-03: "Self Hub already has the right physique in mind but it isn't tracking it
// very well"). One place for the target and for how far there is to go, so the Health tab, the figure, the trainer,
// the nutritionist and Sentinel all see the same thing.
//
// The target is "Daniel Craig in Casino Royale" in numbers at Jake's height (fitness_profile.physique_targets, set in
// 023 and his to change). For each measurement: the latest value he's logged (each on its own: an entry with only
// calf and arm doesn't blank the rest), the gap, which way it has to go, the trend over the last four months, and when
// it gets there at that pace. Shoulders are measured all the way round (shoulder_circ), so shoulder:waist compares
// circumference with circumference.

const DAY = 86400000;
const DEFAULT_TARGETS = { weight_lb: 165, body_fat_pct: 10, bust: 42, waist: 31, shoulder_circ: 48, upper_arm: 15.5, neck: 15.5, thigh: 22.5, calf: 15 };
// What each is, how it's measured, and which way is better (waist and body fat come down; the rest go up).
const METRICS = {
  weight_lb: { label: 'Bodyweight', unit: 'lb', how: 'morning, after the bathroom, before food', down: false },
  body_fat_pct: { label: 'Body fat', unit: '%', how: 'the same method each time', down: true },
  shoulder_circ: { label: 'Shoulders', unit: 'in', how: 'all the way round at the widest point, arms relaxed', down: false },
  bust: { label: 'Chest', unit: 'in', how: 'round the nipple line, after breathing out', down: false },
  waist: { label: 'Waist', unit: 'in', how: 'round the navel, relaxed', down: true },
  upper_arm: { label: 'Arm', unit: 'in', how: 'flexed, at the peak', down: false },
  neck: { label: 'Neck', unit: 'in', how: 'just below the Adam\'s apple', down: false },
  thigh: { label: 'Thigh', unit: 'in', how: 'mid-thigh, relaxed', down: false },
  calf: { label: 'Calf', unit: 'in', how: 'the widest point', down: false },
};
const TAPE = ['shoulder_circ', 'bust', 'waist', 'upper_arm', 'neck', 'thigh', 'calf'];
const STALE_DAYS = 35;
const TREND_DAYS = 120;

const ymd = (d) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(d).slice(0, 10));
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function targetsOf(profile) {
  const t = profile && profile.physique_targets && typeof profile.physique_targets === 'object' ? profile.physique_targets : {};
  const out = { ...DEFAULT_TARGETS };
  for (const k of Object.keys(DEFAULT_TARGETS)) if (num(t[k]) != null) out[k] = num(t[k]);
  return out;
}

/** The series for one metric, oldest first: [{ date, value }]. */
function seriesOf(key, measurements, bodyweight) {
  const rows = key === 'weight_lb' ? (bodyweight || []).map((r) => ({ date: ymd(r.entry_date), value: num(r.weight_lb) }))
    : key === 'body_fat_pct' ? (bodyweight || []).map((r) => ({ date: ymd(r.entry_date), value: num(r.body_fat_pct) }))
      : (measurements || []).map((r) => ({ date: ymd(r.entry_date), value: num(r[key]) }));
  return rows.filter((r) => r.value != null).sort((a, b) => a.date.localeCompare(b.date));
}

/** Least-squares change per 30 days over the last TREND_DAYS (null without enough readings far enough apart).
 *  Bodyweight and body fat swing 2 lb or a few points day to day, so they need four readings over three weeks before
 *  there's a trend (Nov 3: two weigh-ins and a 2 lb dip three days later read as "losing 0.6 lb a month"). */
function trendPer30(series, today, { min = 2, spanDays = 14 } = {}) {
  const from = ymd(new Date(Date.parse(`${today}T12:00:00Z`) - TREND_DAYS * DAY));
  const pts = series.filter((p) => p.date >= from).map((p) => ({ x: Date.parse(`${p.date}T12:00:00Z`) / DAY, y: p.value }));
  if (pts.length < min || !pts.length || pts[pts.length - 1].x - pts[0].x < spanDays) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const den = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den ? (pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den) * 30 : null;
}

/** Everything about the physique against the target. today: YYYY-MM-DD (Regina). */
function physiqueStatus({ profile, measurements, bodyweight, today }) {
  const targets = targetsOf(profile);
  const metrics = {};
  for (const [key, def] of Object.entries(METRICS)) {
    const s = seriesOf(key, measurements, bodyweight);
    const last = s[s.length - 1] || null;
    const first = s[0] || null;
    const target = targets[key];
    const current = last ? last.value : null;
    const gap = current == null || target == null ? null : r1(target - current); // + = still to add, - = still to lose
    const reached = current != null && target != null && (def.down ? current <= target : current >= target);
    const trend = trendPer30(s, today, key === 'weight_lb' || key === 'body_fat_pct' ? { min: 4, spanDays: 21 } : undefined);
    // Moving the right way: months to the target at that pace (capped at five years: past that it's "not at this pace").
    const helping = trend != null && gap != null && !reached && Math.sign(trend) === Math.sign(gap) && Math.abs(trend) > 0.01;
    const months = helping ? Math.abs(gap) / Math.abs(trend) : null;
    const eta = months != null && months <= 60 ? ymd(new Date(Date.parse(`${today}T12:00:00Z`) + months * 30.4 * DAY)) : null;
    // How far along, from the first reading to the target.
    const span = first && target != null ? target - first.value : null;
    const progress = span && current != null ? Math.max(0, Math.min(1, (current - first.value) / span)) : reached ? 1 : null;
    const age = last ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${last.date}T12:00:00Z`)) / DAY) : null;
    metrics[key] = {
      key, label: def.label, unit: def.unit, how: def.how, lower_is_better: def.down,
      current: r1(current), measured_on: last ? last.date : null, target, gap, reached,
      trend_per_30d: r1(trend), on_track: helping || reached, eta, progress: progress == null ? null : Math.round(progress * 100) / 100,
      readings: s.length, stale: age == null || age > STALE_DAYS,
    };
  }
  const ratio = (a, b) => (metrics[a].current && metrics[b].current ? Math.round((metrics[a].current / metrics[b].current) * 100) / 100 : null);
  const ratios = {
    shoulder_to_waist: { current: ratio('shoulder_circ', 'waist'), target: Math.round((targets.shoulder_circ / targets.waist) * 100) / 100, label: 'Shoulders : waist' },
    chest_to_waist: { current: ratio('bust', 'waist'), target: Math.round((targets.bust / targets.waist) * 100) / 100, label: 'Chest : waist' },
  };
  // Lean mass at the current weight and body fat, and what the target needs.
  const w = metrics.weight_lb.current, bf = metrics.body_fat_pct.current;
  const lean = w != null && bf != null ? r1(w * (1 - bf / 100)) : null;
  const leanTarget = r1(targets.weight_lb * (1 - targets.body_fat_pct / 100));
  // Biggest gaps first, as a share of where they started (so an inch on the arm counts more than an inch on the chest).
  const gaps = TAPE.map((k) => metrics[k]).filter((m) => m.current != null && !m.reached && m.target)
    .map((m) => ({ key: m.key, label: m.label, gap: m.gap, share: Math.abs(m.gap) / m.target }))
    .sort((a, b) => b.share - a.share);
  const due = TAPE.filter((k) => metrics[k].stale);
  return {
    target_words: (profile && profile.physique_target) || 'Daniel Craig in Casino Royale: lean, athletic, solid all over.',
    targets, metrics, ratios, lean_mass_lb: lean, lean_mass_target_lb: leanTarget, lean_to_add_lb: lean != null ? r1(leanTarget - lean) : null,
    biggest_gaps: gaps.slice(0, 4), measure_due: due, measured: TAPE.filter((k) => metrics[k].current != null).length,
  };
}

/** The same thing in a few lines, for the trainer's and nutritionist's prompts. */
function physiqueBrief(st) {
  const m = st.metrics;
  const f = (k) => (m[k].current == null ? `${m[k].label} not measured (target ${m[k].target}${m[k].unit === 'in' ? '"' : ` ${m[k].unit}`})`
    : `${m[k].label} ${m[k].current}${m[k].unit === 'in' ? '"' : m[k].unit === '%' ? '%' : ` ${m[k].unit}`} → ${m[k].target}${m[k].unit === 'in' ? '"' : m[k].unit === '%' ? '%' : ` ${m[k].unit}`}${m[k].reached ? ' (there)' : ''}`);
  return [
    `Physique target: ${st.target_words} In numbers for him: ${st.targets.weight_lb} lb at ${st.targets.body_fat_pct}% body fat (about ${st.lean_mass_target_lb} lb lean), chest ${st.targets.bust}", waist ${st.targets.waist}" or less, shoulders ${st.targets.shoulder_circ}" around (shoulders:waist ${st.ratios.shoulder_to_waist.target}), arm ${st.targets.upper_arm}", neck ${st.targets.neck}", thigh ${st.targets.thigh}", calf ${st.targets.calf}".`,
    `Now: ${['weight_lb', 'body_fat_pct', 'shoulder_circ', 'bust', 'waist', 'upper_arm', 'neck', 'thigh', 'calf'].map(f).join('; ')}.${st.lean_to_add_lb != null ? ` About ${st.lean_to_add_lb} lb of lean mass to add.` : ''}`,
    st.biggest_gaps.length ? `Biggest gaps, most first: ${st.biggest_gaps.map((g) => `${g.label} ${g.gap > 0 ? '+' : ''}${g.gap}"`).join(', ')}.` : '',
    st.measure_due.length ? `Not measured in the last five weeks: ${st.measure_due.map((k) => m[k].label.toLowerCase()).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

/** The latest value of each tape measurement on its own (an entry with only some fields doesn't blank the rest). */
function latestEach(measurements, fields) {
  const out = {};
  for (const r of [...(measurements || [])].sort((a, b) => ymd(a.entry_date).localeCompare(ymd(b.entry_date)))) {
    for (const k of fields) if (num(r[k]) != null) out[k] = num(r[k]);
  }
  return out;
}

/** The status straight from the database (for the coaches' prompts and Sentinel's summary). */
async function loadStatus(pool, today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10)) {
  const [p, m, b] = await Promise.all([
    pool.query('SELECT * FROM fitness_profile WHERE id = 1'),
    pool.query('SELECT * FROM fitness_measurements ORDER BY entry_date ASC, id ASC'),
    pool.query('SELECT entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC, id ASC'),
  ]);
  return physiqueStatus({ profile: p.rows[0] || {}, measurements: m.rows, bodyweight: b.rows, today });
}

module.exports = { loadStatus, DEFAULT_TARGETS, METRICS, TAPE, physiqueStatus, physiqueBrief, targetsOf, latestEach, trendPer30, seriesOf };
