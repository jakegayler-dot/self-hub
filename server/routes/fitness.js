const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const MEASUREMENT_FIELDS = ['arm_length', 'bust', 'shoulder', 'length', 'waist', 'seat_hips', 'neck', 'sleeve', 'inseam_low', 'inseam_high'];

// ---- profile / phase ----
router.get('/profile', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM fitness_profile WHERE id = 1');
  res.json(rows[0]);
});

router.put('/profile', async (req, res) => {
  const { phase, body_fat_target, bodyweight_goal_lb, leaderboard_goal } = req.body;
  if (phase !== undefined && (phase < 0 || phase > 4)) {
    return res.status(400).json({ error: 'phase must be 0-4' });
  }
  const { rows } = await pool.query(
    `UPDATE fitness_profile SET
       phase = COALESCE($1, phase),
       body_fat_target = COALESCE($2, body_fat_target),
       bodyweight_goal_lb = COALESCE($3, bodyweight_goal_lb),
       leaderboard_goal = COALESCE($4, leaderboard_goal),
       updated_at = now()
     WHERE id = 1 RETURNING *`,
    [phase ?? null, body_fat_target ?? null, bodyweight_goal_lb ?? null, leaderboard_goal ?? null]
  );
  res.json(rows[0]);
});

// ---- bodyweight ----
router.get('/bodyweight', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC'
  );
  res.json(rows);
});

router.post('/bodyweight', async (req, res) => {
  const { entry_date, weight_lb, body_fat_pct } = req.body;
  if (!isValidDate(entry_date) || num(weight_lb) === null) {
    return res.status(400).json({ error: 'entry_date (YYYY-MM-DD) and weight_lb are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO fitness_bodyweight (entry_date, weight_lb, body_fat_pct)
     VALUES ($1, $2, $3) RETURNING id, entry_date, weight_lb, body_fat_pct`,
    [entry_date, num(weight_lb), num(body_fat_pct)]
  );
  res.status(201).json(rows[0]);
});

router.delete('/bodyweight/:id', async (req, res) => {
  await pool.query('DELETE FROM fitness_bodyweight WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// ---- lifts ----
router.get('/lifts', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, entry_date, lift, load_lb, reps, rpe FROM fitness_lifts ORDER BY entry_date ASC'
  );
  res.json(rows);
});

router.post('/lifts', async (req, res) => {
  const { entry_date, lift, load_lb, reps, rpe } = req.body;
  if (!isValidDate(entry_date) || !lift || num(load_lb) === null || num(reps) === null) {
    return res.status(400).json({ error: 'entry_date, lift, load_lb and reps are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps, rpe)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, entry_date, lift, load_lb, reps, rpe`,
    [entry_date, lift, num(load_lb), num(reps), num(rpe)]
  );
  res.status(201).json(rows[0]);
});

router.delete('/lifts/:id', async (req, res) => {
  await pool.query('DELETE FROM fitness_lifts WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// rename/merge a lift name across all logged entries (e.g. merge "Shoulder Press" into "Strict Press")
router.put('/lifts/rename', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'from and to are required' });
  }
  if (from === to) {
    return res.json({ renamed: 0 });
  }
  const { rowCount } = await pool.query(
    'UPDATE fitness_lifts SET lift = $1 WHERE lift = $2',
    [to, from]
  );
  res.json({ renamed: rowCount });
});

// ---- benchmarks ----
router.get('/benchmarks', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, entry_date, name, result FROM fitness_benchmarks ORDER BY entry_date ASC'
  );
  res.json(rows);
});

