// Expeditions (2026-10-31): trips on the map, journal pages with the day's weather, photos, the training on the way,
// and Sentinel's read of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-ex' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-ex'] = { id: 'pg-mem-shim-ex', filename: 'pg-mem-shim-ex', loaded: true, exports: pgAdapter };
Object.assign(process.env, { DATABASE_URL: 'postgres://fake/fake', SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SENTINEL_USER: 'sentinel', SENTINEL_PASS: 'sentinelpass456' });

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const { createExpeditionsRouter } = require('../server/routes/expeditions');
const { createSentinelReadRouter } = require('../server/routes/sentinelRead');
const { trackMountPaths } = require('../server/routes/sentinelActions');
const X = require('../server/lib/expeditions');
trackMountPaths();

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const web = [];
// Open-Meteo as it answered (archive, Banff, 2024-07-30/31; geocoding "Banff"), whatever day is asked.
const fetchImpl = async (url) => {
  web.push(String(url));
  const u = new URL(url);
  if (u.hostname === 'geocoding-api.open-meteo.com') return Response.json({ results: [
    { name: 'Banff', latitude: 51.17622, longitude: -115.56982, feature_code: 'PPL', country: 'Canada', admin1: 'Alberta' },
    { name: 'Banff', latitude: 57.66, longitude: -2.52, feature_code: 'PPL', country: 'United Kingdom', admin1: 'Scotland' }] });
  const d = u.searchParams.get('start_date');
  return Response.json({ daily: { time: [d], temperature_2m_max: [22.2], temperature_2m_min: [7.7], precipitation_sum: [0.6], snowfall_sum: [0], wind_speed_10m_max: [11.3], weather_code: [51] } });
};
// A real (tiny) JPEG: SOI, a comment, EOI.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x06, 0x53, 0x48, 0x75, 0x62, 0xff, 0xd9]);
let server; let base;
const call = async (method, path, body, auth = JAKE) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};

