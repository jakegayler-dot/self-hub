// Nutrition: the food database, portions, nutrient maths, adaptive targets, the rules meal planner and the
// grocery list (Jake, 2026-10-20). Pure functions; routes/nutrition.js does the database work.
//
// Foods: USDA FoodData Central SR Legacy (public domain), as compiled in tempo-food-db (TempoLife, CC-BY-4.0),
// per 100 g, macros only (no vitamins or minerals). Key 'usda:<id>'. His own foods are 'custom:<id>'.
const path = require('path');
const fs = require('fs');

const FOOD_FILE = path.join(__dirname, '..', 'data', 'foods_usda.json');
const ATTRIBUTION = 'Food data: USDA FoodData Central SR Legacy (public domain), via tempo-food-db — food nutrition data from TempoLife (tempolife.app), CC-BY-4.0. Per 100 g; calories, protein, carbohydrate, fat, fibre, sugar, saturated fat and sodium only.';

let usda = null; // { byId: Map, list: [] }
function loadUsda() {
  if (usda) return usda;
  const doc = JSON.parse(fs.readFileSync(FOOD_FILE, 'utf8'));
  const counts = new Map();
  for (const r of doc.foods) counts.set(r[1], (counts.get(r[1]) || 0) + 1);
  const list = doc.foods.map((r) => {
    const f = { key: `usda:${r[0]}`, name: r[1], kcal: r[2], protein_g: r[3], carbs_g: r[4], fat_g: r[5], fiber_g: r[6], sugar_g: r[7], sat_fat_g: r[8], sodium_mg: r[9], source: 'usda' };
    // SR Legacy has several rows with the same name (different trims); tell them apart by their numbers.
    f.display = counts.get(r[1]) > 1 ? `${r[1]} (${Math.round(r[2])} kcal, ${r[5]} g fat /100 g)` : r[1];
    f.words = words(r[1]);
    return f;
  });
  usda = { byId: new Map(list.map((f) => [f.key, f])), list };
  return usda;
}

function customFood(row) {
  const n = (v) => (v == null ? null : Number(v));
  return { key: `custom:${row.id}`, id: row.id, name: row.name, display: row.brand ? `${row.name} (${row.brand})` : row.name, brand: row.brand || null,
    kcal: n(row.kcal), protein_g: n(row.protein_g), carbs_g: n(row.carbs_g), fat_g: n(row.fat_g), fiber_g: n(row.fiber_g),
    sugar_g: n(row.sugar_g), sat_fat_g: n(row.sat_fat_g), sodium_mg: n(row.sodium_mg), source: 'custom', words: words(`${row.name} ${row.brand || ''}`),
    origin: row.source || 'jake', external_id: row.external_id || null, source_url: row.source_url || null };
}

// customs: Map key → food (from nutrition_foods)
function foodByKey(key, customs = new Map()) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('custom:')) return customs.get(key) || null;
  if (key.startsWith('usda:')) return loadUsda().byId.get(key) || null;
  return null;
}

// ---- search ----
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /(ch|sh|x|ss|o)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
function words(s) {
  return String(s).toLowerCase().replace(/%/g, ' pct ').replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(Boolean).map(stem);
}
const SYNONYMS = { hamburger: ['ground'], mince: ['ground'], yoghurt: ['yogurt'], prawn: ['shrimp'], porridge: ['oat'], oatmeal: ['oat'], spud: ['potato'], pb: ['peanut'] };
const NOISE = /^(fast foods?|restaurant|babyfood|infant formula|school lunch)|breaded|nuggets|\bleaves\b|\boil, (sardine|salmon|cod)/i;
const BRANDED = /\b[A-Z]{3,}\b/; // SR Legacy's brand names are in capitals (McDONALD'S, QUAKER)
const DAIRY = /\b(cheese|milk|yogh?urt|cream|butter(?!nut|bur| oil)|whey|ghee)\b/i;
// The everyday version of common foods, first in a search: his staples and the basics.
const COMMON = new Set(['usda:14951', 'usda:18588', 'usda:18555', 'usda:13231', 'usda:18583', 'usda:17108', 'usda:13485', 'usda:12310', 'usda:18122', 'usda:17458',
  'usda:14741', 'usda:12705', 'usda:13484', 'usda:17366', 'usda:11674', 'usda:13753', 'usda:16205', 'usda:17716', 'usda:15011', 'usda:14106', 'usda:12290', 'usda:13727', 'usda:14120', 'usda:15309', 'usda:14294']);
