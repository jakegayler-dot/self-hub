// Nutrition (2026-10-20): food search, logging, recipes, adaptive targets, the meal plan, pantry, groceries to
// Sentinel (two-way), the nutritionist, and what Sentinel reads. A stand-in Sentinel answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const Module = require('module');

const pgAdapter = newDb({ autoCreateForeignKeyIndices: true }).adapters.createPg();
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === 'pg' ? 'pg-mem-shim-nut' : orig.call(this, r, ...a); };
require.cache['pg-mem-shim-nut'] = { id: 'pg-mem-shim-nut', filename: 'pg-mem-shim-nut', loaded: true, exports: pgAdapter };
Object.assign(process.env, { DATABASE_URL: 'postgres://fake/fake', SELF_HUB_USER: 'jake', SELF_HUB_PASS: 'testpass123', SENTINEL_USER: 'sentinel', SENTINEL_PASS: 'sentinelpass456' });

const express = require('express');
const { runMigrations, pool } = require('../server/db');
const { basicAuth } = require('../server/middleware/basicAuth');
const fitnessRouter = require('../server/routes/fitness');
const { createNutritionRouter } = require('../server/routes/nutrition');
const { createSentinelReadRouter } = require('../server/routes/sentinelRead');
const { createSentinelPusher, buildSummary } = require('../server/lib/sentinel');
const N = require('../server/lib/nutrition');

const JAKE = 'Basic ' + Buffer.from('jake:testpass123').toString('base64');
const SENTINEL = 'Basic ' + Buffer.from('sentinel:sentinelpass456').toString('base64');
const today = N.reginaToday();
const monday = N.mondayOf(today);

// A stand-in Sentinel nutritionist: records what it was asked; answers from a queue.
const asked = []; const replies = [];
// Stand-ins for USDA FoodData Central and Open Food Facts (shapes as their APIs return them).
const web = []; let fdcDown = false;
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const nut = (num, id, unit, value) => ({ nutrientId: id, nutrientNumber: num, nutrientName: 'x', unitName: unit, value });
const FDC_FOODS = {
  2705964: { fdcId: 2705964, dataType: 'Survey (FNDDS)', description: 'Double cheeseburger, from fast food, two patties',
    foodNutrients: [nut('208', 1008, 'KCAL', 262), nut('203', 1003, 'G', 15.1), nut('204', 1004, 'G', 13.9), nut('205', 1005, 'G', 18.6), nut('307', 1093, 'MG', 540)],
    foodMeasures: [{ disseminationText: '1 sandwich', gramWeight: 165 }, { disseminationText: 'Quantity not specified', gramWeight: 165 }] },
  555001: { fdcId: 555001, dataType: 'Branded', description: 'DOUBLE BIG MAC STYLE BURGER', brandName: 'GREAT VALUE', servingSize: 230, servingSizeUnit: 'g', householdServingFullText: '1 burger',
    foodNutrients: [nut('208', 1008, 'KCAL', 270), nut('203', 1003, 'G', 14), nut('204', 1004, 'G', 16), nut('205', 1005, 'G', 18)] },
};
const SR_BIGMAC = { fdcId: 170720, dataType: 'SR Legacy', description: "McDONALD'S, BIG MAC", foodNutrients: [nut('208', 1008, 'KCAL', 257)] };
const fetchImpl = async (url, init) => {
  if (url.startsWith('https://api.nal.usda.gov/fdc/v1/')) {
    web.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (fdcDown) return json(429, { error: { code: 'OVER_RATE_LIMIT' } });
    const b = init.body ? JSON.parse(init.body) : {};
    if (url.includes('/foods/search')) {
      if (b.dataType && b.dataType[0] === 'SR Legacy') return json(200, { foods: /big mac/i.test(b.query) ? [SR_BIGMAC] : [] });
      return json(200, { foods: /double/i.test(b.query) ? Object.values(FDC_FOODS) : [] });
    }
    const id = url.match(/\/food\/(\d+)/)[1];
    if (id === '170720') return json(200, { ...SR_BIGMAC, foodPortions: [{ amount: 1, modifier: 'item', gramWeight: 219, measureUnit: { name: 'undetermined' } }] });
    const f = FDC_FOODS[id];
    return f ? json(200, { ...f, foodMeasures: undefined, foodPortions: (f.foodMeasures || []).map((m) => ({ amount: 1, portionDescription: m.disseminationText, gramWeight: m.gramWeight })) }) : json(404, {});
  }
  if (url.startsWith('https://world.openfoodfacts.org/') || url.startsWith('https://search.openfoodfacts.org/')) {
    web.push({ url, ua: init.headers['User-Agent'] });
    const p = { code: '0062300000000', product_name: 'Double Big Mac', brands: "McDonald's", serving_size: '1 burger (269 g)', serving_quantity: 269,
      nutriments: { 'energy-kcal_100g': 260, proteins_100g: 14.5, carbohydrates_100g: 16.7, fat_100g: 15.2, sodium_100g: 0.48 } };
    if (url.includes('/api/v2/product/')) return json(200, { product: p });
    // The old search refuses anonymous callers now; the search service answers with hits (brands as a list).
    if (url.includes('/cgi/search.pl')) return new Response('<html>Page temporarily unavailable</html>', { status: 503 });
    const q = decodeURIComponent(url);
    return json(200, { hits: /double/i.test(q) ? [{ ...p, brands: ["McDonald's"] }, { code: '1', product_name: 'No numbers' }]
      : /muesli/i.test(q) ? [{ code: '5099856000017', product_name: 'Muesli', brands: ['LifeForce Original Muesli'], nutriments: { 'energy-kcal_100g': 401, proteins_100g: 9.7, carbohydrates_100g: 67, fat_100g: 8.4, sodium_100g: 0 } }] : [] });
  }
  const body = JSON.parse(init.body);
  asked.push({ url, auth: init.headers.Authorization, body });
  const r = replies.shift();
  return new Response(JSON.stringify(r.body || { result: r }), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
};
let server; let base; let router;
const call = async (method, path, body, auth = JAKE) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: auth }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};
const waitJobs = () => Promise.all([...router.jobs.values()]);

