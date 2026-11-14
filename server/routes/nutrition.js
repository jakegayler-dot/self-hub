// Nutrition (Jake, 2026-10-20), mounted under /api/fitness:
//
//   GET    /nutrition/foods/search?q=&online=1   his foods + USDA SR Legacy, per 100 g, with portions; online: + FoodData Central
//                                                 (branded, as eaten) and Open Food Facts
//   GET    /nutrition/foods/:key                  one food, its servings (a built-in food's are fetched from USDA once)
//   POST   /nutrition/foods/import {key}          save an online result (fdc:<id> | off:<barcode>) as his food
//   POST   /nutrition/foods/lookup {query}        Sentinel finds a restaurant's own numbers (Double Big Mac); saved
//   POST   /nutrition/foods                       his own food {name, brand?, kcal, protein_g, carbs_g, fat_g, … per 100 g | per_grams}
//   DELETE /nutrition/foods/:id
//   POST   /nutrition/portions {food_key, name, grams}   DELETE /nutrition/portions/:id
//   GET    /nutrition/day?date=                   the day: targets, what he ate, what's left, the plan
//   GET    /nutrition/diary?from=&to=             entries and daily totals
//   POST   /nutrition/diary                       {date, slot, food_key, qty, unit} | {date, slot, recipe_id, servings} |
//                                                 {date, slot, name, kcal, protein_g, carbs_g, fat_g} | {plan_id}
//   DELETE /nutrition/diary/:id                   (puts back what it took from the pantry)
//   GET    /nutrition/recipes   POST /nutrition/recipes   PUT/DELETE /nutrition/recipes/:id
//   POST   /nutrition/meals/from-day {date, slot, name}   saves what he ate in a slot as a meal
//   GET    /nutrition/targets?date=               this week's targets (the adaptive check runs once a week)
//   PUT    /nutrition/settings                    POST /nutrition/targets/recheck
//   GET    /nutrition/plan?week=                  POST /nutrition/plan/generate {week_start}
//   POST   /nutrition/plan   PUT/DELETE /nutrition/plan/:id
//   GET    /nutrition/pantry   POST /nutrition/pantry {food_key, qty, unit, mode: add|set}   DELETE /nutrition/pantry/:id
//   GET    /nutrition/groceries   POST /nutrition/groceries   PATCH/DELETE /nutrition/groceries/:id
//   POST   /nutrition/groceries/from-plan {week_start}   POST /nutrition/groceries/clear-bought
//   POST   /nutrition/coach {task: week|review|recipe, …}   GET /nutrition/coach/jobs/:id   GET /nutrition/coach/latest?task=
//
// Sentinel: the grocery list is pushed to its shopping list (lib/sentinel.js, source_id grocery:<id>) and Sentinel
// ticks items off through PATCH /nutrition/groceries/:id, which answers {source_id, item} in Sentinel's shape.
// Bought → into the pantry. The nutritionist is Sentinel's (lib/coach.js callNutritionist).
const express = require('express');
const N = require('../lib/nutrition');
const coach = require('../lib/coach');
const foodSources = require('../lib/foodSources');
const { ymd } = require('../lib/workoutGen');

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const RECIPE_SLOTS = ['breakfast', 'main', 'snack'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v) => (v == null || v === '' ? null : Number(v));
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
let planLock = Promise.resolve();
class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---- the store: every database read and write, shared with the Sentinel read API and the summary push ----
// A planned meal's portions by person ({Jake: 1.5, Ashley: 1, ...}); none means Jake's alone (his servings).
function portionsOf(r) {
  const p = typeof r.portions === 'string' ? JSON.parse(r.portions) : r.portions;
  return p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length ? p : null;
}
function totalServings(m) {
  return m.portions ? N.round(Object.values(m.portions).reduce((a, v) => a + (Number(v) || 0), 0), 2) : Number(m.servings) || 0;
}
function peopleOf(m, per) {
  const p = m.portions || { Jake: m.servings };
  return Object.entries(p).filter(([, v]) => Number(v) > 0).map(([name, v]) => ({ name, servings: Number(v), kcal: per ? Math.round(per.kcal * v) : null, protein_g: per ? N.round(per.protein_g * v, 1) : null }));
}