// boost: Set of food keys he already uses (recipes, pantry, recent diary)
function searchFoods(query, { customs = new Map(), boost = new Set(), limit = 25 } = {}) {
  const q = words(query).filter((w) => w !== 'and' && w !== 'with');
  if (!q.length) return [];
  const pool = [...customs.values(), ...loadUsda().list];
  const out = [];
  for (const f of pool) {
    let score = 0; let ok = true;
    for (const [i, t] of q.entries()) {
      const alts = SYNONYMS[t] || [t];
      const hit = f.words.findIndex((w) => alts.some((a) => w === a || w.startsWith(a) || (a.length > 3 && a.startsWith(w) && w.length > 3)));
      if (hit < 0) { ok = false; break; }
      score += f.words[hit] === t ? 6 : 3;
      if (hit === 0 && i === 0) score += 8; // "Eggs" → "Egg, whole…" before "Noodles, egg…"
      score -= hit * 0.4;
    }
    if (!ok) continue;
    if (f.source === 'custom') score += 25;
    if (boost.has(f.key)) score += 15;
    if (COMMON.has(f.key)) score += 10;
    // A one-word search ("eggs") wants the plain food; "big mac" or "quaker oats" means the branded one.
    if (q.length < 2 && (NOISE.test(f.name) || BRANDED.test(f.name))) score -= 9;
    else if (NOISE.test(f.name) && !q.some((t) => /fast|restaurant|bread|nugget/.test(t))) score -= 4;
    if (DAIRY.test(f.name) && !DAIRY.test(query)) score -= 6; // he has no dairy: dairy foods only when he asks for them
    if (/\braw\b/i.test(f.name)) score += 1.5; // weigh it as bought
    score -= f.words.length * 0.35; // shorter, more generic names first
    out.push({ f, score });
  }
  out.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name));
  return out.slice(0, limit).map((x) => x.f);
}

// The best match for a name (the nutritionist names ingredients as USDA does). Exact name first.
function resolveFood(name, opts = {}) {
  const n = String(name || '').trim();
  if (!n) return null;
  if (/^(usda|custom):\d+$/.test(n)) return foodByKey(n, opts.customs);
  const lower = n.toLowerCase();
  const exact = [...(opts.customs || new Map()).values(), ...loadUsda().list].find((f) => f.name.toLowerCase() === lower || f.display.toLowerCase() === lower);
  if (exact) return exact;
  return searchFoods(n, { ...opts, limit: 1 })[0] || null;
}