test.before(async () => {
  await runMigrations();
  router = createNutritionRouter({ pool, env: { SENTINEL_URL: 'https://sentinel.test', SENTINEL_API_KEY: 'snt_live_x' }, fetchImpl, retryMs: 0 });
  const app = express(); app.use(express.json()); app.use(basicAuth);
  app.use('/api/fitness', fitnessRouter);
  app.use('/api/fitness', router);
  app.use('/api/sentinel', createSentinelReadRouter({ pool }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => new Promise((r) => server.close(r)));

test('food search: his staples first, dairy last, USDA credited; his own foods from a label', async () => {
  const s = (q) => call('GET', `/fitness/nutrition/foods/search?q=${encodeURIComponent(q)}`);
  let r = await s('eggs');
  assert.equal(r.status, 200);
  assert.equal(r.body.foods[0].name, 'Egg, whole, raw, fresh');
  assert.deepEqual(r.body.foods[0].portions[0], { name: 'large egg', grams: 50, builtin: true });
  assert.match(r.body.attribution, /USDA FoodData Central SR Legacy \(public domain\)[\s\S]+TempoLife[\s\S]+CC-BY-4\.0/);
  assert.equal((await s('sardines')).body.foods[0].name, 'Fish, sardine, Atlantic, canned in oil, drained solids with bone');
  assert.equal((await s('oysters')).body.foods[0].name, 'Mollusks, oyster, eastern, farmed, raw');
  assert.equal((await s('beef liver')).body.foods[0].name, 'Beef, variety meats and by-products, liver, raw');
  // USDA numbers, checked against FoodData Central: sardines in oil 208 kcal, 24.6 g protein per 100 g.
  const sard = (await s('sardines')).body.foods[0].per_100g;
  assert.deepEqual([sard.kcal, sard.protein_g, sard.fat_g], [208, 24.6, 11.5]);
  // He has no dairy: "butter" finds peanut butter before butter.
  assert.equal((await s('butter')).body.foods[0].name, 'Peanut Butter, smooth');

  // His own food, entered per serving from a label → stored per 100 g, with that serving as a portion.
  r = await call('POST', '/fitness/nutrition/foods', { name: 'Bison jerky', brand: 'Local', per_grams: 25, serving_name: 'piece', kcal: 80, protein_g: 12, carbs_g: 3, fat_g: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.body.kcal, 320);
  const jerky = (await s('bison jerky')).body.foods[0];
  assert.equal(jerky.key, r.body.key);
  assert.deepEqual(jerky.portions, [{ id: jerky.portions[0].id, name: 'piece', grams: 25 }]);
  assert.equal((await call('POST', '/fitness/nutrition/foods', { name: 'x', kcal: 1 })).status, 400);
});

test('starter recipes: dairy-free, built on his staples, per-serving numbers; liver limited', async () => {
  const r = await call('GET', '/fitness/nutrition/recipes');
  assert.equal(r.status, 200);
  const list = r.body.recipes;
  assert.ok(list.length >= 10);
  const all = list.flatMap((x) => x.ingredients.map((i) => i.food)).join(' | ');
  assert.doesNotMatch(all, /\b(milk|cheese|butter,|cream|yogurt|whey)\b/i);
  for (const staple of [/liver/, /oyster/, /sardine/, /Egg, whole/, /short ribs|ribeye|ground/]) assert.match(all, staple);
  const liver = list.find((x) => x.liver);
  assert.equal(liver.max_per_week, 2);
  const se = list.find((x) => x.name === 'Steak, eggs and potatoes');
  assert.equal(se.per_serving.kcal, 749);
  assert.ok(list.every((x) => x.per_serving.kcal > 0 && !x.missing_foods.length));
  // Seeded once: a second read doesn't add them again, and a deleted one stays deleted.
  await call('DELETE', `/fitness/nutrition/recipes/${list.find((x) => x.name === 'Trail mix').id}`);
  const again = (await call('GET', '/fitness/nutrition/recipes')).body.recipes;
  assert.equal(again.length, list.length - 1);
});

test('logging: a food by portion, a recipe, a quick add; the day against its targets; the pantry follows', async () => {
  const eggKey = 'usda:14951';
  await call('POST', '/fitness/nutrition/pantry', { food_key: eggKey, qty: 12, unit: 'large egg' });
  let r = await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'breakfast', food_key: eggKey, qty: 3, unit: 'large egg' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.grams, 150);
  assert.equal(r.body.amount, '3 large eggs (150 g)');
  assert.equal(r.body.kcal, 215); // 143 kcal/100 g
  assert.deepEqual(r.body.pantry_used, [{ food_key: eggKey, grams: 150 }]);
  const eggsEntry = r.body.id;
  let pantry = (await call('GET', '/fitness/nutrition/pantry')).body.items;
  assert.equal(pantry.find((p) => p.food_key === eggKey).amount, '9 large eggs (450 g)');

  const recipes = (await call('GET', '/fitness/nutrition/recipes')).body.recipes;
  const bowls = recipes.find((x) => x.name === 'Beef and rice bowls');
  r = await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'lunch', recipe_id: bowls.id, servings: 1.5 });
  assert.equal(r.body.kcal, Math.round(bowls.per_serving.kcal * 1.5));
  r = await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'snack', name: 'Gas-station jerky', kcal: 240, protein_g: 30 });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'snack', food_key: eggKey, qty: 2, unit: 'cups' })).status, 400);

  const d = (await call('GET', `/fitness/nutrition/day?date=${today}`)).body;
  assert.equal(d.entries.length, 3);
  assert.equal(d.targets.kcal, 3300); // no training planned this week: every day is the base
  assert.equal(d.targets.protein_g, 175);
  assert.equal(d.remaining.kcal, 3300 - d.totals.kcal);
  assert.match(d.week.rationale, /^Holding 3300 kcal: not enough data/);

  // Deleting an entry puts the eggs back.
  await call('DELETE', `/fitness/nutrition/diary/${eggsEntry}`);
  pantry = (await call('GET', '/fitness/nutrition/pantry')).body.items;
  assert.equal(pantry.find((p) => p.food_key === eggKey).grams, 600);

  // What he ate at lunch, saved as a meal.
  r = await call('POST', '/fitness/nutrition/meals/from-day', { date: today, slot: 'lunch', name: 'Usual lunch' });
  assert.equal(r.status, 201);
  assert.equal(r.body.kind, 'meal');
  assert.equal(r.body.per_serving.kcal, Math.round(bowls.per_serving.kcal * 1.5));
});

