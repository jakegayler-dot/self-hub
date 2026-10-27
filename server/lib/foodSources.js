// Foods beyond the built-in list (Jake, 2026-10-21: "the first thing I tried was a double Big Mac and it didn't
// have it"). Looked up, in order:
//   1. USDA FoodData Central's API: Branded (~450k US products, label data), Survey (FNDDS: foods as eaten,
//      with portion weights), Foundation and SR Legacy (portion weights for the built-in foods).
//      FDC_API_KEY (free: https://fdc.nal.usda.gov/api-key-signup); without it DEMO_KEY (30 an hour, 50 a day).
//   2. Open Food Facts (crowd-sourced, worldwide, Canadian products included; no key).
//   3. Sentinel's nutritionist, which finds a restaurant's own published numbers on the web (routes/nutrition.js).
// Everything comes back per 100 g with a serving (name and grams) where the source has one. Network errors and
// rate limits give no results, never an error: the built-in list still works.

const FDC = 'https://api.nal.usda.gov/fdc/v1';
const OFF = 'https://world.openfoodfacts.org';
const TIMEOUT_MS = 12000; // Open Food Facts' search is often slow
const UA = 'SelfHub/1.0 (personal nutrition log; jake.gayler@gmail.com)';

const fdcKey = (env = process.env) => (env.FDC_API_KEY || '').trim() || 'DEMO_KEY';
const r1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