function createStore(pool) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  async function customs() {
    const rows = await q('SELECT * FROM nutrition_foods ORDER BY id');
    return new Map(rows.map((r) => { const f = N.customFood(r); return [f.key, f]; }));
  }
  async function ownPortions() {
    const rows = await q('SELECT id, food_key, name, grams FROM nutrition_portions ORDER BY id');
    const m = new Map();
    for (const r of rows) { if (!m.has(r.food_key)) m.set(r.food_key, []); m.get(r.food_key).push(r); }
    return m;
  }
  async function settings() {
    const r = (await q('SELECT * FROM nutrition_settings WHERE id = 1'))[0] || {};
    return {
      base_kcal: num(r.base_kcal) ?? 3300, protein_g: num(r.protein_g) ?? 175, fat_pct: num(r.fat_pct) ?? 30,
      rate_min_lb: num(r.rate_min_lb) ?? 0.25, rate_max_lb: num(r.rate_max_lb) ?? 0.5, training_extra_kcal: num(r.training_extra_kcal) ?? 400,
      adaptive: r.adaptive !== false, slots: (r.slots || SLOTS.join(',')).split(',').filter((s) => SLOTS.includes(s)), seeded: r.seeded === true,
    };
  }

  // ---- recipes ----
  async function seedStarters() {
    // Claim the seeding first, so two first requests at once can't both seed.
    const claimed = await q('UPDATE nutrition_settings SET seeded = true WHERE id = 1 AND seeded IS NOT TRUE RETURNING id');
    if (!claimed.length) return;
    const have = await q('SELECT count(*)::int AS n FROM nutrition_recipes');
    if (!have[0].n) {
      for (const r of N.starterRecipes()) {
        await pool.query(
          `INSERT INTO nutrition_recipes (name, kind, slot, servings, ingredients, instructions, prep_minutes, portable, max_per_week, notes, source, archived)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, 'starter', false)`,
          [r.name, r.kind, r.slot, r.servings, JSON.stringify(r.ingredients), r.instructions, r.prep_minutes || null, r.portable === true, r.max_per_week || null, r.notes || null]
        );
      }
    }
  }
  async function recipes({ all = false } = {}) {
    await seedStarters();
    const [rows, cust, pics] = await Promise.all([q('SELECT * FROM nutrition_recipes ORDER BY kind, slot, name, id'), customs(), imageIds()]);
    for (const r of rows) r.has_image = pics.has(r.id);
    return rows.filter((r) => all || r.archived !== true).map((r) => recipeView(r, cust));
  }
  function recipeView(r, cust) {
    const ingredients = (typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients) || [];
    const t = N.recipeTotals({ servings: num(r.servings), ingredients }, cust);
    return {
      id: r.id, name: r.name, kind: r.kind, slot: r.slot, servings: num(r.servings),
      ingredients: ingredients.map((i) => { const f = N.foodByKey(i.food_key, cust); return { ...i, food: f ? f.display : null }; }),
      instructions: r.instructions || null, prep_minutes: num(r.prep_minutes), portable: r.portable === true, max_per_week: num(r.max_per_week),
      notes: r.notes || null, source: r.source || 'jake', archived: r.archived === true,
      image: r.has_image ? `/api/fitness/nutrition/recipes/${r.id}/image` : null,
      per_serving: t.per_serving, total: t.total, missing_foods: t.missing,
      liver: ingredients.some((i) => { const f = N.foodByKey(i.food_key, cust); return f && /liver/i.test(f.name); }),
    };
  }
  async function recipeById(id) {
    const rows = await q('SELECT * FROM nutrition_recipes WHERE id = $1', [Number(id)]);
    if (rows[0]) rows[0].has_image = (await imageIds()).has(rows[0].id);
    return rows[0] ? recipeView(rows[0], await customs()) : null;
  }
  // Recipe pictures (Nov 8): made by Sentinel, kept here.
  async function imageIds() {
    return new Set((await q('SELECT recipe_id FROM nutrition_recipe_images')).map((r) => Number(r.recipe_id)));
  }
  async function recipeImage(id) {
    const rows = await q('SELECT jpeg FROM nutrition_recipe_images WHERE recipe_id = $1', [Number(id)]);
    return rows[0] ? rows[0].jpeg : null;
  }
  async function saveRecipeImage(id, jpeg) {
    await pool.query('DELETE FROM nutrition_recipe_images WHERE recipe_id = $1', [Number(id)]);
    await pool.query('INSERT INTO nutrition_recipe_images (recipe_id, jpeg) VALUES ($1, $2)', [Number(id), jpeg]);
  }

  // ---- the family (Nov 8: "correct portions for all family members") ----
  async function household({ all = false } = {}) {
    const rows = await q('SELECT * FROM nutrition_household ORDER BY position, id');
    return rows.filter((m) => all || m.active !== false).map((m) => ({ id: m.id, name: m.name, role: m.role, birth_year: num(m.birth_year), kcal: num(m.kcal), protein_g: num(m.protein_g),
      avoid: m.avoid || null, notes: m.notes || null, active: m.active !== false }));
  }
  async function saveMember(b, id = null) {
    const name = str(b.name, 40);
    if (!id && !name) throw new Bad('A name, please');
    const role = b.role === undefined ? undefined : ['jake', 'adult', 'child'].includes(b.role) ? b.role : 'adult';
    const ints = {};
    for (const [k, lo, hi] of [['birth_year', 1900, 2100], ['kcal', 300, 8000], ['protein_g', 5, 500]]) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') { ints[k] = null; continue; }
      const v = Math.round(Number(b[k]));
      if (!(v >= lo && v <= hi)) throw new Bad(`${k.replace('_', ' ')} must be ${lo} to ${hi}`);
      ints[k] = v;
    }
    if (id) {
      const cur = (await q('SELECT * FROM nutrition_household WHERE id = $1', [Number(id)]))[0];
      if (!cur) throw new Bad('No such person', 404);
      const m = { ...cur, ...(name ? { name } : {}), ...(role ? { role } : {}), ...ints,
        ...(b.avoid !== undefined ? { avoid: str(b.avoid, 300) || null } : {}), ...(b.notes !== undefined ? { notes: str(b.notes, 500) || null } : {}), ...(b.active !== undefined ? { active: b.active !== false } : {}) };
      await pool.query('UPDATE nutrition_household SET name = $2, role = $3, birth_year = $4, kcal = $5, protein_g = $6, avoid = $7, notes = $8, active = $9 WHERE id = $1',
        [cur.id, m.name, m.role, m.birth_year, m.kcal, m.protein_g, m.avoid, m.notes, m.active]);
    } else {
      if ((await q('SELECT 1 FROM nutrition_household WHERE lower(name) = lower($1)', [name])).length) throw new Bad(`${name} is already in the family`);
      await pool.query('INSERT INTO nutrition_household (name, role, birth_year, kcal, protein_g, avoid, notes, position) VALUES ($1, $2, $3, $4, $5, $6, $7, 99)',
        [name, role || 'adult', ints.birth_year ?? null, ints.kcal ?? null, ints.protein_g ?? null, str(b.avoid, 300) || null, str(b.notes, 500) || null]);
    }
    return household({ all: true });
  }
  async function deleteMember(id) {
    const cur = (await q('SELECT * FROM nutrition_household WHERE id = $1', [Number(id)]))[0];
    if (!cur) throw new Bad('No such person', 404);
    if (cur.role === 'jake') throw new Bad("Jake stays: his targets drive the plan");
    await pool.query('DELETE FROM nutrition_household WHERE id = $1', [cur.id]);
    return household({ all: true });
  }
  // Checks a recipe body and turns {qty, unit} ingredients into grams.
  async function cleanRecipe(b, { partial = false, existing = null } = {}) {
    const cust = await customs(); const own = await ownPortions();
    const out = {};
    const name = str(b.name, 120);
    if (name) out.name = name; else if (!partial) throw new Bad('A recipe needs a name');
    if (b.kind !== undefined || !partial) { if (!['recipe', 'meal'].includes(b.kind || 'recipe')) throw new Bad('kind is recipe or meal'); out.kind = b.kind || 'recipe'; }
    if (b.slot !== undefined || !partial) {
      const slot = b.slot === 'lunch' || b.slot === 'dinner' ? 'main' : b.slot || 'main';
      if (!RECIPE_SLOTS.includes(slot)) throw new Bad('slot is breakfast, main or snack'); out.slot = slot;
    }
    if (b.servings !== undefined || !partial) { const s = Number(b.servings ?? 1); if (!(s > 0 && s <= 50)) throw new Bad('servings must be more than 0'); out.servings = s; }
    if (b.ingredients !== undefined || !partial) {
      if (!Array.isArray(b.ingredients) || !b.ingredients.length || b.ingredients.length > 40) throw new Bad('A recipe needs 1 to 40 ingredients');
      out.ingredients = b.ingredients.map((i, n) => {
        const f = N.foodByKey(i && i.food_key, cust);
        if (!f) throw new Bad(`Ingredient ${n + 1}: unknown food`);
        const grams = i.grams != null ? Number(i.grams) : N.toGrams(i.qty, i.unit, f, own.get(f.key) || []);
        if (!(grams > 0 && grams <= 20000)) throw new Bad(`Ingredient ${n + 1} (${f.name}): give grams, or an amount and a unit it knows`);
        return { food_key: f.key, grams: N.round(grams, 1), ...(str(i.label, 60) ? { label: str(i.label, 60) } : {}) };
      });
    }
    for (const k of ['instructions', 'notes']) if (b[k] !== undefined) out[k] = str(b[k], 4000);
    if (b.prep_minutes !== undefined) out.prep_minutes = b.prep_minutes == null || b.prep_minutes === '' ? null : Math.max(0, Math.min(1440, Math.round(Number(b.prep_minutes)) || 0));
    if (b.portable !== undefined) out.portable = b.portable === true;
    if (b.max_per_week !== undefined) out.max_per_week = b.max_per_week == null || b.max_per_week === '' ? null : Math.max(1, Math.min(14, Math.round(Number(b.max_per_week)) || 1));
    void existing;
    return out;
  }
  async function createRecipe(b, source = 'jake') {
    const r = await cleanRecipe(b);
    const rows = await q(
      `INSERT INTO nutrition_recipes (name, kind, slot, servings, ingredients, instructions, prep_minutes, portable, max_per_week, notes, source, archived)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, false) RETURNING id`,
      [r.name, r.kind, r.slot, r.servings, JSON.stringify(r.ingredients), r.instructions ?? null, r.prep_minutes ?? null, r.portable === true, r.max_per_week ?? null, r.notes ?? null, source]
    );
    return recipeById(rows[0].id);
  }

  // ---- the diary ----
  async function pantryMap() {
    const rows = await q('SELECT id, food_key, name, grams FROM nutrition_pantry');
    return new Map(rows.map((r) => [r.food_key, Number(r.grams)]));
  }
  async function adjustPantry(foodKey, delta, name) {
    const cur = (await q('SELECT id, grams FROM nutrition_pantry WHERE food_key = $1', [foodKey]))[0];
    if (cur) {
      const g = Math.max(0, Number(cur.grams) + delta);
      await pool.query('UPDATE nutrition_pantry SET grams = $1, updated_at = now() WHERE id = $2', [N.round(g, 1), cur.id]);
      return Math.min(-delta, Number(cur.grams)); // what was actually taken (for a negative delta)
    }
    if (delta > 0) await pool.query('INSERT INTO nutrition_pantry (food_key, name, grams) VALUES ($1, $2, $3)', [foodKey, name || foodKey, N.round(delta, 1)]);
    return 0;
  }
  // Takes what he ate out of the pantry (only foods it holds); returns [{food_key, grams}] to put back on delete.
  async function takeFromPantry(uses) {
    const have = await pantryMap(); const taken = [];
    for (const u of uses) {
      if (!have.has(u.food_key) || !(u.grams > 0)) continue;
      const t = await adjustPantry(u.food_key, -u.grams);
      if (t > 0) taken.push({ food_key: u.food_key, grams: N.round(t, 1) });
    }
    return taken;
  }
  async function logEntry(b) {
    if (b.plan_id == null) return logOne({ ...b, pantry_servings: null }, null);
    const p = (await q('SELECT * FROM nutrition_plan WHERE id = $1', [Number(b.plan_id)]))[0];
    if (!p) throw new Bad('No such planned meal', 404);
    // Claim it first: a double tap logs it once. Anything that then fails gives it back.
    const claimed = await q('UPDATE nutrition_plan SET eaten = true WHERE id = $1 AND eaten IS NOT TRUE RETURNING id', [p.id]);
    if (!claimed.length) throw new Bad('That planned meal is already logged');
    // The pot was cooked for everyone at the table (Nov 14, Jake: "when I tick off a meal ... it automatically adds calories and
    // adjusts the grocery inventory"): his servings go in his log, the whole family's portions come out of the pantry.
    const portions = (typeof p.portions === 'string' ? JSON.parse(p.portions) : p.portions) || null;
    const family = portions ? Object.values(portions).reduce((a, v) => a + (Number(v) > 0 ? Number(v) : 0), 0) : 0;
    try {
      return await logOne({ ...b, date: ymd(p.plan_date), slot: p.slot, recipe_id: p.recipe_id, servings: b.servings ?? Number(p.servings), pantry_servings: family > 0 ? family : null }, p.id);
    } catch (err) {
      await pool.query('UPDATE nutrition_plan SET eaten = false WHERE id = $1', [p.id]).catch(() => {});
      throw err;
    }
  }
  async function logOne(b, planId) {
    const date = b.date; const slot = b.slot;
    if (!isDate(date)) throw new Bad('date (YYYY-MM-DD) is required');
    if (!SLOTS.includes(slot)) throw new Bad(`slot is one of ${SLOTS.join(', ')}`);
    const cust = await customs();
    let row; let uses = [];
    if (b.recipe_id != null) {
      const r = await recipeById(b.recipe_id);
      if (!r) throw new Bad('No such recipe', 404);
      const s = Number(b.servings ?? 1);
      if (!(s > 0 && s <= 20)) throw new Bad('servings must be more than 0');
      const k = s / (r.servings || 1);
      const n = N.addInto(N.zero(), N.recipeTotals({ servings: 1, ingredients: r.ingredients }, cust).total, k);
      row = { name: r.name, recipe_id: r.id, servings: s, amount: `${s} serving${s === 1 ? '' : 's'}`, ...N.rounded(n) };
      const kp = Number(b.pantry_servings) > 0 ? Number(b.pantry_servings) / (r.servings || 1) : k;
      uses = r.ingredients.map((i) => ({ food_key: i.food_key, grams: i.grams * kp }));
    } else if (b.food_key) {
      const f = N.foodByKey(b.food_key, cust);
      if (!f) throw new Bad('Unknown food', 404);
      const own = (await ownPortions()).get(f.key) || [];
      const grams = b.grams != null ? Number(b.grams) : N.toGrams(b.qty, b.unit, f, own);
      if (!(grams > 0 && grams <= 10000)) throw new Bad('Give an amount: grams, ounces, pounds or one of its portions');
      row = { name: f.display, food_key: f.key, grams: N.round(grams, 1), amount: N.describeAmount(grams, f, own), ...N.rounded(N.nutrientsFor(f, grams)) };
      uses = [{ food_key: f.key, grams }];
    } else {
      const name = str(b.name, 120);
      const kcal = Number(b.kcal);
      if (!name || !(kcal >= 0 && kcal <= 10000)) throw new Bad('Pick a food or recipe, or give a name and calories');
      const g = (k, max) => { const v = num(b[k]); if (v == null) return null; if (!(v >= 0 && v <= max)) throw new Bad(`${k} must be 0 to ${max}`); return v; };
      row = { name, amount: str(b.amount, 60), kcal: Math.round(kcal), protein_g: g('protein_g', 2000) || 0, carbs_g: g('carbs_g', 2000) || 0, fat_g: g('fat_g', 1000) || 0, fiber_g: g('fiber_g', 500), sodium_mg: g('sodium_mg', 50000) };
    }
    const taken = b.use_pantry === false ? [] : await takeFromPantry(uses);
    const ins = await q(
      `INSERT INTO nutrition_diary (entry_date, slot, name, food_key, recipe_id, grams, servings, amount, kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg, plan_id, pantry_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb) RETURNING id`,
      [date, slot, row.name, row.food_key || null, row.recipe_id || null, row.grams ?? null, row.servings ?? null, row.amount || null,
        row.kcal, row.protein_g, row.carbs_g, row.fat_g, row.fiber_g ?? null, row.sodium_mg ?? null, planId, JSON.stringify(taken)]
    );
    return { id: ins[0].id, date, slot, ...row, pantry_used: taken };
  }
  async function deleteEntry(id) {
    const e = (await q('SELECT * FROM nutrition_diary WHERE id = $1', [Number(id)]))[0];
    if (!e) return false;
    const used = (typeof e.pantry_used === 'string' ? JSON.parse(e.pantry_used) : e.pantry_used) || [];
    const cust = await customs();
    for (const u of used) { const f = N.foodByKey(u.food_key, cust); await adjustPantry(u.food_key, Number(u.grams), f ? N.shortName(f) : u.food_key); }
    if (e.plan_id) await pool.query('UPDATE nutrition_plan SET eaten = false WHERE id = $1', [e.plan_id]);
    await pool.query('DELETE FROM nutrition_diary WHERE id = $1', [e.id]);
    return true;
  }
  const entryView = (r) => ({ id: r.id, date: ymd(r.entry_date), slot: r.slot, name: r.name, food_key: r.food_key || null, recipe_id: r.recipe_id || null,
    grams: num(r.grams), servings: num(r.servings), amount: r.amount || null, kcal: num(r.kcal), protein_g: num(r.protein_g), carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g), fiber_g: num(r.fiber_g), sodium_mg: num(r.sodium_mg), plan_id: r.plan_id || null });
  async function entries(from, to) {
    return (await q('SELECT * FROM nutrition_diary WHERE entry_date >= $1 AND entry_date <= $2 ORDER BY entry_date, id', [from, to])).map(entryView);
  }
  function totalsOf(list) {
    const t = N.zero(); for (const e of list) N.addInto(t, e);
    return N.rounded(t);
  }
  async function dailyTotals(from, to) {
    const by = new Map();
    for (const e of await entries(from, to)) { if (!by.has(e.date)) by.set(e.date, []); by.get(e.date).push(e); }
    return [...by.entries()].map(([date, list]) => ({ date, entries: list.length, ...totalsOf(list) }));
  }

  // ---- targets ----
  async function trainingDates(from, to) {
    const rows = await q("SELECT DISTINCT workout_date FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2 AND status <> 'skipped'", [from, to]).catch(() => []);
    return new Set(rows.map((r) => ymd(r.workout_date)));
  }
  async function weighins(from) {
    return (await q('SELECT entry_date, weight_lb FROM fitness_bodyweight WHERE entry_date >= $1 ORDER BY entry_date', [from])).map((r) => ({ date: ymd(r.entry_date), lb: Number(r.weight_lb) }));
  }
  // The week's base, deciding it (once) when the week has none yet.
  async function weekTargets(weekStart, { recheck = false, today = N.reginaToday() } = {}) {
    const s = await settings();
    let row = (await q('SELECT * FROM nutrition_targets WHERE week_start = $1', [weekStart]))[0];
    // A week that hasn't started gets a provisional answer from today's data; it's decided on its Monday.
    const future = weekStart > today;
    if (!row || recheck || future) {
      const prev = (await q('SELECT base_kcal FROM nutrition_targets WHERE week_start < $1 ORDER BY week_start DESC LIMIT 1', [weekStart]))[0];
      // A target set by hand this week is the starting point for a re-check, not last week's.
      const current = row && row.decision === 'manual' ? Number(row.base_kcal) : prev ? Number(prev.base_kcal) : s.base_kcal;
      const asOf = weekStart <= today ? weekStart : today;
      const from = N.addDays(asOf, -21);
      const days = await dailyTotals(from, N.addDays(asOf, -1));
      // A day counts once he's logged at least half its target: a part-logged day would read as undereating.
      const complete = days.filter((d) => d.kcal >= current * 0.5).map((d) => ({ date: d.date, kcal: d.kcal }));
      const a = N.adaptTargets({ settings: s, currentBase: current, intake: complete, weighins: await weighins(from), today: asOf });
      if (future && !row) {
        return { week_start: weekStart, base_kcal: a.base_kcal, protein_g: a.protein_g, decision: a.decision, provisional: true,
          rationale: `Provisional (decided on ${weekStart}): ${a.rationale}`, tdee_kcal: a.tdee_kcal ?? null, rate_lb_wk: a.rate_lb_wk ?? null, avg_intake_kcal: a.avg_intake_kcal ?? null, logged_days: a.logged_days };
      }
      if (future) { /* a future week with a row (set by hand): keep it */ } else if (row) await pool.query('DELETE FROM nutrition_targets WHERE week_start = $1', [weekStart]);
      await pool.query(
        `INSERT INTO nutrition_targets (week_start, base_kcal, protein_g, decision, rationale, tdee_kcal, rate_lb_wk, avg_intake_kcal, logged_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (week_start) DO NOTHING`,
        [weekStart, a.base_kcal, a.protein_g, a.decision, a.rationale, a.tdee_kcal ?? null, a.rate_lb_wk ?? null, a.avg_intake_kcal ?? null, a.logged_days]
      );
      row = (await q('SELECT * FROM nutrition_targets WHERE week_start = $1', [weekStart]))[0];
    }
    return { week_start: weekStart, base_kcal: Number(row.base_kcal), protein_g: Number(row.protein_g), decision: row.decision, rationale: row.rationale,
      tdee_kcal: num(row.tdee_kcal), rate_lb_wk: num(row.rate_lb_wk), avg_intake_kcal: num(row.avg_intake_kcal), logged_days: num(row.logged_days) };
  }
  async function targetsFor(date) {
    const weekStart = N.mondayOf(date);
    const [s, wk, train] = await Promise.all([settings(), weekTargets(weekStart), trainingDates(weekStart, N.addDays(weekStart, 6))]);
    const ss = { ...s, protein_g: wk.protein_g };
    const days = N.weekDates(weekStart).map((d) => ({ date: d, ...N.dayTargets(ss, wk.base_kcal, train.has(d), train.size) }));
    return { week: wk, settings: s, days, day: days.find((d) => d.date === date) };
  }
  async function targetHistory() {
    return (await q('SELECT * FROM nutrition_targets ORDER BY week_start DESC LIMIT 26')).map((r) => ({ week_start: ymd(r.week_start), base_kcal: Number(r.base_kcal), protein_g: Number(r.protein_g),
      decision: r.decision, rationale: r.rationale, tdee_kcal: num(r.tdee_kcal), rate_lb_wk: num(r.rate_lb_wk), avg_intake_kcal: num(r.avg_intake_kcal), logged_days: num(r.logged_days) }));
  }
  async function updateSettings(b) {
    const s = await settings(); const sets = []; const vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const intIn = (k, lo, hi) => { if (b[k] === undefined) return; const v = Math.round(Number(b[k])); if (!(v >= lo && v <= hi)) throw new Bad(`${k} must be ${lo} to ${hi}`); put(k, v); };
    intIn('base_kcal', 1500, 7000); intIn('protein_g', 60, 400); intIn('training_extra_kcal', 0, 1200);
    if (b.fat_pct !== undefined) { const v = Number(b.fat_pct); if (!(v >= 15 && v <= 50)) throw new Bad('fat_pct must be 15 to 50'); put('fat_pct', v); }
    for (const k of ['rate_min_lb', 'rate_max_lb']) if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= -2 && v <= 2)) throw new Bad(`${k} must be -2 to 2 lb a week`); put(k, v); }
    const lo = b.rate_min_lb !== undefined ? Number(b.rate_min_lb) : s.rate_min_lb; const hi = b.rate_max_lb !== undefined ? Number(b.rate_max_lb) : s.rate_max_lb;
    if (lo > hi) throw new Bad('rate_min_lb must not be above rate_max_lb');
    if (b.adaptive !== undefined) put('adaptive', b.adaptive === true);
    if (b.slots !== undefined) {
      const slots = (Array.isArray(b.slots) ? b.slots : String(b.slots).split(',')).map((x) => String(x).trim()).filter((x) => SLOTS.includes(x));
      if (!slots.length) throw new Bad(`slots: some of ${SLOTS.join(', ')}`);
      put('slots', SLOTS.filter((x) => slots.includes(x)).join(','));
    }
    if (sets.length) await pool.query(`UPDATE nutrition_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, vals);
    // Calories or protein set by hand apply from this week.
    if (b.base_kcal !== undefined || b.protein_g !== undefined) {
      const wk = N.mondayOf(N.reginaToday());
      const cur = await weekTargets(wk);
      const kcal = b.base_kcal !== undefined ? Math.round(Number(b.base_kcal)) : cur.base_kcal;
      const protein = b.protein_g !== undefined ? Math.round(Number(b.protein_g)) : cur.protein_g;
      await pool.query("UPDATE nutrition_targets SET base_kcal = $1, protein_g = $2, decision = 'manual', rationale = $3 WHERE week_start = $4",
        [kcal, protein, `Set by hand: ${kcal} kcal and ${protein} g protein a day. The weekly check carries on from here.`, wk]);
    }
    return settings();
  }

  // ---- the plan ----
  async function planRows(weekStart) {
    return (await q('SELECT * FROM nutrition_plan WHERE plan_date >= $1 AND plan_date <= $2 ORDER BY plan_date, id', [weekStart, N.addDays(weekStart, 6)]))
      .map((r) => ({ id: r.id, date: ymd(r.plan_date), slot: r.slot, recipe_id: r.recipe_id, servings: Number(r.servings), portions: portionsOf(r), source: r.source || null, eaten: r.eaten === true }));
  }
  async function planView(weekStart) {
    const [rows, list, t, meta] = await Promise.all([planRows(weekStart), recipes({ all: true }), targetsFor(weekStart), q('SELECT * FROM nutrition_plan_weeks WHERE week_start = $1', [weekStart])]);
    const byId = new Map(list.map((r) => [r.id, r]));
    const s = t.settings;
    const order = (slot) => SLOTS.indexOf(slot);
    const days = t.days.map((d) => {
      const meals = rows.filter((m) => m.date === d.date).sort((a, b) => order(a.slot) - order(b.slot) || a.id - b.id).map((m) => {
        const r = byId.get(m.recipe_id);
        const per = r ? r.per_serving : null;
        return { ...m, recipe: r ? { id: r.id, name: r.name, portable: r.portable, prep_minutes: r.prep_minutes, image: r.image } : { id: m.recipe_id, name: '(deleted recipe)' },
          kcal: per ? Math.round(per.kcal * m.servings) : 0, protein_g: per ? N.round(per.protein_g * m.servings, 1) : 0,
          people: peopleOf(m, per), total_servings: totalServings(m) };
      });
      return { ...d, meals, planned_kcal: meals.reduce((a, m) => a + m.kcal, 0), planned_protein_g: N.round(meals.reduce((a, m) => a + m.protein_g, 0), 1) };
    });
    const m = meta[0];
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    return { week_start: weekStart, slots: s.slots, days, source: m ? m.source : null, summary: m ? m.summary : null, prep: m ? parse(m.prep) || [] : [], notes: m ? parse(m.days) || [] : [] };
  }
  // One plan rewrite at a time (Self Hub runs as one process): two at once would interleave delete and insert.
  function replacePlan(weekStart, meals, meta) {
    const run = planLock.then(() => replacePlanNow(weekStart, meals, meta));
    planLock = run.catch(() => {});
    return run;
  }
  async function replacePlanNow(weekStart, meals, meta) {
    await pool.query('DELETE FROM nutrition_plan WHERE plan_date >= $1 AND plan_date <= $2 AND (eaten IS NULL OR eaten = false)', [weekStart, N.addDays(weekStart, 6)]);
    for (const m of meals) {
      await pool.query('INSERT INTO nutrition_plan (plan_date, slot, recipe_id, servings, source, eaten, portions) VALUES ($1, $2, $3, $4, $5, false, $6::jsonb)',
        [m.date, m.slot, m.recipe_id, m.servings, meta.source, m.portions ? JSON.stringify(m.portions) : null]);
    }
    await pool.query('DELETE FROM nutrition_plan_weeks WHERE week_start = $1', [weekStart]);
    await pool.query('INSERT INTO nutrition_plan_weeks (week_start, source, summary, prep, days) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)',
      [weekStart, meta.source, meta.summary || null, JSON.stringify(meta.prep || []), JSON.stringify(meta.notes || [])]);
  }
  async function generatePlan(weekStart) {
    const [list, t, s, pantry, existing] = await Promise.all([recipes(), targetsFor(weekStart), settings(), pantryMap(), planRows(weekStart)]);
    const keep = existing.filter((m) => m.eaten);
    const targets = Object.fromEntries(t.days.map((d) => [d.date, d]));
    const { meals, notes } = N.planWeek({ dates: N.weekDates(weekStart), slots: s.slots, recipes: list.filter((r) => r.kind === 'recipe' || r.kind === 'meal'), targets, pantry, keep });
    await replacePlan(weekStart, meals, { source: 'rules', summary: `Planned from your ${list.length} recipes and meals: pantry first, protein-dense first, no recipe more than 3 times (breakfasts up to 7), liver never two days running.`, notes });
    await groceriesFromPlan(weekStart);
    return planView(weekStart);
  }

  // ---- pantry ----
  async function pantry() {
    const [rows, cust, own] = await Promise.all([q('SELECT * FROM nutrition_pantry ORDER BY name'), customs(), ownPortions()]);
    return rows.filter((r) => Number(r.grams) > 0).map((r) => {
      const f = N.foodByKey(r.food_key, cust);
      return { id: r.id, food_key: r.food_key, name: r.name, food: f ? f.display : null, grams: Number(r.grams), amount: f ? N.describeAmount(r.grams, f, own.get(r.food_key) || []) : `${Math.round(r.grams)} g`, aisle: f ? N.aisle(f.name) : 'Pantry', updated_at: r.updated_at };
    });
  }
  async function setPantry(b) {
    const cust = await customs();
    const f = N.foodByKey(b.food_key, cust);
    if (!f) throw new Bad('Unknown food', 404);
    const own = (await ownPortions()).get(f.key) || [];
    const grams = b.grams != null ? Number(b.grams) : N.toGrams(b.qty, b.unit, f, own);
    if (!(grams >= 0 && grams <= 200000)) throw new Bad('Give an amount: grams, ounces, pounds or one of its portions');
    const name = str(b.name, 60) || N.shortName(f);
    const cur = (await q('SELECT id, grams FROM nutrition_pantry WHERE food_key = $1', [f.key]))[0];
    const next = b.mode === 'set' || !cur ? grams : Number(cur.grams) + grams;
    if (cur) await pool.query('UPDATE nutrition_pantry SET grams = $1, name = $2, updated_at = now() WHERE id = $3', [N.round(next, 1), name, cur.id]);
    else await pool.query('INSERT INTO nutrition_pantry (food_key, name, grams) VALUES ($1, $2, $3)', [f.key, name, N.round(next, 1)]);
    return (await pantry()).find((p) => p.food_key === f.key) || { food_key: f.key, grams: 0 };
  }
  // A grocery receipt's lines into the pantry (Nov 14; Money Hub reads it, Sentinel sends what the list didn't cover).
  // body { receipt_id, store, date, lines: [{ item, printed, qty, size_value, size_unit, food_type }] }. Once a receipt.
  const NOT_FOOD = new Set(['household', 'personal care', 'other', 'clothing']);
  async function receiptIntake(b) {
    const key = str(String(b.receipt_id ?? ''), 80);
    if (!key) throw new Bad('receipt_id is required');
    const lines = Array.isArray(b.lines) ? b.lines.slice(0, 300).filter((l) => l && typeof l === 'object') : [];
    const seen = async () => {
      const r = (await q('SELECT added, skipped FROM nutrition_receipts WHERE receipt_key = $1', [key]))[0] || {};
      const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || [];
      return { already: true, added: j(r.added), skipped: j(r.skipped) };
    };
    if ((await q('SELECT 1 FROM nutrition_receipts WHERE receipt_key = $1', [key])).length) return seen();
    try { await pool.query('INSERT INTO nutrition_receipts (receipt_key, store, bought_on) VALUES ($1, $2, $3)', [key, str(b.store, 80), isDate(b.date) ? b.date : null]); }
    catch (err) { if (err.code === '23505' || /duplicate|unique/i.test(err.message)) return seen(); throw err; }
    try {
      const [cust, own, list, pan, groc] = await Promise.all([customs(), ownPortions(), recipes({ all: true }), pantryMap(), q('SELECT food_key FROM nutrition_groceries WHERE food_key IS NOT NULL')]);
      const used = new Set([...list.flatMap((r) => (r.ingredients || []).map((i) => i.food_key)), ...pan.keys(), ...groc.map((g) => g.food_key)].filter(Boolean));
      const added = []; const skipped = [];
      for (const l of lines) {
        const item = str(l.item, 120) || str(l.printed, 120);
        if (!item || NOT_FOOD.has(String(l.food_type || '').toLowerCase())) continue;
        const f = N.receiptFood(item, { customs: cust, used });
        if (!f) { skipped.push({ item, why: 'no food matches it surely' }); continue; }
        const mine = own.get(f.key) || [];
        const grams = N.receiptGrams(l, f, mine);
        if (!(grams > 0 && grams <= 200000)) { skipped.push({ item, food: N.shortName(f), why: 'no weight or count on the slip' }); continue; }
        await adjustPantry(f.key, grams, N.shortName(f));
        added.push({ item, food_key: f.key, food: N.shortName(f), grams, amount: N.describeAmount(grams, f, mine) });
      }
      await pool.query('UPDATE nutrition_receipts SET added = $2::jsonb, skipped = $3::jsonb WHERE receipt_key = $1', [key, JSON.stringify(added), JSON.stringify(skipped)]);
      return { added, skipped };
    } catch (err) {
      await pool.query('DELETE FROM nutrition_receipts WHERE receipt_key = $1', [key]).catch(() => {});
      throw err;
    }
  }

  // ---- groceries ----
  const groceryView = (r) => ({ id: r.id, name: r.name, food_key: r.food_key || null, grams: num(r.grams), quantity: r.quantity || null, aisle: r.aisle || 'Pantry',
    notes: r.notes || null, status: r.status, source: r.source, week_start: r.week_start ? ymd(r.week_start) : null,
    bought_at: r.bought_at ? new Date(r.bought_at).toISOString() : null, updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null });
  // The item as Sentinel stores it.
  const sentinelItem = (g) => ({ kind: 'shopping', category: 'personal', title: g.name.slice(0, 120), all_day: true, status: g.status === 'bought' ? 'done' : 'open',
    notes: [g.notes, g.source === 'plan' ? 'For this week\'s meal plan (Self Hub)' : null].filter(Boolean).join(' · ') || null,
    job: { ...(g.quantity ? { quantity: g.quantity.slice(0, 60) } : {}), shop_category: g.aisle } });
  async function groceries() {
    const rows = (await q("SELECT * FROM nutrition_groceries WHERE status = 'open' OR bought_at > $1 ORDER BY aisle, name, id", [new Date(Date.now() - 14 * 864e5).toISOString()])).map(groceryView);
    return { open: rows.filter((g) => g.status === 'open'), bought: rows.filter((g) => g.status === 'bought').sort((a, b) => String(b.bought_at).localeCompare(String(a.bought_at))) };
  }
  async function groceryById(id) {
    const r = (await q('SELECT * FROM nutrition_groceries WHERE id = $1', [Number(id)]))[0];
    return r ? groceryView(r) : null;
  }
  async function addGrocery(b) {
    const cust = await customs();
    const f = b.food_key ? N.foodByKey(b.food_key, cust) : null;
    if (b.food_key && !f) throw new Bad('Unknown food', 404);
    const name = str(b.name, 120) || (f ? N.shortName(f) : null);
    if (!name) throw new Bad('A grocery item needs a name');
    let grams = num(b.grams);
    if (f && grams == null && b.qty != null) grams = N.toGrams(b.qty, b.unit, f, (await ownPortions()).get(f.key) || []);
    const quantity = str(b.quantity, 60) || (f && grams ? N.describeAmount(grams, f) : null);
    const rows = await q(
      "INSERT INTO nutrition_groceries (name, food_key, grams, quantity, aisle, notes, status, source) VALUES ($1, $2, $3, $4, $5, $6, 'open', $7) RETURNING id",
      [name, f ? f.key : null, grams, quantity, f ? N.aisle(f.name) : str(b.aisle, 40) || 'Pantry', str(b.notes, 500), b.source === 'sentinel' ? 'sentinel' : 'manual']
    );
    return groceryById(rows[0].id);
  }
  async function patchGrocery(id, b) {
    const g = await groceryById(id);
    if (!g) return null;
    const sets = []; const vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) { const n = str(b.name, 120); if (!n) throw new Bad('name must not be empty'); put('name', n); }
    if (b.quantity !== undefined) put('quantity', str(String(b.quantity ?? ''), 60));
    if (b.notes !== undefined) put('notes', str(b.notes, 500));
    if (b.status !== undefined) {
      if (!['open', 'bought'].includes(b.status)) throw new Bad('status is open or bought');
      if (b.status !== g.status) {
        // Only the request that actually changes the status moves the pantry (Sentinel and the page at once).
        const changed = await q(`UPDATE nutrition_groceries SET status = $1, bought_at = ${b.status === 'bought' ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $2 AND status <> $1 RETURNING id`, [b.status, g.id]);
        // Bought → into the pantry; un-ticked → back out.
        if (changed.length && g.food_key && g.grams) await adjustPantry(g.food_key, b.status === 'bought' ? g.grams : -g.grams, N.shortName(N.foodByKey(g.food_key, await customs()) || { name: g.name }));
      }
    }
    if (sets.length) await pool.query(`UPDATE nutrition_groceries SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length + 1}`, [...vals, g.id]);
    return groceryById(g.id);
  }
  async function deleteGrocery(id) {
    const g = await groceryById(id);
    if (!g) return false;
    await pool.query('DELETE FROM nutrition_groceries WHERE id = $1', [g.id]);
    return true;
  }
  // Every meal still to come in the plan (this week and any week planned ahead) minus the pantry. Replaces the
  // open items that came from the plan; his own items stay. weekStart is only the label.
  async function groceriesFromPlan(weekStart) {
    const today = N.reginaToday();
    // Enough for everyone who eats each meal (its portions), not just Jake's servings.
    const upcoming = (await q('SELECT * FROM nutrition_plan WHERE plan_date >= $1 ORDER BY plan_date, id', [today]))
      .map((r) => ({ id: r.id, date: ymd(r.plan_date), slot: r.slot, recipe_id: r.recipe_id, servings: totalServings({ servings: Number(r.servings), portions: portionsOf(r) }), eaten: r.eaten === true }));
    const [list, pan, cust, own] = await Promise.all([recipes({ all: true }), pantryMap(), customs(), ownPortions()]);
    const todo = upcoming.filter((m) => !m.eaten);
    void weekStart;
    const need = N.groceriesFromPlan(todo, new Map(list.map((r) => [r.id, r])), pan, cust, own);
    await pool.query("DELETE FROM nutrition_groceries WHERE source = 'plan' AND status = 'open'");
    for (const g of need) {
      await pool.query("INSERT INTO nutrition_groceries (name, food_key, grams, quantity, aisle, status, source, week_start) VALUES ($1, $2, $3, $4, $5, 'open', 'plan', $6)",
        [g.name, g.food_key, g.grams, g.quantity, g.aisle, N.mondayOf(today)]);
    }
    return groceries();
  }
  // Sentinel's snapshot of the grocery list (open, and bought in the last 14 days).
  async function grocerySnapshot(now = new Date()) {
    const { open, bought } = await groceries();
    return { generated_at: now.toISOString(), prefix: 'grocery:', items: [...open, ...bought].map((g) => ({ source_id: `grocery:${g.id}`, ...sentinelItem(g) })) };
  }

  // ---- the day ----
  async function day(date) {
    const [list, t, plan] = await Promise.all([entries(date, date), targetsFor(date), planRows(N.mondayOf(date))]);
    const totals = totalsOf(list);
    const tg = t.day;
    const recipesById = new Map((await recipes({ all: true })).map((r) => [r.id, r]));
    return {
      date, targets: tg, week: t.week, totals,
      remaining: { kcal: Math.round(tg.kcal - totals.kcal), protein_g: N.round(tg.protein_g - totals.protein_g, 1), carbs_g: N.round(tg.carbs_g - totals.carbs_g, 1), fat_g: N.round(tg.fat_g - totals.fat_g, 1) },
      entries: list,
      plan: plan.filter((m) => m.date === date).map((m) => { const r = recipesById.get(m.recipe_id); return { ...m, name: r ? r.name : '(deleted recipe)', image: r ? r.image : null, kcal: r ? Math.round(r.per_serving.kcal * m.servings) : null, protein_g: r ? N.round(r.per_serving.protein_g * m.servings, 1) : null, people: peopleOf(m, r ? r.per_serving : null) }; }),
    };
  }

  return {
    household, saveMember, deleteMember, recipeImage, saveRecipeImage, imageIds,
    q, customs, ownPortions, settings, recipes, recipeById, cleanRecipe, createRecipe, recipeView, logEntry, deleteEntry, entries, dailyTotals, totalsOf,
    weekTargets, targetsFor, targetHistory, updateSettings, trainingDates, weighins, planRows, planView, replacePlan, generatePlan,
    pantry, pantryMap, setPantry, adjustPantry, receiptIntake, groceries, groceryById, addGrocery, patchGrocery, deleteGrocery, groceriesFromPlan, grocerySnapshot, sentinelItem, day,
  };
}

// ---- the nutritionist (Sentinel), in the background ----
const ALLOWED_TASKS = ['week', 'review', 'recipe'];
// Portions sent by the screen or Sentinel: only family members, 0 to 4 servings each.
function cleanPortions(p, fam) {
  if (p == null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) throw new Bad('portions is {name: servings}');
  const names = new Map(fam.map((m) => [m.name.toLowerCase(), m.name]));
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const name = names.get(String(k).toLowerCase());
    if (!name) throw new Bad(`${k} isn't in the family`);
    const n = Number(v);
    if (!(n >= 0 && n <= 4)) throw new Bad(`${name}'s portion must be 0 to 4 servings`);
    if (n > 0) out[name] = Math.round(n * 20) / 20;
  }
  if (!Object.keys(out).length) throw new Bad('Somebody has to eat it');
  return out;
}

