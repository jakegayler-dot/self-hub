const { newDb } = require('pg-mem');
const Module = require('module');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const pgAdapter = mem.adapters.createPg();
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return 'pg-mem-shim';
  return origResolve.call(this, request, ...args);
};
require.cache['pg-mem-shim'] = { id: 'pg-mem-shim', filename: 'pg-mem-shim', loaded: true, exports: pgAdapter };

process.env.DATABASE_URL = 'postgres://fake/fake';
process.env.SELF_HUB_USER = 'jake';
process.env.SELF_HUB_PASS = 'testpass123';
process.env.PORT = '8843';

require('../server/index.js');

setTimeout(async () => {
  const base = 'http://localhost:8843';
  const auth = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');

  // static frontend served (no auth needed for static, but check root serves index.html content)
  let r = await fetch(base + '/', { headers: { Authorization: auth } });
  const html = await r.text();
  console.log('root page status:', r.status, '| contains title:', html.includes('SELF HUB'));

  // health check
  r = await fetch(base + '/healthz');
  console.log('healthz:', r.status, await r.text());

  // full flow through the real mounted app
  r = await fetch(base + '/api/fitness/profile', { headers: { Authorization: auth } });
  console.log('profile via full app:', r.status);

  r = await fetch(base + '/api/fitness/bodyweight', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ entry_date: '2026-09-08', weight_lb: 162.1 })
  });
  console.log('post bodyweight via full app:', r.status);

  r = await fetch(base + '/api/fitness/summary', { headers: { Authorization: auth } });
  console.log('summary via full app:', r.status, JSON.stringify(await r.json()));

  console.log('FULL INTEGRATION TEST COMPLETE');
  process.exit(0);
}, 400);