async function getJson(url, { fetchImpl = (...a) => fetch(...a), method = 'GET', body } = {}) {
  const res = await fetchImpl(url, {
    method, headers: { Accept: 'application/json', 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// ---- FoodData Central ----
// Nutrient numbers (the legacy NDB numbers FDC still carries) and ids; search results and food details use both shapes.
const FDC_NUTRIENTS = {
  kcal: { numbers: ['208'], ids: [1008] },
  kcal_atwater: { numbers: ['958', '957'], ids: [2048, 2047] },
  protein_g: { numbers: ['203'], ids: [1003] },
  fat_g: { numbers: ['204'], ids: [1004] },
  carbs_g: { numbers: ['205'], ids: [1005] },
  fiber_g: { numbers: ['291'], ids: [1079] },
  sugar_g: { numbers: ['269'], ids: [2000] },
  sat_fat_g: { numbers: ['606'], ids: [1258] },
  sodium_mg: { numbers: ['307'], ids: [1093] },
};
function fdcNutrients(list) {
  const out = {};
  for (const n of list || []) {
    const num = String(n.nutrientNumber ?? n.number ?? n.nutrient?.number ?? '');
    const id = Number(n.nutrientId ?? n.nutrient?.id ?? NaN);
    const unit = String(n.unitName ?? n.nutrient?.unitName ?? '').toLowerCase();
    const val = Number(n.value ?? n.amount);
    if (!Number.isFinite(val)) continue;
    for (const [k, def] of Object.entries(FDC_NUTRIENTS)) {
      if (out[k] != null) continue;
      if (!def.numbers.includes(num) && !def.ids.includes(id)) continue;
      if (k.startsWith('kcal') && unit === 'kj') continue; // energy also comes in kJ
      out[k] = val;
    }
  }
  if (out.kcal == null && out.kcal_atwater != null) out.kcal = out.kcal_atwater;
  delete out.kcal_atwater;
  return out;
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
// A serving from what FDC gives: a branded label's serving size, or a food's measures/portions.
function fdcServings(f) {
  const out = [];
  const unit = String(f.servingSizeUnit || '').toLowerCase();
  if (Number(f.servingSize) > 0 && (unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt')) {
    out.push({ name: (f.householdServingFullText || '').trim() ? String(f.householdServingFullText).trim().toLowerCase().slice(0, 40) : 'serving', grams: r1(f.servingSize) });
  }
  for (const m of f.foodMeasures || []) {
    if (Number(m.gramWeight) > 0 && m.disseminationText && !/quantity not specified/i.test(m.disseminationText)) out.push({ name: String(m.disseminationText).trim().slice(0, 40), grams: r1(m.gramWeight) });
  }
  for (const p of f.foodPortions || []) {
    const desc = p.portionDescription && !/quantity not specified/i.test(p.portionDescription) ? p.portionDescription
      : p.modifier || (p.measureUnit && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '');
    if (!(Number(p.gramWeight) > 0) || !desc) continue;
    // gramWeight is for the amount named: "1 item", "0.5 cup".
    const name = /^\d/.test(desc) ? desc : `${p.amount || 1} ${desc}`;
    out.push({ name: name.trim().slice(0, 40), grams: r1(p.gramWeight) });
  }
  const seen = new Set();
  return out.filter((s) => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
}
function fdcCandidate(f) {
  const n = fdcNutrients(f.foodNutrients);
  if (n.kcal == null || n.protein_g == null || n.fat_g == null || n.carbs_g == null) return null;
  const branded = f.dataType === 'Branded';
  const brand = branded ? titleCase(f.brandName || f.brandOwner || '') || null : null;
  return {
    key: `fdc:${f.fdcId}`, source: 'fdc', external_id: String(f.fdcId), data_type: f.dataType || null,
    name: branded ? titleCase(f.description) : f.description, brand,
    per_100g: { kcal: r1(n.kcal), protein_g: r1(n.protein_g), carbs_g: r1(n.carbs_g), fat_g: r1(n.fat_g), fiber_g: r1(n.fiber_g), sugar_g: r1(n.sugar_g), sat_fat_g: r1(n.sat_fat_g), sodium_mg: r1(n.sodium_mg) },
    portions: fdcServings(f),
    source_label: branded ? 'USDA branded (label)' : f.dataType === 'Survey (FNDDS)' ? 'USDA foods as eaten' : 'USDA',
  };
}
async function searchFdc(query, { env, fetchImpl, limit = 15 } = {}) {
  const body = { query, dataType: ['Survey (FNDDS)', 'Branded', 'Foundation'], pageSize: 40 };
  const data = await getJson(`${FDC}/foods/search?api_key=${encodeURIComponent(fdcKey(env))}`, { fetchImpl, method: 'POST', body });
  return (data.foods || []).map(fdcCandidate).filter(Boolean).slice(0, limit);
}
async function fdcFood(fdcId, { env, fetchImpl } = {}) {
  const f = await getJson(`${FDC}/food/${encodeURIComponent(fdcId)}?api_key=${encodeURIComponent(fdcKey(env))}`, { fetchImpl });
  return fdcCandidate(f);
}
// Portion weights for a built-in (SR Legacy) food: the FDC record with the same name and the same calories.
async function fdcPortionsFor(food, { env, fetchImpl } = {}) {
  const data = await getJson(`${FDC}/foods/search?api_key=${encodeURIComponent(fdcKey(env))}`, { fetchImpl, method: 'POST', body: { query: food.name, dataType: ['SR Legacy'], pageSize: 25 } });
  const name = food.name.toLowerCase();
  for (const f of data.foods || []) {
    if (!String(f.description || '').toLowerCase().startsWith(name)) continue;
    const n = fdcNutrients(f.foodNutrients);
    if (n.kcal == null || Math.abs(n.kcal - food.kcal) > Math.max(2, food.kcal * 0.03)) continue;
    const full = await getJson(`${FDC}/food/${encodeURIComponent(f.fdcId)}?api_key=${encodeURIComponent(fdcKey(env))}`, { fetchImpl }).catch(() => null);
    return fdcServings(full || f);
  }
  return [];
}

// ---- Open Food Facts ----
function offCandidate(p) {
  const n = p.nutriments || {};
  const kcal = n['energy-kcal_100g'] ?? (n['energy_100g'] != null ? Number(n['energy_100g']) / 4.184 : null);
  const name = String(p.product_name || p.product_name_en || p.generic_name || '').trim();
  if (!name || kcal == null || n.proteins_100g == null || n.carbohydrates_100g == null || n.fat_100g == null) return null;
  const portions = [];
  if (Number(p.serving_quantity) > 0) portions.push({ name: String(p.serving_size || 'serving').trim().toLowerCase().slice(0, 40), grams: r1(p.serving_quantity) });
  return {
    key: `off:${p.code}`, source: 'off', external_id: String(p.code), name: name.slice(0, 100), brand: String(p.brands || '').split(',')[0].trim() || null,
    per_100g: { kcal: r1(kcal), protein_g: r1(n.proteins_100g), carbs_g: r1(n.carbohydrates_100g), fat_g: r1(n.fat_100g), fiber_g: r1(n.fiber_100g), sugar_g: r1(n.sugars_100g),
      sat_fat_g: r1(n['saturated-fat_100g']), sodium_mg: n.sodium_100g != null ? r1(Number(n.sodium_100g) * 1000) : n.salt_100g != null ? r1((Number(n.salt_100g) * 1000) / 2.5) : null },
    portions, source_label: 'Open Food Facts',
  };
}
const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity';
async function searchOff(query, { fetchImpl, limit = 10 } = {}) {
  const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}`;
  const data = await getJson(url, { fetchImpl });
  return (data.products || []).map(offCandidate).filter(Boolean).slice(0, limit);
}
async function offProduct(code, { fetchImpl } = {}) {
  const data = await getJson(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, { fetchImpl });
  return data.product ? offCandidate({ ...data.product, code: data.product.code || code }) : null;
}

// Both at once; whatever answers in time.
async function searchOnline(query, opts = {}) {
  const [fdc, off] = await Promise.allSettled([searchFdc(query, opts), searchOff(query, opts)]);
  const problems = [];
  if (fdc.status === 'rejected') problems.push(`USDA: ${fdc.reason && fdc.reason.status === 429 ? 'hourly limit reached (set FDC_API_KEY)' : 'unavailable'}`);
  if (off.status === 'rejected') problems.push('Open Food Facts: unavailable');
  // Rank: all of the query's words in the name or brand first.
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const hits = (c) => words.filter((w) => `${c.brand || ''} ${c.name}`.toLowerCase().includes(w)).length;
  const all = [...(fdc.value || []), ...(off.value || [])].sort((a, b) => hits(b) - hits(a));
  return { foods: all.filter((c) => hits(c) > 0 || !words.length).slice(0, 20), problems };
}
async function fetchCandidate(key, opts = {}) {
  const [source, id] = String(key).split(/:(.+)/);
  if (source === 'fdc' && /^\d+$/.test(id)) return fdcFood(id, opts);
  if (source === 'off' && /^[0-9A-Za-z-]{4,40}$/.test(id)) return offProduct(id, opts);
  return null;
}

module.exports = { searchOnline, searchFdc, searchOff, fetchCandidate, fdcPortionsFor, fdcNutrients, fdcCandidate, offCandidate, fdcKey };