test('targets: training days get more, rest days less, the week averaging the base; carbs carry the difference', () => {
  const s = { protein_g: 175, fat_pct: 30, training_extra_kcal: 400 };
  const train = N.dayTargets(s, 3300, true, 5); const rest = N.dayTargets(s, 3300, false, 5);
  assert.equal(train.kcal, 3410); assert.equal(rest.kcal, 3010);
  assert.ok(Math.abs((train.kcal * 5 + rest.kcal * 2) / 7 - 3300) < 10);
  assert.equal(train.fat_g, rest.fat_g);
  assert.equal(train.carbs_g - rest.carbs_g, 100);
});

test('the weekly check: energy balance from intake and the weight trend, a capped step, holds in the band or when he isn\'t eating the target', () => {
  const settings = { protein_g: 175, rate_min_lb: 0.25, rate_max_lb: 0.5 };
  const t = '2026-10-19';
  const days = (kcal, n = 20) => Array.from({ length: n }, (_, i) => ({ date: N.addDays(t, -1 - i), kcal }));
  const weights = (perWeek) => Array.from({ length: 10 }, (_, i) => ({ date: N.addDays(t, -2 * i - 1), lb: 160 - (perWeek / 7) * (2 * i + 1) }));
  // Ate 3,300 and held weight: he burns 3,300; 0.375 lb/wk needs ~3,490 → up 150 (the cap) to 3,450.
  let a = N.adaptTargets({ settings, currentBase: 3300, intake: days(3300), weighins: weights(0), today: t });
  assert.equal(a.decision, 'up'); assert.equal(a.base_kcal, 3450); assert.equal(a.tdee_kcal, 3300);
  assert.match(a.rationale, /Gaining slower[\s\S]+Up 150 kcal to 3450 \(at most 150 a week\)/);
  // Gaining 0.4 lb/wk: in the band, hold.
  a = N.adaptTargets({ settings, currentBase: 3300, intake: days(3300), weighins: weights(0.4), today: t });
  assert.equal(a.decision, 'hold'); assert.equal(a.rate_lb_wk, 0.4);
  // Gaining 1 lb/wk on 3,300: down.
  a = N.adaptTargets({ settings, currentBase: 3300, intake: days(3300), weighins: weights(1), today: t });
  assert.equal(a.decision, 'down'); assert.equal(a.base_kcal, 3150);
  // Not gaining, but eating 2,800 against 3,300: the target's right, the eating isn't. Hold.
  a = N.adaptTargets({ settings, currentBase: 3300, intake: days(2800), weighins: weights(0), today: t });
  assert.equal(a.decision, 'hold'); assert.match(a.rationale, /averaging 500 kcal under the target/);
  // Too little data.
  a = N.adaptTargets({ settings, currentBase: 3300, intake: days(3300, 6), weighins: weights(0), today: t });
  assert.equal(a.decision, 'hold'); assert.match(a.rationale, /4 more fully logged days/);
  assert.equal(N.adaptTargets({ settings: { ...settings, adaptive: false }, currentBase: 3500, intake: [], weighins: [], today: t }).decision, 'manual');
});

