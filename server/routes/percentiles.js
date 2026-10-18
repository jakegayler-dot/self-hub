// CrossFit / Concept2 percentiles (mounted under /api/fitness).
//
//   GET    /percentiles          categories + every benchmark: your best, % beaten, reference
//   GET    /open-results
//   POST   /open-results         { year, workout, division, rank, total, score? }
//   DELETE /open-results/:id
const express = require('express');
const strength = require('../lib/strength');
const { computePercentiles } = require('../lib/percentiles');

async function loadPercentileRows(pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  const [lifts, gymnastics, conditioning, benchmarks, open, bodyweight] = await Promise.all([
    q('SELECT entry_date, lift, load_lb, reps FROM fitness_lifts ORDER BY entry_date ASC'),
    q('SELECT entry_date, movement, reps FROM fitness_gymnastics ORDER BY entry_date ASC'),
    q('SELECT entry_date, movement, distance_m, duration_seconds FROM fitness_conditioning ORDER BY entry_date ASC'),
    q('SELECT entry_date, name, result, rx FROM fitness_benchmarks ORDER BY entry_date ASC'),
    q('SELECT id, year, workout, division, rank, total, score FROM fitness_open_results ORDER BY year DESC, id ASC'),
    q('SELECT entry_date, weight_lb FROM fitness_bodyweight ORDER BY entry_date ASC'),
  ]);
  return { lifts, gymnastics, conditioning, benchmarks, open, bodyweight };
}

// Regina is UTC−6 year-round — "today" there, not on the server's UTC clock.
function reginaToday() { return new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); }

function createPercentilesRouter({ pool }) {
  const router = express.Router();

  router.get('/percentiles', async (req, res) => {
    try {
      const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : reginaToday();
      res.json(computePercentiles(await loadPercentileRows(pool), today, strength));
    } catch (err) {
      console.error('percentiles failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  router.get('/open-results', async (req, res) => {
    const { rows } = await pool.query('SELECT id, year, workout, division, rank, total, score FROM fitness_open_results ORDER BY year DESC, id ASC');
    res.json(rows);
  });

  router.post('/open-results', async (req, res) => {
    const b = req.body || {};
    const year = Number(b.year); const rank = Number(b.rank); const total = Number(b.total);
    const workout = typeof b.workout === 'string' ? b.workout.trim().toLowerCase().slice(0, 20) : '';
    const division = typeof b.division === 'string' ? b.division.trim().slice(0, 60) : '';
    if (!Number.isInteger(year) || year < 2011 || year > 2100) return res.status(400).json({ error: 'year is required (e.g. 2026)' });
    if (!workout) return res.status(400).json({ error: 'workout is required: "overall" or e.g. "26.1"' });
    if (!division) return res.status(400).json({ error: 'division is required (e.g. "Men 35-39" or "Men")' });
    if (!Number.isInteger(rank) || rank < 1 || !Number.isInteger(total) || total < rank) return res.status(400).json({ error: 'rank and total athletes are required, with rank ≤ total' });
    const score = typeof b.score === 'string' && b.score.trim() ? b.score.trim().slice(0, 60) : null;
    const { rows } = await pool.query(
      'INSERT INTO fitness_open_results (year, workout, division, rank, total, score) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, year, workout, division, rank, total, score',
      [year, workout, division, rank, total, score]
    );
    res.status(201).json(rows[0]);
  });

  router.delete('/open-results/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    await pool.query('DELETE FROM fitness_open_results WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  });

  return router;
}

module.exports = { createPercentilesRouter, loadPercentileRows, reginaToday };