router.post('/benchmarks', async (req, res) => {
  const { entry_date, name, result } = req.body;
  if (!isValidDate(entry_date) || !name || !result) {
    return res.status(400).json({ error: 'entry_date, name and result are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO fitness_benchmarks (entry_date, name, result)
     VALUES ($1, $2, $3) RETURNING id, entry_date, name, result`,
    [entry_date, name, result]
  );
  res.status(201).json(rows[0]);
});

router.delete('/benchmarks/:id', async (req, res) => {
  await pool.query('DELETE FROM fitness_benchmarks WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// ---- benchmark lifts: which lifts count as indicator lifts for the strength profile ----
router.get('/benchmark-lifts', async (req, res) => {
  const { rows } = await pool.query('SELECT lift FROM fitness_benchmark_lifts ORDER BY lift ASC');
  res.json(rows.map((r) => r.lift));
});

router.post('/benchmark-lifts', async (req, res) => {
  const { lift } = req.body;
  if (typeof lift !== 'string' || !lift.trim()) {
    return res.status(400).json({ error: 'lift is required' });
  }
  await pool.query('INSERT INTO fitness_benchmark_lifts (lift) VALUES ($1) ON CONFLICT (lift) DO NOTHING', [lift.trim()]);
  res.status(201).json({ lift: lift.trim() });
});

router.delete('/benchmark-lifts/:lift', async (req, res) => {
  await pool.query('DELETE FROM fitness_benchmark_lifts WHERE lift = $1', [req.params.lift]);
  res.status(204).end();
});

// ---- summary: the computed dashboard state, and the future Sentinel read surface ----
router.get('/summary', async (req, res) => {
  const profile = (await pool.query('SELECT * FROM fitness_profile WHERE id = 1')).rows[0];
  const bw = (await pool.query(
    'SELECT entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC'
  )).rows;
  const lifts = (await pool.query(
    'SELECT entry_date, lift, load_lb, reps, rpe FROM fitness_lifts ORDER BY entry_date ASC'
  )).rows;

  const last7 = bw.slice(-7);
  const avg7 = last7.length
    ? Math.round((last7.reduce((s, x) => s + Number(x.weight_lb), 0) / last7.length) * 10) / 10
    : null;

  let weeklyRate = null;
  if (bw.length >= 2) {
    const first = bw[0];
    const last = bw[bw.length - 1];
    const days = (new Date(last.entry_date) - new Date(first.entry_date)) / 86400000;
    if (days > 0) {
      weeklyRate = Math.round(((Number(last.weight_lb) - Number(first.weight_lb)) / (days / 7)) * 100) / 100;
    }
  }

  const latestBf = [...bw].reverse().find((x) => x.body_fat_pct !== null);
  const lastByLift = {};
  for (const l of lifts) lastByLift[l.lift] = l;

  const benchmarkLiftNames = (await pool.query('SELECT lift FROM fitness_benchmark_lifts')).rows.map((r) => r.lift);
  const bestByLift = {};
  for (const l of lifts) {
    if (!benchmarkLiftNames.includes(l.lift)) continue;
    const e1rm = Math.round(Number(l.load_lb) * (1 + Number(l.reps) / 30) * 10) / 10;
    if (!bestByLift[l.lift] || e1rm > bestByLift[l.lift].e1rm) {
      bestByLift[l.lift] = { entry_date: l.entry_date, load_lb: Number(l.load_lb), reps: l.reps, e1rm };
    }
  }

  const measurements = (await pool.query(
    `SELECT entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements ORDER BY entry_date DESC LIMIT 1`
  )).rows;
  const latestMeasurement = measurements[0] || null;
  const shoulderWaistRatio = latestMeasurement && latestMeasurement.shoulder && latestMeasurement.waist
    ? Math.round((Number(latestMeasurement.shoulder) / Number(latestMeasurement.waist)) * 100) / 100
    : null;

  res.json({
    phase: profile.phase,
    targets: {
      body_fat_pct: Number(profile.body_fat_target),
      bodyweight_goal_lb: profile.bodyweight_goal_lb ? Number(profile.bodyweight_goal_lb) : null,
      leaderboard_goal: profile.leaderboard_goal,
    },
    bodyweight_7day_avg_lb: avg7,
    bodyweight_weekly_rate_lb: weeklyRate,
    latest_body_fat_pct: latestBf ? Number(latestBf.body_fat_pct) : null,
    latest_lifts: lastByLift,
    benchmark_lift_bests: bestByLift,
    latest_measurements: latestMeasurement,
    shoulder_waist_ratio: shoulderWaistRatio,
    entry_counts: { bodyweight: bw.length, lifts: lifts.length, measurements: measurements.length },
  });
});

// ---- clothing measurements ----

router.get('/measurements', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements ORDER BY entry_date ASC`
  );
  res.json(rows);
});

router.post('/measurements', async (req, res) => {
  const { entry_date } = req.body;
  if (!isValidDate(entry_date)) {
    return res.status(400).json({ error: 'entry_date is required' });
  }
  const values = MEASUREMENT_FIELDS.map((f) => num(req.body[f]));
  if (values.every((v) => v === null)) {
    return res.status(400).json({ error: 'at least one measurement is required' });
  }
  const cols = MEASUREMENT_FIELDS.join(', ');
  const placeholders = MEASUREMENT_FIELDS.map((_, i) => `$${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO fitness_measurements (entry_date, ${cols})
     VALUES ($1, ${placeholders}) RETURNING id, entry_date, ${cols}`,
    [entry_date, ...values]
  );
  res.status(201).json(rows[0]);
});

router.delete('/measurements/:id', async (req, res) => {
  await pool.query('DELETE FROM fitness_measurements WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

// ---- coach notes: write-back channel for Sentinel's persistent output ----
router.get('/coach-notes', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, entry_date, source, note FROM fitness_coach_notes ORDER BY entry_date DESC, id DESC LIMIT 100'
  );
  res.json(rows);
});

router.post('/coach-notes', async (req, res) => {
  const { entry_date, note } = req.body;
  const source = typeof req.body.source === 'string' && req.body.source.trim() ? req.body.source.trim() : (req.isSentinel ? 'sentinel' : 'manual');
  if (!isValidDate(entry_date) || typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'entry_date and note are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO fitness_coach_notes (entry_date, source, note)
     VALUES ($1, $2, $3) RETURNING id, entry_date, source, note`,
    [entry_date, source, note.trim()]
  );
  res.status(201).json(rows[0]);
});

router.delete('/coach-notes/:id', async (req, res) => {
  await pool.query('DELETE FROM fitness_coach_notes WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

router.get('/coach-prompt', async (req, res) => {
  const profile = (await pool.query('SELECT * FROM fitness_profile WHERE id = 1')).rows[0];
  const bw = (await pool.query(
    'SELECT entry_date, weight_lb, body_fat_pct FROM fitness_bodyweight ORDER BY entry_date ASC'
  )).rows;
  const lifts = (await pool.query(
    'SELECT entry_date, lift, load_lb, reps, rpe FROM fitness_lifts ORDER BY entry_date DESC LIMIT 6'
  )).rows;
  const benchmarks = (await pool.query(
    'SELECT entry_date, name, result FROM fitness_benchmarks ORDER BY entry_date DESC LIMIT 3'
  )).rows;
  const priorNotes = (await pool.query(
    'SELECT entry_date, source, note FROM fitness_coach_notes ORDER BY entry_date DESC, id DESC LIMIT 3'
  )).rows;
  const measurements = (await pool.query(
    `SELECT entry_date, ${MEASUREMENT_FIELDS.join(', ')} FROM fitness_measurements ORDER BY entry_date DESC LIMIT 2`
  )).rows;
  const benchmarkLiftNames = (await pool.query('SELECT lift FROM fitness_benchmark_lifts')).rows.map((r) => r.lift);
  const allLifts = (await pool.query('SELECT entry_date, lift, load_lb, reps FROM fitness_lifts ORDER BY entry_date ASC')).rows;
  const bestByLift = {};
  for (const l of allLifts) {
    if (!benchmarkLiftNames.includes(l.lift)) continue;
    const e1rm = Math.round(Number(l.load_lb) * (1 + Number(l.reps) / 30) * 10) / 10;
    if (bestByLift[l.lift] == null || e1rm > bestByLift[l.lift]) bestByLift[l.lift] = e1rm;
  }

  const last7 = bw.slice(-7);
  const avg7 = last7.length
    ? Math.round((last7.reduce((s, x) => s + Number(x.weight_lb), 0) / last7.length) * 10) / 10
    : null;
  const latestBf = [...bw].reverse().find((x) => x.body_fat_pct !== null);

  const phaseNames = ['Phase 0 (Assess)', 'Phase 1 (Foundation Build)', 'Phase 2 (Shape Build)', 'Phase 3 (Sharpen)', 'Maintain'];
  const recentLifts = lifts.length
    ? lifts.map((l) => `${l.entry_date.toISOString().slice(0, 10)}: ${l.lift} ${l.load_lb}x${l.reps}${l.rpe ? ` @RPE${l.rpe}` : ''}`).join('\n')
    : '(none logged)';
  const recentBm = benchmarks.length
    ? benchmarks.map((b) => `${b.entry_date.toISOString().slice(0, 10)}: ${b.name} — ${b.result}`).join('\n')
    : '(none logged)';
  const recentNotes = priorNotes.length
    ? priorNotes.map((n) => `${n.entry_date.toISOString().slice(0, 10)} (${n.source}): ${n.note}`).join('\n')
    : '(none yet)';
  const fmtMeasurement = (m) => {
    const parts = [];
    if (m.shoulder) parts.push(`shoulder ${Number(m.shoulder)}"`);
    if (m.waist) parts.push(`waist ${Number(m.waist)}"`);
    if (m.shoulder && m.waist) parts.push(`ratio ${(Number(m.shoulder) / Number(m.waist)).toFixed(2)}`);
    if (m.bust) parts.push(`bust ${Number(m.bust)}"`);
    if (m.arm_length) parts.push(`arm ${Number(m.arm_length)}"`);
    if (m.sleeve) parts.push(`sleeve ${Number(m.sleeve)}"`);
    if (m.neck) parts.push(`neck ${Number(m.neck)}"`);
    if (m.seat_hips) parts.push(`seat/hips ${Number(m.seat_hips)}"`);
    if (m.length) parts.push(`length ${Number(m.length)}"`);
    if (m.inseam_low || m.inseam_high) parts.push(`inseam ${m.inseam_low ?? '?'}–${m.inseam_high ?? '?'}"`);
    return `${m.entry_date.toISOString().slice(0, 10)}: ${parts.join(', ')}`;
  };
  const recentMeasurements = measurements.length
    ? measurements.map(fmtMeasurement).join('\n')
    : '(none logged)';
  const bestLiftLines = Object.keys(bestByLift).length
    ? Object.entries(bestByLift).sort((a, b) => a[0].localeCompare(b[0])).map(([name, e1rm]) => `${name}: ~${e1rm} lb e1RM`).join('\n')
    : '(no benchmark lifts logged yet)';

  const prompt = `You are my strength and conditioning coach. I started underweight and lean. My targets are the Casino Royale build (lean with a real V-taper, body fat ${profile.body_fat_target}%) and top of the leaderboard at my local CrossFit box. I am running a continuous lean gain — there is no cut in my programme. I am in ${phaseNames[profile.phase]}.

My data:
- Bodyweight (7-day avg): ${avg7 ? avg7 + ' lb' : 'not enough data yet'}
- Body fat: ${latestBf ? Number(latestBf.body_fat_pct) + '%' : 'not logged'}
- Recent lifts:
${recentLifts}
- Benchmark lift bests (estimated 1RM, Epley formula, all-time):
${bestLiftLines}
- Recent benchmarks:
${recentBm}
- Clothing measurements (shoulder:waist ratio is my V-taper signal):
${recentMeasurements}
- Your own recent notes to me:
${recentNotes}

Review my week: am I gaining at 0.25–0.5 lb/week, is my body fat holding, is my accessory work biased to delts and lats, and am I recovering? Push back if I'm under-eating — that is my most likely failure mode. Post any new note or recommendation back via POST /api/fitness/coach-notes so it carries into next time.`;

  res.json({ prompt });
});

module.exports = router;
