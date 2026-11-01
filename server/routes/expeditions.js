// Expeditions (Jake, 2026-10-31: "a travel style journal… for trips and expeditions. I like the geographical based
// approach"), mounted under /api/fitness:
//
//   GET    /expeditions                       every trip with its places (the atlas), distance, days, photo count
//   POST   /expeditions                       { title, kind? (trip|expedition|outing), start_date?, end_date?, summary? }
//   GET    /expeditions/:id                   the trip: places in order, journal pages (with the day's weather), photos,
//                                              and what he logged in training each day of it
//   PUT    /expeditions/:id   DELETE /expeditions/:id
//   POST   /expeditions/:id/places            { name, region?, lat, lon, arrived_on?, left_on?, notes? }
//   PUT    /expeditions/places/:pid           DELETE /expeditions/places/:pid
//   POST   /expeditions/:id/places/order      { ids: [place ids in order] }
//   POST   /expeditions/:id/entries           { entry_date, place_id?, title?, body }   the weather that day is looked up
//   PUT    /expeditions/entries/:eid          DELETE /expeditions/entries/:eid
//   POST   /expeditions/:id/photos            { image, thumb (base64 JPEG, shrunk in the browser), width?, height?,
//                                                taken_on?, lat?, lon?, caption?, entry_id?, place_id? }  (12 MB max)
//   GET    /expeditions/photos/:pid?size=thumb   the JPEG         PUT /expeditions/photos/:pid { caption?, entry_id?, place_id? }
//   DELETE /expeditions/photos/:pid
//   GET    /expeditions/geocode?q=Banff       places by name (Open-Meteo geocoding, no key)
const express = require('express');
const X = require('../lib/expeditions');

