// Talking to the coaches (Jake, 2026-10-26: "2 coaches and they change anything I ask, and make sure they have a
// memory"). Mounted under /api/fitness:
//
//   GET    /coach/:coach/messages?after=<id>   the conversation (as Jake sees it), the reply in progress, the memory
//   POST   /coach/:coach/messages { text }     say something → 202 { turn }; the reply is worked out in the background
//   DELETE /coach/:coach/messages              start a fresh conversation (the memory stays)
//   GET    /coach/:coach/memory   POST /coach/:coach/memory { text }   PUT/DELETE /coach/:coach/memory/:id
//
// :coach is trainer or nutritionist. Sentinel does the thinking (POST /v1/selfhub/coach-chat, lib/coach.js); Self Hub
// keeps the conversation and the memory and runs the coach's tools: self_hub_api (any of the app's own API calls, run
// as Jake through the same handlers as his screens), list_routes, athlete / nutrition (the full picture), remember,
// forget. So a coach can change anything the app can.
const express = require('express');
const coach = require('../lib/coach');
const guide = require('../lib/coachGuide');
const { listRoutes, validate } = require('./sentinelActions');

const COACHES = ['trainer', 'nutritionist', 'stylist'];
// Each coach reads one other's memory: the stylist the trainer's (his body, his training, his goals).
const OTHER = { trainer: 'nutritionist', nutritionist: 'trainer', stylist: 'trainer' };
const MAX_STEPS = 14; // calls to Sentinel in one reply
const HISTORY_ROWS = 60;
const RESULT_CHARS = 14000; // one tool result, as the coach sees it
const OLD_RESULT_CHARS = 1200; // tool results from earlier replies
const reginaToday = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
// The coach chat itself is out of the coaches' reach, however the path is spelt (routes ignore case).
const isChatPath = (p) => { let d = String(p || ''); try { d = decodeURIComponent(d); } catch (e) { /* as is */ } return d.toLowerCase().startsWith('/api/fitness/coach/'); };

const TOOLS = {
  self_hub_api: {
    name: 'self_hub_api',
    description: "Call Self Hub's own API as Jake: read anything, and make any change he asks for (log, plan, edit, delete). The guide in your instructions lists the calls; list_routes lists every route. Returns { status, body }.",
    input_schema: { type: 'object', properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'e.g. /api/fitness/workouts/42 (no query string here)' },
      query: { type: 'object', description: 'Query string values, e.g. { "from": "2026-10-26" }' },
      body: { type: 'object', description: 'JSON body for POST, PUT and PATCH' },
    }, required: ['method', 'path'] },
  },
  list_routes: {
    name: 'list_routes',
    description: "Every API route Self Hub serves (method and path), optionally only those containing a word.",
    input_schema: { type: 'object', properties: { search: { type: 'string' } } },
  },
  remember: {
    name: 'remember',
    description: 'Save one thing about Jake to your memory, in one plain sentence (a preference, an injury, his schedule, a decision, how something worked out). It stays across conversations.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  forget: {
    name: 'forget',
    description: 'Remove something from your memory by its id (when it is no longer true, or before saving the updated version).',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  athlete: {
    name: 'athlete',
    description: "Everything the trainer's plans use, for a date (default today): goals, physique evidence, the data ledger (tests due, numbers missing), bodyweight, measurements, strength scores, e1RMs, gymnastics bests, engine baselines, CrossFit percentiles, sets this week, the last 28 days of training, known movements and the session schema.",
    input_schema: { type: 'object', properties: { date: { type: 'string' } } },
  },
  wardrobe: {
    name: 'wardrobe',
    description: "His wardrobe as it is: every item (id, category, type, brand, colour, size, season, condition, style, warmth 1-5, notes, status Wear/Repair/Retired/Wishlist, price), what he wore lately, his saved outfits, the gaps, his sizes and body (measurements, bodyweight, physique goal), and what the rules would put him in today (from the farm's forecast and his day).",
    input_schema: { type: 'object', properties: { date: { type: 'string' }, occasion: { type: 'string', enum: ['farm', 'town', 'dress', 'gym'] } } },
  },
  nutrition: {
    name: 'nutrition',
    description: "The nutrition picture for a date (default today): the day's targets and what he's eaten, this week's targets decision and meal plan, his recipes (ids, per serving), the pantry and the open grocery list.",
    input_schema: { type: 'object', properties: { date: { type: 'string' } } },
  },
};
const toolsFor = (c) => [TOOLS.self_hub_api, TOOLS.list_routes, c === 'trainer' ? TOOLS.athlete : c === 'stylist' ? TOOLS.wardrobe : TOOLS.nutrition, TOOLS.remember, TOOLS.forget];

