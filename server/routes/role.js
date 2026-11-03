'use strict';
// The Andrew page (Jake, 2026-11-03: "integrated into self hub as its own page, integrating the full bnd courses
// there, and ensuring there is plenty of guidance, reassurance, and inspiration along the way").
//
//   GET /api/fitness/role                 → the page: today's scene, the courses he's on with their director's notes,
//                                            every BND course by level with what it gives the character, the inner
//                                            life, the look, the notebook
//   PUT /api/fitness/role/notebook/:id    { answer } → one notebook answer saved
//
// The Bond module comes from the Trinity Degree through Sentinel (GET {SENTINEL_URL}/v1/role with Self Hub's key):
// Trinity owns the courses and progress, Sentinel writes the director's notes. The last good read is kept in
// role_cache so the page still shows the courses when either is down. The words are lib/role.js.

const express = require('express');
const R = require('../lib/role');

const FRESH_MS = 10 * 60 * 1000;
const regina = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

function createRoleRouter({ pool, env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
  const router = express.Router();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function trinity(fresh) {
    const cached = (await q('SELECT data, fetched_at FROM role_cache WHERE id = 1'))[0] || null;
    const age = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
    if (cached && age < FRESH_MS && !fresh) return { ...cached.data, fetched_at: cached.fetched_at };
    const url = (env.SENTINEL_URL || '').trim().replace(/\/+$/, '');
    const key = (env.SENTINEL_API_KEY || '').trim();
    if (!url || !key) return cached ? { ...cached.data, fetched_at: cached.fetched_at, stale: true } : { error: "Sentinel isn't connected, so the Trinity courses can't be read" };
    try {
      const res = await fetchImpl(`${url}/v1/role${fresh ? '?fresh=1' : ''}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.courses)) throw new Error((data && data.error && (data.error.message || data.error)) || `Sentinel said ${res.status}`);
      await pool.query(`INSERT INTO role_cache (id, data, fetched_at) VALUES (1, $1::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`, [JSON.stringify(data)]);
      return { ...data, fetched_at: new Date().toISOString() };
    } catch (err) {
      if (cached) return { ...cached.data, fetched_at: cached.fetched_at, stale: true };
      return { error: `Couldn't read the Trinity courses right now (${err.message})` };
    }
  }

  router.get('/role', async (req, res) => {
    try {
      const today = regina();
      const [t, notes] = await Promise.all([trinity(req.query.fresh === '1'), q('SELECT question_id, answer, updated_at FROM role_notebook')]);
      const answers = Object.fromEntries(notes.map((n) => [n.question_id, { answer: n.answer, updated_at: n.updated_at }]));
      const courses = (t.courses || []).map((c) => ({ ...c, role: R.COURSE_ROLE[c.code] || null }));
      const current = (t.current || []).map((c) => ({ ...c, role: R.COURSE_ROLE[c.code] || null, reassurance_line: R.reassuranceFor(c.state, today, c.code) }));
      const levels = Object.entries(R.LEVELS).map(([n, [title, about]]) => ({ level: Number(n), title, about, courses: courses.filter((c) => c.level === Number(n)) }))
        .filter((l) => l.courses.length || !courses.length);
      const count = (s) => courses.filter((c) => c.status === s).length;
      res.json({
        today, scene: R.todaysScene(today),
        trinity: { error: t.error || null, stale: !!t.stale, fetched_at: t.fetched_at || null, url: t.trinity_url || null, week: t.degree && t.degree.week || null },
        totals: { courses: courses.length, complete: count('complete'), in_progress: count('in_progress') + count('submitted'), not_loaded: count('not_loaded') },
        current, levels,
        inner: { forces: R.FORCES, shadow: R.SHADOW, shadow_rule: R.SHADOW_RULE, arc: R.ARC, arc_insight: R.ARC_INSIGHT, method: R.METHOD },
        look: R.LOOK, study: R.STUDY,
        notebook: R.QUESTIONS.map((x) => ({ ...x, answer: answers[x.id] ? answers[x.id].answer : '', updated_at: answers[x.id] ? answers[x.id].updated_at : null })),
        artifacts: R.ARTIFACTS,
      });
    } catch (err) {
      console.error('role route failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  router.put('/role/notebook/:id', async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!R.QUESTIONS.some((x) => x.id === id)) return res.status(404).json({ error: 'No such question' });
      const answer = String((req.body && req.body.answer) || '').slice(0, 8000);
      const rows = await q(`INSERT INTO role_notebook (question_id, answer, updated_at) VALUES ($1, $2, now())
        ON CONFLICT (question_id) DO UPDATE SET answer = EXCLUDED.answer, updated_at = now() RETURNING question_id, answer, updated_at`, [id, answer]);
      res.json(rows[0]);
    } catch (err) {
      console.error('role notebook failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  });

  return router;
}

module.exports = { createRoleRouter };