// ---- portions ----
const UNITS = { g: 1, kg: 1000, oz: 28.35, lb: 453.6 };
const BUILTIN_PORTIONS = [
  [/^Egg, whole/, 'large egg', 50],
  [/^Egg, white, raw/, 'large egg white', 33],
  [/^Egg, yolk, raw/, 'large yolk', 17],
  [/^Bananas, raw/, 'medium banana', 118],
  [/^Apples, raw/, 'medium apple', 182],
  [/^Oranges, raw/, 'medium orange', 131],
  [/oyster.*raw/i, 'medium oyster', 14],
  [/^Fish, sardine.*canned/, 'can (drained)', 92],
  [/^Oats$/, 'cup dry', 81],
  [/^Rice, .*cooked/, 'cup cooked', 158],
  [/^Rice, .*(raw|dry)/, 'cup dry', 185],
  [/^Potatoes, flesh and skin, raw/, 'medium potato', 213],
  [/^Sweet potato, raw/, 'medium sweet potato', 130],
  [/^Peanut [Bb]utter/, 'tbsp', 16],
  [/^Honey$/, 'tbsp', 21],
  [/^Oil, /, 'tbsp', 13.6],
  [/^Avocados, raw/, 'avocado (flesh)', 136],
  [/^Blueberries, raw/, 'cup', 148],
  [/^Spinach, raw/, 'cup', 30],
  [/^Broccoli, raw/, 'cup chopped', 91],
  [/^Onions, raw/, 'medium onion', 110],
  [/^Carrots, raw/, 'medium carrot', 61],
  [/^Garlic, raw/, 'clove', 3],
  [/^Bread, /, 'slice', 32],
  [/^Nuts, almonds/, 'handful (1 oz)', 28],
  [/^Raisins/, 'small box', 43],
];
function portionsFor(food, own = []) {
  if (!food) return [];
  const out = [];
  for (const [re, name, grams] of BUILTIN_PORTIONS) if (re.test(food.name)) out.push({ name, grams, builtin: true });
  for (const p of own) out.push({ id: p.id, name: p.name, grams: Number(p.grams) });
  return out;
}
// qty in a unit (g, kg, oz, lb) or a portion name → grams
function toGrams(qty, unit, food, own = []) {
  const n = Number(qty);
  if (!(n > 0)) return null;
  const u = String(unit || 'g').trim();
  if (UNITS[u.toLowerCase()]) return round(n * UNITS[u.toLowerCase()], 1);
  const p = portionsFor(food, own).find((x) => x.name.toLowerCase() === u.toLowerCase());
  return p ? round(n * p.grams, 1) : null;
}
// The handiest way to say an amount: "3 large egg (150 g)", "1.2 lb", "250 g".
const plural = (name, k) => (k === 1 ? name : name.includes(' (') ? name.replace(' (', 's (') : `${name}s`);
function describeAmount(grams, food, own = []) {
  const g = Number(grams);
  const p = portionsFor(food, own)[0];
  if (p) {
    const n = g / p.grams;
    if (Math.abs(n - Math.round(n * 2) / 2) < 0.08 && n <= 60) { const k = Math.round(n * 2) / 2; return `${k} ${plural(p.name, k)} (${Math.round(g)} g)`; }
  }
  return g >= 900 ? `${round(g / 453.6, 1)} lb (${Math.round(g)} g)` : `${Math.round(g)} g`;
}

// ---- nutrient maths ----
const round = (v, dp = 0) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10 ** dp) / 10 ** dp);
const NUTRIENTS = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg'];
const zero = () => Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
function nutrientsFor(food, grams) {
  const out = {};
  for (const k of NUTRIENTS) out[k] = food && food[k] != null ? (Number(food[k]) * Number(grams)) / 100 : (k === 'fiber_g' || k === 'sodium_mg' ? null : 0);
  return out;
}
function addInto(sum, n, times = 1) {
  for (const k of NUTRIENTS) if (n[k] != null) sum[k] = (sum[k] || 0) + n[k] * times;
  return sum;
}
function rounded(n) {
  return { kcal: round(n.kcal), protein_g: round(n.protein_g, 1), carbs_g: round(n.carbs_g, 1), fat_g: round(n.fat_g, 1), fiber_g: round(n.fiber_g, 1), sodium_mg: round(n.sodium_mg) };
}
// recipe: { servings, ingredients: [{ food_key, grams }] }
function recipeTotals(recipe, customs = new Map()) {
  const total = zero(); const missing = [];
  for (const ing of recipe.ingredients || []) {
    const f = foodByKey(ing.food_key, customs);
    if (!f) { missing.push(ing.food_key); continue; }
    addInto(total, nutrientsFor(f, ing.grams));
  }
  const s = Number(recipe.servings) || 1;
  const per = {}; for (const k of NUTRIENTS) per[k] = total[k] / s;
  return { total: rounded(total), per_serving: rounded(per), missing };
}

