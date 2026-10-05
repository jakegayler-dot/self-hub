// Sentinel push: sends the Fitness tile summary to Sentinel.
//
//   POST {SENTINEL_URL}/v1/sources/self_hub/summary
//   Authorization: Bearer {SENTINEL_API_KEY}
//
// Triggers: ~60 s after any successful POST/PUT/DELETE under /api
// (debounced), ~30 s after boot, and every 6 h. Failures retry with backoff
// 1 → 2 → 4 … → 60 min. Pushing never blocks a request and never throws out
// of this module. If SENTINEL_URL or SENTINEL_API_KEY is unset it logs once
// and does nothing.
const strength = require('./strength');

const REGINA_OFFSET_MS = -6 * 3600 * 1000; // America/Regina: UTC−6, no DST

function reginaDate(now) {
  return new Date(now.getTime() + REGINA_OFFSET_MS).toISOString().slice(0, 10);
}

// Monday–Sunday of the current week in Regina, as YYYY-MM-DD strings.
function reginaWeek(now) {
  const local = new Date(now.getTime() + REGINA_OFFSET_MS);
  const day = local.getUTCDay();
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (day === 0 ? 6 : day - 1)));
  const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

function isoDate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// Same queries (and ordering) the Health tab loads, so the shared strength
// module sees identical input on both sides.
async function loadStrengthInputs(pool) {
  const [lifts, bodyweight, bench] = await Promise.all([
    pool.query('SELECT id, entry_date, lift, load_lb, reps, rpe FROM fitness_lifts ORDER BY entry_date ASC'),
    pool.query('SELECT id, entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC'),
    pool.query('SELECT lift FROM fitness_benchmark_lifts ORDER BY lift ASC'),
  ]);
  return { lifts: lifts.rows, bodyweight: bodyweight.rows, benchmarkLifts: bench.rows.map((r) => r.lift) };
}

// Pure: turns the strength profile + week counts into Sentinel's shape.
// Latest weigh-in (with the change over ~30 days) and the latest measurement set.
const MEASURE_FIELDS = ['arm_length', 'bust', 'shoulder', 'length', 'waist', 'seat_hips', 'neck', 'sleeve', 'inseam_low', 'inseam_high'];
function summarizeBody(bodyweight, measurements, now) {
  const num = (v) => (v == null ? null : Number(v));
  const last = bodyweight[bodyweight.length - 1];
  let change30 = null;
  if (last) {
    const cutoff = new Date(now.getTime() - 30 * 86400e3).toISOString().slice(0, 10);
    const before = [...bodyweight].reverse().find((r) => isoDate(r.entry_date) <= cutoff);
    if (before) change30 = Math.round((Number(last.weight_lb) - Number(before.weight_lb)) * 10) / 10;
  }
  const m = measurements[measurements.length - 1];
  return {
    weight_lb: last ? num(last.weight_lb) : null,
    body_fat_pct: last ? num(last.body_fat_pct) : null,
    weighed_on: last ? isoDate(last.entry_date) : null,
    weight_change_30d_lb: change30,
    measurements: m
      ? { as_of: isoDate(m.entry_date), inches: Object.fromEntries(MEASURE_FIELDS.filter((f) => m[f] != null).map((f) => [f, num(m[f])])) }
      : null,
  };
}

function summarize({ data, profileRow, sessionsDone, now, measurements = [] }) {
  const p = strength.computeStrengthProfile(data, now);
  // A pattern with no scored lift (only possible with no bodyweight at all)
  // has a NaN score on the page; leave it out here.
  const byPattern = p.patterns.filter((c) => Number.isFinite(c.score)).map((c) => ({ pattern: c.pattern, score: c.score, level: c.level }));
  // The Health tab shows no single overall number, only per-pattern cards,
  // so overall = mean of the (rounded) pattern scores shown on those cards.
  const overall = byPattern.length
    ? Math.round(byPattern.reduce((s, c) => s + c.score, 0) / byPattern.length)
    : null;
  const lifts = p.rows
    .filter((r) => r.score != null)
    .map((r) => ({ lift: r.lift, e1rm_lb: r.e1rm, ratio: Math.round(r.ratio * 100) / 100, score: r.score, level: r.level }));

  const needs = [];
  if (!data.bodyweight.length) {
    needs.push({
      text: "No bodyweight logged — strength can't be scored",
      detail: 'Strength is e1RM ÷ bodyweight. Log a weigh-in in Self Hub (Log tab).',
    });
  } else if (!p.bwFromWindow) {
    const last = data.bodyweight[data.bodyweight.length - 1];
    needs.push({
      text: 'No bodyweight logged in 2 months',
      detail: `Strength is using your last weigh-in (${Number(last.weight_lb)} lb on ${isoDate(last.entry_date)}). Log a fresh one so the score reflects today.`,
    });
  }
  if (data.bodyweight.length && !lifts.length) {
    needs.push({
      text: "No benchmark lifts logged in 2 months — strength can't be scored",
      detail: 'Only benchmark lifts logged in the last 2 months count. Log a top set of a main lift (e.g. Back Squat, Deadlift, Strict Press).',
    });
  }

  const goal = profileRow && profileRow.weekly_strength_sessions_goal != null
    ? Number(profileRow.weekly_strength_sessions_goal) : null;

  return {
    generated_at: now.toISOString(),
    summary: {
      strength: {
        overall_score: overall,
        level: overall != null ? strength.levelLabel(overall) : null,
        by_pattern: byPattern,
        lifts,
        bodyweight_avg_lb: p.avgBW != null ? Math.round(p.avgBW * 10) / 10 : null,
        window: '2 months',
        as_of: reginaDate(now),
      },
      training_week: { sessions_done: sessionsDone, sessions_goal: goal },
      body: summarizeBody(data.bodyweight, measurements, now),
      needs_input: needs,
    },
  };
}

