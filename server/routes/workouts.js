// Workout generator routes (mounted under /api/fitness).
//
//   GET    /workout-options                 equipment list, presets, foci, minutes, machines
//   GET    /workouts?from=&to=              saved workouts (newest first)
//   GET    /workouts/:id
//   POST   /workouts/generate               { date, minutes, focus, equipment, engine_modality }
//   POST   /workouts/generate-week          { start_date, days, minutes, focus, equipment, engine_modality }
//   POST   /workouts/:id/regenerate         same inputs, new seed (only before anything is logged)
//   PUT    /workouts/:id/status             { status: planned | done | skipped }
//   DELETE /workouts/:id                    removes the plan; anything already logged stays logged
//
//   One-tap logging — writes into the same tables the Log tab does:
//   POST   /workouts/:id/log                { block_id, item_id, set_index, reps?, load_lb?, output? }
//   POST   /workouts/:id/unlog              { block_id, item_id, set_index }
//   POST   /workouts/:id/metcon             { block_id, result, duration_s? }
//   DELETE /workouts/:id/metcon/:blockId
//
//   The coached week (Sentinel's trainer, called directly — lib/coach.js):
//   POST   /workouts/plan-week              { start_date, days: 4-6, minutes, equipment, engine_modality, note? }
//   POST   /workouts/review-week            { start_date }  → review, adjust the days not started, rank weak points
//   GET    /workouts/week?start=            the week's plan and latest review
//
//   Sentinel refinement:
//   POST   /workouts/:id/refine             { note? }  → refined now by Sentinel's trainer (about a minute)
//   DELETE /workouts/:id/refine             cancel a pending request
//   GET    /workouts/refine-queue           pending requests + full context + response schema
//   PUT    /workouts/:id/refined            { body, notes }  ← Sentinel's write-back
//   POST   /workouts/:id/revert             back to the rules version
//
//   Engine (Gains Lab-style baselines):
//   GET    /engine                          baselines per machine + test history
//   POST   /engine-tests                    { entry_date, modality, test, output, intervals?, notes? }
//   DELETE /engine-tests/:id
const express = require('express');
const strength = require('../lib/strength');
const gen = require('../lib/workoutGen');
const engine = require('../lib/engine');
const { EQUIPMENT, EQUIPMENT_PRESETS, MOVEMENTS, BY_NAME } = require('../lib/movements');
const coach = require('../lib/coach');
const ledger = require('../lib/ledger');
const volume = require('../lib/volume');

const { ymd, mondayOfStr, addDaysStr } = gen;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const MEASUREMENT_FIELDS = ['arm_length', 'bust', 'shoulder', 'length', 'waist', 'seat_hips', 'neck', 'sleeve', 'inseam_low', 'inseam_high', 'thigh', 'calf', 'upper_arm'];

// Trainer errors carry their own status (503 not connected, 429 budget, 502 Sentinel); everything else is a 500.
function coachFail(res, err) {
  if (err && err.status && err.status < 600) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'server error' });
}