// ---- dates (America/Regina, UTC−6, no DST) ----
const reginaToday = (now = Date.now()) => new Date(now - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
function mondayOf(d) {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return addDays(d, -((dow + 6) % 7));
}
const weekDates = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

// ---- targets ----
// base: the week's average daily calories. Training days get more, rest days less, the week averaging the base
// (the gap is training_extra_kcal; the extra is carbohydrate). Protein is fixed; fat is fat_pct of the base.
function dayTargets(settings, base, isTraining, trainingDays) {
  const extra = Number(settings.training_extra_kcal) || 0;
  const t = Math.max(0, Math.min(7, trainingDays || 0));
  const kcal = t === 0 || t === 7 || !extra ? base : isTraining ? base + (extra * (7 - t)) / 7 : base - (extra * t) / 7;
  const protein = Number(settings.protein_g) || 175;
  const fat = (base * (Number(settings.fat_pct) || 30)) / 100 / 9;
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  return { kcal: Math.round(kcal / 10) * 10, protein_g: protein, fat_g: Math.round(fat), carbs_g: Math.round(carbs), day_type: isTraining ? 'training' : 'rest' };
}

// Least-squares slope of weight against day number (lb/day).
function slope(points) {
  const n = points.length;
  const xs = points.map((p) => Date.parse(`${p.date}T12:00:00Z`) / 864e5);
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = points.reduce((a, p) => a + p.lb, 0) / n;
  let num = 0; let den = 0;
  points.forEach((p, i) => { num += (xs[i] - mx) * (p.lb - my); den += (xs[i] - mx) ** 2; });
  return den ? num / den : 0;
}

// The weekly check (MacroFactor-style energy balance): over the last 21 days, his average logged intake minus the
// energy in his weight change (≈3,500 kcal per lb) is what he burns; next week's base = that + the surplus for the
// middle of his target rate. Needs 10+ fully logged days and 5+ weigh-ins over 14+ days; moves at most 150 kcal a week
// (one noisy week shouldn't swing it); holds while the trend is already inside his band.
// intake: [{ date, kcal }] per day (complete days only); weighins: [{ date, lb }]
const KCAL_PER_LB = 3500; const WINDOW = 21; const MAX_STEP = 150;
function adaptTargets({ settings, currentBase, intake, weighins, today }) {
  const from = addDays(today, -WINDOW); const to = addDays(today, -1);
  const days = intake.filter((d) => d.date >= from && d.date <= to);
  const w = weighins.filter((p) => p.date >= from && p.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const base = { base_kcal: currentBase, protein_g: Number(settings.protein_g) || 175, logged_days: days.length };
  const lo = Number(settings.rate_min_lb) || 0.25; const hi = Number(settings.rate_max_lb) || 0.5; const mid = (lo + hi) / 2;
  const spanDays = w.length ? (Date.parse(w[w.length - 1].date) - Date.parse(w[0].date)) / 864e5 : 0;
  if (settings.adaptive === false) return { ...base, decision: 'manual', rationale: `Adaptive targets are off: ${currentBase} kcal as set.` };
  if (days.length < 10 || w.length < 5 || spanDays < 14) {
    const need = [];
    if (days.length < 10) need.push(`${10 - days.length} more fully logged day${10 - days.length === 1 ? '' : 's'} (${days.length} of the last ${WINDOW})`);
    if (w.length < 5 || spanDays < 14) need.push(`weigh-ins across at least two weeks (${w.length} in the last ${WINDOW} days)`);
    return { ...base, decision: 'hold', rationale: `Holding ${currentBase} kcal: not enough data to adjust yet. Needs ${need.join(' and ')}.` };
  }
  const avg = days.reduce((a, d) => a + d.kcal, 0) / days.length;
  const rate = slope(w) * 7; // lb/week
  const tdee = avg - (rate * KCAL_PER_LB) / 7;
  const ideal = Math.round((tdee + (mid * KCAL_PER_LB) / 7) / 25) * 25;
  const r1 = Math.round(rate * 100) / 100;
  const facts = `Over the last ${WINDOW} days: ${days.length} logged days averaging ${Math.round(avg)} kcal; weight trend ${r1 >= 0 ? '+' : ''}${r1} lb/week (${w.length} weigh-ins); so he burns about ${Math.round(tdee)} kcal a day.`;
  const out = { ...base, tdee_kcal: Math.round(tdee), rate_lb_wk: r1, avg_intake_kcal: Math.round(avg) };
  if (rate >= lo && rate <= hi) return { ...out, decision: 'hold', rationale: `${facts} That's inside his ${lo}–${hi} lb/week band: holding ${currentBase} kcal.` };
  // Gaining too slowly while eating under the target (or too fast while over it): the target is right, the eating
  // isn't. Moving the target the other way would be backwards; hold and say so.
  if ((rate < lo && ideal <= currentBase) || (rate > hi && ideal >= currentBase)) {
    return { ...out, decision: 'hold', rationale: `${facts} ${rate < lo ? `Gaining slower than his ${lo}–${hi} lb/week band, but he's averaging ${Math.round(currentBase - avg)} kcal under the target: eating the ${currentBase} kcal target would put him in the band. Holding.` : `Gaining faster than his ${lo}–${hi} lb/week band, but he's averaging ${Math.round(avg - currentBase)} kcal over the target: eating to the ${currentBase} kcal target would slow it. Holding.`}` };
  }
  const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, ideal - currentBase));
  const next = Math.round((currentBase + step) / 10) * 10;
  const dir = next > currentBase ? 'up' : 'down';
  return { ...out, base_kcal: next, decision: dir,
    rationale: `${facts} ${rate < lo ? 'Gaining slower' : 'Gaining faster'} than his ${lo}–${hi} lb/week band; ${Math.round(tdee + (mid * KCAL_PER_LB) / 7)} kcal would put him at ${mid} lb/week. ${dir === 'up' ? 'Up' : 'Down'} ${Math.abs(next - currentBase)} kcal to ${next}${Math.abs(ideal - currentBase) > MAX_STEP ? ` (at most ${MAX_STEP} a week)` : ''}.` };
}

