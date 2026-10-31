// The wardrobe (Jake, 2026-10-31), mounted under /api/fitness:
//
//   GET    /wardrobe                     his items (and wishlist), the stats, the gaps
//   POST   /wardrobe/items               { category, type, brand?, colour?, size?, season?, condition?, style?, warmth?, notes?,
//                                           status? (Wear|Repair|Retired|Wishlist), price_cad?, link? }
//   PUT    /wardrobe/items/:id           any of those          DELETE /wardrobe/items/:id
//   GET    /wardrobe/today?date=&occasion=farm|town|dress|gym   what to wear: the forecast at the farm (Open-Meteo, asked by
//                                         the page and passed as high_c, low_c, feels_low_c, feels_high_c, precip_mm,
//                                         precip_chance, snow_cm, wind_kmh; else asked here) and the day's plan
//   POST   /wardrobe/wear { date?, item_ids }   wore these          GET /wardrobe/outfits   POST/PUT/DELETE /wardrobe/outfits[/:id]
//   GET    /wardrobe/export?format=json|csv|sql
const express = require('express');
const fs = require('fs');
const path = require('path');
const W = require('../lib/wardrobe');
const { ymd } = require('../lib/workoutGen');

const SEED = path.join(__dirname, '..', 'data', 'wardrobe_seed.json');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const reginaToday = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function createWardrobeStore(pool, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const view = (r) => ({ id: r.id, category: r.category, type: r.type, brand: r.brand || null, colour: r.colour || null, size: r.size || null, season: r.season || null,
    condition: r.condition || null, style: r.style || null, warmth: r.warmth == null ? null : Number(r.warmth), notes: r.notes || null, status: r.status,
    price_cad: r.price_cad == null ? null : Number(r.price_cad), link: r.link || null });

  async function seed() {
    const claimed = await q('UPDATE wardrobe_settings SET seeded = true WHERE id = 1 AND seeded IS NOT TRUE RETURNING id');
    if (!claimed.length) return;
    const have = await q('SELECT count(*)::int AS n FROM wardrobe_items');
    if (have[0].n) return;
    for (const i of JSON.parse(fs.readFileSync(SEED, 'utf8'))) {
      await q(`INSERT INTO wardrobe_items (id, category, type, brand, colour, size, season, condition, style, warmth, notes, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
      [i.id, i.category, i.type, i.brand, i.colour, i.size, i.season, i.condition, i.style, i.warmth, i.notes, i.status || 'Wear']);
    }
  }
  async function items() {
    await seed();
    return (await q('SELECT * FROM wardrobe_items ORDER BY category, id')).map(view);
  }
  async function lastWorn() {
    const rows = await q('SELECT item_id, max(worn_on) AS d FROM wardrobe_wear GROUP BY item_id');
    return Object.fromEntries(rows.map((r) => [r.item_id, ymd(r.d)]));
  }
  // Checks a body; partial for an edit.
  function clean(b, partial) {
    const o = {};
    const pick = (k, list) => { if (b[k] === undefined) return; if (b[k] === null || b[k] === '') { o[k] = null; return; } if (list && !list.includes(b[k])) throw new Bad(`${k} is one of ${list.join(', ')}`); o[k] = String(b[k]); };
    if (b.category !== undefined || !partial) { if (!W.CATS.includes(b.category)) throw new Bad(`category is one of ${W.CATS.join(', ')}`); o.category = b.category; }
    if (b.type !== undefined || !partial) { const t = str(b.type, 80); if (!t) throw new Bad('type is required (e.g. Hoodie)'); o.type = t; }
    for (const k of ['brand', 'colour', 'size', 'style']) if (b[k] !== undefined) o[k] = str(b[k], 60);
    if (b.notes !== undefined) o.notes = str(b.notes, 500);
    if (b.link !== undefined) o.link = /^https?:\/\//.test(String(b.link || '')) ? String(b.link).slice(0, 500) : null;
    pick('season', W.SEASONS); pick('condition', W.CONDITIONS);
    if (b.status !== undefined || !partial) { const s = b.status || 'Wear'; if (!W.STATUS.includes(s)) throw new Bad(`status is one of ${W.STATUS.join(', ')}`); o.status = s; }
    if (b.warmth !== undefined) { if (b.warmth === null || b.warmth === '') o.warmth = null; else { const w = Math.round(Number(b.warmth)); if (!(w >= 1 && w <= 5)) throw new Bad('warmth is 1 to 5'); o.warmth = w; } }
    if (b.price_cad !== undefined) { if (b.price_cad === null || b.price_cad === '') o.price_cad = null; else { const p = Number(b.price_cad); if (!(p >= 0 && p < 100000)) throw new Bad('price_cad must be a price'); o.price_cad = Math.round(p * 100) / 100; } }
    return o;
  }
  async function add(b) {
    const o = clean(b, false);
    const ids = (await q('SELECT id FROM wardrobe_items')).map((r) => r.id);
    const id = W.nextId(o.category, ids, o.status === 'Wishlist');
    const cols = ['id', ...Object.keys(o)];
    await q(`INSERT INTO wardrobe_items (${cols.join(', ')}) VALUES (${cols.map((_, k) => `$${k + 1}`).join(', ')})`, [id, ...Object.values(o)]);
    return view((await q('SELECT * FROM wardrobe_items WHERE id = $1', [id]))[0]);
  }
  async function update(id, b) {
    const cur = (await q('SELECT * FROM wardrobe_items WHERE id = $1', [id]))[0];
    if (!cur) return null;
    const o = clean(b, true);
    const cols = Object.keys(o);
    if (cols.length) await q(`UPDATE wardrobe_items SET ${cols.map((c, k) => `${c} = $${k + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1}`, [...Object.values(o), id]);
    return view((await q('SELECT * FROM wardrobe_items WHERE id = $1', [id]))[0]);
  }

  // The forecast at the farm (Open-Meteo); null when it can't be had.
  async function forecast(date) {
    try {
      const r = await fetchImpl(W.openMeteoUrl(7), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      return W.weatherFromOpenMeteo(await r.json(), date);
    } catch (e) { return null; }
  }
  // What the day holds: a session planned (and where: gym or at the truck).
  async function dayPlan(date) {
    const ws = await q("SELECT title, inputs FROM fitness_workouts WHERE workout_date = $1 AND status <> 'skipped' ORDER BY id", [date]).catch(() => []);
    const weeks = await q('SELECT plan FROM fitness_weeks WHERE week_start <= $1 ORDER BY week_start DESC LIMIT 1', [date]).catch(() => []);
    const plan = weeks[0] && (typeof weeks[0].plan === 'string' ? JSON.parse(weeks[0].plan) : weeks[0].plan);
    const mode = plan && plan.availability && plan.availability[date] ? plan.availability[date] : null;
    return { mode, session: ws.length ? { gym: mode !== 'truck', title: ws[0].title } : null };
  }
  async function today({ date, occasion, weather }) {
    const plan = await dayPlan(date);
    const occ = W.OCCASIONS[occasion] ? occasion : 'farm';
    const w = weather || await forecast(date);
    return { ...W.todaysOutfit({ items: await items(), worn: await lastWorn(), date, weather: w, occasion: occ, session: plan.session }), day: plan };
  }
  async function outfits() {
    const list = await items(); const byId = new Map(list.map((i) => [i.id, i]));
    return (await q('SELECT * FROM wardrobe_outfits ORDER BY id DESC')).map((o) => {
      const ids = typeof o.item_ids === 'string' ? JSON.parse(o.item_ids) : o.item_ids;
      return { id: o.id, name: o.name, occasion: o.occasion || null, notes: o.notes || null, source: o.source || 'jake',
        items: ids.map((id) => byId.get(id) ? { id, type: byId.get(id).type, brand: byId.get(id).brand, colour: byId.get(id).colour, status: byId.get(id).status } : { id, missing: true }) };
    });
  }
  // Sentinel's snapshot: each piece needing repair is a task on its list.
  async function sentinelSnapshot(now = new Date()) {
    const list = (await items()).filter((i) => i.status === 'Repair');
    return { generated_at: now.toISOString(), prefix: 'wardrobe:', items: list.map((i) => ({ source_id: `wardrobe:repair:${i.id}`, kind: 'task', category: 'personal',
      title: `Repair: ${[i.brand, i.type].filter(Boolean).join(' ')}`.slice(0, 120), notes: [i.notes, `Wardrobe ${i.id} in Self Hub — set it back to Wear there once it's fixed.`].filter(Boolean).join(' · '), status: 'open' })) };
  }
  return { q, view, seed, items, lastWorn, add, update, forecast, dayPlan, today, outfits, sentinelSnapshot };
}

function createWardrobeRouter({ pool, fetchImpl } = {}) {
  const router = express.Router();
  const S = createWardrobeStore(pool, fetchImpl ? { fetchImpl } : {});
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof Bad) return res.status(err.status).json({ error: err.message });
      console.error('wardrobe failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  };
  router.get('/wardrobe', wrap(async (req, res) => {
    const list = await S.items();
    res.json({ items: list, stats: W.stats(list), gaps: W.gaps(list), options: { categories: W.CATS, seasons: W.SEASONS, conditions: W.CONDITIONS, statuses: W.STATUS, styles: W.STYLES, occasions: W.OCCASIONS } });
  }));
  router.post('/wardrobe/items', wrap(async (req, res) => res.status(201).json(await S.add(req.body || {}))));
  router.put('/wardrobe/items/:id', wrap(async (req, res) => {
    const it = await S.update(String(req.params.id), req.body || {});
    if (!it) return res.status(404).json({ error: 'not found' });
    res.json(it);
  }));
  router.delete('/wardrobe/items/:id', wrap(async (req, res) => {
    await S.q('DELETE FROM wardrobe_items WHERE id = $1', [String(req.params.id)]);
    res.status(204).end();
  }));
  router.get('/wardrobe/today', wrap(async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : reginaToday();
    const n = (k) => (req.query[k] === undefined || req.query[k] === '' ? null : Number(req.query[k]));
    const weather = req.query.high_c !== undefined || req.query.low_c !== undefined
      ? { date, high_c: n('high_c'), low_c: n('low_c'), feels_low_c: n('feels_low_c'), feels_high_c: n('feels_high_c'), precip_mm: n('precip_mm'), precip_chance: n('precip_chance'), snow_cm: n('snow_cm'), wind_kmh: n('wind_kmh'), source: 'Open-Meteo' }
      : null;
    res.json(await S.today({ date, occasion: String(req.query.occasion || 'farm'), weather }));
  }));
  router.post('/wardrobe/wear', wrap(async (req, res) => {
    const b = req.body || {};
    const date = isDate(b.date) ? b.date : reginaToday();
    const ids = Array.isArray(b.item_ids) ? b.item_ids.map(String).slice(0, 15) : [];
    if (!ids.length) throw new Bad('item_ids: what you wore');
    const known = new Set((await S.items()).map((i) => i.id));
    const bad = ids.filter((id) => !known.has(id));
    if (bad.length) throw new Bad(`No such item: ${bad.join(', ')}`);
    await S.q('DELETE FROM wardrobe_wear WHERE worn_on = $1 AND item_id = ANY($2::text[])', [date, ids]);
    for (const id of ids) await S.q('INSERT INTO wardrobe_wear (worn_on, item_id) VALUES ($1, $2)', [date, id]);
    res.status(201).json({ date, worn: ids });
  }));
  router.get('/wardrobe/outfits', wrap(async (req, res) => res.json({ outfits: await S.outfits() })));
  async function cleanOutfit(b) {
    const name = str(b.name, 80); if (!name) throw new Bad('An outfit needs a name');
    const ids = Array.isArray(b.item_ids) ? [...new Set(b.item_ids.map(String))].slice(0, 12) : [];
    if (!ids.length) throw new Bad('item_ids: the pieces in it');
    const known = new Set((await S.items()).map((i) => i.id));
    const bad = ids.filter((id) => !known.has(id)); if (bad.length) throw new Bad(`No such item: ${bad.join(', ')}`);
    return { name, ids, occasion: W.OCCASIONS[b.occasion] ? b.occasion : null, notes: str(b.notes, 1000) };
  }
  router.post('/wardrobe/outfits', wrap(async (req, res) => {
    const o = await cleanOutfit(req.body || {});
    const rows = await S.q('INSERT INTO wardrobe_outfits (name, occasion, item_ids, notes, source) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id',
      [o.name, o.occasion, JSON.stringify(o.ids), o.notes, req.body && req.body.source === 'stylist' ? 'stylist' : 'jake']);
    res.status(201).json((await S.outfits()).find((x) => x.id === rows[0].id));
  }));
  router.put('/wardrobe/outfits/:id', wrap(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    const o = await cleanOutfit(req.body || {});
    const r = await S.q('UPDATE wardrobe_outfits SET name = $1, occasion = $2, item_ids = $3::jsonb, notes = $4 WHERE id = $5 RETURNING id', [o.name, o.occasion, JSON.stringify(o.ids), o.notes, Number(req.params.id)]);
    if (!r.length) return res.status(404).json({ error: 'not found' });
    res.json((await S.outfits()).find((x) => x.id === r[0].id));
  }));
  router.delete('/wardrobe/outfits/:id', wrap(async (req, res) => {
    if (/^\d+$/.test(req.params.id)) await S.q('DELETE FROM wardrobe_outfits WHERE id = $1', [Number(req.params.id)]);
    res.status(204).end();
  }));
  router.get('/wardrobe/export', wrap(async (req, res) => {
    const list = await S.items();
    const f = String(req.query.format || 'json');
    if (f === 'csv') return res.type('text/csv').set('Content-Disposition', 'attachment; filename="wardrobe.csv"').send(W.toCsv(list));
    if (f === 'sql') return res.type('text/plain').set('Content-Disposition', 'attachment; filename="wardrobe.sql"').send(W.toSql(list));
    res.set('Content-Disposition', 'attachment; filename="wardrobe.json"').json(list);
  }));
  router.store = S;
  return router;
}

module.exports = { createWardrobeRouter, createWardrobeStore };
