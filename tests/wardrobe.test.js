// The wardrobe (2026-10-31): his manager's items brought in, what to wear today, outfits, the wishlist, exports,
// Sentinel's view and the stylist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-wd' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-wd'] = { id: 'pg-mem-shim-wd', filename: 'pg-mem-shim-wd', loaded: true, exports: pgAdapter };
Object.assign(process.env, { DATABASE_URL: 'postgres://fake/fake', SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SENTINEL_USER: 'sentinel', SENTINEL_PASS: 'sentinelpass456' });

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const { createWardrobeRouter, createWardrobeStore } = require('../server/routes/wardrobe');
const { createSentinelReadRouter } = require('../server/routes/sentinelRead');
const { createCoachChatRouter } = require('../server/routes/coachChat');
const { createSentinelPusher } = require('../server/lib/sentinel');
const { trackMountPaths } = require('../server/routes/sentinelActions');
const W = require('../server/lib/wardrobe');
trackMountPaths();

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
// The forecast as Open-Meteo gave it for the farm on Oct 31, 2026.
const OCT31 = { daily: { time: [today], temperature_2m_max: [4.0], temperature_2m_min: [-4.0], apparent_temperature_min: [-8.4], apparent_temperature_max: [0.7], precipitation_sum: [0], precipitation_probability_max: [0], snowfall_sum: [0], wind_speed_10m_max: [14.1], weather_code: [3] } };
const web = []; const script = [];
const fetchImpl = async (url, init) => {
  web.push(url);
  if (String(url).startsWith('https://api.open-meteo.com/')) return new Response(JSON.stringify(OCT31), { status: 200, headers: { 'content-type': 'application/json' } });
  const next = script.shift();
  return new Response(JSON.stringify(typeof next === 'function' ? next(JSON.parse(init.body)) : next), { status: 200, headers: { 'content-type': 'application/json' } });
};
let server; let base; let chat;
const call = async (method, path, body, auth = JAKE) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};