test('settings: calories set by hand apply this week; bad values refused', async () => {
  let r = await call('PUT', '/fitness/nutrition/settings', { base_kcal: 3400, training_extra_kcal: 300 });
  assert.equal(r.status, 200);
  r = await call('GET', '/fitness/nutrition/targets');
  assert.equal(r.body.week.base_kcal, 3400);
  assert.equal(r.body.week.decision, 'manual');
  assert.equal(r.body.history[0].week_start, monday);
  assert.equal((await call('PUT', '/fitness/nutrition/settings', { base_kcal: 900 })).status, 400);
  assert.equal((await call('PUT', '/fitness/nutrition/settings', { rate_min_lb: 0.6 })).status, 400);
  await call('PUT', '/fitness/nutrition/settings', { base_kcal: 3300, training_extra_kcal: 400 });
});

test('the rules plan fills the week from his recipes, liver never two days running, and the grocery list is the plan minus the pantry', async () => {
  const r = await call('POST', '/fitness/nutrition/plan/generate', { week_start: monday });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body;
  assert.equal(p.days.length, 7);
  const all = p.days.flatMap((d) => d.meals);
  assert.ok(all.length >= 7 * 4 - 2, `${all.length} meals`);
  const liverDays = p.days.filter((d) => d.meals.some((m) => /liver/i.test(m.recipe.name))).map((d) => d.date);
  assert.ok(liverDays.length <= 2);
  for (let i = 1; i < liverDays.length; i++) assert.notEqual(N.addDays(liverDays[i - 1], 1), liverDays[i]);
  const counts = {}; for (const m of all) counts[m.recipe.name] = (counts[m.recipe.name] || 0) + 1;
  // A dinner is often tomorrow's lunch, so a main can turn up a few times, but not more than 3 a week as a dinner.
  for (const d of p.days) assert.ok(d.planned_kcal > d.kcal * 0.7, `${d.date} ${d.planned_kcal} vs ${d.kcal}`);

  const g = (await call('GET', '/fitness/nutrition/groceries')).body;
  assert.ok(g.open.length > 3);
  assert.ok(g.open.every((x) => x.source === 'plan' && x.quantity && x.aisle));
  const eggs = g.open.find((x) => x.food_key === 'usda:14951');
  // Eggs on the list are what the rest of the week needs beyond the 12 in the pantry.
  const need = N.groceriesFromPlan((await router.store.planRows(monday)).filter((m) => m.date >= today), new Map((await router.store.recipes({ all: true })).map((x) => [x.id, x])), new Map());
  const egg = need.find((x) => x.food_key === 'usda:14951');
  if (egg) assert.equal(eggs ? eggs.grams : 0, Math.max(0, Math.ceil((egg.grams - 600) / 5) * 5) || (eggs ? eggs.grams : 0));
  assert.ok(Object.values(counts).length > 4);
});

