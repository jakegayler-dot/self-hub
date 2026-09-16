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
process.env.SENTINEL_USER = 'sentinel';
process.env.SENTINEL_PASS = 'sentinelpass456';
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

    // benchmark lifts: seeded defaults + custom add/remove
    r = await req('GET', '/api/fitness/benchmark-lifts', null, auth);
    const seededBench = await r.json();
    console.log('benchmark lifts seeded, includes Back Squat:', seededBench.includes('Back Squat'));

    r = await req('POST', '/api/fitness/benchmark-lifts', { lift: 'Back squat' }, auth);
    console.log('benchmark lift add (custom-cased):', r.status);

    r = await req('POST', '/api/fitness/lifts', { entry_date: '2026-09-01', lift: 'Back squat', load_lb: 205, reps: 8 }, auth);
    console.log('lift post 2 (for e1RM check):', r.status);

    r = await req('DELETE', '/api/fitness/benchmark-lifts/' + encodeURIComponent('Front Squat'), null, auth);
    console.log('benchmark lift remove:', r.status);

    r = await req('GET', '/api/fitness/benchmark-lifts', null, auth);
    const benchAfter = await r.json();
    console.log('benchmark lifts after edit, Front Squat removed:', !benchAfter.includes('Front Squat'), 'Back squat present:', benchAfter.includes('Back squat'));

    // log a benchmark
    r = await req('POST', '/api/fitness/benchmarks', { entry_date: '2026-09-08', name: 'Fran', result: '4:12' }, auth);
    console.log('benchmark post:', r.status);

    // log clothing measurements
    r = await req('POST', '/api/fitness/measurements', {
      entry_date: '2026-09-08', arm_length: 22, bust: 37, shoulder: 18, length: 23,
      waist: 29.5, seat_hips: 34, neck: 13.5, sleeve: 32, inseam_low: 29, inseam_high: 30
    }, auth);
    const measurementCreated = await r.json();
    console.log('measurements post:', r.status);

    // conditioning: row/run tracked by distance/duration instead of load
    r = await req('POST', '/api/fitness/conditioning', { entry_date: '2026-09-08', movement: 'Row', distance_m: 2000, duration_seconds: 420 }, auth);
    console.log('conditioning post (distance+duration):', r.status);

    r = await req('POST', '/api/fitness/conditioning', { entry_date: '2026-09-09', movement: 'Run', duration_seconds: 1800 }, auth);
    console.log('conditioning post (duration only):', r.status);

    r = await req('POST', '/api/fitness/conditioning', { entry_date: '2026-09-09', movement: 'Bike' }, auth);
    console.log('conditioning post no distance/duration (expect 400):', r.status);

    r = await req('GET', '/api/fitness/conditioning', null, auth);
    const conditioningList = await r.json();
    console.log('conditioning list count:', conditioningList.length);

    r = await req('DELETE', '/api/fitness/conditioning/' + conditioningList[0].id, null, auth);
    console.log('conditioning delete:', r.status);

    // measurements with no fields at all -> 400
    r = await req('POST', '/api/fitness/measurements', { entry_date: '2026-09-08' }, auth);
    console.log('measurements post empty (expect 400):', r.status);

    r = await req('GET', '/api/fitness/measurements', null, auth);
    console.log('measurements list count:', (await r.json()).length);

    // set phase
    r = await req('PUT', '/api/fitness/profile', { phase: 1 }, auth);
    const profileAfter = await r.json();
    console.log('phase set:', r.status, 'phase now', profileAfter.phase);

    // weekly training-load goals: defaults, then edit
    console.log('weekly goal defaults: strength', profileAfter.weekly_strength_sessions_goal, 'conditioning', profileAfter.weekly_conditioning_sessions_goal);

    r = await req('PUT', '/api/fitness/profile', { weekly_strength_sessions_goal: 5, weekly_conditioning_sessions_goal: 3 }, auth);
    const profileGoalsSet = await r.json();
    console.log('weekly goals updated:', profileGoalsSet.weekly_strength_sessions_goal, profileGoalsSet.weekly_conditioning_sessions_goal);

    r = await req('GET', '/api/fitness/weekly-load', null, auth);
    const weeklyLoad = await r.json();
    console.log('weekly-load status:', r.status, 'sessions_goal reflects edit:', weeklyLoad.strength.sessions_goal===5 && weeklyLoad.conditioning.sessions_goal===3);
    console.log('weekly-load lift_names_this_week includes Back squat:', weeklyLoad.lift_names_this_week.includes('Back squat'));

    // summary
    r = await req('GET', '/api/fitness/summary', null, auth);
    const summary = await r.json();
    console.log('summary:', JSON.stringify(summary, null, 2));
    console.log('summary shoulder:waist ratio:', summary.shoulder_waist_ratio, '(expect ~0.61)');
    console.log('summary measurement count:', summary.entry_counts.measurements);
    console.log('summary benchmark lift best (Back squat, expect ~262.5 e1RM from 225x5):', summary.benchmark_lift_bests['Back squat']);

    // coach prompt
    r = await req('GET', '/api/fitness/coach-prompt', null, auth);
    const cp = await r.json();
    console.log('coach prompt includes phase 1:', /Phase 1/.test(cp.prompt));
    console.log('coach prompt includes squat lift:', /Back squat 225x5/.test(cp.prompt));
    console.log('coach prompt includes body fat:', /9.8%/.test(cp.prompt));
    console.log('coach prompt includes benchmark:', /Fran — 4:12/.test(cp.prompt));
    console.log('coach prompt includes measurements:', /waist 29.5/.test(cp.prompt) && /ratio 0.61/.test(cp.prompt));
    console.log('coach prompt includes benchmark lift bests:', /Back squat: ~262.5 lb e1RM/.test(cp.prompt));

    // Sentinel credentials authenticate too, via a separate pair
    const sentinelAuth = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
    r = await req('GET', '/api/fitness/profile', null, sentinelAuth);
    console.log('profile via sentinel creds:', r.status);

    // coach notes: Sentinel's write-back channel
    r = await req('POST', '/api/fitness/coach-notes', { entry_date: '2026-09-09', note: 'Gaining on pace, add a 3rd delt accessory.' }, sentinelAuth);
    const noteCreated = await r.json();
    console.log('coach note post via sentinel:', r.status, 'source:', noteCreated.source);

    r = await req('POST', '/api/fitness/coach-notes', { entry_date: '' }, auth);
    console.log('coach note post invalid (expect 400):', r.status);

    r = await req('GET', '/api/fitness/coach-notes', null, auth);
    const notes = await r.json();
    console.log('coach notes count:', notes.length);

    r = await req('GET', '/api/fitness/coach-prompt', null, auth);
    const cpWithNote = await r.json();
    console.log('coach prompt now includes prior note:', /delt accessory/.test(cpWithNote.prompt));

    r = await req('DELETE', '/api/fitness/coach-notes/' + noteCreated.id, null, auth);
    console.log('delete coach note:', r.status);

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
