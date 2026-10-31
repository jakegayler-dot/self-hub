// Today's workout for Sentinel's fitness window (2026-10-31): the session on today's date (America/Regina) from
// fitness_workouts, in the same terms as Sentinel's "workouts" read collection (server/routes/sentinelRead.js).
// status: planned | started (planned, with something logged) | done | skipped.

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const num = (v) => (v == null ? null : Number(v));
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Which one to show when a day has more than one: the one under way, then planned, then done, then skipped.
const RANK = { started: 0, planned: 1, done: 2, skipped: 3 };

function shapeWorkout(r) {
  const body = parse(r.body) || {};
  const meta = parse(r.meta) || {};
  let logged = 0; let total = 0;
  const blocks = (body.blocks || []).map((b) => {
    if (b.kind === 'metcon') { total++; if (b.result) logged++; }
    const items = (b.items || []).map((it) => {
      if (b.kind !== 'metcon' && it.log_as !== 'none') {
        for (const s of it.sets || []) { total++; if (s.entry) logged++; }
      }
      return { name: it.movement, detail: it.prescription || '' };
    });
    return { title: b.title, kind: b.kind || null, minutes: num(b.minutes), items };
  });
  let status = r.status;
  if (status === 'planned' && logged > 0) status = 'started';
  return {
    id: r.id,
    date: ymd(r.workout_date),
    title: r.title,
    focus: r.focus || null,
    objective: meta.objective || null,
    minutes: num(r.minutes),
    status,
    sets_logged: logged,
    sets_total: total,
    blocks,
  };
}

// rows: fitness_workouts rows for the day. Returns the one to show, or null.
function pickToday(rows) {
  const shaped = (rows || []).map(shapeWorkout);
  shaped.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.id - b.id);
  return shaped[0] || null;
}

async function loadTodayWorkout(pool, date) {
  const { rows } = await pool.query(
    'SELECT id, workout_date, title, focus, minutes, status, body, meta FROM fitness_workouts WHERE workout_date = $1 ORDER BY id ASC',
    [date],
  );
  return pickToday(rows);
}

module.exports = { shapeWorkout, pickToday, loadTodayWorkout };
