// Talking to the coaches (2026-10-26): the trainer and the nutritionist change things through Self Hub's own API,
// remember what matters, and see each other's memory. A stand-in Sentinel plays the coach.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-chat' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-chat'] = { id: 'pg-mem-shim-chat', filename: 'pg-mem-shim-chat', loaded: true, exports: pgAdapter };
Object.assign(process.env, { DATABASE_URL: 'postgres://fake/fake', SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SELF_HUB_NO_AUTO_REVIEW: '1' });

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const { createWorkoutsRouter } = require('../server/routes/workouts');
const { createNutritionRouter, createStore } = require('../server/routes/nutrition');
const { createCoachChatRouter } = require('../server/routes/coachChat');
const { trackMountPaths } = require('../server/routes/sentinelActions');
trackMountPaths();

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// The stand-in Sentinel: each reply is a function of what it was sent.
const asked = []; const script = [];
const fetchImpl = async (url, init) => {
  const body = JSON.parse(init.body);
  asked.push({ url, body });
  const next = script.shift();
  const out = typeof next === 'function' ? next(body) : next;
  if (out && out.status) return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
};
const said = (text) => ({ messages: [{ role: 'assistant', content: [{ type: 'text', text }] }], pending_results: [], stop_reason: 'end_turn' });
const calls = (...uses) => ({ messages: [{ role: 'assistant', content: uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) }], pending_results: [], stop_reason: 'tool_use' });

let server; let base; let chat;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: JAKE }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};
const settle = () => Promise.all([...chat.running.values()]);