test('groceries are two-way with Sentinel: snapshot out, ticked off back in (into the pantry), added and removed', async () => {
  let r = await call('POST', '/fitness/nutrition/groceries', { name: 'Coffee', quantity: '1 bag' });
  assert.equal(r.status, 201);
  assert.equal(r.body.source_id, `grocery:${r.body.grocery.id}`);
  assert.deepEqual(r.body.item, { kind: 'shopping', category: 'personal', title: 'Coffee', all_day: true, status: 'open', notes: null, job: { quantity: '1 bag', shop_category: 'Pantry' } });

  // Sentinel's login can tick a plan item off: it goes into the pantry.
  const open = (await call('GET', '/fitness/nutrition/groceries')).body.open;
  const beef = open.find((x) => x.food_key === 'usda:17458');
  assert.ok(beef, 'ground beef on the list');
  const before = (await router.store.pantryMap()).get('usda:17458') || 0;
  r = await call('PATCH', `/fitness/nutrition/groceries/${beef.id}`, { status: 'bought' }, SENTINEL);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.status, 'done');
  assert.equal((await router.store.pantryMap()).get('usda:17458'), before + beef.grams);
  // Un-ticked: back out.
  await call('PATCH', `/fitness/nutrition/groceries/${beef.id}`, { status: 'open' }, SENTINEL);
  assert.equal((await router.store.pantryMap()).get('usda:17458') || 0, before);
  await call('PATCH', `/fitness/nutrition/groceries/${beef.id}`, { status: 'bought' });

  // Added from Sentinel (voice: "put oysters on my grocery list").
  r = await call('POST', '/fitness/nutrition/groceries', { name: 'Oysters', quantity: '2 dozen' }, SENTINEL);
  assert.equal(r.body.grocery.source, 'sentinel');
  assert.equal((await call('DELETE', `/fitness/nutrition/groceries/${r.body.grocery.id}`, null, SENTINEL)).body.item, null);
  assert.equal((await call('PATCH', '/fitness/nutrition/groceries/99999', { status: 'bought' }, SENTINEL)).status, 404);

  // The snapshot Sentinel gets: grocery items only, open and recently bought.
  const snap = await router.store.grocerySnapshot();
  assert.equal(snap.prefix, 'grocery:');
  assert.ok(snap.items.every((i) => i.source_id.startsWith('grocery:') && i.kind === 'shopping'));
  assert.ok(snap.items.some((i) => i.source_id === `grocery:${beef.id}` && i.status === 'done'));
  assert.ok(snap.items.some((i) => i.title === 'Coffee'));

  // The pusher sends the summary, then the snapshot.
  const posts = [];
  const p = createSentinelPusher({ pool, env: { SENTINEL_URL: 'https://s.test', SENTINEL_API_KEY: 'k' }, logger: { log() {}, error() {} },
    fetchImpl: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); } });
  await p.run();
  assert.deepEqual(posts.map((x) => x.url), ['https://s.test/v1/sources/self_hub/summary', 'https://s.test/v1/sources/self_hub/snapshot']);
  assert.equal(posts[1].body.prefix, 'grocery:');
  // The tile shows today's eating against today's target.
  const n = posts[0].body.summary.nutrition;
  assert.equal(n.target.protein_g, 175);
  assert.ok(n.eaten.kcal > 0);
  assert.ok(n.planned.length >= 1);
});

test('the nutritionist plans the week through Sentinel: unknown foods go back to be fixed, then the plan, new recipes and groceries land', async () => {
  const recipes = (await call('GET', '/fitness/nutrition/recipes')).body.recipes;
  const breakfast = recipes.find((x) => x.slot === 'breakfast');
  const week = (food) => ({
    summary: 'Batch-cook the stew Sunday; packed lunches Mon-Tue (harvest)',
    prep: ['Sunday: stew, boil a dozen eggs'],
    days: N.weekDates(monday).map((date) => ({ date, note: date === monday ? 'harvest: packed lunch' : undefined, meals: [{ slot: 'breakfast', recipe_id: breakfast.id, servings: 1 }, { slot: 'dinner', new_recipe: 'stew', servings: 1.5 }] })),
    new_recipes: [{ ref: 'stew', name: 'Beef heart stew', slot: 'main', servings: 4, ingredients: [{ food, grams: 800, label: 'Beef heart' }, { food: 'Potatoes, flesh and skin, raw', grams: 900 }], instructions: 'Stew 2 h', why: 'Cheap, iron-rich' }],
  });
  replies.push(week('Unobtainium, raw'), week('Beef, variety meats and by-products, heart, raw'));
  const r = await call('POST', '/fitness/nutrition/coach', { task: 'week', week_start: monday, note: 'harvesting Monday' });
  assert.equal(r.status, 202);
  await waitJobs();
  const job = (await call('GET', `/fitness/nutrition/coach/jobs/${r.body.job}`)).body;
  assert.equal(job.status, 'done', job.error);
  assert.equal(asked[0].url, 'https://sentinel.test/v1/selfhub/nutritionist');
  assert.equal(asked[0].auth, 'Bearer snt_live_x');
  const ctx = asked[0].body.context;
  assert.equal(asked[0].body.task, 'week');
  assert.equal(ctx.week_start, monday);
  assert.equal(ctx.dates.length, 7);
  assert.equal(ctx.note, 'harvesting Monday');
  assert.ok(ctx.recipes.some((x) => x.liver));
  assert.ok(ctx.targets.days.length === 7 && ctx.targets.protein_g === 175);
  assert.match(asked[1].body.errors[0], /no food like "Unobtainium, raw"/);
  assert.deepEqual(asked[1].body.previous.summary, week('x').summary);

  const plan = (await call('GET', `/fitness/nutrition/plan?week=${monday}`)).body;
  assert.equal(plan.source, 'nutritionist');
  assert.match(plan.summary, /Batch-cook the stew/);
  assert.deepEqual(plan.prep, ['Sunday: stew, boil a dozen eggs']);
  assert.ok(plan.days.every((d) => d.meals.some((m) => m.recipe.name === 'Beef heart stew') || d.meals.every((m) => m.eaten)));
  const g = (await call('GET', '/fitness/nutrition/groceries')).body.open;
  assert.ok(g.some((x) => x.name === 'Beef heart'));

  // A review: advice shown, nothing applied until he says.
  replies.push({ summary: 'Short on calories', adherence: '1 day logged', target_advice: { kcal: 3400, protein_g: 180, why: 'x' }, gaps: [{ area: 'Fibre', evidence: '10 g', fix: 'Oats' }] });
  const rv = await call('POST', '/fitness/nutrition/coach', { task: 'review' });
  await waitJobs();
  const latest = (await call('GET', '/fitness/nutrition/coach/latest?task=review')).body;
  assert.equal(latest.latest.job, rv.body.job);
  assert.equal(latest.latest.result.review.target_advice.kcal, 3400);
  assert.ok(asked.at(-1).body.context.intake.length >= 0);
  assert.equal((await call('GET', '/fitness/nutrition/targets')).body.week.base_kcal, 3300);

  // A recipe on request: saved.
  replies.push({ name: 'Sardine scramble', slot: 'breakfast', servings: 1, ingredients: [{ food: 'Fish, sardine, Atlantic, canned in oil, drained solids with bone', grams: 92 }, { food: 'Egg, whole, raw, fresh', grams: 150 }], instructions: 'Scramble' });
  const rr = await call('POST', '/fitness/nutrition/coach', { task: 'recipe', request: 'sardines and eggs' });
  await waitJobs();
  const made = (await call('GET', `/fitness/nutrition/coach/jobs/${rr.body.job}`)).body.result.recipe;
  assert.equal(made.name, 'Sardine scramble');
  assert.equal(made.source, 'nutritionist');

  // Sentinel's error comes through; no Sentinel → 503.
  replies.push({ status: 429, body: { error: { message: "Sentinel's AI budget is used up" } } });
  const bad = await call('POST', '/fitness/nutrition/coach', { task: 'review' });
  await waitJobs();
  assert.match((await call('GET', `/fitness/nutrition/coach/jobs/${bad.body.job}`)).body.error, /budget is used up/);
  assert.equal((await call('POST', '/fitness/nutrition/coach', { task: 'nap' })).status, 400);
});