async function buildSummary(pool, now = new Date()) {
  const data = await loadStrengthInputs(pool);
  const profileRow = (await pool.query('SELECT weekly_strength_sessions_goal FROM fitness_profile WHERE id = 1')).rows[0];
  // Strength sessions = distinct days with a lift logged, Mon–Sun in Regina
  // (same definition the weekly-load panel uses, but on Regina's calendar).
  const wk = reginaWeek(now);
  const days = new Set(data.lifts
    .map((l) => isoDate(l.entry_date))
    .filter((d) => d >= wk.start && d <= wk.end));
  const measurements = (await pool.query('SELECT * FROM fitness_measurements ORDER BY entry_date ASC, id ASC')).rows;
  return summarize({ data, profileRow, sessionsDone: days.size, now, measurements });
}

function createSentinelPusher({
  pool,
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  logger = console,
  build = () => buildSummary(pool),
  debounceMs = 60 * 1000,
  maxWaitMs = 5 * 60 * 1000, // a steady stream of writes still pushes at least every 5 min
  bootDelayMs = 30 * 1000,
  intervalMs = 6 * 3600 * 1000,
  backoffMinMs = 60 * 1000,
  backoffMaxMs = 60 * 60 * 1000,
  timeoutMs = 15 * 1000,
} = {}) {
  const baseUrl = (env.SENTINEL_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (env.SENTINEL_API_KEY || '').trim();
  const enabled = Boolean(baseUrl && apiKey);
  const state = { timer: null, interval: null, running: false, rerun: false, pendingSince: null, failures: 0, retryAt: 0, lastSuccessAt: null, lastError: null };
  let warned = false;

  function warnDisabled() {
    if (warned) return;
    warned = true;
    logger.log('Sentinel push disabled: set SENTINEL_URL and SENTINEL_API_KEY to enable it.');
  }

  function arm(at) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(run, Math.max(0, at - Date.now()));
    if (state.timer.unref) state.timer.unref();
  }

  async function pushOnce() {
    const body = await build();
    const res = await fetchImpl(`${baseUrl}/v1/sources/self_hub/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
  }

  async function run() {
    state.timer = null;
    state.pendingSince = null;
    if (state.running) { state.rerun = true; return; }
    state.running = true;
    try {
      await pushOnce();
      if (state.failures) logger.log(`Sentinel push recovered after ${state.failures} failure(s).`);
      state.failures = 0;
      state.retryAt = 0;
      state.lastError = null;
      state.lastSuccessAt = new Date();
    } catch (err) {
      state.failures += 1;
      const wait = Math.min(backoffMaxMs, backoffMinMs * 2 ** (state.failures - 1));
      state.retryAt = Date.now() + wait;
      state.lastError = err && err.message;
      logger.error(`Sentinel push failed (${state.lastError}); retrying in ${Math.round(wait / 1000)} s.`);
      arm(state.retryAt);
    } finally {
      state.running = false;
      if (state.rerun) {
        state.rerun = false;
        arm(Math.max(Date.now(), state.retryAt));
      }
    }
  }

  // Called after every successful write under /api.
  function notifyWrite() {
    if (!enabled) { warnDisabled(); return; }
    try {
      const now = Date.now();
      if (state.pendingSince == null) state.pendingSince = now;
      const at = Math.max(Math.min(now + debounceMs, state.pendingSince + maxWaitMs), state.retryAt);
      arm(at);
    } catch (err) {
      logger.error('Sentinel push scheduling failed:', err && err.message);
    }
  }

  function start() {
    if (!enabled) { warnDisabled(); return; }
    logger.log(`Sentinel push enabled → ${baseUrl}`);
    arm(Date.now() + bootDelayMs);
    state.interval = setInterval(() => {
      if (!state.timer) arm(Math.max(Date.now(), state.retryAt));
    }, intervalMs);
    if (state.interval.unref) state.interval.unref();
  }

  function stop() {
    if (state.timer) clearTimeout(state.timer);
    if (state.interval) clearInterval(state.interval);
    state.timer = null; state.interval = null;
  }

  // Express middleware: schedule a push after successful POST/PUT/DELETE.
  function middleware(req, res, next) {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) notifyWrite();
      });
    }
    next();
  }

  return { enabled, state, start, stop, notifyWrite, middleware, run };
}

module.exports = { buildSummary, summarize, createSentinelPusher, reginaDate, reginaWeek, loadStrengthInputs };