test.before(async () => {
  await runMigrations();
  const app = express(); app.use(express.json()); app.use(basicAuth);
  app.use('/api/fitness', createWardrobeRouter({ pool, fetchImpl }));
  chat = createCoachChatRouter({ pool, wardrobe: createWardrobeStore(pool, { fetchImpl }), env: { ...process.env, SENTINEL_URL: 'https://sentinel.test', SENTINEL_API_KEY: 'k' }, fetchImpl, retryMs: 0 });
  app.use('/api/fitness', chat);
  app.use('/api/sentinel', createSentinelReadRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

test('his 52 items come over from his manager, once; stats and gaps', async () => {
  const r = await call('GET', '/fitness/wardrobe');
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 52);
  assert.ok(r.body.items.every((i) => !/^A-/.test(i.id)), "none of Ashley's");
  const bag = r.body.items.find((i) => i.id === 'A001');
  assert.equal(bag.status, 'Repair');
  assert.equal(r.body.stats.repair.length, 4);
  assert.deepEqual(r.body.stats.by_category[0], ['Top', 27]);
  const areas = r.body.gaps.map((g) => g.area);
  for (const a of ['Winter coat', 'Boots', 'Toque', 'Gloves']) assert.ok(areas.includes(a), a);
  // Deleted stays deleted (seeded once).
  await call('DELETE', '/fitness/wardrobe/items/T023');
  assert.equal((await call('GET', '/fitness/wardrobe')).body.items.length, 51);
});

test('add, edit, wishlist and exports, as his manager did them', async () => {
  let r = await call('POST', '/fitness/wardrobe/items', { category: 'Outerwear', type: 'Parka', brand: 'Canada Goose', colour: 'Black', warmth: 5, season: 'Winter' });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'O004');
  r = await call('POST', '/fitness/wardrobe/items', { category: 'Footwear', type: 'Chelsea Boots', brand: 'Blundstone', status: 'Wishlist', price_cad: 290, link: 'https://example.ca/b' });
  assert.equal(r.body.id, 'WF001');
  assert.equal(r.body.price_cad, 290);
  assert.equal((await call('POST', '/fitness/wardrobe/items', { category: 'Hat', type: 'x' })).status, 400);
  assert.equal((await call('PUT', '/fitness/wardrobe/items/A004', { warmth: 9 })).status, 400);
  r = await call('PUT', '/fitness/wardrobe/items/A004', { status: 'Wear', notes: 'New battery' });
  assert.equal(r.body.status, 'Wear');
  const csv = await fetch(`${base}/fitness/wardrobe/export?format=csv`, { headers: { Authorization: JAKE } }).then((x) => x.text());
  assert.match(csv.split('\n')[0], /^id,category,type,brand,colour,size,season,condition,style,warmth,notes,status$/);
  const sql = await fetch(`${base}/fitness/wardrobe/export?format=sql`, { headers: { Authorization: JAKE } }).then((x) => x.text());
  assert.match(sql, /INSERT INTO items \(id, category[\s\S]+'Levi'|INSERT INTO items/);
  assert.match(sql, /'Jake'\);/);
});

test('what to wear today: the farm forecast, layers for −6°C, farm clothes on the farm, the gaps said plainly, a gym bag', async () => {
  // Without the page's forecast, the server asks Open-Meteo for the farm.
  await pool.query("INSERT INTO fitness_workouts (workout_date, title, focus, minutes, inputs, body) VALUES ($1, 'Heavy squat', 'strength', 60, '{}'::jsonb, '{}'::jsonb)", [today]);
  let r = await call('GET', `/fitness/wardrobe/today?occasion=farm&date=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(web.some((u) => u.includes('latitude=52.87') && u.includes('timezone=America%2FRegina')));
  assert.equal(r.body.weather.low_c, -4);
  assert.equal(r.body.band, 'freezing');
  const roles = r.body.pieces.map((p) => p.role);
  for (const role of ['top', 'layer', 'bottom', 'outer', 'shoes']) assert.ok(roles.includes(role), role);
  assert.equal(r.body.pieces.find((p) => p.role === 'outer').id, 'O004', 'the new parka');
  assert.ok(r.body.notes.some((n) => /No work boots/.test(n)));
  assert.ok(r.body.notes.some((n) => /toque and gloves/.test(n)));
  assert.equal(r.body.gym_kit.for, 'Heavy squat');
  assert.ok(r.body.gym_kit.pieces.every((p) => ['top', 'bottom', 'layer', 'shoes'].includes(p.role)));
  // The page's own forecast is used as given; a hot day in town is shorts and sandals.
  r = await call('GET', `/fitness/wardrobe/today?occasion=town&high_c=29&low_c=17&feels_low_c=17&feels_high_c=30`);
  const n = (role) => (r.body.pieces.find((p) => p.role === role) || {}).type;
  assert.match(n('bottom'), /Short/);
  assert.equal(n('shoes'), 'Sandals');
  assert.ok(!r.body.pieces.some((p) => p.role === 'outer'));
  // Dressed up: dress shoes, dress pants.
  r = await call('GET', `/fitness/wardrobe/today?occasion=dress&high_c=10&low_c=2`);
  assert.equal(r.body.pieces.find((p) => p.role === 'shoes').type, 'Dress Shoes');
  assert.match(r.body.pieces.find((p) => p.role === 'bottom').type, /Dress Pants/);
  // Wore it: tomorrow gets something different.
  const first = (await call('GET', `/fitness/wardrobe/today?occasion=farm&date=${today}`)).body;
  await call('POST', '/fitness/wardrobe/wear', { date: today, item_ids: first.pieces.map((p) => p.id) });
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const next = W.todaysOutfit({ items: await createWardrobeStore(pool).items(), worn: await createWardrobeStore(pool).lastWorn(), date: tomorrow, weather: W.weatherFromOpenMeteo(OCT31, today), occasion: 'farm' });
  assert.notEqual(next.pieces.find((p) => p.role === 'top').id, first.pieces.find((p) => p.role === 'top').id);
  assert.equal((await call('POST', '/fitness/wardrobe/wear', { item_ids: ['NOPE'] })).status, 400);
});

test('outfits; Sentinel reads the wardrobe and gets repairs as tasks', async () => {
  let r = await call('POST', '/fitness/wardrobe/outfits', { name: 'Town, cold', occasion: 'town', item_ids: ['T004', 'T013', 'B010', 'O001', 'F002'], source: 'stylist' });
  assert.equal(r.status, 201);
  assert.equal(r.body.items.length, 5);
  assert.equal(r.body.source, 'stylist');
  assert.equal((await call('POST', '/fitness/wardrobe/outfits', { name: 'x', item_ids: ['ZZZ'] })).status, 400);
  r = await call('GET', '/sentinel/read/wardrobe?status=Repair', null, SENTINEL);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows.map((x) => x.id).sort(), ['A001', 'B007', 'T003']);
  assert.ok((await call('GET', '/sentinel/read/wardrobe_outfits', null, SENTINEL)).body.rows[0].pieces.includes('Base Layer'));
  const posts = [];
  const p = createSentinelPusher({ pool, env: { SENTINEL_URL: 'https://s.test', SENTINEL_API_KEY: 'k' }, logger: { log() {}, error() {} },
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); } });
  await p.run();
  const wsnap = posts.find((x) => x.body.prefix === 'wardrobe:');
  assert.ok(wsnap);
  assert.deepEqual(wsnap.body.items.map((i) => i.source_id).sort(), ['wardrobe:repair:A001', 'wardrobe:repair:B007', 'wardrobe:repair:T003']);
  assert.equal(wsnap.body.items.find((i) => i.source_id === 'wardrobe:repair:A001').title, 'Repair: Boston Tech Weekend Bag');
  assert.equal(wsnap.body.items[0].kind, 'task');
});

test('the stylist: its own tools and guide, the wardrobe picture with his body, and it changes the wardrobe', async () => {
  const said = (text) => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] }], pending_results: [], stop_reason: 'end_turn' });
  script.push((b) => {
    assert.equal(b.coach, 'stylist');
    assert.deepEqual(b.tools.map((t) => t.name), ['self_hub_api', 'list_routes', 'wardrobe', 'remember', 'forget']);
    assert.match(b.context.api_guide, /POST \/wardrobe\/items/);
    assert.ok(b.context.snapshot.today.rules_pick.length >= 4);
    return { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'wardrobe', input: {} }, { type: 'tool_use', id: 'w2', name: 'self_hub_api', input: { method: 'POST', path: '/api/fitness/wardrobe/items', body: { category: 'Accessory', type: 'Toque', colour: 'Charcoal', status: 'Wishlist', price_cad: 35, notes: 'Merino; your head is bare below freezing' } } }] }], pending_results: [], stop_reason: 'tool_use' };
  }, (b) => {
    const res = b.messages.at(-1).content;
    const pic = JSON.parse(res[0].content);
    assert.ok(pic.items.length > 40 && Array.isArray(pic.gaps) && pic.body);
    assert.match(res[1].content, /"status":201/);
    return said('Put a merino toque on your wishlist.');
  });
  const r = await call('POST', '/fitness/coach/stylist/messages', { text: 'What do I need for winter?' });
  assert.equal(r.status, 202);
  await Promise.all([...chat.running.values()]);
  const wd = (await call('GET', '/fitness/wardrobe')).body.items;
  assert.ok(wd.some((i) => i.type === 'Toque' && i.status === 'Wishlist'));
  const m = (await call('GET', '/fitness/coach/stylist/messages')).body;
  assert.equal(m.items.at(-1).text, 'Put a merino toque on your wishlist.');
});
