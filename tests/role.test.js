// The Andrew page (2026-11-03): the role's words, the Trinity Bond courses through Sentinel (kept when Sentinel is
// down), and the actor's notebook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-role' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-role'] = { id: 'pg-mem-shim-role', filename: 'pg-mem-shim-role', loaded: true, exports: pgAdapter };
process.env.DATABASE_URL = 'postgres://fake/fake';

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { createRoleRouter } = require('../server/routes/role');
const R = require('../server/lib/role');

const SENTINEL = {
  generated_at: '2026-11-03T15:00:00Z', trinity_url: 'https://trinity.test',
  courses: [
    { code: 'BND-101', id: 'b101', label: 'The Standard', level: 1, status: 'in_progress', steps_done: 0, steps_total: 25, project: 'The physique', url: 'https://trinity.test/#/c/b101/sessions' },
    { code: 'BND-108', id: 'b108', label: 'Spanish', level: 1, status: 'in_progress', steps_done: 2, steps_total: 17 },
    { code: 'BND-212', id: 'b212', label: 'The Motorcycle', level: 2, status: 'not_loaded', steps_done: 0, steps_total: 5 },
    { code: 'BND-501', id: 'b501', label: 'The Standing Life', level: 5, status: 'not_loaded', steps_done: 0, steps_total: 4 },
  ],
  current: [
    { code: 'BND-101', label: 'The Standard', state: 'stalled', session: { n: 0, title: 'Session 0 — Course introduction', due: '2026-11-23' },
      note: { why: 'w', this_session: 't', reassurance: 'r', inspiration: 'i' } },
    { code: 'BND-108', label: 'Spanish', state: 'moving', session: null, note: null },
  ],
};
let sentinelUp = true; let calls = 0;
const fetchImpl = async (url, opts) => {
  calls++;
  assert.equal(opts.headers.Authorization, 'Bearer sk');
  assert.match(url, /^https:\/\/sentinel\.test\/v1\/role/);
  if (!sentinelUp) throw new Error('down');
  return { ok: true, status: 200, json: async () => SENTINEL };
};

let server; let base;
test.before(async () => {
  await runMigrations();
  const app = express();
  app.use(express.json());
  app.use('/api/fitness', createRoleRouter({ pool, env: { SENTINEL_URL: 'https://sentinel.test/', SENTINEL_API_KEY: 'sk' }, fetchImpl }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/fitness`;
});
test.after(() => new Promise((r) => server.close(r)));
const get = async (p) => { const r = await fetch(base + p); return [r.status, await r.json()]; };

test('every Bond course has its place in the character; the words never quote', () => {
  // Trinity's curriculum, where it's checked out next to this repo (Jake's machine).
  const cur = path.join(__dirname, '..', '..', 'trinity-platform', 'data', 'curriculum.json');
  const codes = fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8').match(/"code": "BND-\d+"/g) : null;
  if (fs.existsSync(cur)) assert.ok(codes && codes.length >= 48);
  if (codes) for (const c of new Set(codes.map((x) => x.slice(9, -1)))) assert.ok(R.COURSE_ROLE[c], `${c} has a role line`);
  assert.equal(R.FORCES.length, 10);
  for (const f of R.FORCES) for (const k of ['title', 'body', 'shows', 'actor']) assert.ok(f[k], `${f.id}.${k}`);
  for (const s of ['not started', 'stalled', 'overdue', 'moving', 'complete']) assert.ok(R.REASSURANCE[s].length);
  assert.equal(R.todaysScene('2026-11-03').force, R.todaysScene('2026-11-03').force);
  assert.notEqual(R.todaysScene('2026-11-03').force, R.todaysScene('2026-11-04').force);
});

test('the page: today\'s scene, the courses he\'s on with notes and reassurance, every course by level', async () => {
  const [status, d] = await get('/role');
  assert.equal(status, 200);
  assert.ok(d.scene.force.title);
  assert.deepEqual(d.totals, { courses: 4, complete: 0, in_progress: 2, not_loaded: 2 });
  assert.equal(d.current[0].note.reassurance, 'r');
  assert.ok(R.REASSURANCE.moving.includes(d.current[1].reassurance_line), 'no note yet: the reassurance for its state');
  assert.equal(d.current[0].role, R.COURSE_ROLE['BND-101']);
  assert.deepEqual(d.levels.map((l) => l.level), [1, 2, 5]);
  assert.equal(d.levels[0].courses[1].role, R.COURSE_ROLE['BND-108']);
  assert.equal(d.notebook[0].id, 'super_objective');
  assert.equal(d.trinity.stale, false);
});

test('kept when Sentinel is down; fresh asks again', async () => {
  const before = calls;
  await get('/role');
  assert.equal(calls, before, 'ten minutes: from the cache');
  sentinelUp = false;
  const [, d] = await get('/role?fresh=1');
  assert.equal(calls, before + 1);
  assert.equal(d.trinity.stale, true);
  assert.equal(d.totals.courses, 4);
  sentinelUp = true;
});

test('the notebook: saved, kept, unknown questions refused', async () => {
  const put = (id, answer) => fetch(`${base}/role/notebook/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) });
  assert.equal((await put('survived', 'Calving at forty below.')).status, 200);
  assert.equal((await put('survived', 'Calving at forty below, alone.')).status, 200);
  assert.equal((await put('nope', 'x')).status, 404);
  const [, d] = await get('/role');
  assert.equal(d.notebook.find((q) => q.id === 'survived').answer, 'Calving at forty below, alone.');
});