// ---- the rules meal planner ----
// recipes: [{ id, name, slot ('breakfast'|'main'|'snack'), per_serving, ingredients, servings, max_per_week }]
// targets: { date → { kcal, protein_g } }; pantry: Map food_key → grams; keep: [{date, slot}] already planned (left alone)
const SLOT_KIND = { breakfast: 'breakfast', lunch: 'main', dinner: 'main', snack: 'snack' };
const SLOT_SHARE = { breakfast: 0.25, lunch: 0.3, dinner: 0.32, snack: 0.13 };
function planWeek({ dates, slots, recipes, targets, pantry = new Map(), keep = [] }) {
  const usable = recipes.filter((r) => r.per_serving && r.per_serving.kcal > 0);
  const uses = new Map(); const meals = []; const notes = [];
  const pantryShare = (r) => {
    const g = (r.ingredients || []).reduce((a, i) => a + Number(i.grams || 0), 0) || 1;
    return (r.ingredients || []).reduce((a, i) => a + Math.min(Number(i.grams || 0), pantry.get(i.food_key) || 0), 0) / g;
  };
  const kept = new Set(keep.map((k) => `${k.date}|${k.slot}`));
  const lastDay = new Map();
  dates.forEach((date, di) => {
    const t = targets[date] || { kcal: 3300, protein_g: 175 };
    const day = [];
    for (const slot of slots) {
      if (kept.has(`${date}|${slot}`)) continue;
      const kind = SLOT_KIND[slot] || 'main';
      const options = usable.filter((r) => r.slot === kind || (kind === 'main' && r.slot === 'any'));
      if (!options.length) { notes.push(`${date} ${slot}: no ${kind} recipes yet`); continue; }
      let best = null; let bestScore = -Infinity;
      for (const r of options) {
        const n = uses.get(r.id) || 0;
        const cap = r.max_per_week || (kind === 'breakfast' ? 7 : 3);
        if (n >= cap) continue;
        const ld = lastDay.get(r.id);
        if (r.max_per_week && r.max_per_week <= 2 && ld != null && di - ld < 2) continue; // limited foods (liver): never two days running
        // Dinner cooked today is tomorrow's lunch (batch cooking): favour yesterday's dinner at lunch.
        const leftovers = slot === 'lunch' && day.length === 0 && meals.some((m) => m.date === dates[di - 1] && m.slot === 'dinner' && m.recipe_id === r.id);
        const score = -n * 3 + pantryShare(r) * 4 + (r.per_serving.protein_g / Math.max(1, r.per_serving.kcal)) * 40 + (leftovers ? 5 : 0) - ((r.id * 7 + di * 3 + slot.length) % 5) * 0.3;
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (!best) { notes.push(`${date} ${slot}: every ${kind} recipe is used up for the week`); continue; }
      uses.set(best.id, (uses.get(best.id) || 0) + 1);
      lastDay.set(best.id, di);
      day.push({ date, slot, recipe: best, servings: 1 });
    }
    // Scale each meal toward its share of the day's calories, in quarter servings, then nudge the biggest
    // meals a quarter at a time until the day is within about 3% of its target.
    const shares = day.reduce((a, m) => a + (SLOT_SHARE[m.slot] || 0.25), 0) || 1;
    for (const m of day) {
      const want = (t.kcal * (SLOT_SHARE[m.slot] || 0.25)) / shares;
      m.servings = Math.min(4, Math.max(0.5, Math.round((want / m.recipe.per_serving.kcal) * 4) / 4));
    }
    const dayKcal = () => day.reduce((a, m) => a + m.recipe.per_serving.kcal * m.servings, 0);
    for (let i = 0; i < 12 && day.length && Math.abs(dayKcal() - t.kcal) > t.kcal * 0.03; i++) {
      const up = dayKcal() < t.kcal;
      const order = [...day].filter((m) => (up ? m.servings < 4 : m.servings > 0.5)).sort((a, b) => b.recipe.per_serving.kcal * 0.25 - a.recipe.per_serving.kcal * 0.25);
      // The step that brings the day closest.
      const best = order.map((m) => ({ m, after: Math.abs(dayKcal() + (up ? 1 : -1) * m.recipe.per_serving.kcal * 0.25 - t.kcal) })).sort((a, b) => a.after - b.after)[0];
      if (!best || best.after >= Math.abs(dayKcal() - t.kcal)) break;
      best.m.servings += up ? 0.25 : -0.25;
    }
    const kcal = dayKcal();
    const protein = day.reduce((a, m) => a + m.recipe.per_serving.protein_g * m.servings, 0);
    if (day.length && protein < t.protein_g - 15) notes.push(`${date}: about ${Math.round(protein)} g protein against ${t.protein_g} g; add a protein snack or more of the main`);
    if (day.length && Math.abs(kcal - t.kcal) > t.kcal * 0.08) notes.push(`${date}: about ${Math.round(kcal)} kcal against ${t.kcal}`);
    for (const m of day) meals.push({ date, slot: m.slot, recipe_id: m.recipe.id, servings: m.servings });
  });
  return { meals, notes };
}

// ---- groceries ----
function aisle(name) {
  const n = String(name);
  if (/^(Beef|Pork|Lamb|Veal|Chicken|Turkey|Game|Bison|Fish|Mollusks|Crustaceans)/.test(n)) return 'Meat & seafood';
  if (/^Egg/.test(n)) return 'Eggs';
  if (/^(Bananas|Apples|Oranges|Blueberries|Strawberries|Raspberries|Grapes|Pears|Lemon|Lime|Avocados|Spinach|Broccoli|Kale|Lettuce|Onions|Garlic|Carrots|Peppers|Tomatoes|Potatoes|Sweet potato|Squash|Cabbage|Cauliflower|Mushrooms|Celery|Cucumber|Zucchini|Beets|Asparagus|Brussels)/.test(n)) return 'Produce';
  if (/^(Bread|Rolls|Bagels|Tortillas)/.test(n)) return 'Bakery';
  if (/frozen/i.test(n)) return 'Frozen';
  return 'Pantry';
}
// The handiest short name for the list: the recipe's label, else the start of the USDA name.
function shortName(food, label) {
  if (label) return String(label).slice(0, 60);
  const parts = food.name.split(', ');
  const drop = /^(raw|fresh|cooked|boneless|regular|unprepared|drained solids with bone|all grades|separable lean and fat|salad or cooking|whole|variety meats and by-products)$/i;
  const keep = parts.filter((p, i) => i === 0 || !drop.test(p)).slice(0, 3);
  if (parts[0] === 'Beef' && /liver/.test(food.name)) return 'Beef liver';
  return keep.join(', ').slice(0, 60);
}
const COUNTABLE = /^(large egg|medium|can|avocado|clove|slice|small box)/;
// plan: [{ recipe_id, servings }] → what to buy: per food, the plan's grams minus the pantry.
function groceriesFromPlan(plan, recipesById, pantry = new Map(), customs = new Map(), ownPortions = new Map()) {
  const need = new Map(); // food_key → { grams, label }
  for (const m of plan) {
    const r = recipesById.get(m.recipe_id);
    if (!r) continue;
    const k = Number(m.servings) / (Number(r.servings) || 1);
    for (const ing of r.ingredients || []) {
      const cur = need.get(ing.food_key) || { grams: 0, label: ing.label };
      cur.grams += Number(ing.grams) * k; cur.label = cur.label || ing.label;
      need.set(ing.food_key, cur);
    }
  }
  const out = [];
  for (const [key, { grams, label }] of need) {
    const food = foodByKey(key, customs);
    if (!food) continue;
    const short = Math.max(0, grams - (pantry.get(key) || 0));
    if (short < 5) continue;
    // Things bought whole (eggs, cans, onions) are rounded up to whole ones.
    const p = portionsFor(food, ownPortions.get(key) || [])[0];
    const g = p && COUNTABLE.test(p.name) ? Math.ceil(short / p.grams - 0.05) * p.grams : Math.ceil(short / 5) * 5;
    out.push({ food_key: key, name: shortName(food, label), grams: g, quantity: describeAmount(g, food, ownPortions.get(key) || []), aisle: aisle(food.name) });
  }
  return out.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.name.localeCompare(b.name));
}

