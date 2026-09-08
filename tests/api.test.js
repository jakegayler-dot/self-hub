const { newDb } = require('pg-mem');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// build an in-memory postgres and get a pg-compatible adapter
const mem = newDb({ autoCreateForeignKeyIndices: true });
const pgAdapter = mem.adapters.createPg();

// hijack require('pg') so server/db.js picks up the in-memory adapter
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return 'pg-mem-shim';
  return origResolve.call(this, request, ...args);
};
require.cache['pg-mem-shim'] = { id: 'pg-mem-shim', filename: 'pg-mem-shim', loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';
process.env.PORT = '8842';

const { runMigrations, pool } = require('../server/db');
const express = require('express');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');

async function main() {
  await runMigrations();
  console.log('migrations ran OK');

  const app = express();
  app.use(express.json());
  app.get('/healthz', (req, res) => res.status(200).send('ok'));
  app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  const server = app.listen(8842, async () => {
    const base = 'http://localhost:8842';
    const auth = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
    const badAuth = 'Basic ' + Buffer.from('jake:wrong').toString('base64');

    function req(method, urlPath, body, authHeader) {
      return fetch(base + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', ...(authHeader ? { Authorization: authHeader } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    // health check unauthenticated
    let r = await fetch(base + '/healthz');
    console.log('healthz (no auth):', r.status, await r.text());

    // no auth on API -> 401
    r = await req('GET', '/api/fitness/profile', null, null);
    console.log('profile no auth:', r.status);

    // wrong auth -> 401
    r = await req('GET', '/api/fitness/profile', null, badAuth);
    console.log('profile wrong auth:', r.status);

    // correct auth -> profile
    r = await req('GET', '/api/fitness/profile', null, auth);
    console.log('profile ok:', r.status, JSON.stringify(await r.json()));

    // log bodyweight entries
    r = await req('POST', '/api/fitness/bodyweight', { entry_date: '2026-09-01', weight_lb: 160.5, body_fat_pct: 9.8 }, auth);
    console.log('bw post 1:', r.status);
    r = await req('POST', '/api/fitness/bodyweight', { entry_date: '2026-09-08', weight_lb: 161.2 }, auth);
    console.log('bw post 2:', r.status);

    // bad bodyweight (missing weight) -> 400
    r = await req('POST', '/api/fitness/bodyweight', { entry_date: '2026-09-09' }, auth);
    console.log('bw post invalid (expect 400):', r.status);

    // log a lift
    r = await req('POST', '/api/fitness/lifts', { entry_date: '2026-09-08', lift: 'Back squat', load_lb: 225, reps: 5, rpe: 8 }, auth);
    console.log('lift post:', r.status);

    // log a benchmark
    r = await req('POST', '/api/fitness/benchmarks', { entry_date: '2026-09-08', name: 'Fran', result: '4:12' }, auth);
    console.log('benchmark post:', r.status);

    // set phase
    r = await req('PUT', '/api/fitness/profile', { phase: 1 }, auth);
    const profileAfter = await r.json();
    console.log('phase set:', r.status, 'phase now', profileAfter.phase);

    // summary
    r = await req('GET', '/api/fitness/summary', null, auth);
    const summary = await r.json();
    console.log('summary:', JSON.stringify(summary, null, 2));

    // coach prompt
    r = await req('GET', '/api/fitness/coach-prompt', null, auth);
    const cp = await r.json();
    console.log('coach prompt includes phase 1:', /Phase 1/.test(cp.prompt));
    console.log('coach prompt includes squat lift:', /Back squat 225x5/.test(cp.prompt));
    console.log('coach prompt includes body fat:', /9.8%/.test(cp.prompt));
    console.log('coach prompt includes benchmark:', /Fran — 4:12/.test(cp.prompt));

    // list + delete
    r = await req('GET', '/api/fitness/bodyweight', null, auth);
    const bwList = await r.json();
    console.log('bodyweight count:', bwList.length);
    r = await req('DELETE', '/api/fitness/bodyweight/' + bwList[0].id, null, auth);
    console.log('delete bw:', r.status);
    r = await req('GET', '/api/fitness/bodyweight', null, auth);
    console.log('bodyweight count after delete:', (await r.json()).length);

    server.close();
    console.log('ALL TESTS COMPLETE');
  });
}
main().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
