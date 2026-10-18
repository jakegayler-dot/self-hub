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
//   Sentinel refinement (Sentinel pulls — see README):
//   POST   /workouts/:id/refine             { note? }  → queues it
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
const { EQUIPMENT, EQUIPMENT_PRESETS, MOVEMENTS } = require('../lib/movements');

const { ymd, mondayOfStr, addDaysStr } = gen;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const MEASUREMENT_FIELDS = ['arm_length', 'bust', 'shoulder', 'length', 'waist', 'seat_hips', 'neck', 'sleeve', 'inseam_low', 'inseam_high'];

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
      progress: progressOf(body),
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
  router.get('/workouts', async (req, res) => {
    const { from, to } = req.query;
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const rows = await q('SELECT * FROM fitness_workouts ORDER BY workout_date DESC, id DESC');
    res.json(rows.map(shape).filter((w) => (!from || w.date >= from) && (!to || w.date <= to)));
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

  router.post('/workouts/:id/log', locked(async (req, res) => {
    try {
      const r = await getRow(req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const w = shape(r);
      const { block, item, set, si } = locate(w.body, req.body.block_id, req.body.item_id, req.body.set_index);
      if (!set) return res.status(404).json({ error: 'no such set' });
      if (set.entry) return res.status(409).json({ error: 'already logged' });
      if (item.log_as === 'none') return res.status(400).json({ error: 'this item is not logged' });
      const date = w.date;
      const reps = num(req.body.reps) ?? set.reps;
      let entry;

      if (item.log_as === 'lift') {
        const load = num(req.body.load_lb) ?? set.load_lb;
        if (load == null) return res.status(400).json({ error: 'enter the load you used — this lift had no prescribed load' });
        if (reps == null) return res.status(400).json({ error: 'reps required' });
        const row = (await q('INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps, rpe) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [date, item.movement, load, reps, set.rpe ?? null]))[0];
        entry = { table: 'lifts', id: row.id, reps, load_lb: load };
      } else if (item.log_as === 'gymnastics') {
        if (reps == null) return res.status(400).json({ error: 'reps required' });
        const row = (await q('INSERT INTO fitness_gymnastics (entry_date, movement, reps, notes) VALUES ($1, $2, $3, $4) RETURNING id',
          [date, item.movement, reps, item.notes || null]))[0];
        entry = { table: 'gymnastics', id: row.id, reps };
      } else if (item.log_as === 'conditioning') {
        const row = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [date, item.movement, set.distance_m ?? null, set.duration_s ?? null, item.prescription || null]))[0];
        entry = { table: 'conditioning', id: row.id };
      } else if (item.log_as === 'engine' || item.log_as === 'test') {
        const output = num(req.body.output) ?? (item.log_as === 'engine' ? set.target : null);
        if (output == null || output < 0 || (item.log_as === 'test' && output <= 0)) return res.status(400).json({ error: `enter your ${set.unit === 'm' ? 'meters' : 'calories'} for this interval` });
        const n = item.sets.length;
        const label = item.log_as === 'test' ? block.title : `${block.title} ${si + 1}/${n}`;
        const pctTxt = set.target ? `, target ${set.target} (${Math.round((output / set.target) * 100)}%)` : '';
        const row = (await q('INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [date, item.movement, set.unit === 'm' ? output : null, set.duration_s ?? null, `${label}: ${output} ${set.unit}${pctTxt}`]))[0];
        entry = { table: 'conditioning', id: row.id, output };
        set.actual = output;
      } else {
        return res.status(400).json({ error: `unknown log_as ${item.log_as}` });
      }
      set.entry = entry;
      if (item.log_as === 'test') await syncEngineTest(w, block, item);
      res.json(await saveBody(w.id, w.body));
    } catch (err) { fail(res, err); }
  }));

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
      const b = (await q('INSERT INTO fitness_benchmarks (entry_date, name, result) VALUES ($1, $2, $3) RETURNING id',
        [w.date, `Metcon: ${block.title}`, result]))[0];
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
          summary: 'Casino Royale physique (lean, V-taper — shoulder:waist is the key ratio) and top of the local CrossFit leaderboard; continuous lean gain, no cut.',
        },
        bodyweight_lb: bw ? num(bw.weight_lb) : null,
        measurements_in: m ? Object.fromEntries(MEASUREMENT_FIELDS.filter((f) => m[f] != null).map((f) => [f, num(m[f])])) : null,
        strength_scores: ctx.strengthPatterns,
        e1rm_60d_lb: Object.fromEntries(Object.entries(ctx.e1rm).map(([k, v]) => [k, Math.round(v)])),
        gymnastics_best_set_60d: ctx.gymBest,
        engine_baselines: baselines,
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