test.before(async () => {
  await runMigrations();
  const app = express(); app.use(express.json()); app.use(basicAuth);
  const workouts = createWorkoutsRouter({ pool });
  app.use('/api/fitness', fitnessRouter);
  app.use('/api/fitness', workouts);
  app.use('/api/fitness', createNutritionRouter({ pool }));
  chat = createCoachChatRouter({ pool, workouts, nutrition: createStore(pool), env: { ...process.env, SENTINEL_URL: 'https://sentinel.test', SENTINEL_API_KEY: 'k' }, fetchImpl, retryMs: 0 });
  app.use('/api/fitness', chat);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/fitness`;
});
test.after(() => new Promise((r) => server.close(r)));

const SESSION = { title: 'Heavy bench', focus: 'strength', minutes: 60, rationale: ['Bench is behind'], blocks: [{ kind: 'strength', title: 'Bench', minutes: 40, items: [{ movement: 'Bench Press', log_as: 'lift', prescription: '5 × 3 @ 205 lb', sets: [{ reps: 3, load_lb: 205 }] }] }] };

test('a session written whole, and moved', async () => {
  const r = await call('POST', '/workouts/custom', { date: addDays(today, 1), body: SESSION, why: 'Bench is 1.1x bodyweight' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.title, 'Heavy bench');
  assert.equal(r.body.date, addDays(today, 1));
  const bad = await call('POST', '/workouts/custom', { date: today, body: { blocks: [] } });
  assert.equal(bad.status, 422);
  const m = await call('PUT', `/workouts/${r.body.id}/date`, { date: addDays(today, 2) });
  assert.equal(m.body.date, addDays(today, 2));
  await call('PUT', `/workouts/${r.body.id}/date`, { date: addDays(today, 1) });
});

test('the trainer changes what he asks (through the app\'s own API), remembers, and shows what it changed', async () => {
  const w = (await call('GET', `/workouts?from=${addDays(today, 1)}&to=${addDays(today, 1)}`)).body[0];
  const thu = addDays(today, 3);
  script.push(
    calls(['t1', 'self_hub_api', { method: 'GET', path: '/api/fitness/workouts', query: { from: addDays(today, 1), to: addDays(today, 1) } }],
      ['t2', 'remember', { text: 'Left shoulder sore from bench (Oct 26): no heavy pressing until it settles' }]),
    (b) => {
      // It got the results of both, in order.
      const res = b.messages.at(-1).content;
      assert.equal(res[0].tool_use_id, 't1');
      assert.match(res[0].content, /"title":"Heavy bench"/);
      assert.match(res[1].content, /"id":\d+/);
      return calls(['t3', 'self_hub_api', { method: 'PUT', path: `/api/fitness/workouts/${w.id}/date`, body: { date: thu } }], ['t4', 'self_hub_api', { method: 'GET', path: '/api/fitness/nope' }]);
    },
    said(`Moved Heavy bench to ${thu} and noted the shoulder.`),
  );
  let r = await call('POST', '/coach/trainer/messages', { text: "Shoulder's sore. Push tomorrow's bench to Thursday." });
  assert.equal(r.status, 202);
  assert.equal((await call('POST', '/coach/trainer/messages', { text: 'again' })).status, 409);
  await settle();
  // What Sentinel was sent: the coach, the tools, the API guide, his memory.
  const first = asked[0].body;
  assert.equal(asked[0].url, 'https://sentinel.test/v1/selfhub/coach-chat');
  assert.equal(first.coach, 'trainer');
  assert.deepEqual(first.tools.map((t) => t.name), ['self_hub_api', 'list_routes', 'athlete', 'remember', 'forget']);
  assert.match(first.context.api_guide, /PUT \/workouts\/:id\/date \{ date \}/);
  assert.equal(first.messages[0].content[0].text, "Shoulder's sore. Push tomorrow's bench to Thursday.");
  assert.ok(first.context.snapshot.workouts_around_today.some((x) => x.title === 'Heavy bench'));
  // It happened.
  assert.equal((await call('GET', `/workouts/${w.id}`)).body.date, thu);
  r = await call('GET', '/coach/trainer/messages');
  assert.equal(r.body.turn.status, 'done');
  assert.deepEqual(r.body.items.map((i) => i.role), ['user', 'action', 'action', 'coach']); // reads aren't shown
  assert.match(r.body.items[1].text, /^Remembered: Left shoulder sore/);
  assert.equal(r.body.items[2].text, `PUT /workouts/${w.id}/date`);
  assert.equal(r.body.items[2].ok, true);
  assert.equal(r.body.memory.length, 1);
  // The bad call came back as an error the coach could read.
  const sentResults = asked[2].body.messages.at(-1).content;
  assert.equal(sentResults[1].is_error, true);
  assert.match(sentResults[1].content, /no route GET \/api\/fitness\/nope/);
});

test('memory carries across conversations and between the coaches; he can edit it', async () => {
  // A fresh conversation: the trainer still knows (memory in its context); the nutritionist sees it read-only.
  await call('DELETE', '/coach/trainer/messages');
  script.push((b) => { assert.match(JSON.stringify(b.context.memory), /Left shoulder sore/); assert.equal(b.messages.length, 1); return said('Still babying that shoulder — easy pressing today.'); });
  await call('POST', '/coach/trainer/messages', { text: 'What am I doing today?' });
  await settle();
  script.push((b) => {
    assert.equal(b.coach, 'nutritionist');
    assert.deepEqual(b.tools.map((t) => t.name), ['self_hub_api', 'list_routes', 'nutrition', 'remember', 'forget']);
    assert.match(JSON.stringify(b.context.other_memory), /Left shoulder sore/);
    assert.equal(b.context.memory.length, 0);
    assert.ok(b.context.snapshot.today.targets.kcal > 0);
    return calls(['n1', 'nutrition', {}], ['n2', 'self_hub_api', { method: 'POST', path: '/api/fitness/nutrition/diary', body: { date: today, slot: 'breakfast', food_key: 'usda:14951', qty: 3, unit: 'large egg' } }], ['n3', 'remember', { text: 'Eats 3 eggs most breakfasts' }]);
  }, (b) => {
    const res = b.messages.at(-1).content;
    assert.match(res[0].content, /"recipes":\[/);
    assert.match(res[1].content, /"status":201/);
    return said('Logged 3 eggs (215 kcal, 19 g protein).');
  });
  await call('POST', '/coach/nutritionist/messages', { text: 'had 3 eggs for breakfast' });
  await settle();
  const day = (await call('GET', `/nutrition/day?date=${today}`)).body;
  assert.equal(day.entries[0].amount, '3 large eggs (150 g)');
  // Jake edits and deletes memory himself.
  const mem = (await call('GET', '/coach/nutritionist/memory')).body.memory;
  assert.equal(mem[0].text, 'Eats 3 eggs most breakfasts');
  await call('PUT', `/coach/nutritionist/memory/${mem[0].id}`, { text: 'Eats 3-4 eggs most breakfasts' });
  const added = await call('POST', '/coach/nutritionist/memory', { text: 'No dairy, ever' });
  assert.equal(added.status, 201);
  assert.equal((await call('POST', '/coach/nutritionist/memory', { text: 'my password is hunter2' })).status, 400);
  await call('DELETE', `/coach/nutritionist/memory/${added.body.id}`);
  assert.deepEqual((await call('GET', '/coach/nutritionist/memory')).body.memory.map((m) => m.text), ['Eats 3-4 eggs most breakfasts']);
});

test('a reply that breaks off says why and leaves the conversation usable; old results are shortened in the history', async () => {
  script.push(calls(['x1', 'athlete', {}]), { status: 429, body: { error: { message: "Sentinel's AI budget is used up for now" } } });
  await call('POST', '/coach/trainer/messages', { text: 'Plan me something' });
  await settle();
  let r = await call('GET', '/coach/trainer/messages');
  assert.equal(r.body.turn.status, 'failed');
  assert.match(r.body.turn.error, /budget is used up/);
  // Next time, every tool call in the history has its result, and the big athlete result from before is shortened.
  script.push((b) => {
    const uses = b.messages.flatMap((m) => m.content.filter((x) => x.type === 'tool_use').map((x) => x.id));
    const results = b.messages.flatMap((m) => m.content.filter((x) => x.type === 'tool_result').map((x) => x.tool_use_id));
    assert.deepEqual(uses.filter((u) => !results.includes(u)), []);
    const athlete = b.messages.flatMap((m) => m.content).find((x) => x.tool_use_id === 'x1');
    assert.ok(athlete.content.length < 1400, `${athlete.content.length}`);
    return said('Back now.');
  });
  await call('POST', '/coach/trainer/messages', { text: 'Try again' });
  await settle();
  r = await call('GET', '/coach/trainer/messages');
  assert.equal(r.body.items.at(-1).text, 'Back now.');
  assert.equal((await call('POST', '/coach/chef/messages', { text: 'x' })).status, 404);
});

test('review fixes: the chat is out of a coach\'s reach however it\'s spelt; a reply cut off by a restart is repaired; a double send starts one reply', async () => {
  // A coach can't reach the chat routes, even as /Coach/.
  script.push(calls(['k1', 'self_hub_api', { method: 'DELETE', path: '/api/fitness/Coach/nutritionist/messages' }], ['k2', 'list_routes', { search: 'coach' }]), (b) => {
    const res = b.messages.at(-1).content;
    assert.equal(res[0].is_error, true);
    assert.match(res[0].content, /isn't callable/);
    assert.doesNotMatch(res[1].content, /\/coach\//i);
    return said('Can\'t do that.');
  });
  await call('POST', '/coach/trainer/messages', { text: 'wipe the nutritionist' });
  await settle();
  assert.ok((await call('GET', '/coach/nutritionist/messages')).body.items.length > 0);

  // A restart mid-reply: a stored call with no result, and a turn still marked running.
  const turn = (await pool.query("INSERT INTO coach_turns (coach, status) VALUES ('trainer', 'running') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ('trainer', 'user', $1::jsonb, $2)", [JSON.stringify([{ type: 'text', text: 'move it' }]), turn]);
  await pool.query("INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ('trainer', 'assistant', $1::jsonb, $2)", [JSON.stringify([{ type: 'tool_use', id: 'dead1', name: 'athlete', input: {} }]), turn]);
  assert.equal((await call('GET', '/coach/trainer/messages')).body.turn.status, 'failed');
  script.push((b) => {
    const results = b.messages.flatMap((m) => m.content.filter((x) => x.type === 'tool_result').map((x) => x.tool_use_id));
    assert.ok(results.includes('dead1'));
    return said('Here.');
  });
  // Two sends at once: one reply.
  const [a, c] = await Promise.all([call('POST', '/coach/trainer/messages', { text: 'hello?' }), call('POST', '/coach/trainer/messages', { text: 'hello?' })]);
  assert.deepEqual([a.status, c.status].sort(), [202, 409]);
  await settle();
  assert.equal((await call('GET', '/coach/trainer/messages')).body.items.at(-1).text, 'Here.');
});

test('rest between sets: a session that doesn\'t say gets it by the reps; one that does keeps its own', async () => {
  const body = { title: 'Mixed', focus: 'strength', minutes: 60, blocks: [
    { kind: 'strength', title: 'Main', items: [
      { movement: 'Back Squat', log_as: 'lift', sets: [{ reps: 3, load_lb: 275 }] },
      { movement: 'Romanian Deadlift', log_as: 'lift', sets: [{ reps: 10, load_lb: 185 }] },
      { movement: 'Bench Press', log_as: 'lift', rest_s: 200, sets: [{ reps: 5, load_lb: 205 }] },
      { movement: 'Strict Pull-Ups', log_as: 'gymnastics', sets: [{ reps: 8 }] }] },
    { kind: 'metcon', title: 'Finisher', items: [{ movement: 'Burpees', log_as: 'none', prescription: '21-15-9' }] }] };
  const r = await call('POST', '/workouts/custom', { date: addDays(today, 5), body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.body.blocks[0].items.map((i) => i.rest_s), [180, 90, 200, 90]);
  assert.equal(r.body.body.blocks[1].items[0].rest_s, null);
});