test('review fixes: delete after the pantry row is gone, other weeks\' groceries kept, a hand-set target survives a re-check, future weeks stay provisional, a double tap logs once', async () => {
  // 1. Log eggs from the pantry, remove the pantry row, delete the entry: it comes back to the pantry, no error.
  await call('POST', '/fitness/nutrition/pantry', { food_key: 'usda:11674', grams: 500, mode: 'set' });
  const e = (await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'snack', food_key: 'usda:11674', grams: 182 })).body;
  const row = (await call('GET', '/fitness/nutrition/pantry')).body.items.find((p) => p.food_key === 'usda:11674');
  await call('DELETE', `/fitness/nutrition/pantry/${row.id}`);
  assert.equal((await call('DELETE', `/fitness/nutrition/diary/${e.id}`)).status, 204);
  assert.equal((await router.store.pantryMap()).get('usda:11674'), 182);

  // 2. Planning next week keeps this week's groceries (the list covers every meal still to come).
  const before = (await call('GET', '/fitness/nutrition/groceries')).body.open.filter((g) => g.source === 'plan').length;
  assert.ok(before > 0);
  const recipes = (await call('GET', '/fitness/nutrition/recipes')).body.recipes;
  await call('POST', '/fitness/nutrition/plan', { date: N.addDays(monday, 7), slot: 'dinner', recipe_id: recipes.find((r) => r.name === 'Salmon, sweet potato and broccoli').id, servings: 1 });
  const after = (await call('GET', '/fitness/nutrition/groceries')).body.open.filter((g) => g.source === 'plan');
  assert.ok(after.length >= before, `${after.length} < ${before}`);
  assert.ok(after.some((g) => /Salmon/.test(g.name)));

  // 3. Set by hand, then re-check: the hand-set number is where it starts.
  await call('PUT', '/fitness/nutrition/settings', { base_kcal: 3700 });
  const re = (await call('POST', '/fitness/nutrition/targets/recheck')).body;
  assert.equal(re.week.base_kcal, 3700);
  await call('PUT', '/fitness/nutrition/settings', { base_kcal: 3300 });

  // 4. Looking at next week doesn't decide it.
  const next = N.addDays(monday, 7);
  const t = (await call('GET', `/fitness/nutrition/targets?date=${next}`)).body;
  assert.equal(t.week.provisional, true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM nutrition_targets WHERE week_start = $1', [next])).rows[0].n, 0);

  // 8. "Ate it" twice at once: logged once.
  const plan = (await call('GET', `/fitness/nutrition/plan?week=${monday}`)).body;
  const meal = plan.days.flatMap((d) => d.meals).find((m) => !m.eaten && m.recipe.name !== '(deleted recipe)');
  const [a, b] = await Promise.all([call('POST', '/fitness/nutrition/diary', { plan_id: meal.id }), call('POST', '/fitness/nutrition/diary', { plan_id: meal.id })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 400]);
  // A bad quick add and a label that can't be right are refused, not a 500.
  assert.equal((await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'snack', name: 'x', kcal: 100, protein_g: 999999 })).status, 400);
  assert.equal((await call('POST', '/fitness/nutrition/foods', { name: 'x', per_grams: 1, kcal: 10000, protein_g: 0, carbs_g: 0, fat_g: 0 })).status, 400);
});