test.before(async () => {
  await runMigrations();
  const app = express();
  app.use('/api/fitness/expeditions', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' })); app.use(basicAuth);
  app.use('/api/fitness', createExpeditionsRouter({ pool, fetchImpl }));
  app.use('/api/sentinel', createSentinelReadRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

test('geography: distances along the route, nearest place, which weather service for which day', () => {
  const banff = { lat: 51.1762, lon: -115.5698 }, louise = { lat: 51.4254, lon: -116.1773 }, jasper = { lat: 52.8737, lon: -118.0814 };
  assert.equal(Math.round(X.haversineKm(banff, louise)), 51);
  assert.ok(X.routeKm([banff, louise, jasper]) > 250 && X.routeKm([banff, louise, jasper]) < 260);
  assert.equal(X.nearestPlace([{ id: 1, ...banff }, { id: 2, ...louise }], 51.18, -115.57).id, 1);
  assert.equal(X.nearestPlace([{ id: 1, ...banff }], 52, -110), null, 'nothing within 5 km');
  assert.match(X.weatherUrl(51.18, -115.57, '2024-07-30', '2026-10-31'), /^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?.*start_date=2024-07-30&end_date=2024-07-30/);
  assert.match(X.weatherUrl(51.18, -115.57, '2026-10-29', '2026-10-31'), /^https:\/\/api\.open-meteo\.com\/v1\/forecast/);
  assert.equal(X.weatherUrl(51.18, -115.57, '2026-12-25', '2026-10-31'), null, 'too far ahead to know');
  assert.deepEqual(X.weatherFrom({ daily: { time: ['2024-07-31'], temperature_2m_max: [25], temperature_2m_min: [8], precipitation_sum: [0], snowfall_sum: [0], wind_speed_10m_max: [17.5], weather_code: [3] } }, '2024-07-31'),
    { high_c: 25, low_c: 8, precip_mm: 0, snow_cm: 0, wind_kmh: 17.5, code: 3, sky: 'Overcast' });
});

test('a trip: places on the map, pages with the weather, the training done on the way', async () => {
  let r = await call('POST', '/fitness/expeditions', { title: 'Rockies, July 2024', kind: 'expedition', start_date: '2024-07-29', end_date: '2024-08-02' });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal((await call('POST', '/fitness/expeditions', { title: '' })).status, 400);
  assert.equal((await call('POST', '/fitness/expeditions', { title: 'x', start_date: '2024-08-02', end_date: '2024-07-01' })).status, 400);
  // Find a place by name, then pin it.
  const found = (await call('GET', '/fitness/expeditions/geocode?q=Banff')).body;
  assert.equal(found[0].region, 'Alberta, Canada');
  const banff = (await call('POST', `/fitness/expeditions/${id}/places`, { ...found[0], arrived_on: '2024-07-29', left_on: '2024-07-31' })).body;
  const louise = (await call('POST', `/fitness/expeditions/${id}/places`, { name: 'Lake Louise', lat: 51.4254, lon: -116.1773, arrived_on: '2024-07-31' })).body;
  assert.equal(louise.position, 1);
  assert.equal((await call('POST', `/fitness/expeditions/${id}/places`, { name: 'Nowhere', lat: 95, lon: 0 })).status, 400);
  // A page: the weather that day at its place, kept.
  web.length = 0;
  r = await call('POST', `/fitness/expeditions/${id}/entries`, { entry_date: '2024-07-30', place_id: banff.id, title: 'Sulphur Mountain', body: 'Ran the switchbacks before breakfast.' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.weather, { high_c: 22.2, low_c: 7.7, precip_mm: 0.6, snow_cm: 0, wind_kmh: 11.3, code: 51, sky: 'Light drizzle', at: 'Banff' });
  assert.ok(web[0].includes('archive-api') && web[0].includes('latitude=51.1762'));
  const page = r.body.id;
  assert.equal((await call('POST', `/fitness/expeditions/${id}/entries`, { entry_date: '2024-07-30' })).status, 400, 'an empty page');
  // Training logged during the trip shows on its day.
  await pool.query("INSERT INTO fitness_conditioning (entry_date, movement, distance_m, duration_seconds) VALUES ('2024-07-30', 'Run', 5500, 1980), ('2024-09-01', 'Run', 5000, 1500)");
  await pool.query("INSERT INTO fitness_lifts (entry_date, lift, load_lb, reps) VALUES ('2024-08-01', 'Kettlebell Swing', 53, 20), ('2024-08-01', 'Kettlebell Swing', 53, 20)");
  web.length = 0;
  const full = (await call('GET', `/fitness/expeditions/${id}`)).body;
  assert.equal(web.length, 0, 'kept weather is not asked again');
  assert.deepEqual(full.places.map((p) => p.name), ['Banff', 'Lake Louise']);
  assert.equal(full.distance_km, 51);
  assert.deepEqual(full.span, { from: '2024-07-29', to: '2024-08-02' });
  assert.deepEqual(full.training['2024-07-30'], [{ kind: 'conditioning', text: 'Run 5.5 km in 33:00', km: 5.5 }]);
  assert.deepEqual(full.training['2024-08-01'], [{ kind: 'sets', text: 'Kettlebell Swing 2 sets' }]);
  assert.equal(full.training['2024-09-01'], undefined, 'outside the trip');
  // Reorder, edit, move a page to another day.
  await call('POST', `/fitness/expeditions/${id}/places/order`, { ids: [louise.id, banff.id] });
  assert.deepEqual((await call('GET', `/fitness/expeditions/${id}`)).body.places.map((p) => p.name), ['Lake Louise', 'Banff']);
  assert.equal((await call('POST', `/fitness/expeditions/${id}/places/order`, { ids: [louise.id] })).status, 400);
  r = await call('PUT', `/fitness/expeditions/entries/${page}`, { entry_date: '2024-07-31', place_id: louise.id });
  assert.equal(r.body.weather.at, 'Lake Louise', 'a new day or place, new weather');
  // The atlas.
  const atlas = (await call('GET', '/fitness/expeditions')).body;
  assert.equal(atlas[0].title, 'Rockies, July 2024');
  assert.equal(atlas[0].days, 5);
  assert.equal(atlas[0].entries, 1);
  assert.equal(atlas[0].places.length, 2);
});

test('photos: shrunk JPEGs in, their GPS puts them at the place, served back, Sentinel reads the trips', async () => {
  const { id } = (await call('POST', '/fitness/expeditions', { title: 'Waskesiu weekend', kind: 'outing' })).body;
  const lake = (await call('POST', `/fitness/expeditions/${id}/places`, { name: 'Waskesiu Lake', lat: 53.9206, lon: -106.0817 })).body;
  const b64 = JPEG.toString('base64');
  let r = await call('POST', `/fitness/expeditions/${id}/photos`, { image: `data:image/jpeg;base64,${b64}`, thumb: b64, width: 1600, height: 1200, taken_on: '2026-08-15', lat: 53.921, lon: -106.08, caption: 'Dock at dawn' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.place_id, lake.id, 'its GPS is within 5 km of the lake');
  assert.equal(r.body.caption, 'Dock at dawn');
  const res = await fetch(base + r.body.thumb_url.replace('/api', ''), { headers: { Authorization: JAKE } });
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), JPEG);
  assert.equal((await call('POST', `/fitness/expeditions/${id}/photos`, { image: Buffer.from('not a jpeg').toString('base64'), thumb: b64 })).status, 400);
  // A 5 MB photo fits under the route's own limit.
  const big = Buffer.concat([JPEG.subarray(0, 3), Buffer.alloc(5 * 1024 * 1024, 7)]).toString('base64');
  assert.equal((await call('POST', `/fitness/expeditions/${id}/photos`, { image: big, thumb: b64 })).status, 201);
  const list = (await call('GET', '/fitness/expeditions')).body.find((e) => e.id === id);
  assert.equal(list.photos, 2);
  assert.ok(list.cover_url);
  // Sentinel.
  r = await call('GET', '/sentinel/read/expeditions', null, SENTINEL);
  assert.equal(r.status, 200);
  const rockies = r.body.rows.find((x) => x.title === 'Rockies, July 2024');
  assert.equal(rockies.places, 'Lake Louise; Banff, Alberta, Canada');
  assert.equal(rockies.distance_km, 51);
  r = await call('GET', '/sentinel/read/expedition_entries?search=switchbacks', null, SENTINEL);
  assert.equal(r.body.rows[0].place, 'Lake Louise');
  assert.equal(r.body.rows[0].weather, 'Light drizzle, 22°/8°C, 0.6 mm');
  // Deleting a trip takes its places, pages and photos with it.
  await call('DELETE', `/fitness/expeditions/${id}`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM expedition_photos WHERE expedition_id = $1', [id])).rows[0].n, 0);
});