function createCoachChatRouter({ pool, workouts = null, nutrition = null, wardrobe = null, env = process.env, fetchImpl, retryMs } = {}) {
  const router = express.Router();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const callOpts = { env, ...(fetchImpl ? { fetchImpl } : {}), ...(retryMs != null ? { retryMs } : {}) };
  const running = new Map(); // coach → turn promise (one reply at a time per coach)

  const coachOf = (req, res) => {
    if (COACHES.includes(req.params.coach)) return req.params.coach;
    res.status(404).json({ error: 'coach is trainer or nutritionist' });
    return null;
  };

  // ---- memory ----
  async function memoryOf(c) {
    return (await q('SELECT id, text, source, created_at, updated_at FROM coach_memory WHERE coach = $1 ORDER BY id', [c]))
      .map((m) => ({ id: m.id, text: m.text, source: m.source || 'coach', updated_at: new Date(m.updated_at).toISOString() }));
  }
  async function remember(c, text, source = 'coach') {
    const t = String(text || '').trim().slice(0, 500);
    if (!t) throw new Error('text is required');
    if (/\b(password|passcode|pin|card number|account number)\b/i.test(t)) throw new Error("Don't store passwords or account numbers");
    const have = await q('SELECT id FROM coach_memory WHERE coach = $1 AND lower(text) = lower($2)', [c, t]);
    if (have.length) return { id: have[0].id, text: t, already: true };
    const rows = await q('INSERT INTO coach_memory (coach, text, source) VALUES ($1, $2, $3) RETURNING id', [c, t, source]);
    return { id: rows[0].id, text: t };
  }

  // ---- the conversation ----
  async function rows(c, afterId = 0) {
    return (await q('SELECT id, role, content, turn_id, created_at FROM coach_messages WHERE coach = $1 AND id > $2 ORDER BY id', [c, afterId]))
      .map((r) => ({ ...r, content: parse(r.content) }));
  }
  const isUserText = (r) => r.role === 'user' && Array.isArray(r.content) && r.content.some((b) => b.type === 'text') && !r.content.some((b) => b.type === 'tool_result');
  // What the model sees: the recent conversation, from one of Jake's messages; older tool results shortened.
  async function history(c, turnId) {
    const all = await rows(c);
    let start = Math.max(0, all.length - HISTORY_ROWS);
    // Never later than this reply's own first row (his message), however long the reply has run.
    const own = all.findIndex((r) => r.turn_id === turnId);
    if (own >= 0 && own < start) start = own;
    while (start < all.length && !isUserText(all[start])) start += 1;
    return all.slice(start).map((r) => ({
      role: r.role,
      content: r.turn_id === turnId ? r.content : r.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > OLD_RESULT_CHARS
        ? { ...b, content: `${b.content.slice(0, OLD_RESULT_CHARS)}… [older result shortened]` } : b)),
    }));
  }
  // As Jake sees it: what he said, what the coach said, and what the coach changed.
  function view(list) {
    const results = new Map();
    for (const r of list) if (r.role === 'user') for (const b of r.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
    const out = [];
    for (const r of list) {
      if (r.role === 'user') {
        const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text && isUserText(r)) out.push({ id: r.id, role: 'user', text, at: new Date(r.created_at).toISOString() });
        continue;
      }
      for (const b of r.content) {
        if (b.type === 'text' && b.text.trim()) out.push({ id: r.id, role: 'coach', text: b.text.trim(), at: new Date(r.created_at).toISOString() });
        if (b.type !== 'tool_use') continue;
        const res = results.get(b.id);
        const ok = res ? !res.is_error : null;
        const i = b.input || {};
        if (b.name === 'self_hub_api' && String(i.method).toUpperCase() !== 'GET') {
          out.push({ id: r.id, role: 'action', ok, text: `${String(i.method).toUpperCase()} ${String(i.path || '').replace(/^\/api\/fitness/, '')}`, detail: res && typeof res.content === 'string' ? res.content.slice(0, 300) : null });
        }
        if (b.name === 'remember') out.push({ id: r.id, role: 'action', ok, text: `Remembered: ${i.text || ''}` });
        if (b.name === 'forget') out.push({ id: r.id, role: 'action', ok, text: `Forgot memory #${i.id}` });
      }
    }
    return out;
  }

  // ---- the tools, run here as Jake ----
  async function runTool(c, b, port) {
    const i = b.input || {};
    try {
      if (b.name === 'remember') return JSON.stringify(await remember(c, i.text));
      if (b.name === 'forget') {
        const gone = await q('DELETE FROM coach_memory WHERE coach = $1 AND id = $2 RETURNING id', [c, Number(i.id)]);
        return gone.length ? `Forgot #${i.id}` : `No memory #${i.id} (yours are listed in your instructions)`;
      }
      if (b.name === 'list_routes') {
        const word = String(i.search || '').toLowerCase();
        return listRoutes(appRef).filter((r) => !isChatPath(r.path) && (!word || r.path.toLowerCase().includes(word))).map((r) => `${r.method} ${r.path}`).join('\n') || 'No routes match.';
      }
      if (b.name === 'athlete' && c === 'trainer' && workouts) return JSON.stringify(await workouts.athleteContext(/^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : reginaToday()));
      if (b.name === 'wardrobe' && c === 'stylist' && wardrobe) return JSON.stringify(await wardrobePicture(/^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : reginaToday(), i.occasion));
      if (b.name === 'nutrition' && c === 'nutritionist' && nutrition) return JSON.stringify(await nutritionPicture(/^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : reginaToday()));
      if (b.name !== 'self_hub_api') return { error: `No tool called ${b.name}` };
      const method = String(i.method || '').toUpperCase();
      const path = String(i.path || '');
      if (isChatPath(path)) return { error: "The coach chat itself isn't callable from here" };
      const err = validate(method, path, listRoutes(appRef));
      if (err) return { error: err };
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(i.query && typeof i.query === 'object' ? i.query : {})) if (v != null) sp.append(k, String(v));
      const qs = sp.toString() ? `?${sp}` : '';
      const headers = { Authorization: 'Basic ' + Buffer.from(`${env.SELF_HUB_USER}:${env.SELF_HUB_PASS}`).toString('base64'), Accept: 'application/json' };
      const init = { method, headers, signal: AbortSignal.timeout(120000), redirect: 'manual' };
      if (method !== 'GET' && i.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(i.body); }
      const r = await fetch(`http://127.0.0.1:${port}${path}${qs}`, init);
      const text = await r.text();
      const out = JSON.stringify({ status: r.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null });
      const clipped = out.length > RESULT_CHARS ? `${out.slice(0, RESULT_CHARS)}… [cut: ask for less, e.g. with from/to]` : out;
      return r.ok ? clipped : { error: clipped };
    } catch (e) {
      return { error: e.message || 'failed' };
    }
  }
  async function nutritionPicture(date) {
    const S = nutrition;
    const monday = (() => { const w = new Date(`${date}T12:00:00Z`).getUTCDay(); return addDays(date, -((w + 6) % 7)); })();
    const [day, plan, recipes, pantry, groceries] = await Promise.all([S.day(date), S.planView(monday), S.recipes(), S.pantry(), S.groceries()]);
    return {
      day, week_plan: { week_start: plan.week_start, summary: plan.summary, days: plan.days.map((d) => ({ date: d.date, day_type: d.day_type, kcal: d.kcal, protein_g: d.protein_g, planned_kcal: d.planned_kcal, planned_protein_g: d.planned_protein_g,
        meals: d.meals.map((m) => ({ plan_id: m.id, slot: m.slot, recipe_id: m.recipe.id, recipe: m.recipe.name, servings: m.servings, eaten: m.eaten })) })) },
      recipes: recipes.map((r) => ({ id: r.id, name: r.name, kind: r.kind, slot: r.slot, servings: r.servings, per_serving: r.per_serving, portable: r.portable, max_per_week: r.max_per_week })),
      pantry: pantry.map((p) => ({ id: p.id, food_key: p.food_key, name: p.name, amount: p.amount })),
      groceries_open: groceries.open.map((g) => ({ id: g.id, name: g.name, quantity: g.quantity })),
    };
  }
  async function wardrobePicture(date, occasion) {
    const W = require('../lib/wardrobe');
    const [items, worn, outfits, today] = await Promise.all([wardrobe.items(), wardrobe.lastWorn(), wardrobe.outfits(), wardrobe.today({ date, occasion: occasion || 'farm', weather: null })]);
    const body = (await q('SELECT entry_date, weight_lb FROM fitness_bodyweight ORDER BY entry_date DESC LIMIT 1').catch(() => []))[0];
    const m = (await q('SELECT * FROM fitness_measurements ORDER BY entry_date DESC LIMIT 1').catch(() => []))[0];
    const prof = (await q('SELECT height_in, physique_target, bodyweight_goal_lb, body_fat_target FROM fitness_profile WHERE id = 1').catch(() => []))[0] || {};
    const keep = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => v != null && !['id', 'entry_date', 'created_at'].includes(k)).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)]));
    return {
      items: items.map((i) => ({ ...i, last_worn: worn[i.id] || null })), outfits, gaps: W.gaps(items), stats: W.stats(items), today,
      body: { weight_lb: body ? Number(body.weight_lb) : null, measurements_in: keep(m), height_in: prof.height_in == null ? null : Number(prof.height_in),
        goal: 'Continuous lean gain: getting bigger through the chest, shoulders and back (V-taper), about 8-10% body fat', physique_target: prof.physique_target || null, bodyweight_goal_lb: prof.bodyweight_goal_lb == null ? null : Number(prof.bodyweight_goal_lb) },
    };
  }
  async function snapshot(c) {
    const today = reginaToday();
    try {
      if (c === 'trainer') {
        const ws = await q("SELECT id, workout_date, title, status FROM fitness_workouts WHERE workout_date >= $1 AND workout_date <= $2 ORDER BY workout_date, id", [addDays(today, -3), addDays(today, 7)]);
        const ymd = (d) => (d instanceof Date ? (d.getHours() === 0 && d.getMinutes() === 0 ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d.toISOString().slice(0, 10)) : String(d).slice(0, 10));
        return { workouts_around_today: ws.map((w) => ({ id: w.id, date: ymd(w.workout_date), title: w.title, status: w.status })) };
      }
      if (c === 'stylist') {
        if (!wardrobe) return null;
        const [items, t] = await Promise.all([wardrobe.items(), wardrobe.today({ date: today, occasion: 'farm', weather: null })]);
        return { wardrobe_items: items.filter((i) => i.status !== 'Retired').length, wishlist: items.filter((i) => i.status === 'Wishlist').map((i) => `${i.id} ${i.type}`),
          today: { weather: t.weather, dress_for_c: t.dress_for_c, day: t.day, rules_pick: t.pieces.map((p) => `${p.role}: ${p.id} ${p.type}`), notes: t.notes } };
      }
      if (nutrition) {
        const d = await nutrition.day(today);
        return { today: { targets: d.targets, eaten: d.totals, remaining: d.remaining, logged: d.entries.map((e) => `${e.slot}: ${e.name}${e.amount ? ` (${e.amount})` : ''}`), planned: d.plan.map((m) => `${m.slot}: ${m.name} x${m.servings}${m.eaten ? ' (eaten)' : ''}`) } };
      }
    } catch (e) { /* the coach can still look things up */ }
    return null;
  }

  // A reply that broke off mid-change (an error, or a restart) leaves a call with no result: close it, so the
  // conversation stays valid for the next message.
  async function repair(c, turnId = null) {
    const all = await rows(c);
    const lastRow = all[all.length - 1];
    if (!lastRow || lastRow.role !== 'assistant') return;
    const open = lastRow.content.filter((x) => x.type === 'tool_use');
    if (open.length) await q('INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ($1, $2, $3::jsonb, $4)', [c, 'user', JSON.stringify(open.map((x) => ({ type: 'tool_result', tool_use_id: x.id, is_error: true, content: 'Not run: the reply broke off.' }))), turnId ?? lastRow.turn_id]);
  }
  // Replies left running by a restart are over.
  pool.query("UPDATE coach_turns SET status = 'failed', error = 'It stopped (Self Hub restarted) — say it again', finished_at = now() WHERE status = 'running'").catch(() => {});

  let appRef = null;
  async function runTurn(turnId, c, port) {
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const [messages, memory, other, snap] = await Promise.all([history(c, turnId), memoryOf(c), memoryOf(OTHER[c]), snapshot(c)]);
        const ans = await coach.callCoachChat({ coach: c, messages, tools: toolsFor(c), context: { memory, other_memory: other, api_guide: guide[c], today: reginaToday(), snapshot: snap } }, callOpts);
        for (const m of ans.messages) {
          if (!m || !['user', 'assistant'].includes(m.role) || !Array.isArray(m.content)) continue;
          // An empty message would make every later call fail: keep a placeholder instead.
          if (!m.content.length) m.content = [{ type: 'text', text: m.role === 'assistant' ? '(no reply)' : '(nothing)' }];
          await q('INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ($1, $2, $3::jsonb, $4)', [c, m.role, JSON.stringify(m.content), turnId]);
        }
        if (ans.stop_reason !== 'tool_use') {
          await q("UPDATE coach_turns SET status = 'done', finished_at = now() WHERE id = $1", [turnId]);
          return;
        }
        const last = [...ans.messages].reverse().find((m) => m.role === 'assistant') || { content: [] };
        const answered = new Set((ans.pending_results || []).map((x) => x.tool_use_id));
        const results = [...(ans.pending_results || [])];
        // One at a time: changes land in the order the coach made them.
        for (const b of last.content.filter((x) => x.type === 'tool_use' && !answered.has(x.id))) {
          const out = await runTool(c, b, port);
          results.push(typeof out === 'string' ? { type: 'tool_result', tool_use_id: b.id, content: out } : { type: 'tool_result', tool_use_id: b.id, is_error: true, content: String(out.error) });
        }
        await q('INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ($1, $2, $3::jsonb, $4)', [c, 'user', JSON.stringify(results), turnId]);
      }
      await q('INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ($1, $2, $3::jsonb, $4)', [c, 'assistant', JSON.stringify([{ type: 'text', text: "That took more steps than I'm allowed in one go. Tell me to carry on and I'll pick up where I stopped." }]), turnId]);
      await q("UPDATE coach_turns SET status = 'done', finished_at = now() WHERE id = $1", [turnId]);
    } catch (err) {
      if (!(err instanceof coach.CoachError)) console.error('coach chat failed:', err);
      await repair(c, turnId).catch(() => {});
      await q("UPDATE coach_turns SET status = 'failed', error = $1, finished_at = now() WHERE id = $2", [err instanceof coach.CoachError ? err.message : 'Something went wrong — try again', turnId]).catch(() => {});
    }
  }

  // ---- routes ----
  router.get('/coach/:coach/messages', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    const after = /^\d+$/.test(String(req.query.after || '')) ? Number(req.query.after) : 0;
    const list = await rows(c);
    const turn = (await q('SELECT id, status, error, created_at FROM coach_turns WHERE coach = $1 ORDER BY id DESC LIMIT 1', [c]))[0];
    const live = turn && turn.status === 'running' && !running.has(c) ? { ...turn, status: 'failed', error: 'It stopped (Self Hub restarted) — say it again' } : turn;
    const items = view(list).filter((m) => m.id > after);
    res.json({ coach: c, ready: coach.trainerReady(env), items: after ? items : items.slice(-80), last_id: list.length ? list[list.length - 1].id : 0,
      turn: live ? { id: live.id, status: live.status, error: live.error || null } : null, memory: await memoryOf(c) });
  });
  router.post('/coach/:coach/messages', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim().slice(0, 4000) : '';
    if (!text) return res.status(400).json({ error: 'Say something' });
    if (!coach.trainerReady(env)) return res.status(503).json({ error: "Sentinel isn't connected (SENTINEL_URL and SENTINEL_API_KEY), so the coaches are off" });
    if (running.has(c)) return res.status(409).json({ error: 'Still working on the last one — a moment' });
    // Claimed before anything is awaited, so a double send starts one reply.
    let release; running.set(c, new Promise((r) => { release = r; }));
    try {
      appRef = req.app;
      await q("UPDATE coach_turns SET status = 'failed', error = 'It stopped (Self Hub restarted) — say it again', finished_at = now() WHERE coach = $1 AND status = 'running'", [c]);
      await repair(c);
      const turn = (await q("INSERT INTO coach_turns (coach, status) VALUES ($1, 'running') RETURNING id", [c]))[0].id;
      await q('INSERT INTO coach_messages (coach, role, content, turn_id) VALUES ($1, $2, $3::jsonb, $4)', [c, 'user', JSON.stringify([{ type: 'text', text }]), turn]);
      const p = runTurn(turn, c, req.socket.localPort).finally(() => { running.delete(c); release(); });
      running.set(c, p);
      res.status(202).json({ turn: { id: turn, status: 'running' } });
    } catch (err) {
      running.delete(c); release();
      console.error('coach chat start failed:', err);
      res.status(500).json({ error: 'failed' });
    }
  });
  router.delete('/coach/:coach/messages', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    if (running.has(c)) return res.status(409).json({ error: 'Still working on the last one — a moment' });
    await q('DELETE FROM coach_messages WHERE coach = $1', [c]);
    res.status(204).end();
  });
  router.get('/coach/:coach/memory', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    res.json({ memory: await memoryOf(c) });
  });
  router.post('/coach/:coach/memory', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    try { res.status(201).json(await remember(c, req.body && req.body.text, 'jake')); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  router.put('/coach/:coach/memory/:id', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    const t = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim().slice(0, 500) : '';
    if (!t || !/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'text is required' });
    const r = await q('UPDATE coach_memory SET text = $1, source = $2, updated_at = now() WHERE coach = $3 AND id = $4 RETURNING id', [t, 'jake', c, Number(req.params.id)]);
    if (!r.length) return res.status(404).json({ error: 'not found' });
    res.json({ id: r[0].id, text: t });
  });
  router.delete('/coach/:coach/memory/:id', async (req, res) => {
    const c = coachOf(req, res); if (!c) return;
    if (/^\d+$/.test(req.params.id)) await q('DELETE FROM coach_memory WHERE coach = $1 AND id = $2', [c, Number(req.params.id)]);
    res.status(204).end();
  });

  router.running = running;
  return router;
}

module.exports = { createCoachChatRouter, TOOLS, COACHES };