function createWorkoutsRouter({ pool }) {
  const router = express.Router();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  // Every handler that reads a workout body, changes it and writes it back
  // runs one-at-a-time per workout, so two quick taps can't overwrite each
  // other (and leave a logged row the workout no longer knows about). Self
  // Hub runs as a single Node process, so an in-process queue is enough.
  const locks = new Map();
  function withLock(id, fn) {
    const key = String(id);
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }
  const locked = (handler) => (req, res) => withLock(req.params.id, () => handler(req, res));

  function shape(r) {
    if (!r) return null;
    const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    return {
      id: r.id, date: ymd(r.workout_date), title: r.title, focus: r.focus, minutes: Number(r.minutes),
      status: r.status, source: r.source, seed: Number(r.seed),
      inputs: typeof r.inputs === 'string' ? JSON.parse(r.inputs) : r.inputs,
      body, has_rules_version: r.rules_body != null,
      refine: { status: r.refine_status, request: r.refine_request, requested_at: r.refine_requested_at, notes: r.refine_notes, refined_at: r.refined_at },
      meta: r.meta == null ? null : (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta),
      progress: progressOf(body),
      volume: { planned: volume.sessionVolume(body), logged: volume.sessionVolume(body, { logged: true }) },
      // What he logged for the session as a whole; load = session RPE × minutes (the usual training-load unit).
      session: {
        minutes: r.actual_minutes == null ? null : Number(r.actual_minutes),
        rpe: r.session_rpe == null ? null : Number(r.session_rpe),
        notes: r.session_notes || null,
        load: r.actual_minutes != null && r.session_rpe != null ? Math.round(Number(r.actual_minutes) * Number(r.session_rpe)) : null,
      },
    };
  }
  function progressOf(body) {
    let total = 0; let done = 0;
    for (const b of body.blocks || []) {
      if (b.kind === 'metcon') { total++; if (b.result) done++; continue; }
      for (const it of b.items || []) {
        if (it.log_as === 'none') continue;
        for (const s of it.sets || []) { total++; if (s.entry) done++; }
      }
    }
    return { done, total };
  }
  const anyLogged = (body) => progressOf(body).done > 0;

  async function getRow(id) {
    if (!/^\d+$/.test(String(id))) return null;
    const rows = await q('SELECT * FROM fitness_workouts WHERE id = $1', [Number(id)]);
    return rows[0] || null;
  }
  async function saveBody(id, body, extra = {}) {
    const p = progressOf(body);
    let status = extra.status;
    if (!status) {
      // Skipped and manually-done stay put; otherwise done once everything is logged.
      const cur = (await getRow(id)).status;
      status = cur === 'skipped' || cur === 'done' ? cur : (p.total && p.done === p.total ? 'done' : 'planned');
    }
    await pool.query('UPDATE fitness_workouts SET body = $1::jsonb, status = $2, updated_at = now() WHERE id = $3', [JSON.stringify(body), status, Number(id)]);
    return shape(await getRow(id));
  }

  // Everything the generator scores against, read fresh from the database.
  async function loadGenRows(date, excludeId = null) {
    const [lifts, gymnastics, bodyweight, bench, tests, workouts] = await Promise.all([
      q('SELECT entry_date, lift, load_lb, reps, rpe FROM fitness_lifts ORDER BY entry_date ASC'),
      q('SELECT entry_date, movement, reps FROM fitness_gymnastics ORDER BY entry_date ASC'),
      q('SELECT entry_date, weight_lb FROM fitness_bodyweight ORDER BY entry_date ASC'),
      q('SELECT lift FROM fitness_benchmark_lifts'),
      q('SELECT entry_date, modality, test, output, intervals FROM fitness_engine_tests ORDER BY entry_date ASC'),
      q("SELECT id, workout_date, status, body FROM fitness_workouts WHERE status <> 'skipped'"),
    ]);
    const profile = strength.computeStrengthProfile({ lifts, bodyweight, benchmarkLifts: bench.map((r) => r.lift) }, new Date(`${date}T23:59:59Z`));
    const strengthPatterns = {};
    profile.patterns.forEach((p) => { if (Number.isFinite(p.score)) strengthPatterns[p.pattern] = p.score; });
    const ws = mondayOfStr(date);
    const lo = addDaysStr(ws, -3); const hi = addDaysStr(ws, 9);
    const hist = addDaysStr(date, -120);
    const plannedOther = []; const engineHistory = [];
    for (const w of workouts) {
      if (excludeId != null && Number(w.id) === Number(excludeId)) continue;
      const d = ymd(w.workout_date);
      const body = typeof w.body === 'string' ? JSON.parse(w.body) : w.body;
      if (w.status === 'planned' && d >= lo && d <= hi) plannedOther.push({ date: d, body });
      else if (d >= hist && d <= date) engineHistory.push({ date: d, body });
    }
    return {
      lifts, gymnastics, bodyweight, benchmarkLifts: bench.map((r) => r.lift),
      engineTests: tests.map((t) => ({ ...t, intervals: typeof t.intervals === 'string' ? JSON.parse(t.intervals) : t.intervals })),
      strengthPatterns, plannedOther, engineHistory,
    };
  }

  async function insertWorkout(body, inputs, seed) {
    const rows = await q(
      `INSERT INTO fitness_workouts (workout_date, title, focus, minutes, inputs, body, seed)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING *`,
      [body.date, body.title, body.focus, body.minutes, JSON.stringify(inputs), JSON.stringify(body), seed]
    );
    return shape(rows[0]);
  }

  const fail = (res, err) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('workouts route failed:', err);
    return res.status(500).json({ error: 'failed' });
  };

  // ---- options ----
  router.get('/workout-options', (req, res) => {
    res.json({
      equipment: EQUIPMENT,
      presets: EQUIPMENT_PRESETS,
      foci: gen.FOCI.map((f) => ({ id: f, label: gen.FOCUS_LABEL[f] })),
      minutes: gen.MINUTES,
      machines: Object.entries(engine.MODALITIES).map(([id, m]) => ({ id, label: m.name, unit: m.unit })),
      tests: Object.entries(engine.TESTS).map(([id, t]) => ({ id, label: t.label, instructions: t.instructions })),
    });
  });

  // ---- generate ----
  router.post('/workouts/generate', async (req, res) => {
    try {
      const { inputs, errors } = gen.normalizeInputs(req.body || {});
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      const seed = Number.isFinite(Number(req.body.seed)) ? Number(req.body.seed) : Math.floor(Math.random() * 1e6);
      const rows = await loadGenRows(inputs.date);
      const body = gen.generateSession(rows, inputs, seed);
      res.status(201).json(await insertWorkout(body, inputs, seed));
    } catch (err) { fail(res, err); }
  });

  router.post('/workouts/generate-week', async (req, res) => {
    try {
      const raw = req.body || {};
      const start = raw.start_date || raw.date;
      const { inputs, errors } = gen.normalizeInputs({ ...raw, date: start });
      if (errors.length) return res.status(400).json({ error: errors.join('; ').replace('date', 'start_date') });
      const days = Math.max(1, Math.min(7, Math.round(Number(raw.days) || 4)));
      const end = addDaysStr(inputs.date, 6);
      // Replace untouched planned workouts in the window (nothing logged, no
      // pending or finished Sentinel refinement) so regenerating a week
      // doesn't stack plans or throw away the agent's work.
      const existing = await q("SELECT * FROM fitness_workouts WHERE status = 'planned' AND workout_date >= $1 AND workout_date <= $2", [inputs.date, end]);
      const kept = [];
      for (const r of existing) {
        const w = shape(r);
        if (!anyLogged(w.body) && w.refine.status !== 'pending' && w.source !== 'sentinel') await pool.query('DELETE FROM fitness_workouts WHERE id = $1', [w.id]);
        else kept.push(w.id);
      }
      const seed = Number.isFinite(Number(raw.seed)) ? Number(raw.seed) : Math.floor(Math.random() * 1e6);
      const rows = await loadGenRows(inputs.date);
      const bodies = gen.generateWeek(rows, { ...inputs, start_date: inputs.date, days }, seed);
      const out = [];
      for (let i = 0; i < bodies.length; i++) {
        out.push(await insertWorkout(bodies[i], { ...inputs, date: bodies[i].date, focus: bodies[i].focus }, seed + i));
      }
      res.status(201).json({ workouts: out, kept_existing: kept });
    } catch (err) { fail(res, err); }
  });

  router.post('/workouts/:id/regenerate', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      if (anyLogged(w.body)) return res.status(409).json({ error: 'sets are already logged on this workout — unlog them first, or generate a new one' });
      const seed = w.seed + 1;
      const rows = await loadGenRows(w.date, w.id);
      const body = gen.generateSession(rows, { ...w.inputs, date: w.date }, seed);
      await pool.query(
        `UPDATE fitness_workouts SET title = $1, focus = $2, minutes = $3, body = $4::jsonb, rules_body = NULL, seed = $5,
           source = 'rules', refine_status = 'none', refine_request = NULL, refine_notes = NULL, refined_at = NULL, status = 'planned', updated_at = now()
         WHERE id = $6`,
        [body.title, body.focus, body.minutes, JSON.stringify(body), seed, w.id]
      );
      res.json(shape(await getRow(w.id)));
    } catch (err) { fail(res, err); }
  }));

  // ---- read / status / delete ----

  // ---- The data ledger: tests due, measurements missing, facts unknown (lib/ledger.js) ----
  async function ledgerFor(date) {
    const profile = (await q('SELECT * FROM fitness_profile WHERE id = 1'))[0] || {};
    const [tests, benchmarks, lifts, mrows, bf] = await Promise.all([
      q('SELECT entry_date, test, value, unit, notes FROM fitness_tests WHERE entry_date <= $1', [date]),
      q('SELECT entry_date, name, result, rx FROM fitness_benchmarks WHERE entry_date <= $1', [date]),
      q('SELECT lift, MAX(entry_date) AS entry_date FROM fitness_lifts WHERE entry_date <= $1 GROUP BY lift', [date]),
      q(`SELECT entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements WHERE entry_date <= $1 ORDER BY entry_date DESC`, [date]),
      q('SELECT entry_date, body_fat_pct FROM fitness_bodyweight WHERE body_fat_pct IS NOT NULL AND entry_date <= $1 ORDER BY entry_date DESC LIMIT 1', [date]),
    ]);
    // Engine: retests on the machines he tests on; one full baseline when there's none at all.
    const rows = await loadGenRows(date);
    const base = Object.values(gen.makeContext(rows, date).baselines || {});
    const tested = base.filter((b) => b.tt10 || b.sprint60 || b.repeat);
    const engineDue = tested.length
      ? tested.flatMap((b) => (b.testsDue || []).map((t) => ({ machine: b.name, test: t, reason: 'missing or older than 8 weeks' })))
      : [{ machine: 'one machine (rower, bike or ski)', test: 'tt10, sprint60 and repeat (over two sessions)', reason: 'no engine baseline at all' }];
    // Latest value of each measurement (not every entry has every field), with its own date.
    const measurements = {};
    for (const f of ['thigh', 'calf', 'upper_arm', 'waist']) {
      const r = mrows.find((x) => x[f] != null);
      if (r) measurements[f] = { value: Number(r[f]), date: ymd(r.entry_date) };
    }
    const out = ledger.computeLedger({ profile, tests, benchmarks, lifts, measurements, bodyFat: bf[0], engineDue }, date);
    const rhr = tests.filter((t) => t.test === 'resting_hr').sort((a, b) => (ymd(a.entry_date) < ymd(b.entry_date) ? 1 : -1)).slice(0, 7);
    out.resting_hr_recent = rhr.map((t) => ({ date: ymd(t.entry_date), bpm: Number(t.value) }));
    return out;
  }
  const todayStr = () => gen.ymd(new Date(Date.now() - 6 * 3600e3));
  router.ledgerFor = ledgerFor; // for the read API (Sentinel)
  router.athleteContext = (date) => athleteContext(date); // for the coach chat
  router.get('/ledger', async (req, res) => {
    try { res.json(await ledgerFor(isDate(req.query.date) ? req.query.date : todayStr())); } catch (err) { fail(res, err); }
  });
  // Snooze a measurement or question (it stops being asked until then).
  router.post('/ledger/snooze', async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '');
      if (!ledger.MEASURES[id] && !ledger.FACTS[id]) return res.status(400).json({ error: 'unknown item' });
      const days = Math.max(1, Math.min(90, Math.round(Number(req.body.days) || 30)));
      const until = addDaysStr(todayStr(), days);
      const p = (await q('SELECT ledger_snoozed FROM fitness_profile WHERE id = 1'))[0] || {};
      const sn = { ...((p.ledger_snoozed && typeof p.ledger_snoozed === 'object') ? p.ledger_snoozed : {}), [id]: until };
      await pool.query('UPDATE fitness_profile SET ledger_snoozed = $1::jsonb WHERE id = 1', [JSON.stringify(sn)]);
      res.json({ id, until });
    } catch (err) { fail(res, err); }
  });
  // Numbers he gives (the Train page's card, or Sentinel by voice): measurements, body fat, resting HR, age, gear.
  //   POST /body-data { date?, thigh?, calf?, upper_arm?, waist?, body_fat_pct?, weight_lb?, resting_hr?, age?, fins?, swim_gear? }
  router.post('/body-data', async (req, res) => {
    try {
      const b = req.body || {};
      const date = isDate(b.date) ? b.date : todayStr();
      const saved = {};
      const n = (v, lo, hi) => { if (v == null || v === '') return null; const x = num(v); return x != null && x >= lo && x <= hi ? x : NaN; };
      const m = { thigh: n(b.thigh, 10, 45), calf: n(b.calf, 8, 30), upper_arm: n(b.upper_arm, 8, 30), waist: n(b.waist, 20, 60) };
      const other = { body_fat_pct: n(b.body_fat_pct, 3, 50), weight_lb: n(b.weight_lb, 60, 500), resting_hr: n(b.resting_hr, 25, 120), age: n(b.age, 14, 99) };
      const bad = [...Object.entries(m), ...Object.entries(other)].filter((e) => Number.isNaN(e[1])).map((e) => e[0]);
      if (bad.length) return res.status(400).json({ error: `out of range: ${bad.join(', ')} (inches for measurements)` });
      const mk = Object.keys(m).filter((k) => m[k] != null);
      if (mk.length) {
        await pool.query(`INSERT INTO fitness_measurements (entry_date, ${mk.join(', ')}) VALUES ($1, ${mk.map((_, i) => `$${i + 2}`).join(', ')})`, [date, ...mk.map((k) => m[k])]);
        for (const k of mk) saved[k] = m[k];
      }
      if (other.body_fat_pct != null || other.weight_lb != null) {
        const last = (await q('SELECT weight_lb FROM fitness_bodyweight ORDER BY entry_date DESC, id DESC LIMIT 1'))[0];
        const weight = other.weight_lb != null ? other.weight_lb : (last ? Number(last.weight_lb) : null);
        if (weight == null) return res.status(400).json({ error: 'give your weight with the body fat (there is no weigh-in yet)' });
        await pool.query('INSERT INTO fitness_bodyweight (entry_date, weight_lb, body_fat_pct) VALUES ($1, $2, $3)', [date, weight, other.body_fat_pct]);
        if (other.body_fat_pct != null) saved.body_fat_pct = other.body_fat_pct;
        if (other.weight_lb != null) saved.weight_lb = other.weight_lb;
      }
      if (other.resting_hr != null) {
        await pool.query("INSERT INTO fitness_tests (entry_date, test, value, unit) VALUES ($1, 'resting_hr', $2, 'bpm')", [date, other.resting_hr]);
        saved.resting_hr = other.resting_hr;
      }
      if (other.age != null) {
        await pool.query('UPDATE fitness_profile SET age_years = $1, age_recorded_on = $2 WHERE id = 1', [Math.round(other.age), date]);
        saved.age = Math.round(other.age);
      }
      const gearIn = {};
      for (const k of ['fins', 'swim_gear']) if (typeof b[k] === 'boolean') gearIn[k] = b[k];
      if (Object.keys(gearIn).length) {
        const p = (await q('SELECT gear FROM fitness_profile WHERE id = 1'))[0] || {};
        const gear = { ...((p.gear && typeof p.gear === 'object') ? p.gear : {}), ...gearIn };
        await pool.query('UPDATE fitness_profile SET gear = $1::jsonb WHERE id = 1', [JSON.stringify(gear)]);
        Object.assign(saved, gearIn);
      }
      if (!Object.keys(saved).length) return res.status(400).json({ error: 'nothing to save' });
      res.status(201).json({ date, saved });
    } catch (err) { fail(res, err); }
  });
  // Test results: logged from a planned test item automatically, or entered here (time as m:ss or seconds).
  router.get('/tests', async (req, res) => {
    try { res.json(await q('SELECT id, entry_date, test, value, unit, notes, workout_id FROM fitness_tests ORDER BY entry_date DESC, id DESC')); } catch (err) { fail(res, err); }
  });
  router.post('/tests', async (req, res) => {
    try {
      const b = req.body || {};
      const t = ledger.TESTS[b.test];
      if (!t) return res.status(400).json({ error: `test must be one of ${Object.keys(ledger.TESTS).join(', ')}` });
      const asTime = t.unit === 's' && typeof b.value === 'string' && /^\d+:\d{1,2}(:\d{2})?$/.test(b.value.trim());
      const value = asTime ? b.value.trim().split(':').reduce((acc, x) => acc * 60 + Number(x), 0) : num(b.value);
      if (value == null || value <= 0) return res.status(400).json({ error: t.unit === 's' ? 'time as m:ss or seconds' : 'a number' });
      const row = (await q('INSERT INTO fitness_tests (entry_date, test, value, unit, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [isDate(b.date) ? b.date : todayStr(), b.test, value, t.unit, typeof b.notes === 'string' ? b.notes.slice(0, 500) : null]))[0];
      res.status(201).json(row);
    } catch (err) { fail(res, err); }
  });
  router.delete('/tests/:id', async (req, res) => {
    try { await pool.query('DELETE FROM fitness_tests WHERE id = $1', [Number(req.params.id)]); res.status(204).end(); } catch (err) { fail(res, err); }
  });

  router.get('/workouts', async (req, res) => {
    const { from, to } = req.query;
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const rows = await q('SELECT * FROM fitness_workouts ORDER BY workout_date DESC, id DESC');
    res.json(rows.map(shape).filter((w) => (!from || w.date >= from) && (!to || w.date <= to)));
  });

  // ---- the coached week (before /workouts/:id so these aren't read as an id) ----
  // Planning a week takes a few minutes (the trainer looks things up and its plan is checked), longer than a
  // phone will hold a request open ("Load failed", Oct 18). background: true starts it and answers at once;
  // GET /workouts/plan-week/status says how it's going. Without it the request waits, as before.
  let planJob = null;
  router.get('/workouts/plan-week/status', (req, res) => res.json({ job: planJob }));
  router.post('/workouts/plan-week', async (req, res) => {
    try {
      const raw = req.body || {};
      const start = raw.start_date || raw.date;
      const { inputs, errors } = gen.normalizeInputs({ ...raw, date: start });
      if (errors.length) return res.status(400).json({ error: errors.join('; ').replace('date', 'start_date') });
      const days = Math.max(4, Math.min(6, Math.round(Number(raw.days) || 5)));
      const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : '';
      // How much he can take (Oct 19): a volume level, and each day of the week gym, truck (no gym: near the truck) or off.
      inputs.volume_level = volume.LEVELS[raw.volume_level] ? raw.volume_level : 'intermediate';
      inputs.availability = {};
      for (const [d, mode] of Object.entries((raw.availability && typeof raw.availability === 'object') ? raw.availability : {})) {
        if (isDate(d) && ['gym', 'truck', 'off'].includes(mode)) inputs.availability[d] = mode;
      }
      if (raw.background === true) {
        if (planJob && planJob.status === 'running') return res.status(409).json({ error: 'Already planning a week — give it a minute', job: planJob });
        const job = planJob = { status: 'running', week_start: inputs.date, started_at: new Date().toISOString() };
        planWeek(inputs, days, note)
          .then((r) => Object.assign(job, { status: 'done', finished_at: new Date().toISOString(), sessions: r.workouts.length, kept_existing: r.kept_existing.length }))
          .catch((e) => Object.assign(job, { status: 'failed', finished_at: new Date().toISOString(), error: e.message || 'Could not plan the week', errors: e.errors }));
        return res.status(202).json({ job });
      }
      res.status(201).json(await planWeek(inputs, days, note));
    } catch (err) { if (err.errors) return res.status(502).json({ error: err.message, errors: err.errors }); coachFail(res, err); }
  });

  // Hard sets he actually logged in the 7 days before a date (lifts and gymnastics), for the ramp.
  async function lastWeekHardSets(date) {
    const from = addDaysStr(date, -7), to = addDaysStr(date, -1);
    const [l, g] = await Promise.all([
      q('SELECT COUNT(*)::int AS n FROM fitness_lifts WHERE entry_date >= $1 AND entry_date <= $2', [from, to]),
      q('SELECT COUNT(*)::int AS n FROM fitness_gymnastics WHERE entry_date >= $1 AND entry_date <= $2', [from, to]),
    ]);
    return Number(l[0].n) + Number(g[0].n);
  }
  // What a truck day can't have: anything that needs gym kit (a barbell, rack, bench, machines, a pool, rings…).
  const TRUCK_KIT = ['dumbbells', 'kettlebells', 'jumprope'];
  function truckBreaks(body) {
    const out = new Set();
    for (const b of body.blocks || []) {
      if (b.engine && ['bike', 'row', 'ski'].includes(b.engine.modality)) out.add(b.title || 'engine machine');
      for (const it of b.items || []) {
        const m = BY_NAME.get(it.movement);
        if (!m || !m.equip || !m.equip.length) continue;
        if (!m.equip.some((opt) => opt.every((e) => TRUCK_KIT.includes(e)))) out.add(it.movement);
      }
    }
    return [...out];
  }

  async function planWeek(inputs, days, note) {
    {
      const end = addDaysStr(inputs.date, 6);
      const ctx = await athleteContext(inputs.date);
      const lastWeek = await lastWeekHardSets(inputs.date);
      const level = volume.LEVELS[inputs.volume_level];
      const context = { ...ctx, week_start: inputs.date, days, minutes: inputs.minutes, equipment: inputs.equipment, engine_machine: inputs.engine_modality, note,
        availability: inputs.availability,
        volume: { level: inputs.volume_level, ...level, start_cap_hard_sets: volume.startCap(level), last_week_hard_sets_logged: lastWeek,
          this_week_max_hard_sets: lastWeek > 0 ? Math.max(Math.round(lastWeek * volume.RAMP), volume.startCap(level)) : volume.startCap(level) } };
      const fallbackFor = (d) => ({ date: d.date, title: d.title, focus: gen.FOCI.includes(d.focus) ? d.focus : inputs.focus, minutes: d.minutes || inputs.minutes, equipment: inputs.equipment });
      const check = (r) => {
        const out = [];
        if (!Array.isArray(r.days) || !r.days.length) return ['days must list the sessions'];
        const built = [];
        r.days.forEach((d, i) => {
          if (!isDate(d.date) || d.date < inputs.date || d.date > end) out.push(`days[${i}].date must be a date from ${inputs.date} to ${end}`);
          const sf = sessionFrom(d, `days[${i}]`, fallbackFor(d));
          out.push(...sf.errors);
          if (sf.body) built.push({ date: d.date, title: d.title, body: sf.body });
          // His availability is a hard rule: no session on an off day; on a truck day nothing that needs a gym.
          const mode = inputs.availability[d.date];
          if (mode === 'off') out.push(`days[${i}] (${d.date}): he's off that day (no session at all)`);
          if (mode === 'truck' && sf.body) {
            const gym = truckBreaks(sf.body);
            if (gym.length) out.push(`days[${i}] (${d.date}) is a truck day (harvest: no gym, near the truck: bodyweight, a kettlebell or dumbbells, running): ${gym.join(', ')} ${gym.length === 1 ? 'needs' : 'need'} a gym`);
          }
        });
        out.push(...volume.checkWeekVolume(built, inputs.volume_level, lastWeek));
        return out;
      };
      const plan = await askTrainer('week', context, check);
      if (plan.errors.length) throw Object.assign(new Error("Sentinel's plan didn't fit Self Hub's workout format, even after a fix — try again"), { errors: plan.errors.slice(0, 20) });
      // Replace untouched planned workouts that week; anything started stays.
      const existing = await q("SELECT * FROM fitness_workouts WHERE status = 'planned' AND workout_date >= $1 AND workout_date <= $2", [inputs.date, end]);
      const kept = [];
      for (const r of existing) {
        const w = shape(r);
        if (!anyLogged(w.body)) await pool.query('DELETE FROM fitness_workouts WHERE id = $1', [w.id]);
        else kept.push(w.id);
      }
      const out = [];
      for (const d of plan.result.days) {
        const { body, meta } = sessionFrom(d, 'day', fallbackFor(d));
        const rows = await q(
          `INSERT INTO fitness_workouts (workout_date, title, focus, minutes, inputs, body, seed, source, meta)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 0, 'sentinel', $7::jsonb) RETURNING *`,
          [d.date, body.title, body.focus, body.minutes, JSON.stringify({ ...inputs, date: d.date }), JSON.stringify({ ...body, date: d.date }), JSON.stringify(meta)]);
        out.push(shape(rows[0]));
      }
      const { days: _d, ...week } = plan.result;
      const weekRow = { ...week, calendar: plan.calendar || [], planned_at: new Date().toISOString(), note, volume_level: inputs.volume_level, availability: inputs.availability };
      await pool.query(`INSERT INTO fitness_weeks (week_start, days, plan) VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (week_start) DO UPDATE SET days = EXCLUDED.days, plan = EXCLUDED.plan, review = NULL, reviewed_at = NULL, updated_at = now()`,
      [inputs.date, days, JSON.stringify(weekRow)]);
      return { week: { week_start: inputs.date, days, plan: weekRow, review: null }, workouts: out, kept_existing: kept };
    }
  }

  // The week a date falls in: the coached week that started on or before it, within 7 days.
  async function weekOf(date) {
    const rows = await q('SELECT * FROM fitness_weeks WHERE week_start <= $1 AND week_start > $2 ORDER BY week_start DESC LIMIT 1', [date, addDaysStr(date, -7)]);
    if (!rows[0]) return null;
    const r = rows[0];
    const j = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
    return { week_start: ymd(r.week_start), days: Number(r.days), plan: j(r.plan), review: j(r.review), reviewed_at: r.reviewed_at };
  }

  // Review the week: what he did against the plan, adjust the days not started, rank where to work.
  async function reviewWeek(start) {
    const wk = await weekOf(start);
    if (!wk) { const e = new Error('No coached week starts then — plan one with Sentinel first'); e.status = 404; throw e; }
    const today = gen.ymd(new Date(Date.now() - 6 * 3600e3));
    const end = addDaysStr(wk.week_start, 6);
    const rows = await q('SELECT * FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2 ORDER BY workout_date ASC, id ASC', [wk.week_start, end]);
    const workouts = rows.map(shape);
    const tests = await q('SELECT entry_date, modality, test, output, unit FROM fitness_engine_tests WHERE entry_date >= $1 AND entry_date <= $2', [wk.week_start, end]);
    const ctx = await athleteContext(today > end ? end : today);
    const context = { ...ctx, week_start: wk.week_start, today, plan: wk.plan,
      // What he logged: each set's entry (reps, load, RPE, note) is in body; the session's time, RPE, notes and load.
      sessions: workouts.map((w) => ({ date: w.date, title: w.title, status: w.status, started: anyLogged(w.body), progress: w.progress, session: w.session, meta: w.meta, body: w.body })),
      engine_tests_this_week: tests.map((t) => ({ date: ymd(t.entry_date), machine: t.modality, test: t.test, output: Number(t.output), unit: t.unit })) };
    const open = (date) => workouts.find((w) => w.date === date && !anyLogged(w.body) && w.status !== 'done');
    const fb = (d) => ({ date: d.date, title: d.title, focus: gen.FOCI.includes(d.focus) ? d.focus : 'mixed', minutes: d.minutes || 45, equipment: ((open(d.date) || {}).inputs || {}).equipment || [] });
    const check = (r) => (r.adjustments || []).flatMap((d, i) => (d.date >= today && d.date <= end ? sessionFrom(d, `adjustments[${i}]`, fb(d)).errors : []));
    const out = await askTrainer('review', context, check);
    const applied = [];
    for (const d of out.result.adjustments || []) {
      if (!(d.date >= today && d.date <= end)) continue;
      const { body, meta, errors } = sessionFrom(d, 'adjustment', fb(d));
      if (errors.length) continue;
      const w = open(d.date);
      if (w) {
        await pool.query(`UPDATE fitness_workouts SET rules_body = COALESCE(rules_body, body), body = $1::jsonb, title = $2, focus = $3, minutes = $4, meta = $5::jsonb,
          source = 'sentinel', updated_at = now() WHERE id = $6`, [JSON.stringify({ ...body, date: d.date }), body.title, body.focus, body.minutes, JSON.stringify(meta), w.id]);
      } else if (!workouts.some((x) => x.date === d.date)) {
        await pool.query(`INSERT INTO fitness_workouts (workout_date, title, focus, minutes, inputs, body, seed, source, meta) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 0, 'sentinel', $7::jsonb)`,
          [d.date, body.title, body.focus, body.minutes, JSON.stringify({ date: d.date, minutes: body.minutes, focus: body.focus, equipment: [] }), JSON.stringify({ ...body, date: d.date }), JSON.stringify(meta)]);
      } else continue;
      applied.push({ date: d.date, title: body.title, change: meta.change || '' });
    }
    const review = { ...out.result, adjustments: undefined, applied, reviewed_for: today };
    await pool.query('UPDATE fitness_weeks SET review = $1::jsonb, reviewed_at = now(), updated_at = now() WHERE week_start = $2', [JSON.stringify(review), wk.week_start]);
    return { ...wk, review, reviewed_at: new Date().toISOString() };
  }
  router.post('/workouts/review-week', async (req, res) => {
    try {
      const start = (req.body && req.body.start_date) || gen.ymd(new Date(Date.now() - 6 * 3600e3));
      if (!isDate(start)) return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
      res.json(await reviewWeek(start));
    } catch (err) { coachFail(res, err); }
  });
  router.get('/workouts/week', async (req, res) => {
    const d = req.query.start || gen.ymd(new Date(Date.now() - 6 * 3600e3));
    if (!isDate(d)) return res.status(400).json({ error: 'start must be YYYY-MM-DD' });
    const week = await weekOf(d);
    if (week) {
      const rows = await q("SELECT body FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2 AND status <> 'skipped'", [week.week_start, addDaysStr(week.week_start, 6)]);
      const bodies = rows.map((r) => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body));
      week.volume = {
        planned: bodies.reduce((a, b) => volume.addVolume(a, volume.sessionVolume(b)), volume.emptyVolume()),
        logged: bodies.reduce((a, b) => volume.addVolume(a, volume.sessionVolume(b, { logged: true })), volume.emptyVolume()),
        last_week_hard_sets: await lastWeekHardSets(week.week_start),
        level: (week.plan && week.plan.volume_level) || null,
      };
    }
    res.json({ week, trainer_ready: coach.trainerReady() });
  });

  // (before /workouts/:id so "refine-queue" isn't read as an id)
  router.get('/workouts/refine-queue', async (req, res) => {
    try {
      const rows = await q("SELECT * FROM fitness_workouts WHERE refine_status = 'pending' ORDER BY refine_requested_at ASC");
      const out = [];
      for (const r of rows) out.push(await refineRequest(shape(r)));
      res.json({ pending: out.length, requests: out });
    } catch (err) { fail(res, err); }
  });

  // A session written whole (the coach chat, 2026-10-26): { date, body (REFINE_SCHEMA.body), objective?, why? }.
  router.post('/workouts/custom', async (req, res) => {
    try {
      const b = req.body || {};
      if (!isDate(b.date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
      const raw = b.body || {};
      const focus = gen.FOCI.includes(raw.focus) ? raw.focus : gen.FOCI[0];
      const { body, errors } = gen.sanitizeBody(raw, { date: b.date, title: raw.title || 'Workout', focus, minutes: Math.max(10, Math.min(240, Math.round(Number(raw.minutes)) || 60)), equipment: Array.isArray(raw.equipment) ? raw.equipment : [] });
      if (errors.length) return res.status(422).json({ error: 'body does not match the schema', errors: errors.slice(0, 30), schema: gen.REFINE_SCHEMA });
      const w = await insertWorkout(body, { date: b.date, focus: body.focus, minutes: body.minutes, equipment: body.equipment || [] }, 0);
      const meta = {};
      for (const k of ['objective', 'why', 'intensity']) if (typeof b[k] === 'string' && b[k].trim()) meta[k] = b[k].trim().slice(0, 1500);
      await pool.query(`UPDATE fitness_workouts SET source = 'coach'${Object.keys(meta).length ? ', meta = $2::jsonb' : ''} WHERE id = $1`, Object.keys(meta).length ? [w.id, JSON.stringify(meta)] : [w.id]);
      res.status(201).json(shape(await getRow(w.id)));
    } catch (err) { fail(res, err); }
  });
  // Move a session to another day: { date }.
  router.put('/workouts/:id/date', locked(async (req, res) => {
    try {
      const date = req.body && req.body.date;
      if (!isDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      await pool.query('UPDATE fitness_workouts SET workout_date = $1, body = $2::jsonb, updated_at = now() WHERE id = $3', [date, JSON.stringify({ ...w.body, date }), w.id]);
      res.json(shape(await getRow(w.id)));
    } catch (err) { fail(res, err); }
  }));

  router.get('/workouts/:id', async (req, res) => {
    const r = await getRow(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(shape(r));
  });

  router.put('/workouts/:id/status', async (req, res) => {
    const status = req.body && req.body.status;
    if (!['planned', 'done', 'skipped'].includes(status)) return res.status(400).json({ error: 'status must be planned, done or skipped' });
    const r = await getRow(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    await pool.query('UPDATE fitness_workouts SET status = $1, updated_at = now() WHERE id = $2', [status, r.id]);
    res.json(shape(await getRow(r.id)));
    // A finished session in a coached week: the trainer reviews it and adjusts the rest of the week.
    if (status === 'done' && coach.trainerReady() && !process.env.SELF_HUB_NO_AUTO_REVIEW) {
      weekOf(ymd(r.workout_date)).then((wk) => wk && reviewWeek(wk.week_start)).catch((e) => console.error('  !! week review: ' + e.message));
    }
  });

  router.delete('/workouts/:id', async (req, res) => {
    await pool.query('DELETE FROM fitness_workouts WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  });

  // ---- logging ----
  function locate(body, blockId, itemId, setIndex) {
    const block = (body.blocks || []).find((b) => b.id === blockId);
    const item = block && (block.items || []).find((i) => i.id === itemId);
    const si = Number(setIndex);
    const set = item && Number.isInteger(si) ? item.sets[si] : null;
    return { block, item, set, si };
  }

  // Log one set into the history (lifts, gymnastics, conditioning) from what he actually did: reps, load,
  // RPE, time and a note (Jake, 2026-10-18). Returns an error message, or null once set.entry is filled.
  async function logSet(w, block, item, set, si, input) {
    if (set.entry) return 'already logged';
    if (item.log_as === 'none') return 'this item is not logged';
    const date = w.date;
    const reps = num(input.reps) ?? set.reps;
    const rpe = num(input.rpe);
    if (rpe != null && (rpe < 1 || rpe > 10)) return 'RPE is 1 to 10';
    const note = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim().slice(0, 500) : null;
    const secs = num(input.duration_s);
    let entry;
    if (item.log_as === 'lift') {
      const load = num(input.load_lb) ?? set.load_lb;
      if (load == null) return 'enter the load you used — this lift had no prescribed load';
      if (reps == null) return 'reps required';
      const row = (await q('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps, rpe, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [date, item.movement, load, reps, rpe ?? set.rpe ?? null, note]))[0];
      entry = { table: 'lifts', id: row.id, reps, load_lb: load };
    } else if (item.log_as === 'gymnastics') {
      if (reps == null) return 'reps required';
      const row = (await q('INSERT INTO fitness_gymnastics (entry_date, movement, reps, notes) VALUES ($1, $2, $3, $4) RETURNING id',
        [date, item.movement, reps, [note, item.notes].filter(Boolean).join(' · ') || null]))[0];
      entry = { table: 'gymnastics', id: row.id, reps };
    } else if (item.log_as === 'conditioning') {
      const dist = num(input.distance_m) ?? set.distance_m ?? null;
      const row = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [date, item.movement, dist, secs ?? set.duration_s ?? null, [item.prescription, note].filter(Boolean).join(' · ') || null]))[0];
      entry = { table: 'conditioning', id: row.id, ...(dist != null ? { distance_m: dist } : {}), ...(secs != null ? { duration_s: secs } : {}) };
    } else if (item.log_as === 'engine' || item.log_as === 'test') {
      const output = num(input.output) ?? (item.log_as === 'engine' ? set.target : null);
      if (output == null || output < 0 || (item.log_as === 'test' && output <= 0)) return `enter your ${set.unit === 'm' ? 'meters' : 'calories'} for this interval`;
      const n = item.sets.length;
      const label = item.log_as === 'test' ? block.title : `${block.title} ${si + 1}/${n}`;
      const pctTxt = set.target ? `, target ${set.target} (${Math.round((output / set.target) * 100)}%)` : '';
      const row = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [date, item.movement, set.unit === 'm' ? output : null, secs ?? set.duration_s ?? null, [`${label}: ${output} ${set.unit}${pctTxt}`, note].filter(Boolean).join(' · ')]))[0];
      entry = { table: 'conditioning', id: row.id, output };
      set.actual = output;
    } else {
      return `unknown log_as ${item.log_as}`;
    }
    if (rpe != null) entry.rpe = rpe;
    if (note) entry.notes = note;
    set.entry = entry;
    if (item.log_as === 'test') await syncEngineTest(w, block, item);
    // A planned test (ledger.TESTS) also records its result in fitness_tests.
    if (item.test && ledger.TESTS[item.test]) {
      const t = ledger.TESTS[item.test];
      const value = t.unit === 'reps' ? reps : (secs != null ? secs : null);
      if (value != null) {
        const row = (await q('INSERT INTO fitness_tests (entry_date, test, value, unit, notes, workout_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [date, item.test, value, t.unit, note, w.id]))[0];
        entry.test_row = row.id;
      }
    }
    return null;
  }

  // One more set than planned: a copy of the item's last set (same target), marked extra.
  function addSet(item) {
    const last = item.sets[item.sets.length - 1] || {};
    const copy = { ...last, entry: null, extra: true };
    delete copy.actual;
    item.sets.push(copy);
    return item.sets.length - 1;
  }

  router.post('/workouts/:id/log', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const { block, item, set, si } = locate(w.body, req.body.block_id, req.body.item_id, req.body.set_index);
      if (!set) return res.status(404).json({ error: 'no such set' });
      const err = await logSet(w, block, item, set, si, req.body);
      if (err) return res.status(err === 'already logged' ? 409 : 400).json({ error: err });
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

  // + set: an extra set on an item; an unlogged extra set can be taken off again.
  router.post('/workouts/:id/sets', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const { item } = locate(w.body, req.body.block_id, req.body.item_id, 0);
      if (!item || item.log_as === 'none' || !Array.isArray(item.sets) || !item.sets.length) return res.status(404).json({ error: 'no such item' });
      if (item.sets.length >= 20) return res.status(400).json({ error: 'that is plenty of sets' });
      addSet(item);
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));
  router.delete('/workouts/:id/sets', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const { item, set, si } = locate(w.body, req.body.block_id, req.body.item_id, req.body.set_index);
      if (!set) return res.status(404).json({ error: 'no such set' });
      if (!set.extra || set.entry) return res.status(400).json({ error: 'only an unlogged extra set can be removed' });
      item.sets.splice(si, 1);
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

  // The session as a whole: time taken, session RPE (1-10), notes; done: true marks it done too.
  async function saveSession(w, input) {
    const mins = input.minutes === undefined ? undefined : num(input.minutes);
    const rpe = input.rpe === undefined ? undefined : num(input.rpe);
    if (mins != null && (mins < 1 || mins > 600)) return 'minutes is 1 to 600';
    if (rpe != null && (rpe < 1 || rpe > 10)) return 'session RPE is 1 to 10';
    const notes = input.notes === undefined ? undefined : (String(input.notes || '').trim().slice(0, 2000) || null);
    await pool.query(`UPDATE fitness_workouts SET
        actual_minutes = CASE WHEN $1 THEN $2 ELSE actual_minutes END,
        session_rpe = CASE WHEN $3 THEN $4 ELSE session_rpe END,
        session_notes = CASE WHEN $5 THEN $6 ELSE session_notes END,
        status = CASE WHEN $7 THEN 'done' ELSE status END, updated_at = now() WHERE id = $8`,
      [mins !== undefined, mins == null ? null : Math.round(mins), rpe !== undefined, rpe ?? null, notes !== undefined, notes ?? null, input.done === true, w.id]);
    return null;
  }
  router.put('/workouts/:id/session', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const err = await saveSession(shape(r), req.body || {});
      if (err) return res.status(400).json({ error: err });
      res.json(shape(await getRow(r.id)));
    } catch (err) { fail(res, err); }
  }));

  // For Sentinel (and anything that knows the movement, not the set): log what he did on a date into that
  // day's planned workout, at the first open set of that movement (an extra set once they're all in), or
  // straight into the history when nothing planned matches. Session fields (minutes, session_rpe,
  // session_notes, done) go on that day's workout.
  //   POST /workouts/log-entry { date, movement?, reps?, load_lb?, rpe?, notes?, output?, duration_s?, distance_m?,
  //                              minutes?, session_rpe?, session_notes?, done? }
  router.post('/workouts/log-entry', async (req, res) => {
    try {
      const b = req.body || {};
      const date = isDate(b.date) ? b.date : gen.ymd(new Date(Date.now() - 6 * 3600e3));
      const rows = await q("SELECT * FROM fitness_workouts WHERE workout_date = $1 AND status <> 'skipped' ORDER BY id ASC", [date]);
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const want = norm(b.movement);
      let logged = null;
      if (want) {
        let found = null;
        for (const r of rows) {
          const w = shape(r);
          for (const block of w.body.blocks || []) {
            for (const item of block.items || []) {
              const m = norm(item.movement);
              if (item.log_as !== 'none' && m && (m === want || m.includes(want) || want.includes(m))) { found = found || { id: w.id, block, item }; }
            }
          }
        }
        if (found) {
          logged = await withLock(found.id, async () => {
            const w = shape(await getRow(found.id));
            const block = w.body.blocks.find((x) => x.id === found.block.id);
            const item = block.items.find((x) => x.id === found.item.id);
            let si = item.sets.findIndex((s) => !s.entry);
            if (si === -1) si = addSet(item);
            const err = await logSet(w, block, item, item.sets[si], si, b);
            if (err) { const e = new Error(err); e.status = 400; throw e; }
            const out = await saveBody(w.id, w.body);
            return { into: 'workout', workout_id: w.id, workout: w.title, movement: item.movement, set: si + 1, of: item.sets.length, extra: !!item.sets[si].extra, entry: item.sets[si].entry, progress: out.progress };
          });
        } else {
          // Nothing planned matches: straight into the history.
          const reps = num(b.reps); const load = num(b.load_lb); const rpe = num(b.rpe);
          const note = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 500) : null;
          if (load != null && reps != null) {
            const row = (await q('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps, rpe, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [date, String(b.movement).slice(0, 80), load, reps, rpe, note]))[0];
            logged = { into: 'history', table: 'lifts', id: row.id };
          } else if (reps != null) {
            const row = (await q('INSERT INTO fitness_gymnastics (entry_date, movement, reps, notes) VALUES ($1, $2, $3, $4) RETURNING id', [date, String(b.movement).slice(0, 80), reps, note]))[0];
            logged = { into: 'history', table: 'gymnastics', id: row.id };
          } else if (num(b.duration_s) != null || num(b.distance_m) != null) {
            const row = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id', [date, String(b.movement).slice(0, 80), num(b.distance_m), num(b.duration_s), note]))[0];
            logged = { into: 'history', table: 'conditioning', id: row.id };
          } else return res.status(400).json({ error: 'say the reps (and the load for a lift), or the time or distance' });
        }
      }
      let session = null;
      if (['minutes', 'session_rpe', 'session_notes', 'done'].some((k) => b[k] !== undefined)) {
        const r = rows[0];
        if (!r) return res.status(404).json({ error: `no workout on ${date} to put that on`, logged });
        const err = await withLock(r.id, () => saveSession(shape(r), { minutes: b.minutes, rpe: b.session_rpe, notes: b.session_notes, done: b.done }));
        if (err) return res.status(400).json({ error: err, logged });
        const w = shape(await getRow(r.id));
        session = { workout_id: w.id, workout: w.title, status: w.status, ...w.session };
      }
      if (!logged && !session) return res.status(400).json({ error: 'nothing to log: give a movement with what you did, or the session time, RPE or notes' });
      res.status(201).json({ date, logged, session });
    } catch (err) { if (err.status === 400) return res.status(400).json({ error: err.message }); fail(res, err); }
  });

  // One test row per test block: single-interval tests store the output;
  // the repeatability test stores every interval and their average.
  async function syncEngineTest(w, block, item) {
    const e = block.engine;
    if (!e || e.type !== 'test') return;
    const done = item.sets.filter((s) => s.entry && s.actual != null).map((s) => Number(s.actual));
    await pool.query('DELETE FROM fitness_engine_tests WHERE workout_id = $1 AND test = $2 AND modality = $3', [w.id, e.test, e.modality]);
    if (!done.length) return;
    // Repeatability only counts once every interval is in.
    if (e.test === 'repeat' && done.length < item.sets.length) return;
    const output = e.test === 'repeat' ? Math.round((done.reduce((s, v) => s + v, 0) / done.length) * 10) / 10 : done[0];
    await pool.query(
      'INSERT INTO fitness_engine_tests (entry_date, modality, test, output, unit, intervals, notes, workout_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)',
      [w.date, e.modality, e.test, output, e.unit, e.test === 'repeat' ? JSON.stringify(done) : null, 'from generated workout', w.id]
    );
  }

  const TABLES = { lifts: 'fitness_lifts', gymnastics: 'fitness_gymnastics', conditioning: 'fitness_conditioning', benchmarks: 'fitness_benchmarks' };
  async function deleteEntry(entry) {
    if (entry && TABLES[entry.table]) await pool.query(`DELETE FROM ${TABLES[entry.table]} WHERE id = $1`, [entry.id]);
    if (entry && entry.test_row) await pool.query('DELETE FROM fitness_tests WHERE id = $1', [entry.test_row]);
  }

  router.post('/workouts/:id/unlog', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const { block, item, set } = locate(w.body, req.body.block_id, req.body.item_id, req.body.set_index);
      if (!set) return res.status(404).json({ error: 'no such set' });
      if (!set.entry) return res.json(w);
      await deleteEntry(set.entry);
      set.entry = null;
      if ('actual' in set) set.actual = null;
      if (item.log_as === 'test') await syncEngineTest(w, block, item);
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

  router.post('/workouts/:id/metcon', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const block = (w.body.blocks || []).find((b) => b.id === req.body.block_id);
      if (!block || block.kind !== 'metcon') return res.status(404).json({ error: 'no such metcon block' });
      if (block.result) return res.status(409).json({ error: 'already logged' });
      const result = typeof req.body.result === 'string' ? req.body.result.trim().slice(0, 200) : '';
      if (!result) return res.status(400).json({ error: 'result is required, e.g. "5 rounds + 12" or "11:42"' });
      const dur = num(req.body.duration_s) ?? (block.minutes ? block.minutes * 60 : null);
      // Conditioning row → counts toward aerobic minutes; benchmark row →
      // shows in "Metcons this week" and the Benchmark log.
      const c = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [w.date, 'Metcon', null, dur, `${block.title}: ${result}`]))[0];
      // A benchmark metcon logs under the benchmark's name, so it counts toward the percentiles and the ledger.
      const bname = block.benchmark || (ledger.BENCHMARKS.includes(block.title) ? block.title : null);
      const b = (await q('INSERT INTO fitness_benchmarks (entry_date, name, result) VALUES ($1, $2, $3) RETURNING id',
        [w.date, bname || `Metcon: ${block.title}`, result]))[0];
      block.result = { text: result, duration_s: dur, conditioning_id: c.id, benchmark_id: b.id };
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

  router.delete('/workouts/:id/metcon/:blockId', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const block = (w.body.blocks || []).find((b) => b.id === req.params.blockId);
      if (!block || !block.result) return res.json(w);
      await deleteEntry({ table: 'conditioning', id: block.result.conditioning_id });
      await deleteEntry({ table: 'benchmarks', id: block.result.benchmark_id });
      block.result = null;
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

  // ---- Sentinel refinement ----
  router.post('/workouts/:id/refine', locked(async (req, res) => {
    // With the trainer connected, refine now: Sentinel answers in about a minute. Otherwise it's queued as before.
    if (coach.trainerReady()) {
      try {
        const r = await getRow(req.params.id);
        if (!r) return res.status(404).json({ error: 'not found' });
        const w = shape(r);
        if (anyLogged(w.body)) return res.status(409).json({ error: 'sets are already logged — refinement only applies before you start' });
        const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim().slice(0, 500) : '';
        await pool.query("UPDATE fitness_workouts SET refine_request = $1 WHERE id = $2", [note || null, w.id]);
        const pkg = await refineRequest({ ...w, refine: { ...w.refine, request: note || null } });
        const ctx = await athleteContext(w.date, w.id);
        const fb = { date: w.date, title: w.title, focus: w.focus, minutes: w.minutes, equipment: w.inputs.equipment };
        const out = await askTrainer('refine', { ...ctx, ...pkg, workout: { date: w.date, ...pkg.workout } }, (x) => sessionFrom(x, 'session', fb).errors);
        if (out.errors.length) return res.status(502).json({ error: "Sentinel's session didn't fit Self Hub's workout format — try again", errors: out.errors.slice(0, 20) });
        const { body, meta } = sessionFrom(out.result, 'session', fb);
        await pool.query(
          `UPDATE fitness_workouts SET rules_body = COALESCE(rules_body, body), body = $1::jsonb, title = $2, focus = $3, minutes = $4, meta = $5::jsonb,
             source = 'sentinel', refine_status = 'done', refine_notes = $6, refined_at = now(), updated_at = now() WHERE id = $7`,
          [JSON.stringify({ ...body, date: w.date }), body.title, body.focus, body.minutes, JSON.stringify(meta), String(out.result.notes || '').slice(0, 2000) || null, w.id]);
        return res.json(shape(await getRow(w.id)));
      } catch (err) { return coachFail(res, err); }
    }
    const r = await getRow(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const w = shape(r);
    if (anyLogged(w.body)) return res.status(409).json({ error: 'sets are already logged — refinement only applies before you start' });
    const note = typeof (req.body && req.body.note) === 'string' ? req.body.note.trim().slice(0, 500) : null;
    await pool.query("UPDATE fitness_workouts SET refine_status = 'pending', refine_request = $1, refine_requested_at = now(), updated_at = now() WHERE id = $2", [note || null, w.id]);
    res.json(shape(await getRow(w.id)));
  }));

  router.delete('/workouts/:id/refine', async (req, res) => {
    const r = await getRow(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.refine_status === 'pending') await pool.query("UPDATE fitness_workouts SET refine_status = 'none', refine_request = NULL, refine_requested_at = NULL WHERE id = $1", [r.id]);
    res.json(shape(await getRow(r.id)));
  });

  router.put('/workouts/:id/refined', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      if (anyLogged(w.body)) return res.status(409).json({ error: 'Jake has already started this workout (sets logged) — not replacing it' });
      const { body, errors } = gen.sanitizeBody(req.body && req.body.body, { date: w.date, title: w.title, focus: w.focus, minutes: w.minutes, equipment: w.inputs.equipment });
      if (errors.length) return res.status(422).json({ error: 'body does not match the schema', errors: errors.slice(0, 30), schema: gen.REFINE_SCHEMA });
      const notes = typeof (req.body && req.body.notes) === 'string' ? req.body.notes.trim().slice(0, 2000) : null;
      await pool.query(
        `UPDATE fitness_workouts SET rules_body = COALESCE(rules_body, body), body = $1::jsonb, title = $2, focus = $3, minutes = $4,
           source = 'sentinel', refine_status = 'done', refine_notes = $5, refined_at = now(), updated_at = now()
         WHERE id = $6`,
        [JSON.stringify(body), body.title, body.focus || w.focus, body.minutes || w.minutes, notes, w.id]
      );
      res.json(shape(await getRow(w.id)));
    } catch (err) { fail(res, err); }
  }));

  router.post('/workouts/:id/revert', locked(async (req, res) => {
    const r = await getRow(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const w = shape(r);
    if (r.rules_body == null) return res.status(400).json({ error: 'nothing to revert — this is already the rules version' });
    if (anyLogged(w.body)) return res.status(409).json({ error: 'sets are already logged — unlog them first' });
    const rb = typeof r.rules_body === 'string' ? JSON.parse(r.rules_body) : r.rules_body;
    await pool.query(
      `UPDATE fitness_workouts SET body = rules_body, rules_body = NULL, title = $1, focus = $2, minutes = $3, source = 'rules',
         refine_status = 'none', refine_request = NULL, refine_notes = NULL, refined_at = NULL, updated_at = now() WHERE id = $4`,
      [rb.title, rb.focus, rb.minutes, w.id]
    );
    res.json(shape(await getRow(w.id)));
  }));

  // Where he ranks against the field (the Dashboard's CrossFit percentiles), so the trainer weighs his
  // weaknesses against other CrossFitters as well as his own history. null if it can't be worked out.
  async function percentilesFor(date) {
    try {
      const { loadPercentileRows } = require('./percentiles');
      const { computePercentiles } = require('../lib/percentiles');
      const p = computePercentiles(await loadPercentileRows(pool), date, strength);
      return {
        note: 'Percent of male CrossFitters each best beats (2019 Open athlete profiles; rows vs Concept2 2025 lightweight men; Open from his leaderboard rank). Self-reported, so optimistic; not bodyweight-adjusted. Strict pull-ups are the exception: against StrengthLevel lifters at his bodyweight.',
        by_area: p.categories.filter((c) => c.percentile != null).map((c) => ({ area: c.category, percentile: c.percentile, basis: c.basis })),
        benchmarks: p.benchmarks.filter((b) => b.percentile != null).map((b) => ({ name: b.label, best: b.display, date: b.date, percentile: b.percentile, field_median: b.median, recent: b.recent ? { best: b.recent.display, date: b.recent.date, percentile: b.recent.percentile } : null })),
        open: p.open.map((o) => ({ year: o.year, workout: o.workout, percentile: o.percentile })),
      };
    } catch (e) {
      return null;
    }
  }

  // Everything about Jake the trainer needs, as of a date.
  // The evidence for where his body needs attention (Jake, 2026-10-18: worked out objectively, not from a
  // remark): proportions from his measurements, strength by pattern against bodyweight standards (lower body
  // against upper), body composition, and what isn't measured so can't be judged.
  async function physiqueEvidence(m, strengthPatterns, profile) {
    const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    const bf = (await q('SELECT entry_date, body_fat_pct FROM fitness_bodyweight WHERE body_fat_pct IS NOT NULL ORDER BY entry_date DESC LIMIT 1'))[0];
    const v = (f) => (m && m[f] != null ? Number(m[f]) : null);
    const mean = (xs) => { const ok = xs.filter(Number.isFinite); return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : null; };
    const sp = strengthPatterns || {};
    const lower = mean([sp.Squat, sp.Hinge]), upper = mean([sp['Push Horizontal'], sp['Push Vertical'], sp['Pull Horizontal'], sp['Pull Vertical']]);
    // The circumferences, each from its latest entry (an entry needn't have every field).
    const circ = {};
    for (const f of ['thigh', 'calf', 'upper_arm']) {
      const r = (await q(`SELECT entry_date, ${f} AS v FROM fitness_measurements WHERE ${f} IS NOT NULL ORDER BY entry_date DESC LIMIT 1`))[0];
      if (r) circ[f] = { in: Number(r.v), date: ymd(r.entry_date) };
    }
    const label = { thigh: 'thigh circumference', calf: 'calf circumference', upper_arm: 'upper-arm circumference' };
    const missing = Object.keys(label).filter((f) => !circ[f]).map((f) => label[f]);
    if (!m) missing.unshift('body measurements');
    if (!bf) missing.push('body fat %');
    return {
      note: 'Decide where he needs attention from this, not from anything he said in passing. measurements are clothing measurements in inches (shoulder = width across the back; bust = chest circumference; waist and seat_hips = circumferences). strength_by_pattern scores each pattern against bodyweight standards (higher is stronger for his size).',
      measured: m ? ymd(m.entry_date) : null,
      height_in: num(profile.height_in),
      body_fat_pct: bf ? num(bf.body_fat_pct) : null,
      ratios: m ? { chest_to_waist: r2(v('bust') / v('waist')), hips_to_waist: r2(v('seat_hips') / v('waist')), neck_to_waist: r2(v('neck') / v('waist')),
        shoulder_width_to_waist_circumference: r2(v('shoulder') / v('waist')),
        ...(circ.thigh && v('waist') ? { thigh_to_waist: r2(circ.thigh.in / v('waist')) } : {}),
        ...(circ.upper_arm && circ.thigh ? { upper_arm_to_thigh: r2(circ.upper_arm.in / circ.thigh.in) } : {}),
        ...(circ.calf && circ.thigh ? { calf_to_thigh: r2(circ.calf.in / circ.thigh.in) } : {}) } : null,
      circumferences_in: circ,
      strength_by_pattern: sp,
      lower_vs_upper_strength: lower != null && upper != null ? { lower_body: r2(lower), upper_body: r2(upper), difference: r2(lower - upper) } : null,
      not_measured: missing,
    };
  }

  async function athleteContext(date, excludeId = null) {
    const rows = await loadGenRows(date, excludeId);
    const ctx = gen.makeContext(rows, date);
    const profile = (await q('SELECT * FROM fitness_profile WHERE id = 1'))[0] || {};
    const bw = rows.bodyweight[rows.bodyweight.length - 1];
    const bw30 = rows.bodyweight.filter((b) => ymd(b.entry_date) >= addDaysStr(date, -30))[0];
    const m = (await q(`SELECT entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements ORDER BY entry_date DESC LIMIT 1`))[0];
    const since = addDaysStr(date, -28);
    const known = Array.from(new Set([...MOVEMENTS.map((x) => x.name), ...rows.lifts.map((l) => l.lift), ...rows.gymnastics.map((g) => g.movement)])).sort();
    const baselines = Object.values(ctx.baselines).filter((b) => b.tt10 || b.sprint60 || b.repeat).map((b) => ({
      machine: b.name, unit: b.unit,
      ten_min_test: b.tt10 && { output: b.tt10.output, date: b.tt10.date, pace_per_min: b.enduranceRate },
      one_min_test: b.sprint60 && { output: b.sprint60.output, date: b.sprint60.date },
      repeatability: b.repeatability, speed_reserve: b.speedReserve,
      adaptation: { endurance: b.adjEndurance, speed: b.adjSpeed }, limiter: b.limiter && b.limiter.text, tests_due: b.testsDue,
    }));
    return {
      athlete: {
        goals: {
          phase: profile.phase, body_fat_target_pct: num(profile.body_fat_target), bodyweight_goal_lb: num(profile.bodyweight_goal_lb),
          leaderboard_goal: profile.leaderboard_goal,
          summary: 'Top of the local CrossFit leaderboard and the physique below; continuous lean gain, no cut.',
          physique_target: profile.physique_target || null,
          ...(profile.physique_assessment ? { his_own_notes: profile.physique_assessment } : {}),
        },
        physique_evidence: await physiqueEvidence(m, ctx.strengthPatterns, profile),
        // What's due to be tested, what's missing and what's unknown (lib/ledger.js).
        data_ledger: await ledgerFor(date).catch(() => null),
        bodyweight_lb: bw ? num(bw.weight_lb) : null,
        bodyweight_30d_ago_lb: bw30 ? num(bw30.weight_lb) : null,
        measurements_in: m ? Object.fromEntries(MEASUREMENT_FIELDS.filter((f) => m[f] != null).map((f) => [f, num(m[f])])) : null,
        strength_scores: ctx.strengthPatterns,
        e1rm_60d_lb: Object.fromEntries(Object.entries(ctx.e1rm).map(([k, v]) => [k, Math.round(v)])),
        gymnastics_best_set_60d: ctx.gymBest,
        engine_baselines: baselines,
        crossfit_percentiles: await percentilesFor(date),
        sets_this_week_by_pattern: ctx.weekSets,
        weekly_set_target: gen.WEEKLY_SET_TARGET,
        last_28_days: {
          lifts: rows.lifts.filter((l) => ymd(l.entry_date) >= since && ymd(l.entry_date) <= date).map((l) => `${ymd(l.entry_date)} ${l.lift} ${Number(l.load_lb)}×${l.reps}${l.rpe ? ` @${l.rpe}` : ''}`).slice(-120),
          gymnastics: rows.gymnastics.filter((g) => ymd(g.entry_date) >= since && ymd(g.entry_date) <= date).map((g) => `${ymd(g.entry_date)} ${g.movement} ×${g.reps}`).slice(-80),
        },
      },
      known_movements: known,
      foci: gen.FOCI,
      schema: gen.REFINE_SCHEMA,
    };
  }

  // A trainer session → a body Self Hub can log, plus what it's for. errors are prefixed with where.
  function sessionFrom(day, where, fallback) {
    const { body, errors } = gen.sanitizeBody({ ...(day.body || {}), title: (day.body && day.body.title) || day.title, focus: day.focus, minutes: day.minutes }, fallback);
    const sys = day.systems || {};
    const total = ['phosphagen', 'glycolytic', 'oxidative'].reduce((a, k) => a + (Number(sys[k]) || 0), 0) || 1;
    const meta = {
      objective: String(day.objective || '').slice(0, 600),
      systems: Object.fromEntries(['phosphagen', 'glycolytic', 'oxidative'].map((k) => [k, Math.round(((Number(sys[k]) || 0) / total) * 100)])),
      qualities: Object.fromEntries(Object.entries(day.qualities || {}).map(([k, v]) => [k, Math.max(0, Math.min(3, Math.round(Number(v) || 0)))]).filter(([, v]) => v > 0)),
      muscles: Array.isArray(day.muscles) ? day.muscles.map(String).slice(0, 12) : [],
      intensity: String(day.intensity || '').slice(0, 200),
      why: String(day.why || '').slice(0, 1500),
      ...(day.change ? { change: String(day.change).slice(0, 600) } : {}),
    };
    return { body, meta, errors: errors.map((e) => `${where}.${e}`) };
  }

  // Ask the trainer; when Self Hub can't take what comes back, send the errors once to be fixed.
  async function askTrainer(task, context, check) {
    let out = await coach.callTrainer(task, { context });
    let errors = check(out.result);
    if (errors.length) {
      out = await coach.callTrainer(task, { context, previous: out.result, errors });
      errors = check(out.result);
    }
    return { ...out, errors };
  }

  // The package Sentinel's trainer agent gets for each pending request:
  // the rule-built workout, why it was built that way, everything about Jake
  // that went into it, and exactly what to send back.
  async function refineRequest(w) {
    const rows = await loadGenRows(w.date, w.id);
    const ctx = gen.makeContext(rows, w.date);
    const profile = (await q('SELECT * FROM fitness_profile WHERE id = 1'))[0] || {};
    const bw = rows.bodyweight[rows.bodyweight.length - 1];
    const m = (await q(`SELECT entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements ORDER BY entry_date DESC LIMIT 1`))[0];
    const week = await q('SELECT id, workout_date, title, status FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2 ORDER BY workout_date ASC',
      [ctx.weekStart, ctx.weekEnd]);
    const since = addDaysStr(w.date, -7);
    const recentLifts = rows.lifts.filter((l) => ymd(l.entry_date) >= since && ymd(l.entry_date) < w.date)
      .map((l) => `${ymd(l.entry_date)} ${l.lift} ${Number(l.load_lb)}×${l.reps}`);
    const recentGym = rows.gymnastics.filter((g) => ymd(g.entry_date) >= since && ymd(g.entry_date) < w.date)
      .map((g) => `${ymd(g.entry_date)} ${g.movement} ×${g.reps}`);
    const known = Array.from(new Set([...MOVEMENTS.map((x) => x.name), ...rows.lifts.map((l) => l.lift), ...rows.gymnastics.map((g) => g.movement)])).sort();
    const baselines = Object.values(ctx.baselines).filter((b) => b.tt10 || b.sprint60 || b.repeat).map((b) => ({
      machine: b.name, unit: b.unit,
      ten_min_test: b.tt10 && { output: b.tt10.output, date: b.tt10.date, pace_per_min: b.enduranceRate },
      one_min_test: b.sprint60 && { output: b.sprint60.output, date: b.sprint60.date },
      repeatability: b.repeatability, speed_reserve: b.speedReserve,
      adaptation: { endurance: b.adjEndurance, speed: b.adjSpeed }, limiter: b.limiter && b.limiter.text, tests_due: b.testsDue,
    }));
    return {
      id: w.id, date: w.date, requested_at: w.refine.requested_at, jake_note: w.refine.request,
      constraints: { minutes: w.minutes, focus: w.focus, equipment: w.inputs.equipment, engine_machine: w.inputs.engine_modality },
      workout: w.body,
      athlete: {
        goals: {
          phase: profile.phase, body_fat_target_pct: num(profile.body_fat_target), bodyweight_goal_lb: num(profile.bodyweight_goal_lb),
          leaderboard_goal: profile.leaderboard_goal,
          summary: 'Top of the local CrossFit leaderboard and the physique below; continuous lean gain, no cut.',
          physique_target: profile.physique_target || null,
          ...(profile.physique_assessment ? { his_own_notes: profile.physique_assessment } : {}),
        },
        physique_evidence: await physiqueEvidence(m, ctx.strengthPatterns, profile),
        bodyweight_lb: bw ? num(bw.weight_lb) : null,
        measurements_in: m ? Object.fromEntries(MEASUREMENT_FIELDS.filter((f) => m[f] != null).map((f) => [f, num(m[f])])) : null,
        strength_scores: ctx.strengthPatterns,
        e1rm_60d_lb: Object.fromEntries(Object.entries(ctx.e1rm).map(([k, v]) => [k, Math.round(v)])),
        gymnastics_best_set_60d: ctx.gymBest,
        engine_baselines: baselines,
        crossfit_percentiles: await percentilesFor(w.date),
        sets_this_week_by_pattern: ctx.weekSets,
        weekly_set_target: gen.WEEKLY_SET_TARGET,
        last_7_days: { lifts: recentLifts.slice(-40), gymnastics: recentGym.slice(-40) },
        this_week_plan: week.map((x) => ({ id: x.id, date: ymd(x.workout_date), title: x.title, status: x.status })),
      },
      known_movements: known,
      instructions: [
        "You are Jake's personal trainer agent. Refine this rule-built workout — don't start from scratch unless it's clearly wrong.",
        'Keep it within the minutes and equipment in constraints. Take jake_note into account if present.',
        'Loads and engine targets must come from his own numbers (e1rm_60d_lb, gymnastics_best_set_60d, engine_baselines) — keep everything personal, like The Gains Lab does.',
        'Use names from known_movements wherever one fits, so it logs into the same history.',
        'Explain your changes in body.rationale and give a one-line summary in notes.',
        `Send it back with PUT /api/fitness/workouts/${w.id}/refined as { "body": {...}, "notes": "..." }. A 422 response lists exactly what to fix.`,
      ],
      response_schema: gen.REFINE_SCHEMA,
      submit: { method: 'PUT', path: `/api/fitness/workouts/${w.id}/refined` },
    };
  }

  // ---- engine baselines + tests ----
  router.get('/engine', async (req, res) => {
    try {
      const date = isDate(req.query.date) ? req.query.date : ymd(new Date());
      const rows = await loadGenRows(date);
      const ctx = gen.makeContext(rows, date);
      const tests = await q('SELECT id, entry_date, modality, test, output, unit, intervals, notes, workout_id FROM fitness_engine_tests ORDER BY entry_date DESC, id DESC');
      res.json({
        date,
        baselines: Object.values(ctx.baselines).map((b) => ({ ...b, endurance_pace: b.enduranceRate ? engine.rateText(b.enduranceRate, b.unit) : null, speed_pace: b.speedRate ? engine.rateText(b.speedRate, b.unit) : null })),
        tests: tests.map((t) => ({ ...t, entry_date: ymd(t.entry_date), output: Number(t.output), intervals: typeof t.intervals === 'string' ? JSON.parse(t.intervals) : t.intervals })),
      });
    } catch (err) { fail(res, err); }
  });

  router.post('/engine-tests', async (req, res) => {
    const { entry_date, modality, test, notes } = req.body || {};
    if (!isDate(entry_date)) return res.status(400).json({ error: 'entry_date (YYYY-MM-DD) is required' });
    if (!engine.MODALITIES[modality]) return res.status(400).json({ error: `modality must be one of ${Object.keys(engine.MODALITIES).join(', ')}` });
    if (!engine.TESTS[test]) return res.status(400).json({ error: `test must be one of ${Object.keys(engine.TESTS).join(', ')}` });
    let intervals = null; let output = num(req.body.output);
    if (test === 'repeat') {
      const iv = Array.isArray(req.body.intervals) ? req.body.intervals.map(num) : [];
      if (iv.length < 2 || iv.some((v) => v == null || v < 0)) return res.status(400).json({ error: 'repeat test needs intervals: an array of each interval\'s output' });
      intervals = iv;
      output = Math.round((iv.reduce((s, v) => s + v, 0) / iv.length) * 10) / 10;
    }
    if (output == null || output <= 0) return res.status(400).json({ error: 'output is required' });
    const unit = engine.MODALITIES[modality].unit;
    const row = (await q(
      'INSERT INTO fitness_engine_tests (entry_date, modality, test, output, unit, intervals, notes) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id',
      [entry_date, modality, test, output, unit, intervals ? JSON.stringify(intervals) : null, typeof notes === 'string' ? notes.slice(0, 300) : null]
    ))[0];
    res.status(201).json({ id: row.id, entry_date, modality, test, output, unit, intervals });
  });

  router.delete('/engine-tests/:id', async (req, res) => {
    await pool.query('DELETE FROM fitness_engine_tests WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  });

  return router;
}

module.exports = { createWorkoutsRouter };