function closest(name, cust) {
  return N.searchFoods(String(name).split(',').slice(0, 2).join(' '), { customs: cust, limit: 3 }).map((f) => f.name);
}
// Checks the nutritionist's recipes; returns { recipes (food keys resolved), errors }.
function resolveRecipes(list, cust) {
  const errors = []; const out = [];
  for (const r of list || []) {
    const ings = [];
    for (const i of r.ingredients || []) {
      const f = N.resolveFood(i.food, { customs: cust });
      if (!f) { errors.push(`"${r.name}": no food like "${i.food}" in Self Hub's database${closest(i.food, cust).length ? `; closest: ${closest(i.food, cust).join(' | ')}` : ''}`); continue; }
      if (!(Number(i.grams) > 0)) { errors.push(`"${r.name}": ${i.food} needs grams`); continue; }
      ings.push({ food_key: f.key, grams: N.round(Number(i.grams), 1), ...(i.label ? { label: String(i.label).slice(0, 60) } : {}) });
    }
    const slot = r.slot === 'lunch' || r.slot === 'dinner' ? 'main' : r.slot;
    if (!RECIPE_SLOTS.includes(slot)) errors.push(`"${r.name}": slot is breakfast, main or snack`);
    if (!(Number(r.servings) > 0)) errors.push(`"${r.name}": servings must be more than 0`);
    if (!ings.length && !(r.ingredients || []).length) errors.push(`"${r.name}": no ingredients`);
    out.push({ ...r, slot, ingredients: ings });
  }
  return { recipes: out, errors };
}