test('foods beyond the list: USDA branded and as-eaten, Open Food Facts, then Sentinel; each saved the first time with its serving, logged in one tap', async () => {
  let r = await call('GET', '/fitness/nutrition/foods/search?q=double%20big%20mac');
  assert.ok(r.body.foods.every((f) => /BIG MAC/.test(f.name)), 'only the closest built-in (a single Big Mac)');
  assert.equal(r.body.online, undefined);
  r = await call('GET', '/fitness/nutrition/foods/search?online=1&q=double%20big%20mac');
  const keys = r.body.online.map((c) => c.key);
  assert.ok(keys.includes('off:0062300000000') && keys.includes('fdc:555001') && keys.includes('fdc:2705964'), keys.join());
  assert.ok(!keys.includes('off:1'), 'no numbers, not shown');
  const off = r.body.online.find((c) => c.key === 'off:0062300000000');
  assert.deepEqual(off.serving, { name: '1 burger (269 g)', grams: 269 });
  assert.equal(off.per_100g.sodium_mg, 480);
  assert.equal(r.body.online.find((c) => c.key === 'fdc:555001').brand, 'Great Value');
  assert.ok(web.some((w) => w.url.includes('api_key=DEMO_KEY')), 'no key set: the demo key');
  assert.match(web.find((w) => w.ua).ua, /^SelfHub\//);

  // Picked: saved as his food with its serving; picked again, the same food.
  const imp = await call('POST', '/fitness/nutrition/foods/import', { key: 'fdc:2705964' });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.serving, { id: imp.body.serving.id, name: '1 sandwich', grams: 165 });
  assert.equal(imp.body.source_label, 'USDA');
  assert.equal((await call('POST', '/fitness/nutrition/foods/import', { key: 'fdc:2705964' })).body.key, imp.body.key);
  // Now it's found without going online, and not offered twice.
  r = await call('GET', '/fitness/nutrition/foods/search?online=1&q=double%20cheeseburger');
  assert.equal(r.body.foods[0].key, imp.body.key);
  assert.ok(!r.body.online.some((c) => c.key === 'fdc:2705964'));
  // One tap: one serving.
  const e = await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'lunch', food_key: imp.body.key, qty: 1, unit: '1 sandwich' });
  assert.equal(e.body.grams, 165);
  assert.equal(e.body.kcal, 432);
  await call('DELETE', `/fitness/nutrition/diary/${e.body.id}`);

  // A built-in food with no serving weight (McDonald's Big Mac): USDA's portion, fetched once.
  const bm = (await call('GET', '/fitness/nutrition/foods/search?q=big%20mac')).body.foods[0];
  assert.equal(bm.name, "McDONALD'S, BIG MAC");
  assert.equal(bm.serving, null);
  const n0 = web.length;
  const got = await call('GET', `/fitness/nutrition/foods/${encodeURIComponent(bm.key)}`);
  assert.deepEqual(got.body.serving, { id: got.body.serving.id, name: '1 item', grams: 219 });
  await call('GET', `/fitness/nutrition/foods/${encodeURIComponent(bm.key)}`);
  assert.equal(web.length - n0, 2, 'search + details, once');

  // USDA over its limit: the rest still answers, and it says why.
  fdcDown = true;
  r = await call('GET', '/fitness/nutrition/foods/search?online=1&q=double%20big%20mac');
  fdcDown = false;
  assert.ok(r.body.online.some((c) => c.source === 'off'));
  assert.match(r.body.online_problems[0], /hourly limit/);

  // Sentinel finds the restaurant's own numbers; saved per 100 g with the serving; asked once.
  replies.push({ found: true, name: 'Double Big Mac', brand: "McDonald's", serving_name: '1 sandwich', serving_g: 269, per_serving: { kcal: 700, protein_g: 39, carbs_g: 45, fat_g: 41, sodium_mg: 1290 },
    source_url: 'https://www.mcdonalds.com/ca/en-ca/product/double-big-mac.html', note: 'Canadian menu' });
  const asks = asked.length;
  const lk = await call('POST', '/fitness/nutrition/foods/lookup', { query: 'Double Big Mac' });
  assert.equal(lk.status, 201, JSON.stringify(lk.body));
  assert.equal(asked[asks].body.task, 'food');
  assert.equal(asked[asks].body.context.query, 'Double Big Mac');
  assert.equal(lk.body.per_100g.kcal, 260.2);
  assert.equal(lk.body.serving.grams, 269);
  assert.equal(lk.body.source_label, 'Looked up by Sentinel');
  assert.match(lk.body.source_url, /mcdonalds\.com\/ca/);
  assert.equal((await call('POST', '/fitness/nutrition/foods/lookup', { query: 'double big mac' })).body.key, lk.body.key);
  assert.equal(asked.length, asks + 1);
  const logged = await call('POST', '/fitness/nutrition/diary', { date: today, slot: 'lunch', food_key: lk.body.key, qty: 1, unit: '1 sandwich' });
  assert.equal(logged.body.kcal, 700);
  await call('DELETE', `/fitness/nutrition/diary/${logged.body.id}`);
  replies.push({ found: false, note: 'No such item on the Canadian or US menu' });
  const nf = await call('POST', '/fitness/nutrition/foods/lookup', { query: 'triple mega mac' });
  assert.equal(nf.status, 404);
  assert.match(nf.body.error, /No such item/);
});

