// Sentinel API bridge: lets Sentinel do anything Self Hub's own screens can
// do, through one authenticated endpoint.
//
//   GET  /api/sentinel/actions/routes → { routes: [{ method, path }] }
//        Every /api/ route the app serves, except /api/sentinel* and anything
//        login/auth/session/user/password shaped. Sorted, de-duplicated.
//
//   POST /api/sentinel/actions/api    { method, path, query?, body? }
//        → { status, body }  (HTTP status mirrors the inner status)
//        Replays the request against this same server over loopback
//        (http://127.0.0.1:<port>) as the owner, so it runs through exactly
//        the same handlers, validation and Sentinel push as the app's screens.
//
// Auth: the app's normal Basic auth (basicAuth middleware runs before this
// router) — Sentinel uses its own SENTINEL_USER/SENTINEL_PASS login.
// The loopback call authenticates as the owner with SELF_HUB_USER/PASS read
// from the environment; no auth bypass exists and nothing leaves the host.
const express = require('express');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_BYTES = 200 * 1024;
const TIMEOUT_MS = 20000;
const EXCLUDED_WORDS = /(login|logout|auth|session|user|password)/i;

// Express 5's Router keeps no record of the path a sub-router was mounted at,
// so tag each layer created by .use(path, ...) with it. Must be installed
// before the app mounts its routers (index.js requires this module first).
function trackMountPaths() {
  // express.Router() returns a function whose prototype is a fresh Router
  // instance; one level further up is the shared Router.prototype.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));
  if (proto.use.__tracksMounts) return;
  const original = proto.use;
  const wrapped = function use(...args) {
    const before = this.stack.length;
    const result = original.apply(this, args);
    let p = args[0];
    while (Array.isArray(p) && p.length) p = p[0];
    const mountPath = typeof p === 'string' ? p : '/';
    for (let i = before; i < this.stack.length; i++) this.stack[i].mountPath = mountPath;
    return result;
  };
  wrapped.__tracksMounts = true;
  proto.use = wrapped;
}

function joinPath(a, b) {
  const joined = `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

// Walk a router stack (recursing into mounted routers) → [{ method, path }].
function walk(stack, prefix, out) {
  for (const layer of stack || []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const m of Object.keys(layer.route.methods || {})) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: joinPath(prefix, p) });
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack) && typeof layer.mountPath === 'string') {
      walk(layer.handle.stack, joinPath(prefix, layer.mountPath), out);
    }
  }
  return out;
}

function isExcluded(p) {
  const lower = p.toLowerCase();
  return lower === '/api/sentinel' || lower.startsWith('/api/sentinel/') || lower.startsWith('/api/sentinel-')
    || EXCLUDED_WORDS.test(lower);
}

function listRoutes(app) {
  const router = app.router || app._router;
  const all = walk(router ? router.stack : [], '/', []);
  const seen = new Set();
  const routes = [];
  for (const r of all) {
    if (!r.path.startsWith('/api/') || isExcluded(r.path) || !METHODS.includes(r.method)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(r);
  }
  routes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
  return routes;
}

// Segment-wise match: ":param" matches one non-empty segment, "*name" the rest.
function matchesRoute(pattern, path) {
  const ps = pattern.split('/');
  const xs = path.split('/');
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i];
    if (seg.startsWith('*')) return xs.length > i && xs.slice(i).join('') !== '';
    if (i >= xs.length) return false;
    if (seg.startsWith(':')) {
      if (!xs[i]) return false;
    } else if (seg.toLowerCase() !== xs[i].toLowerCase()) {
      return false;
    }
  }
  return ps.length === xs.length;
}

// Returns an error string, or null when the request may be forwarded.
function validate(method, path, routes) {
  if (typeof method !== 'string' || !METHODS.includes(method.toUpperCase())) return `method must be one of ${METHODS.join(', ')}`;
  if (typeof path !== 'string' || !path.startsWith('/api/')) return 'path must start with "/api/"';
  if (path.length > 2048) return 'path too long';
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return 'path is not valid URL encoding'; }
  if (/[?#\\\s]/.test(path) || decoded.includes('..') || decoded.includes('\\') || path.includes('//')) {
    return 'path may not contain "..", "//", "\\", "?", "#" or spaces (put query values in "query")';
  }
  if (isExcluded(path) || isExcluded(decoded)) return 'path is not available through the bridge';
  const m = method.toUpperCase();
  if (!routes.some((r) => r.method === m && matchesRoute(r.path, path))) {
    return `no route ${m} ${path}; see GET /api/sentinel/actions/routes`;
  }
  return null;
}

function buildQuery(query) {
  if (query == null) return '';
  if (typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be an object');
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    for (const item of Array.isArray(v) ? v : [v]) sp.append(k, String(item));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function createSentinelActionsRouter({ log = console.log } = {}) {
  const router = express.Router();

  router.get('/actions/routes', (req, res) => {
    res.json({ routes: listRoutes(req.app) });
  });

  router.post('/actions/api', async (req, res) => {
    const started = Date.now();
    const { method, path, query, body } = req.body || {};
    const err = validate(method, path, listRoutes(req.app));
    let qs = '';
    if (!err) {
      try { qs = buildQuery(query); } catch (e) { return res.status(422).json({ error: e.message }); }
    }
    if (err) return res.status(422).json({ error: err });

    const user = process.env.SELF_HUB_USER;
    const pass = process.env.SELF_HUB_PASS;
    if (!user || !pass) return res.status(500).json({ error: 'owner auth is not configured' });

    const m = method.toUpperCase();
    const port = req.socket.localPort;
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      Accept: 'application/json',
    };
    const init = { method: m, headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' };
    if (m !== 'GET' && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let status;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}${qs}`, init);
      status = r.status;
      let text = await r.text();
      let truncated = false;
      if (Buffer.byteLength(text) > MAX_BYTES) {
        text = Buffer.from(text).subarray(0, MAX_BYTES).toString('utf8');
        truncated = true;
      }
      let parsed = text;
      if (!truncated && /json/i.test(r.headers.get('content-type') || '')) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      const out = { status, body: parsed };
      if (truncated) out.truncated = true;
      res.status(status).json(out);
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      status = timedOut ? 504 : 502;
      res.status(status).json({ status, error: timedOut ? 'timed out after 20 s' : 'inner request failed' });
    } finally {
      log(`sentinel bridge: ${m} ${path} -> ${status} (${Date.now() - started} ms)`);
    }
  });

  return router;
}

module.exports = { createSentinelActionsRouter, trackMountPaths, listRoutes, validate, matchesRoute };