function createNutritionRouter({ pool, env = process.env, fetchImpl, retryMs } = {}) {
  const router = express.Router();
  const S = createStore(pool);
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ error: err.message });
      console.error('nutrition failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  };
  const today = () => N.reginaToday();

  // ---- foods ----
  const foodOpts = { env, ...(fetchImpl ? { fetchImpl } : {}) };
  const per100 = (f) => ({ kcal: f.kcal, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g, fiber_g: f.fiber_g, sugar_g: f.sugar_g, sat_fat_g: f.sat_fat_g, sodium_mg: f.sodium_mg });
  const SOURCE_LABEL = { usda: 'USDA', fdc: 'USDA', off: 'Open Food Facts', sentinel: 'Looked up by Sentinel', jake: 'Yours' };
  // A food as the page uses it; the first portion is its usual serving (what a tap logs).
  const foodView = (f, own) => {
    const portions = N.portionsFor(f, own.get(f.key) || []);
    return { key: f.key, name: f.name, display: f.display, source: f.source, brand: f.brand || null, origin: f.origin || f.source,
      source_label: SOURCE_LABEL[f.origin || f.source] || null, source_url: f.source_url || null, per_100g: per100(f), portions, serving: portions[0] || null };
  };
  // Portion weights for a built-in food from FoodData Central, looked up once (found or not).
  async function ensurePortions(f) {
    if (f.source !== 'usda') return;
    const own = (await S.ownPortions()).get(f.key) || [];
    if (N.portionsFor(f, own).length) return;
    if ((await S.q('SELECT 1 FROM nutrition_portion_checks WHERE food_key = $1', [f.key])).length) return;
    let found = [];
    try { found = await foodSources.fdcPortionsFor(f, foodOpts); } catch (e) { return; } // offline or rate-limited: try again next time
    for (const p of found) await S.q('INSERT INTO nutrition_portions (food_key, name, grams) VALUES ($1, $2, $3)', [f.key, p.name, p.grams]);
    await S.q('INSERT INTO nutrition_portion_checks (food_key) VALUES ($1) ON CONFLICT (food_key) DO NOTHING', [f.key]);
  }
  async function saveFood(c, origin) {
    if (c.external_id) {
      const have = (await S.q('SELECT id FROM nutrition_foods WHERE source = $1 AND external_id = $2', [origin, c.external_id]))[0];
      if (have) return `custom:${have.id}`;
    }
    const v = c.per_100g;
    const rows = await S.q(
      'INSERT INTO nutrition_foods (name, brand, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg, source, external_id, source_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id',
      [String(c.name).slice(0, 120), c.brand ? String(c.brand).slice(0, 80) : null, v.kcal, v.protein_g, v.carbs_g, v.fat_g, v.fiber_g ?? null, v.sugar_g ?? null, v.sat_fat_g ?? null, v.sodium_mg ?? null,
        origin, c.external_id || null, c.source_url || null]
    );
    const key = `custom:${rows[0].id}`;
    for (const p of (c.portions || []).slice(0, 6)) if (p.grams > 0 && p.name) await S.q('INSERT INTO nutrition_portions (food_key, name, grams) VALUES ($1, $2, $3)', [key, String(p.name).slice(0, 40), p.grams]);
    return key;
  }
  const sane = (v) => v && v.kcal >= 0 && v.kcal <= 900 && [v.protein_g, v.carbs_g, v.fat_g].every((x) => x >= 0 && x <= 100);

  // ?online=1 also asks FoodData Central and Open Food Facts (a second or two).
  router.get('/nutrition/foods/search', wrap(async (req, res) => {
    const query = String(req.query.q || '').slice(0, 80);
    const [cust, own, list, pan] = await Promise.all([S.customs(), S.ownPortions(), S.recipes(), S.pantryMap()]);
    const recent = await S.q('SELECT DISTINCT food_key FROM nutrition_diary WHERE food_key IS NOT NULL AND entry_date > $1', [N.addDays(today(), -60)]);
    const boost = new Set([...list.flatMap((r) => r.ingredients.map((i) => i.food_key)), ...pan.keys(), ...recent.map((r) => r.food_key)]);
    const foods = N.searchFoods(query, { customs: cust, boost, limit: Math.min(40, Number(req.query.limit) || 25) });
    const out = { query, attribution: N.ATTRIBUTION, foods: foods.map((f) => foodView(f, own)) };
    if (req.query.online === '1' && query.trim().length >= 3) Object.assign(out, await online(query, cust, null));
    res.json(out);
  }));
  async function online(query, cust, fdcFoods) {
    const r = await foodSources.searchOnline(query, { ...foodOpts, fdcFoods });
    const saved = new Set([...cust.values()].filter((f) => f.external_id).map((f) => `${f.origin === 'off' ? 'off' : 'fdc'}:${f.external_id}`));
    return { online: r.foods.filter((c) => !saved.has(c.key) && sane(c.per_100g)).map((c) => ({ ...c, serving: c.portions[0] || null })), online_problems: r.problems };
  }
  // The page asks USDA itself, from his own connection (the server's address is shared, and USDA limits each address),
  // and hands the results here to be read the same way: POST { query, fdc_foods: [USDA search results, slimmed] | null }.
  router.get('/nutrition/foods/online-config', wrap(async (req, res) => {
    res.json({ fdc_search: 'https://api.nal.usda.gov/fdc/v1/foods/search', fdc_key: foodSources.fdcKey(env), data_types: foodSources.FDC_TYPES,
      require_all_words: true, nutrient_numbers: foodSources.FDC_NUTRIENT_NUMBERS, nutrient_ids: foodSources.FDC_NUTRIENT_IDS });
  }));
  router.post('/nutrition/foods/online', wrap(async (req, res) => {
    const b = req.body || {};
    const query = String(b.query || '').slice(0, 80);
    if (query.trim().length < 2) return res.json({ online: [], online_problems: [] });
    const fdcFoods = Array.isArray(b.fdc_foods) ? b.fdc_foods.slice(0, 50) : null;
    res.json(await online(query, await S.customs(), fdcFoods));
  }));
  router.get('/nutrition/foods/:key', wrap(async (req, res) => {
    const cust = await S.customs();
    const f = N.foodByKey(req.params.key, cust);
    if (!f) return res.status(404).json({ error: 'not found' });
    await ensurePortions(f);
    res.json({ ...foodView(f, await S.ownPortions()), attribution: f.source === 'usda' ? N.ATTRIBUTION : null });
  }));
  // Picking a USDA or Open Food Facts result saves it as one of his foods (fresh from the source, with its servings).
  router.post('/nutrition/foods/import', wrap(async (req, res) => {
    const key = String((req.body || {}).key || '');
    const raw = (req.body || {}).raw;
    let c = null;
    // The result as the page already has it (USDA from his browser, or Open Food Facts' search): no second trip.
    if (raw && typeof raw === 'object') {
      const fromRaw = key.startsWith('fdc:') ? foodSources.fdcCandidate(raw) : key.startsWith('off:') ? foodSources.offCandidate(raw) : null;
      if (fromRaw && fromRaw.key === key) c = fromRaw;
    }
    if (!c) try { c = await foodSources.fetchCandidate(key, foodOpts); } catch (e) {
      throw new Bad(e.status === 429 ? 'USDA\'s hourly limit is used up (set FDC_API_KEY); try again later' : `Couldn't reach ${key.startsWith('off:') ? 'Open Food Facts' : 'USDA'}: try again`, 502);
    }
    if (!c || !sane(c.per_100g)) throw new Bad('That food has no usable nutrition numbers', 404);
    const fk = await saveFood(c, c.source);
    res.status(201).json(foodView(N.foodByKey(fk, await S.customs()), await S.ownPortions()));
  }));
  // Not in any database: Sentinel finds the restaurant's or maker's own numbers on the web (a few cents, once).
  router.post('/nutrition/foods/lookup', wrap(async (req, res) => {
    const query = str((req.body || {}).query, 120);
    if (!query) throw new Bad('What food?');
    const cust = await S.customs();
    const prev = [...cust.values()].find((f) => f.origin === 'sentinel' && f.external_id === query.toLowerCase());
    if (prev) return res.json(foodView(prev, await S.ownPortions()));
    if (!coach.trainerReady(env)) throw new Bad("Sentinel isn't connected, so it can't look foods up", 503);
    let answer;
    try { answer = await coach.callNutritionist('food', { context: { query, country: 'Canada' } }, foodOpts); }
    catch (e) { throw new Bad(e.message, e.status === 429 ? 429 : 502); }
    const r = answer.result || {};
    if (r.found === false) throw new Bad(r.note || `Sentinel couldn't find reliable numbers for "${query}"`, 404);
    const g = Number(r.serving_g);
    const ps = r.per_serving || {};
    if (!(g > 0 && g <= 3000) || !(Number(ps.kcal) >= 0)) throw new Bad("Sentinel's answer didn't have a serving size and calories", 502);
    const k = 100 / g;
    const v = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : N.round(Number(x) * k, 1));
    const c = { name: str(r.name, 120) || query, brand: str(r.brand, 80), external_id: query.toLowerCase(), source_url: str(r.source_url, 500),
      per_100g: { kcal: v(ps.kcal), protein_g: v(ps.protein_g) ?? 0, carbs_g: v(ps.carbs_g) ?? 0, fat_g: v(ps.fat_g) ?? 0, fiber_g: v(ps.fiber_g), sugar_g: v(ps.sugar_g), sat_fat_g: v(ps.sat_fat_g), sodium_mg: v(ps.sodium_mg) },
      portions: [{ name: str(r.serving_name, 40) || '1 serving', grams: N.round(g, 1) }] };
    if (!sane(c.per_100g)) throw new Bad("Sentinel's numbers don't add up for that serving size", 502);
    const fk = await saveFood(c, 'sentinel');
    res.status(201).json({ ...foodView(N.foodByKey(fk, await S.customs()), await S.ownPortions()), note: str(r.note, 300) });
  }));
  router.post('/nutrition/foods', wrap(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 120);
    if (!name) throw new Bad('A food needs a name');
    // Per 100 g, or per a serving of per_grams grams (as on a label).
    const per = b.per_grams != null ? Number(b.per_grams) : 100;
    if (!(per > 0 && per <= 2000)) throw new Bad('per_grams must be the serving size in grams');
    const k = 100 / per;
    // Per 100 g nothing tops 900 kcal or 100 g of a macro; sodium tops out near salt's 39,000 mg.
    const LIMIT = { kcal: 900, sodium_mg: 40000 };
    const val = (key, req2 = false) => { const v = num(b[key]); if (v == null) { if (req2) throw new Bad(`${key} is required`); return null; } const x = N.round(v * k, 1); if (!(v >= 0 && x <= (LIMIT[key] || 100))) throw new Bad(`${key} doesn't look right for a ${per} g serving`); return x; };
    const vals = { kcal: val('kcal', true), protein_g: val('protein_g', true), carbs_g: val('carbs_g', true), fat_g: val('fat_g', true), fiber_g: val('fiber_g'), sugar_g: val('sugar_g'), sat_fat_g: val('sat_fat_g'), sodium_mg: val('sodium_mg') };
    const rows = await S.q(
      'INSERT INTO nutrition_foods (name, brand, kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sat_fat_g, sodium_mg) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [name, str(b.brand, 80), vals.kcal, vals.protein_g, vals.carbs_g, vals.fat_g, vals.fiber_g, vals.sugar_g, vals.sat_fat_g, vals.sodium_mg]
    );
    const f = N.customFood(rows[0]);
    if (b.per_grams != null && str(b.serving_name, 40)) await S.q('INSERT INTO nutrition_portions (food_key, name, grams) VALUES ($1, $2, $3)', [f.key, str(b.serving_name, 40), per]);
    const { words, ...food } = f; void words;
    res.status(201).json(food);
  }));
  router.delete('/nutrition/foods/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    const key = `custom:${req.params.id}`;
    const used = await S.q('SELECT id, name, ingredients FROM nutrition_recipes WHERE archived IS NOT TRUE');
    const inUse = used.filter((r) => ((typeof r.ingredients === 'string' ? JSON.parse(r.ingredients) : r.ingredients) || []).some((i) => i.food_key === key));
    if (inUse.length) throw new Bad(`It's in ${inUse.map((r) => r.name).join(', ')}: take it out of those first`, 409);
    await S.q('DELETE FROM nutrition_foods WHERE id = $1', [Number(req.params.id)]);
    await S.q('DELETE FROM nutrition_portions WHERE food_key = $1', [key]);
    res.status(204).end();
  }));
  router.post('/nutrition/portions', wrap(async (req, res) => {
    const b = req.body || {};
    const f = N.foodByKey(b.food_key, await S.customs());
    if (!f) throw new Bad('Unknown food', 404);
    const name = str(b.name, 40); const grams = Number(b.grams);
    if (!name || !(grams > 0 && grams <= 5000)) throw new Bad('A portion needs a name and its grams');
    const rows = await S.q('INSERT INTO nutrition_portions (food_key, name, grams) VALUES ($1, $2, $3) RETURNING id, food_key, name, grams', [f.key, name, grams]);
    res.status(201).json({ ...rows[0], grams: Number(rows[0].grams) });
  }));
  router.delete('/nutrition/portions/:id', wrap(async (req, res) => {
    if (/^\d+$/.test(req.params.id)) await S.q('DELETE FROM nutrition_portions WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  }));

  // ---- the day and the diary ----
  router.get('/nutrition/day', wrap(async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : today();
    res.json(await S.day(date));
  }));
  router.get('/nutrition/diary', wrap(async (req, res) => {
    const to = isDate(req.query.to) ? req.query.to : today();
    const from = isDate(req.query.from) ? req.query.from : N.addDays(to, -13);
    if (from > to) throw new Bad('from must be on or before to');
    res.json({ from, to, entries: await S.entries(from, to), days: await S.dailyTotals(from, to) });
  }));
  router.post('/nutrition/diary', wrap(async (req, res) => {
    res.status(201).json(await S.logEntry({ date: today(), ...(req.body || {}) }));
  }));
  router.delete('/nutrition/diary/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    await S.deleteEntry(req.params.id);
    res.status(204).end();
  }));

  // ---- recipes and saved meals ----
  router.get('/nutrition/recipes', wrap(async (req, res) => res.json({ recipes: await S.recipes({ all: req.query.all === '1' }) })));
  router.post('/nutrition/recipes', wrap(async (req, res) => res.status(201).json(await S.createRecipe(req.body || {}))));
  router.put('/nutrition/recipes/:id', wrap(async (req, res) => {
    const cur = /^\d+$/.test(req.params.id) ? await S.recipeById(req.params.id) : null;
    if (!cur) return res.status(404).json({ error: 'not found' });
    const r = await S.cleanRecipe(req.body || {}, { partial: true });
    const cols = Object.keys(r);
    if (cols.length) {
      const vals = cols.map((c) => (c === 'ingredients' ? JSON.stringify(r[c]) : r[c]));
      await pool.query(`UPDATE nutrition_recipes SET ${cols.map((c, i) => `${c} = $${i + 1}${c === 'ingredients' ? '::jsonb' : ''}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`, [...vals, cur.id]);
    }
    res.json(await S.recipeById(cur.id));
  }));
  router.delete('/nutrition/recipes/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    // Kept (archived) so old plans and the diary still name it; gone from the planner and the lists.
    await pool.query('UPDATE nutrition_recipes SET archived = true, updated_at = now() WHERE id = $1', [Number(req.params.id)]);
    await pool.query('DELETE FROM nutrition_plan WHERE recipe_id = $1 AND plan_date >= $2 AND (eaten IS NULL OR eaten = false)', [Number(req.params.id), today()]);
    res.status(204).end();
  }));
  router.post('/nutrition/meals/from-day', wrap(async (req, res) => {
    const b = req.body || {};
    if (!isDate(b.date) || !SLOTS.includes(b.slot)) throw new Bad('date and slot are required');
    const list = (await S.entries(b.date, b.date)).filter((e) => e.slot === b.slot);
    const ings = [];
    for (const e of list) {
      if (e.food_key) ings.push({ food_key: e.food_key, grams: e.grams });
      else if (e.recipe_id) {
        const r = await S.recipeById(e.recipe_id);
        if (r) for (const i of r.ingredients) ings.push({ food_key: i.food_key, grams: N.round((i.grams * e.servings) / (r.servings || 1), 1), ...(i.label ? { label: i.label } : {}) });
      }
    }
    if (!ings.length) throw new Bad(`Nothing from the food database logged at ${b.slot} on ${b.date}`);
    const merged = new Map();
    for (const i of ings) { const m = merged.get(i.food_key) || { ...i, grams: 0 }; m.grams = N.round(m.grams + i.grams, 1); merged.set(i.food_key, m); }
    res.status(201).json(await S.createRecipe({ name: str(b.name, 120) || `My ${b.slot}`, kind: 'meal', slot: b.slot, servings: 1, ingredients: [...merged.values()] }));
  }));

  // ---- targets ----
  router.get('/nutrition/targets', wrap(async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : today();
    const t = await S.targetsFor(date);
    res.json({ ...t, history: await S.targetHistory() });
  }));
  router.put('/nutrition/settings', wrap(async (req, res) => res.json(await S.updateSettings(req.body || {}))));
  router.post('/nutrition/targets/recheck', wrap(async (req, res) => {
    const wk = N.mondayOf(today());
    await S.weekTargets(wk, { recheck: true });
    res.json({ ...(await S.targetsFor(today())), history: await S.targetHistory() });
  }));

  // ---- the plan ----
  const weekOf = (v) => N.mondayOf(isDate(v) ? v : today());
  router.get('/nutrition/plan', wrap(async (req, res) => res.json(await S.planView(weekOf(req.query.week)))));
  // The family (Nov 8): who eats, with their own daily calories and protein.
  router.get('/nutrition/household', wrap(async (req, res) => res.json({ members: await S.household({ all: true }) })));
  router.post('/nutrition/household', wrap(async (req, res) => res.status(201).json({ members: await S.saveMember(req.body || {}) })));
  router.put('/nutrition/household/:id', wrap(async (req, res) => res.json({ members: await S.saveMember(req.body || {}, req.params.id) })));
  router.delete('/nutrition/household/:id', wrap(async (req, res) => res.json({ members: await S.deleteMember(req.params.id) })));
  // A recipe's picture: kept here; the first time it's asked for, fetched from Sentinel, which makes them.
  router.get('/nutrition/recipes/:id/image', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).end();
    let jpeg = await S.recipeImage(req.params.id);
    if (!jpeg) {
      const url = (env.SENTINEL_URL || '').trim().replace(/\/+$/, ''); const key = (env.SENTINEL_API_KEY || '').trim();
      if (url && key) {
        try {
          const r = await (fetchImpl || fetch)(`${url}/v1/selfhub/meal-image/${req.params.id}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
          if (r.ok) { jpeg = Buffer.from(await r.arrayBuffer()); await S.saveRecipeImage(req.params.id, jpeg); }
        } catch { /* no picture yet */ }
      }
    }
    if (!jpeg) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=86400').send(jpeg);
  }));
  router.post('/nutrition/plan/generate', wrap(async (req, res) => res.json(await S.generatePlan(weekOf((req.body || {}).week_start)))));
  router.post('/nutrition/plan', wrap(async (req, res) => {
    const b = req.body || {};
    if (!isDate(b.date) || !SLOTS.includes(b.slot)) throw new Bad('date and slot are required');
    const r = await S.recipeById(b.recipe_id);
    if (!r || r.archived) throw new Bad('No such recipe', 404);
    const portions = cleanPortions(b.portions, await S.household());
    const s = portions ? Number(portions.Jake || 0) : Number(b.servings ?? 1);
    if (!(s >= (portions ? 0 : 0.01) && s <= 10)) throw new Bad('servings must be more than 0');
    const rows = await S.q("INSERT INTO nutrition_plan (plan_date, slot, recipe_id, servings, source, eaten, portions) VALUES ($1, $2, $3, $4, 'jake', false, $5::jsonb) RETURNING id", [b.date, b.slot, r.id, s, portions ? JSON.stringify(portions) : null]);
    if (b.groceries !== false) await S.groceriesFromPlan(N.mondayOf(b.date));
    res.status(201).json({ id: rows[0].id });
  }));
  router.put('/nutrition/plan/:id', wrap(async (req, res) => {
    const cur = /^\d+$/.test(req.params.id) ? (await S.q('SELECT * FROM nutrition_plan WHERE id = $1', [Number(req.params.id)]))[0] : null;
    if (!cur) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const date = b.date !== undefined ? b.date : ymd(cur.plan_date);
    const slot = b.slot !== undefined ? b.slot : cur.slot;
    // Portions by person (Nov 8); a change to Jake's servings alone moves his portion too.
    let portions = b.portions !== undefined ? cleanPortions(b.portions, await S.household()) : portionsOf(cur);
    let servings = b.servings !== undefined ? Number(b.servings) : Number(cur.servings);
    if (b.portions !== undefined && portions) servings = Number(portions.Jake || 0);
    else if (b.servings !== undefined && portions) portions = { ...portions, Jake: servings };
    let recipeId = cur.recipe_id;
    if (b.recipe_id !== undefined) { const r = await S.recipeById(b.recipe_id); if (!r || r.archived) throw new Bad('No such recipe', 404); recipeId = r.id; }
    if (!isDate(date) || !SLOTS.includes(slot) || !(servings >= (portions ? 0 : 0.01) && servings <= 10)) throw new Bad('date, slot and servings (0-10) must be valid');
    await pool.query('UPDATE nutrition_plan SET plan_date = $1, slot = $2, servings = $3, recipe_id = $4, portions = $5::jsonb WHERE id = $6', [date, slot, servings, recipeId, portions ? JSON.stringify(portions) : null, cur.id]);
    if (b.groceries !== false) await S.groceriesFromPlan(N.mondayOf(date));
    res.json({ ok: true });
  }));
  router.delete('/nutrition/plan/:id', wrap(async (req, res) => {
    const cur = /^\d+$/.test(req.params.id) ? (await S.q('SELECT * FROM nutrition_plan WHERE id = $1', [Number(req.params.id)]))[0] : null;
    if (cur) {
      await pool.query('DELETE FROM nutrition_plan WHERE id = $1', [cur.id]);
      await S.groceriesFromPlan(N.mondayOf(ymd(cur.plan_date)));
    }
    res.status(204).end();
  }));

  // ---- pantry ----
  router.get('/nutrition/pantry', wrap(async (req, res) => res.json({ items: await S.pantry() })));
  router.post('/nutrition/pantry', wrap(async (req, res) => res.status(201).json(await S.setPantry(req.body || {}))));
  router.post('/nutrition/pantry/receipt', wrap(async (req, res) => res.json(await S.receiptIntake(req.body || {}))));
  router.delete('/nutrition/pantry/:id', wrap(async (req, res) => {
    if (/^\d+$/.test(req.params.id)) await pool.query('DELETE FROM nutrition_pantry WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  }));

  // ---- groceries (Sentinel calls these too; answers carry {source_id, item} for it) ----
  const forSentinel = (g) => ({ source_id: `grocery:${g.id}`, item: S.sentinelItem(g), grocery: g });
  router.get('/nutrition/groceries', wrap(async (req, res) => res.json(await S.groceries())));
  router.post('/nutrition/groceries', wrap(async (req, res) => {
    const b = req.body || {};
    const g = await S.addGrocery({ ...b, source: req.isSentinel ? 'sentinel' : b.source });
    res.status(201).json(forSentinel(g));
  }));
  router.post('/nutrition/groceries/from-plan', wrap(async (req, res) => res.json(await S.groceriesFromPlan(weekOf((req.body || {}).week_start)))));
  router.post('/nutrition/groceries/clear-bought', wrap(async (req, res) => {
    await pool.query("DELETE FROM nutrition_groceries WHERE status = 'bought'");
    res.json(await S.groceries());
  }));
  router.patch('/nutrition/groceries/:id', wrap(async (req, res) => {
    const g = /^\d+$/.test(req.params.id) ? await S.patchGrocery(req.params.id, req.body || {}) : null;
    if (!g) return res.status(404).json({ error: 'not found' });
    res.json(forSentinel(g));
  }));
  router.delete('/nutrition/groceries/:id', wrap(async (req, res) => {
    const ok = /^\d+$/.test(req.params.id) && await S.deleteGrocery(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ source_id: `grocery:${req.params.id}`, item: null });
  }));

  // ---- the nutritionist ----
  const callOpts = { env, ...(fetchImpl ? { fetchImpl } : {}), ...(retryMs != null ? { retryMs } : {}) };
  async function contextFor(task, b) {
    const [s, list, pan, cust] = await Promise.all([S.settings(), S.recipes(), S.pantry(), S.customs()]);
    const t = await S.targetsFor(task === 'week' ? b.week_start : today());
    const from = N.addDays(today(), -42);
    const w = await S.weighins(from);
    const known = new Set();
    for (const r of list) for (const i of r.ingredients) { const f = N.foodByKey(i.food_key, cust); if (f) known.add(f.name); }
    for (const p of pan) if (p.food) known.add(p.food);
    const ctx = {
      today: today(),
      athlete: { weight_lb_recent: w.slice(-10), goal: `${await require('../lib/physique').loadStatus(pool).then(require('../lib/physique').physiqueBrief).catch(() => 'Continuous lean gain to a lean athletic physique (about 10% body fat).')} Also: top of his local CrossFit leaderboard.`, diet: 'No dairy. Staples: beef liver, oysters, sardines, eggs, fattier beef cuts.' },
      targets: { base_kcal: t.week.base_kcal, protein_g: t.week.protein_g, rate_band_lb_wk: [s.rate_min_lb, s.rate_max_lb], week_decision: t.week.rationale, days: t.days },
      recipes: list.map((r) => ({ id: r.id, name: r.name, kind: r.kind, slot: r.slot, servings: r.servings, per_serving: r.per_serving, portable: r.portable, max_per_week: r.max_per_week, liver: r.liver,
        ingredients: r.ingredients.map((i) => `${i.label || i.food} ${Math.round(i.grams)} g`) })),
      pantry: pan.map((p) => ({ name: p.food || p.name, amount: p.amount })),
      known_foods: [...known].slice(0, 150),
    };
    if (task === 'week') {
      const fam = await S.household();
      Object.assign(ctx, { week_start: b.week_start, dates: N.weekDates(b.week_start), slots: s.slots, note: str(b.note, 500) || undefined,
        household: fam.map((m) => ({ name: m.name, role: m.role, age: m.birth_year ? Number(today().slice(0, 4)) - m.birth_year : undefined,
          kcal: m.role === 'jake' ? 'his targets (targets.days)' : m.kcal, protein_g: m.role === 'jake' ? 'his targets' : m.protein_g, avoid: m.avoid || undefined, notes: m.notes || undefined })) });
    }
    if (task === 'review') {
      const days = Number(b.days) || 14;
      const ents = await S.entries(N.addDays(today(), -days), N.addDays(today(), -1));
      const byDay = new Map();
      for (const e of ents) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
      Object.assign(ctx, { days, intake: [...byDay.entries()].map(([date, es]) => ({ date, ...S.totalsOf(es), foods: es.map((e) => `${e.name}${e.amount ? ` (${e.amount})` : ''}`).slice(0, 25) })),
        weight: w, target_history: (await S.targetHistory()).slice(0, 6) });
    }
    if (task === 'recipe') ctx.request = str(b.request, 500) || 'something new built on his staples';
    return ctx;
  }
  // Checks an answer; returns errors (sent back to the nutritionist) or what to apply.
  async function checkAnswer(task, result, ctx) {
    const cust = await S.customs();
    if (task === 'recipe') {
      const { recipes, errors } = resolveRecipes([result], cust);
      return { errors, recipes };
    }
    if (task === 'review') {
      const a = result.target_advice || {};
      const errors = [];
      if (!(Number(a.kcal) >= 1500 && Number(a.kcal) <= 7000)) errors.push('target_advice.kcal must be 1500 to 7000');
      if (!(Number(a.protein_g) >= 60 && Number(a.protein_g) <= 400)) errors.push('target_advice.protein_g must be 60 to 400');
      if (!Array.isArray(result.gaps)) errors.push('gaps must be a list');
      return { errors };
    }
    const { recipes, errors } = resolveRecipes(result.new_recipes || [], cust);
    const ids = new Set(ctx.recipes.map((r) => r.id)); const refs = new Set(recipes.map((r) => r.ref));
    const dates = new Set(ctx.dates);
    for (const d of result.days || []) {
      if (!dates.has(d.date)) { errors.push(`${d.date} isn't in the week ${ctx.week_start}`); continue; }
      for (const m of d.meals || []) {
        if (!ctx.slots.includes(m.slot)) errors.push(`${d.date}: slot "${m.slot}" isn't one of ${ctx.slots.join(', ')}`);
        if (m.recipe_id != null ? !ids.has(m.recipe_id) : !refs.has(m.new_recipe)) errors.push(`${d.date} ${m.slot}: recipe ${m.recipe_id ?? m.new_recipe} isn't one of his or the new ones`);
        if (m.portions) {
          const names = new Set((ctx.household || []).map((h) => h.name));
          for (const [who, v] of Object.entries(m.portions)) {
            if (!names.has(who)) errors.push(`${d.date} ${m.slot}: "${who}" isn't in the family (${[...names].join(', ')})`);
            if (!(Number(v) >= 0 && Number(v) <= 4)) errors.push(`${d.date} ${m.slot}: ${who}'s portion must be 0 to 4 servings`);
          }
          if (!Object.values(m.portions).some((v) => Number(v) > 0)) errors.push(`${d.date} ${m.slot}: nobody eats it`);
        } else if (!(Number(m.servings) > 0 && Number(m.servings) <= 4)) errors.push(`${d.date} ${m.slot}: servings 0.25 to 4`);
      }
    }
    if (!(result.days || []).length) errors.push('No days planned');
    // Each person's day against their calories (Nov 8: "work toward the dietary caloric and health goals").
    const fam = (ctx.household || []).filter((h) => h.role !== 'jake' && Number(h.kcal) > 0);
    if (fam.length && !errors.length) {
      const per = new Map(ctx.recipes.map((r) => [r.id, r.per_serving ? r.per_serving.kcal : null]));
      for (const r of recipes) { const t = N.recipeTotals({ servings: r.servings, ingredients: r.ingredients }, cust); per.set(`new:${r.ref}`, t.per_serving ? t.per_serving.kcal : null); }
      for (const d of result.days || []) {
        if (!(d.meals || []).some((m) => m.portions)) continue;
        for (const h of fam) {
          let kcal = 0;
          for (const m of d.meals || []) { const k = per.get(m.recipe_id != null ? m.recipe_id : `new:${m.new_recipe}`); kcal += (Number((m.portions || {})[h.name]) || 0) * (k || 0); }
          if (Math.abs(kcal - h.kcal) > h.kcal * (h.role === 'child' ? 0.2 : 0.15)) errors.push(`${d.date}: ${h.name} gets about ${Math.round(kcal)} kcal against ${h.kcal}; adjust ${h.name}'s portions (snacks count).`);
        }
      }
    }
    return { errors, recipes };
  }
  async function applyAnswer(task, result, checked, ctx) {
    if (task === 'recipe') {
      const r = checked.recipes[0];
      const made = await S.createRecipe({ ...r, kind: 'recipe', notes: r.why || null }, 'nutritionist');
      return { recipe: made };
    }
    if (task === 'review') return { review: result };
    const refIds = new Map();
    for (const r of checked.recipes) {
      const made = await S.createRecipe({ ...r, kind: 'recipe', notes: r.why || null }, 'nutritionist');
      refIds.set(r.ref, made.id);
    }
    const meals = [];
    const q4 = (v) => Math.round(Number(v) * 20) / 20; // to the nearest 0.05 serving (a child's portion is small)
    for (const d of result.days || []) for (const m of d.meals || []) {
      const portions = m.portions ? Object.fromEntries(Object.entries(m.portions).map(([k, v]) => [k, q4(v)]).filter(([, v]) => v > 0)) : null;
      meals.push({ date: d.date, slot: m.slot, recipe_id: m.recipe_id ?? refIds.get(m.new_recipe), servings: portions ? (portions.Jake || 0) : Math.round(Number(m.servings) * 4) / 4, portions });
    }
    const eaten = (await S.planRows(ctx.week_start)).filter((m) => m.eaten).map((m) => `${m.date}|${m.slot}`);
    await S.replacePlan(ctx.week_start, meals.filter((m) => !eaten.includes(`${m.date}|${m.slot}`)), {
      source: result.source === 'chef' ? 'chef' : 'nutritionist', summary: result.summary, prep: result.prep || [], notes: (result.days || []).filter((d) => d.note).map((d) => `${d.date}: ${d.note}`) });
    await S.groceriesFromPlan(ctx.week_start);
    return { plan: await S.planView(ctx.week_start), new_recipes: [...refIds.values()] };
  }
  // Cheffy (Jake, Nov 8: "Cheffy / chef is also a grok bot not a Claude agent"): the family's week is planned by Jake's
  // Grok bot, through Sentinel. It reads what the planner would have been given, and hands back a week in the same shape;
  // the same checks apply (recipes, foods, portions, each person's calories) and a failed check comes back as errors to fix.
  router.get('/nutrition/chef/context', wrap(async (req, res) => {
    const week_start = N.mondayOf(isDate(req.query.week_start) ? req.query.week_start : N.addDays(today(), 7 - ((new Date(`${today()}T12:00:00Z`).getUTCDay() + 6) % 7)));
    res.json(await contextFor('week', { week_start, note: req.query.note }));
  }));
  router.post('/nutrition/chef/week', wrap(async (req, res) => {
    const b = req.body || {};
    if (!isDate(b.week_start)) throw new Bad('week_start (YYYY-MM-DD) is required');
    const answer = b.answer && typeof b.answer === 'object' ? b.answer : null;
    if (!answer) throw new Bad('answer: { summary, days: [{ date, note?, meals: [{ slot, recipe_id | new_recipe, portions }] }], new_recipes?, prep? }');
    const ctx = await contextFor('week', { week_start: N.mondayOf(b.week_start), note: b.note });
    const checked = await checkAnswer('week', answer, ctx);
    if (checked.errors.length) return res.status(422).json({ error: 'Fix these and send the week again', errors: checked.errors.slice(0, 40) });
    const applied = await applyAnswer('week', { ...answer, source: 'chef' }, checked, ctx);
    await pool.query("INSERT INTO nutrition_jobs (task, status, result, finished_at) VALUES ('week', 'done', $1::jsonb, now())", [JSON.stringify({ answer, by: 'Cheffy', ...applied })]);
    res.json({ ok: true, week_start: ctx.week_start, new_recipes: applied.new_recipes, days: applied.plan.days.length });
  }));
  async function runCoach(jobId, task, b) {
    try {
      if (task === 'week') {
        // The week is Cheffy's: Sentinel gives it the job, and the menu lands here when Cheffy next runs.
        const out = await coach.callTrainer(undefined, { week_start: b.week_start, note: b.note }, { ...callOpts, path: '/v1/selfhub/chef', who: 'Cheffy' });
        await pool.query("UPDATE nutrition_jobs SET status = 'done', result = $1::jsonb, finished_at = now() WHERE id = $2", [JSON.stringify({ handed_to: 'Cheffy', ...out.result }), jobId]);
        return;
      }
      const ctx = await contextFor(task, b);
      let answer = await coach.callNutritionist(task, { context: ctx }, callOpts);
      let checked = await checkAnswer(task, answer.result, ctx);
      for (let i = 0; i < 2 && checked.errors.length; i++) {
        answer = await coach.callNutritionist(task, { context: ctx, previous: answer.result, errors: checked.errors }, callOpts);
        checked = await checkAnswer(task, answer.result, ctx);
      }
      if (checked.errors.length) throw new coach.CoachError(502, `The nutritionist's answer still had problems: ${checked.errors.slice(0, 3).join('; ')}`);
      const applied = await applyAnswer(task, answer.result, checked, ctx);
      await pool.query("UPDATE nutrition_jobs SET status = 'done', result = $1::jsonb, finished_at = now() WHERE id = $2", [JSON.stringify({ answer: answer.result, ...applied }), jobId]);
    } catch (err) {
      if (!(err instanceof coach.CoachError)) console.error('nutritionist job failed:', err);
      await pool.query("UPDATE nutrition_jobs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [err instanceof coach.CoachError ? err.message : 'Something went wrong — try again', jobId]).catch(() => {});
    }
  }
  const jobs = new Map(); // id → running promise (tests wait on them)
  const running = new Map(); // task|week → job id, while it runs in this process
  // A job left 'running' by a restart never finishes.
  pool.query("UPDATE nutrition_jobs SET status = 'failed', error = 'It stopped (Self Hub restarted) — try again', finished_at = now() WHERE status = 'running'").catch(() => {});
  router.post('/nutrition/coach', wrap(async (req, res) => {
    const b = { ...(req.body || {}) };
    if (!ALLOWED_TASKS.includes(b.task)) throw new Bad('task is week, review or recipe');
    if (!coach.trainerReady(env)) throw new Bad("Sentinel isn't connected (SENTINEL_URL and SENTINEL_API_KEY), so the nutritionist is off", 503);
    if (b.task === 'week') b.week_start = N.mondayOf(isDate(b.week_start) ? b.week_start : today());
    if (b.task === 'recipe' && !str(b.request, 500)) throw new Bad('Say what you want a recipe for');
    const key = `${b.task}|${b.week_start || ''}`;
    if (running.has(key)) return res.status(202).json({ job: running.get(key), status: 'running' });
    const rows = await S.q("INSERT INTO nutrition_jobs (task, status) VALUES ($1, 'running') RETURNING id", [b.task]);
    const id = rows[0].id;
    running.set(key, id);
    const p = runCoach(id, b.task, b).finally(() => { jobs.delete(id); running.delete(key); });
    jobs.set(id, p);
    res.status(202).json({ job: id, status: 'running' });
  }));
  const jobView = (r) => {
    // 'running' in the table but not in this process: a restart ended it.
    const stale = r.status === 'running' && !jobs.has(r.id);
    return { job: r.id, task: r.task, status: stale ? 'failed' : r.status, error: stale ? 'It stopped (Self Hub restarted) — try again' : r.error || null,
      result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result || null, created_at: new Date(r.created_at).toISOString(), finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null };
  };
  router.get('/nutrition/coach/jobs/:id', wrap(async (req, res) => {
    const r = /^\d+$/.test(req.params.id) ? (await S.q('SELECT * FROM nutrition_jobs WHERE id = $1', [Number(req.params.id)]))[0] : null;
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(jobView(r));
  }));
  router.get('/nutrition/coach/latest', wrap(async (req, res) => {
    const task = ALLOWED_TASKS.includes(req.query.task) ? req.query.task : 'review';
    const r = (await S.q("SELECT * FROM nutrition_jobs WHERE task = $1 AND status = 'done' ORDER BY id DESC LIMIT 1", [task]))[0];
    res.json({ ready: coach.trainerReady(env), latest: r ? jobView(r) : null });
  }));

  router.store = S;
  router.jobs = jobs;
  return router;
}

module.exports = { createNutritionRouter, createStore, SLOTS };