const KINDS = ['trip', 'expedition', 'outing'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const ymd = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const reginaToday = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
class Bad extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const B64 = /^[A-Za-z0-9+/=\s]+$/;
const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

function createExpeditionStore(pool, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const vExp = (r) => ({ id: r.id, title: r.title, kind: r.kind, start_date: ymd(r.start_date), end_date: ymd(r.end_date), summary: r.summary || null });
  const vPlace = (r) => ({ id: r.id, expedition_id: r.expedition_id, name: r.name, region: r.region || null, lat: Number(r.lat), lon: Number(r.lon),
    arrived_on: ymd(r.arrived_on), left_on: ymd(r.left_on), notes: r.notes || null, position: r.position });
  const vEntry = (r) => ({ id: r.id, expedition_id: r.expedition_id, place_id: r.place_id, entry_date: ymd(r.entry_date), title: r.title || null, body: r.body || '', weather: r.weather || null });
  const vPhoto = (r) => ({ id: r.id, expedition_id: r.expedition_id, entry_id: r.entry_id, place_id: r.place_id, taken_on: ymd(r.taken_on),
    lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), caption: r.caption || null, width: r.width, height: r.height,
    url: `/api/fitness/expeditions/photos/${r.id}`, thumb_url: `/api/fitness/expeditions/photos/${r.id}?size=thumb` });
  const PHOTO_COLS = 'id, expedition_id, entry_id, place_id, taken_on, lat, lon, caption, width, height';

  async function exp(id) {
    const r = (await q('SELECT * FROM expeditions WHERE id = $1', [Number(id)]))[0];
    if (!r) throw new Bad('No such expedition', 404);
    return vExp(r);
  }
  // The span of a trip: its own dates, else the dates of its places and pages.
  function span(e, places, entries, photos) {
    const ds = [e.start_date, e.end_date, ...places.flatMap((p) => [p.arrived_on, p.left_on]), ...entries.map((x) => x.entry_date), ...photos.map((p) => p.taken_on)].filter(Boolean).sort();
    return ds.length ? { from: e.start_date || ds[0], to: e.end_date || ds[ds.length - 1] } : null;
  }

  async function list() {
    const [exps, places, counts, pcounts] = await Promise.all([
      q('SELECT * FROM expeditions ORDER BY start_date DESC NULLS FIRST, id DESC'),
      q('SELECT * FROM expedition_places ORDER BY expedition_id, position, id'),
      q('SELECT expedition_id, count(*)::int AS n FROM expedition_entries GROUP BY expedition_id'),
      q('SELECT expedition_id, count(*)::int AS n, min(id) AS first FROM expedition_photos GROUP BY expedition_id'),
    ]);
    const byExp = {};
    for (const p of places.map(vPlace)) (byExp[p.expedition_id] = byExp[p.expedition_id] || []).push(p);
    const ent = Object.fromEntries(counts.map((c) => [c.expedition_id, c.n]));
    const ph = Object.fromEntries(pcounts.map((c) => [c.expedition_id, c]));
    return exps.map(vExp).map((e) => {
      const ps = byExp[e.id] || [];
      const days = e.start_date && e.end_date ? Math.round((Date.parse(e.end_date) - Date.parse(e.start_date)) / 864e5) + 1 : null;
      return { ...e, days, places: ps, distance_km: X.routeKm(ps), entries: ent[e.id] || 0, photos: ph[e.id] ? ph[e.id].n : 0,
        cover_url: ph[e.id] ? `/api/fitness/expeditions/photos/${ph[e.id].first}?size=thumb` : null };
    });
  }

  async function full(id) {
    const e = await exp(id);
    const [places, entries, photos] = await Promise.all([
      q('SELECT * FROM expedition_places WHERE expedition_id = $1 ORDER BY position, id', [e.id]),
      q('SELECT * FROM expedition_entries WHERE expedition_id = $1 ORDER BY entry_date, id', [e.id]),
      q(`SELECT ${PHOTO_COLS} FROM expedition_photos WHERE expedition_id = $1 ORDER BY taken_on NULLS LAST, id`, [e.id]),
    ]).then(([a, b, c]) => [a.map(vPlace), b.map(vEntry), c.map(vPhoto)]);
    // Pages written before the weather could be looked up get it now (once).
    for (const en of entries) if (!en.weather) en.weather = await weatherFor(en, places);
    const s = span(e, places, entries, photos);
    let training = {};
    if (s) {
      const [conditioning, workouts, lifts, gymnastics] = await Promise.all([
        q('SELECT entry_date, movement, distance_m, duration_seconds FROM fitness_conditioning WHERE entry_date >= $1 AND entry_date <= $2', [s.from, s.to]),
        q('SELECT workout_date, title, minutes, status FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2', [s.from, s.to]),
        q('SELECT entry_date, lift FROM fitness_lifts WHERE entry_date >= $1 AND entry_date <= $2', [s.from, s.to]),
        q('SELECT entry_date, movement FROM fitness_gymnastics WHERE entry_date >= $1 AND entry_date <= $2', [s.from, s.to]),
      ]);
      training = X.trainingByDay({ conditioning, workouts, lifts, gymnastics }, s.from, s.to);
    }
    return { ...e, span: s, places, entries, photos, training, distance_km: X.routeKm(places) };
  }

  // The weather on a page's day at its place (or the trip's place for that day, or its first place). Kept on the page.
  async function weatherFor(en, places) {
    const p = (en.place_id && places.find((x) => x.id === en.place_id))
      || places.find((x) => x.arrived_on && x.arrived_on <= en.entry_date && (!x.left_on || x.left_on >= en.entry_date))
      || places[0];
    if (!p) return null;
    const url = X.weatherUrl(p.lat, p.lon, en.entry_date, reginaToday());
    if (!url) return null;
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const w = X.weatherFrom(await r.json(), en.entry_date);
      if (!w) return null;
      w.at = p.name;
      // Only a finished day is kept; today's and future days are asked again next time.
      if (en.entry_date < reginaToday()) await q('UPDATE expedition_entries SET weather = $1::jsonb WHERE id = $2', [JSON.stringify(w), en.id]);
      return w;
    } catch (err) { return null; }
  }

  function cleanExp(b, partial) {
    const o = {};
    if (b.title !== undefined || !partial) { const t = str(b.title, 120); if (!t) throw new Bad('title is required (e.g. Banff, July 2024)'); o.title = t; }
    if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw new Bad(`kind is one of ${KINDS.join(', ')}`); o.kind = b.kind; }
    for (const k of ['start_date', 'end_date']) if (b[k] !== undefined) { if (b[k] === null || b[k] === '') o[k] = null; else if (!isDate(b[k])) throw new Bad(`${k} is YYYY-MM-DD`); else o[k] = b[k]; }
    if (o.start_date && o.end_date && o.end_date < o.start_date) throw new Bad('end_date is before start_date');
    if (b.summary !== undefined) o.summary = str(b.summary, 4000);
    return o;
  }
  function cleanPlace(b, partial) {
    const o = {};
    if (b.name !== undefined || !partial) { const n = str(b.name, 120); if (!n) throw new Bad('name is required'); o.name = n; }
    for (const [k, lo, hi] of [['lat', -90, 90], ['lon', -180, 180]]) {
      if (b[k] !== undefined || !partial) { const v = num(b[k]); if (!(Number.isFinite(v) && v >= lo && v <= hi)) throw new Bad(`${k} is a number from ${lo} to ${hi}`); o[k] = v; }
    }
    if (b.region !== undefined) o.region = str(b.region, 120);
    if (b.notes !== undefined) o.notes = str(b.notes, 4000);
    for (const k of ['arrived_on', 'left_on']) if (b[k] !== undefined) { if (b[k] === null || b[k] === '') o[k] = null; else if (!isDate(b[k])) throw new Bad(`${k} is YYYY-MM-DD`); else o[k] = b[k]; }
    return o;
  }
  const setClause = (o, from = 1) => Object.keys(o).map((k, i) => `${k} = $${i + from}`).join(', ');

  return {
    list, full, exp, weatherFor, vPhoto, PHOTO_COLS,
    async create(b) {
      const o = cleanExp(b || {}, false);
      const r = (await q('INSERT INTO expeditions (title, kind, start_date, end_date, summary) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [o.title, o.kind || 'trip', o.start_date || null, o.end_date || null, o.summary || null]))[0];
      return vExp(r);
    },
    async update(id, b) {
      await exp(id);
      const o = cleanExp(b || {}, true);
      if (Object.keys(o).length) await q(`UPDATE expeditions SET ${setClause(o)}, updated_at = now() WHERE id = $${Object.keys(o).length + 1}`, [...Object.values(o), Number(id)]);
      return exp(id);
    },
    async remove(id) { await exp(id); await q('DELETE FROM expeditions WHERE id = $1', [Number(id)]); },
    async addPlace(id, b) {
      const e = await exp(id);
      const o = cleanPlace(b || {}, false);
      const pos = (await q('SELECT coalesce(max(position), -1) + 1 AS n FROM expedition_places WHERE expedition_id = $1', [e.id]))[0].n;
      const r = (await q(`INSERT INTO expedition_places (expedition_id, name, region, lat, lon, arrived_on, left_on, notes, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [e.id, o.name, o.region || null, o.lat, o.lon, o.arrived_on || null, o.left_on || null, o.notes || null, Number(pos)]))[0];
      return vPlace(r);
    },
    async updatePlace(pid, b) {
      const o = cleanPlace(b || {}, true);
      const have = (await q('SELECT * FROM expedition_places WHERE id = $1', [Number(pid)]))[0];
      if (!have) throw new Bad('No such place', 404);
      if (Object.keys(o).length) await q(`UPDATE expedition_places SET ${setClause(o)} WHERE id = $${Object.keys(o).length + 1}`, [...Object.values(o), Number(pid)]);
      return vPlace((await q('SELECT * FROM expedition_places WHERE id = $1', [Number(pid)]))[0]);
    },
    async removePlace(pid) { const n = await q('DELETE FROM expedition_places WHERE id = $1 RETURNING id', [Number(pid)]); if (!n.length) throw new Bad('No such place', 404); },
    async orderPlaces(id, ids) {
      const e = await exp(id);
      if (!Array.isArray(ids)) throw new Bad('ids is a list of place ids in order');
      const mine = new Set((await q('SELECT id FROM expedition_places WHERE expedition_id = $1', [e.id])).map((r) => r.id));
      if (ids.length !== mine.size || !ids.every((x) => mine.has(Number(x)))) throw new Bad("ids must be every one of this trip's places, once");
      for (let i = 0; i < ids.length; i++) await q('UPDATE expedition_places SET position = $1 WHERE id = $2', [i, Number(ids[i])]);
    },
    async addEntry(id, b) {
      const e = await exp(id);
      b = b || {};
      if (!isDate(b.entry_date)) throw new Bad('entry_date is YYYY-MM-DD');
      const body = typeof b.body === 'string' ? b.body.slice(0, 20000) : '';
      const title = str(b.title, 160);
      if (!body.trim() && !title) throw new Bad('Write something (a title or the page)');
      const placeId = b.place_id == null || b.place_id === '' ? null : Number(b.place_id);
      if (placeId && !(await q('SELECT 1 FROM expedition_places WHERE id = $1 AND expedition_id = $2', [placeId, e.id])).length) throw new Bad("place_id isn't one of this trip's places");
      const r = vEntry((await q('INSERT INTO expedition_entries (expedition_id, place_id, entry_date, title, body) VALUES ($1, $2, $3, $4, $5) RETURNING *', [e.id, placeId, b.entry_date, title, body]))[0]);
      const places = (await q('SELECT * FROM expedition_places WHERE expedition_id = $1 ORDER BY position, id', [e.id])).map(vPlace);
      r.weather = await weatherFor(r, places);
      return r;
    },
    async updateEntry(eid, b) {
      b = b || {};
      const have = (await q('SELECT * FROM expedition_entries WHERE id = $1', [Number(eid)]))[0];
      if (!have) throw new Bad('No such page', 404);
      const o = {};
      if (b.entry_date !== undefined) { if (!isDate(b.entry_date)) throw new Bad('entry_date is YYYY-MM-DD'); o.entry_date = b.entry_date; }
      if (b.title !== undefined) o.title = str(b.title, 160);
      if (b.body !== undefined) o.body = typeof b.body === 'string' ? b.body.slice(0, 20000) : '';
      if (b.place_id !== undefined) {
        o.place_id = b.place_id == null || b.place_id === '' ? null : Number(b.place_id);
        if (o.place_id && !(await q('SELECT 1 FROM expedition_places WHERE id = $1 AND expedition_id = $2', [o.place_id, have.expedition_id])).length) throw new Bad("place_id isn't one of this trip's places");
      }
      // A new day or place means new weather.
      if (o.entry_date !== undefined || o.place_id !== undefined) o.weather = null;
      if (Object.keys(o).length) await q(`UPDATE expedition_entries SET ${setClause(o)}, updated_at = now() WHERE id = $${Object.keys(o).length + 1}`, [...Object.values(o), Number(eid)]);
      const r = vEntry((await q('SELECT * FROM expedition_entries WHERE id = $1', [Number(eid)]))[0]);
      if (!r.weather) r.weather = await weatherFor(r, (await q('SELECT * FROM expedition_places WHERE expedition_id = $1 ORDER BY position, id', [r.expedition_id])).map(vPlace));
      return r;
    },
    async removeEntry(eid) { const n = await q('DELETE FROM expedition_entries WHERE id = $1 RETURNING id', [Number(eid)]); if (!n.length) throw new Bad('No such page', 404); },
    async addPhoto(id, b) {
      const e = await exp(id);
      b = b || {};
      const dec = (s, what) => {
        if (typeof s !== 'string' || !s) throw new Bad(`${what} is a base64 JPEG`);
        const raw = s.replace(/^data:image\/jpeg;base64,/, '');
        if (!B64.test(raw)) throw new Bad(`${what} is a base64 JPEG`);
        const buf = Buffer.from(raw, 'base64');
        if (!isJpeg(buf)) throw new Bad(`${what} must be a JPEG (the page shrinks photos to JPEG before sending)`);
        return buf;
      };
      const image = dec(b.image, 'image'), thumb = dec(b.thumb, 'thumb');
      const lat = num(b.lat), lon = num(b.lon);
      const hasGps = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
      let placeId = b.place_id == null || b.place_id === '' ? null : Number(b.place_id);
      const places = (await q('SELECT * FROM expedition_places WHERE expedition_id = $1 ORDER BY position, id', [e.id])).map(vPlace);
      if (placeId && !places.some((p) => p.id === placeId)) throw new Bad("place_id isn't one of this trip's places");
      // A photo with its own GPS goes with the trip's place it was taken at (within 5 km).
      if (!placeId && hasGps) { const near = X.nearestPlace(places, lat, lon); if (near) placeId = near.id; }
      const entryId = b.entry_id == null || b.entry_id === '' ? null : Number(b.entry_id);
      if (entryId && !(await q('SELECT 1 FROM expedition_entries WHERE id = $1 AND expedition_id = $2', [entryId, e.id])).length) throw new Bad("entry_id isn't one of this trip's pages");
      const r = (await q(`INSERT INTO expedition_photos (expedition_id, entry_id, place_id, taken_on, lat, lon, caption, width, height, image, thumb)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${PHOTO_COLS}`,
      [e.id, entryId, placeId, isDate(b.taken_on) ? b.taken_on : null, hasGps ? lat : null, hasGps ? lon : null, str(b.caption, 500),
        Number.isFinite(num(b.width)) ? Math.round(num(b.width)) : null, Number.isFinite(num(b.height)) ? Math.round(num(b.height)) : null, image.toString('base64'), thumb.toString('base64')]))[0];
      return vPhoto(r);
    },
    async photo(pid, size) {
      const r = (await q(`SELECT ${size === 'thumb' ? 'thumb' : 'image'} AS bytes FROM expedition_photos WHERE id = $1`, [Number(pid)]))[0];
      if (!r) throw new Bad('No such photo', 404);
      return Buffer.from(r.bytes, 'base64');
    },
    async updatePhoto(pid, b) {
      b = b || {};
      const have = (await q(`SELECT ${PHOTO_COLS} FROM expedition_photos WHERE id = $1`, [Number(pid)]))[0];
      if (!have) throw new Bad('No such photo', 404);
      const o = {};
      if (b.caption !== undefined) o.caption = str(b.caption, 500);
      for (const [k, t] of [['entry_id', 'expedition_entries'], ['place_id', 'expedition_places']]) {
        if (b[k] === undefined) continue;
        o[k] = b[k] == null || b[k] === '' ? null : Number(b[k]);
        if (o[k] && !(await q(`SELECT 1 FROM ${t} WHERE id = $1 AND expedition_id = $2`, [o[k], have.expedition_id])).length) throw new Bad(`${k} isn't part of this trip`);
      }
      if (Object.keys(o).length) await q(`UPDATE expedition_photos SET ${setClause(o)} WHERE id = $${Object.keys(o).length + 1}`, [...Object.values(o), Number(pid)]);
      return vPhoto((await q(`SELECT ${PHOTO_COLS} FROM expedition_photos WHERE id = $1`, [Number(pid)]))[0]);
    },
    async removePhoto(pid) { const n = await q('DELETE FROM expedition_photos WHERE id = $1 RETURNING id', [Number(pid)]); if (!n.length) throw new Bad('No such photo', 404); },
    async geocode(text) {
      const name = str(text, 100);
      if (!name || name.length < 2) return [];
      const r = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Bad("The place search didn't answer — try again, or tap the map", 502);
      const d = await r.json();
      return (d.results || []).map((x) => ({ name: x.name, region: [x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude, kind: x.feature_code || null }));
    },
  };
}

function createExpeditionsRouter({ pool, fetchImpl } = {}) {
  const S = createExpeditionStore(pool, fetchImpl ? { fetchImpl } : {});
  const router = express.Router();
  const h = (fn, code = 200) => async (req, res) => {
    try { const out = await fn(req); if (out === undefined) res.status(204).end(); else res.status(code).json(out); }
    catch (e) { if (e instanceof Bad) return res.status(e.status).json({ error: e.message }); console.error('expeditions:', e.message); res.status(500).json({ error: 'Something went wrong with the expeditions' }); }
  };
  router.get('/expeditions', h(() => S.list()));
  router.post('/expeditions', h((req) => S.create(req.body), 201));
  router.get('/expeditions/geocode', h((req) => S.geocode(req.query.q)));
  router.get('/expeditions/photos/:pid', async (req, res) => {
    try {
      const buf = await S.photo(req.params.pid, req.query.size);
      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=31536000, immutable').send(buf);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  router.put('/expeditions/photos/:pid', h((req) => S.updatePhoto(req.params.pid, req.body)));
  router.delete('/expeditions/photos/:pid', h((req) => S.removePhoto(req.params.pid)));
  router.put('/expeditions/places/:pid', h((req) => S.updatePlace(req.params.pid, req.body)));
  router.delete('/expeditions/places/:pid', h((req) => S.removePlace(req.params.pid)));
  router.put('/expeditions/entries/:eid', h((req) => S.updateEntry(req.params.eid, req.body)));
  router.delete('/expeditions/entries/:eid', h((req) => S.removeEntry(req.params.eid)));
  router.get('/expeditions/:id', h((req) => S.full(req.params.id)));
  router.put('/expeditions/:id', h((req) => S.update(req.params.id, req.body)));
  router.delete('/expeditions/:id', h((req) => S.remove(req.params.id)));
  router.post('/expeditions/:id/places', h((req) => S.addPlace(req.params.id, req.body), 201));
  router.post('/expeditions/:id/places/order', h((req) => S.orderPlaces(req.params.id, req.body && req.body.ids)));
  router.post('/expeditions/:id/entries', h((req) => S.addEntry(req.params.id, req.body), 201));
  router.post('/expeditions/:id/photos', h((req) => S.addPhoto(req.params.id, req.body), 201));
  router.store = S;
  return router;
}

module.exports = { createExpeditionsRouter, createExpeditionStore };