// ---- starter recipes (dairy-free, built on his staples; his to change or delete) ----
const STARTERS = [
  { name: 'Steak, eggs and potatoes', kind: 'recipe', slot: 'breakfast', servings: 1, prep_minutes: 20,
    ingredients: [['usda:18122', 150, 'Ribeye cap steak'], ['usda:14951', 150, 'Eggs'], ['usda:13753', 250, 'Potatoes'], ['usda:15011', 10, 'Olive oil']],
    instructions: 'Cube the potatoes and fry in the oil, covered, 12 min. Sear the steak 3 min a side, rest it. Fry the eggs in the pan.' },
  { name: 'Big oats bowl and eggs', kind: 'recipe', slot: 'breakfast', servings: 1, prep_minutes: 10,
    ingredients: [['usda:14951', 150, 'Eggs'], ['usda:13485', 100, 'Oats'], ['usda:17366', 118, 'Bananas'], ['usda:17716', 32, 'Peanut butter'], ['usda:15309', 75, 'Blueberries'], ['usda:13420', 21, 'Honey']],
    instructions: 'Cook the oats in water (about 2 cups). Top with the sliced banana, berries, peanut butter and honey. Scramble or boil the eggs on the side.' },
  { name: 'Sardines on toast', kind: 'recipe', slot: 'breakfast', servings: 1, prep_minutes: 5,
    ingredients: [['usda:18555', 92, 'Sardines in oil'], ['usda:16205', 64, 'Whole-wheat bread'], ['usda:14184', 100, 'Tomatoes']],
    instructions: 'Toast the bread, mash the sardines (bones and all: that\'s the calcium) onto it, top with sliced tomato and pepper.' },
  { name: 'Beef and rice bowls', kind: 'recipe', slot: 'main', servings: 4, prep_minutes: 30, portable: true,
    ingredients: [['usda:17458', 900, 'Ground beef 80/20'], ['usda:12705', 400, 'White rice'], ['usda:14106', 500, 'Broccoli'], ['usda:13727', 150, 'Onions'], ['usda:15011', 15, 'Olive oil']],
    instructions: 'Cook the rice. Brown the beef with the onion, season. Steam the broccoli. Pack in four containers: eats hot or from a thermos in the cab.' },
  { name: 'Beef and liver with onions and rice', kind: 'recipe', slot: 'main', servings: 2, prep_minutes: 25, max_per_week: 2,
    ingredients: [['usda:13231', 200, 'Beef liver'], ['usda:17458', 300, 'Ground beef 80/20'], ['usda:13727', 220, 'Onions'], ['usda:12705', 160, 'White rice'], ['usda:12290', 100, 'Spinach'], ['usda:15011', 20, 'Olive oil']],
    instructions: 'Cook the rice. Soften the onions slowly in half the oil, 15 min, then brown the ground beef with them. Slice the liver thin, sear 1–2 min a side in the rest; keep it pink. Wilt the spinach in the pan. About 100 g liver a serving: at most twice a week, never two days running (vitamin A).',
    notes: 'Beef liver has about 9,000 mcg vitamin A per 100 g; the daily upper limit is 3,000 mcg.' },
  { name: 'Surf and turf: steak and oysters', kind: 'recipe', slot: 'main', servings: 1, prep_minutes: 20,
    ingredients: [['usda:18122', 200, 'Ribeye cap steak'], ['usda:18588', 170, 'Oysters (1 dozen)'], ['usda:12705', 80, 'White rice'], ['usda:12290', 75, 'Spinach'], ['usda:13010', 5, 'Garlic'], ['usda:15011', 10, 'Olive oil']],
    instructions: 'Cook the rice. Sear the steak, rest it. Pat the shucked oysters dry and fry 1 min a side in the pan (or eat them raw). Soften the garlic, wilt the spinach. Oysters are the richest zinc source there is; oysters alone are light on protein, so the steak carries it.' },
  { name: 'Braised short ribs, potatoes and carrots', kind: 'recipe', slot: 'main', servings: 6, prep_minutes: 200, portable: true,
    ingredients: [['usda:14555', 1400, 'Boneless short ribs'], ['usda:13753', 1200, 'Potatoes'], ['usda:14120', 600, 'Carrots'], ['usda:13727', 300, 'Onions'], ['usda:15011', 20, 'Olive oil']],
    instructions: 'Brown the beef in the oil, add the onions, cover with water or stock, braise at 300°F for 2.5 h. Add potatoes and carrots for the last hour. Batch-cook on a light day; reheats well for the truck.' },
  { name: 'Salmon, sweet potato and broccoli', kind: 'recipe', slot: 'main', servings: 2, prep_minutes: 35,
    ingredients: [['usda:18583', 400, 'Salmon fillets'], ['usda:12310', 500, 'Sweet potatoes'], ['usda:14106', 400, 'Broccoli'], ['usda:15011', 15, 'Olive oil']],
    instructions: 'Roast the cubed sweet potato in the oil at 425°F for 25 min; add the salmon and broccoli for the last 12.' },
  { name: 'Hard-boiled eggs and an apple', kind: 'recipe', slot: 'snack', servings: 1, prep_minutes: 12, portable: true,
    ingredients: [['usda:14951', 150, 'Eggs'], ['usda:11674', 182, 'Apples']],
    instructions: 'Boil a dozen at a time (10 min, then cold water); they keep a week in the fridge.' },
  { name: 'PB banana toast', kind: 'recipe', slot: 'snack', servings: 1, prep_minutes: 5,
    ingredients: [['usda:16205', 64, 'Whole-wheat bread'], ['usda:17716', 32, 'Peanut butter'], ['usda:17366', 118, 'Bananas'], ['usda:13420', 10, 'Honey']],
    instructions: 'Toast, spread, slice the banana on top, drizzle the honey.' },
  { name: 'Trail mix', kind: 'recipe', slot: 'snack', servings: 1, prep_minutes: 1, portable: true,
    ingredients: [['usda:14294', 40, 'Almonds'], ['usda:11993', 40, 'Raisins']],
    instructions: 'Bag it up: lives in the truck.' },
];
const starterRecipes = () => STARTERS.map((r) => ({ ...r, ingredients: r.ingredients.map(([food_key, grams, label]) => ({ food_key, grams, label })) }));

module.exports = {
  ATTRIBUTION, loadUsda, customFood, foodByKey, searchFoods, resolveFood, portionsFor, toGrams, describeAmount, UNITS,
  NUTRIENTS, nutrientsFor, addInto, rounded, recipeTotals, zero, round,
  reginaToday, addDays, mondayOf, weekDates, dayTargets, adaptTargets, slope, planWeek, SLOT_KIND, aisle, shortName, groceriesFromPlan, starterRecipes,
};
