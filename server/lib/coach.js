// The trainer lives in Sentinel (Jake, 2026-10-18): Self Hub sends what it knows, Sentinel's Sonnet plans the
// week, reviews it and refines sessions, on Jake's AI budget and knowing his calendar.
//
//   POST {SENTINEL_URL}/v1/selfhub/trainer   Authorization: Bearer {SENTINEL_API_KEY}
//   { task: "week" | "review" | "refine", context, errors?, previous? }  →  { result, calendar }
//
// The same SENTINEL_URL and SENTINEL_API_KEY as the summary push (lib/sentinel.js).

const TIMEOUT_MS = 5 * 60 * 1000; // a full week takes a minute or two

class CoachError extends Error { constructor(status, message) { super(message); this.status = status; } }

function target(env = process.env) {
  const url = (env.SENTINEL_URL || '').trim().replace(/\/+$/, '');
  const key = (env.SENTINEL_API_KEY || '').trim();
  return url && key ? { url, key } : null;
}

async function callTrainer(task, body, { env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
  const t = target(env);
  if (!t) throw new CoachError(503, "Sentinel isn't connected (SENTINEL_URL and SENTINEL_API_KEY), so the trainer is off");
  let res;
  try {
    res = await fetchImpl(`${t.url}/v1/selfhub/trainer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
      body: JSON.stringify({ task, ...body }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CoachError(502, e.name === 'TimeoutError' ? 'Sentinel took too long to answer — try again' : "Couldn't reach Sentinel");
  }
  const data = await res.json().catch(() => ({}));
  const msg = data && data.error && (data.error.message || data.error);
  if (res.status === 429) throw new CoachError(429, typeof msg === 'string' ? msg : "Sentinel's AI budget is used up for now");
  if (!res.ok) throw new CoachError(502, typeof msg === 'string' ? msg : `Sentinel couldn't do it (${res.status})`);
  if (!data || typeof data.result !== 'object') throw new CoachError(502, "Sentinel's answer wasn't readable — try again");
  return data;
}

module.exports = { callTrainer, CoachError, trainerReady: (env) => !!target(env) };