test('Sentinel reads nutrition: today, the log, targets, recipes, the plan, pantry and groceries', async () => {
  for (const c of ['nutrition_today', 'food_log', 'nutrition_days', 'nutrition_targets', 'recipes', 'meal_plan', 'pantry', 'groceries']) {
    const r = await call('GET', `/sentinel/read/${c}`, null, SENTINEL);
    assert.equal(r.status, 200, `${c}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.rows.length > 0, c);
  }
  const t = (await call('GET', '/sentinel/read/nutrition_today', null, SENTINEL)).body.rows[0];
  assert.equal(t.target.protein_g, 175);
  const s = await buildSummary(pool);
  assert.ok(s.summary.nutrition);
});

test('a longer description still finds the food: "sausage and egg breakfast sandwich" (Oct 26)', () => {
  const names = N.searchFoods('sausage and egg breakfast sandwich', { limit: 6 }).map((f) => f.name);
  assert.ok(names.length >= 4, names.join(' | '));
  assert.ok(names.some((n) => /McMUFFIN with Egg/.test(n)), names.join(' | '));
  assert.ok(names.slice(0, 5).every((n) => /sausage/i.test(n) && /egg/i.test(n)), names.join(' | '));
  // Short searches still need every word.
  assert.equal(N.searchFoods('egg zzqx').length, 0);
  assert.equal(N.searchFoods('eggs')[0].name, 'Egg, whole, raw, fresh');
});


test('muesli (Oct 27): USDA asked from his browser and read here; Open Food Facts from its search service; picked without a second trip', async () => {
  // USDA's search results exactly as the browser gets them (shape checked against the live API).
  const raw = [{ fdcId: 474366, description: 'MUESLI', dataType: 'Branded', brandOwner: 'DORSET CEREALS', servingSizeUnit: 'g', servingSize: 100.0, householdServingFullText: '100 GRM', foodMeasures: [],
    foodNutrients: [{ nutrientId: 1003, nutrientName: 'Protein', nutrientNumber: '203', unitName: 'G', value: 9.6 }, { nutrientId: 1004, nutrientNumber: '204', unitName: 'G', value: 7.9 },
      { nutrientId: 1005, nutrientNumber: '205', unitName: 'G', value: 62.9 }, { nutrientId: 1008, nutrientNumber: '208', unitName: 'KCAL', value: 392 }, { nutrientId: 1093, nutrientNumber: '307', unitName: 'MG', value: 200 }] }];
  const cfg = (await call('GET', '/fitness/nutrition/foods/online-config')).body;
  assert.equal(cfg.fdc_key, 'DEMO_KEY');
  const n = web.length;
  const r = await call('POST', '/fitness/nutrition/foods/online', { query: 'muesli', fdc_foods: raw });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.online_problems, []);
  const usda = r.body.online.find((c) => c.key === 'fdc:474366');
  assert.equal(usda.name, 'Muesli');
  assert.equal(usda.brand, 'Dorset Cereals');
  assert.equal(usda.per_100g.kcal, 392);
  assert.ok(r.body.online.some((c) => c.key === 'off:5099856000017' && c.brand === 'LifeForce Original Muesli'));
  assert.ok(!web.slice(n).some((w) => w.url.includes('api.nal.usda.gov')), 'the server did not ask USDA');
  assert.ok(web.slice(n).some((w) => w.url.startsWith('https://search.openfoodfacts.org/search?q=muesli')));
  // Picked: saved from the browser's copy.
  const m = web.length;
  const imp = await call('POST', '/fitness/nutrition/foods/import', { key: 'fdc:474366', raw: raw[0] });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.equal(web.length, m);
  assert.equal(imp.body.per_100g.kcal, 392);
  // A raw that doesn't match the key is ignored (fetched instead).
  assert.equal((await call('POST', '/fitness/nutrition/foods/import', { key: 'fdc:2705964', raw: raw[0] })).body.name, 'Double cheeseburger, from fast food, two patties');
  // No browser results: the server asks USDA itself, as before.
  const s = await call('POST', '/fitness/nutrition/foods/online', { query: 'double cheese', fdc_foods: null });
  assert.ok(s.body.online.some((c) => c.key.startsWith('fdc:')));
});
