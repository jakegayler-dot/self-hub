// Login (Jake, 2026-10-26: "why do I have to log into Self Hub every time I load the site").
//
// It used to be HTTP Basic Auth only: the browser's own prompt, whose answer browsers keep only until they close
// (and the iPhone's Safari and home-screen app don't keep at all). Now:
//   - Jake signs in once on /login with SELF_HUB_USER / SELF_HUB_PASS and gets a signed cookie good for 400 days
//     (the most Chrome allows), renewed as he uses the app, so it stays signed in on that phone or computer.
//     The cookie is HttpOnly, SameSite=Lax and Secure on https. It's signed with a key derived from the password
//     (or SESSION_SECRET if set), so changing SELF_HUB_PASS signs every device out. No database involved.
//   - Basic Auth still works for programs: Sentinel (SENTINEL_USER / SENTINEL_PASS, req.isSentinel) and scripts.
//   - Signed out: a page goes to /login; an /api call gets 401 JSON (no browser prompt), and the page sends him to /login.
//   - POST /logout signs this device out. Wrong passwords: 10 tries per 15 minutes per address, then a wait.

const crypto = require('crypto');

const COOKIE = 'selfhub_session';
const MAX_AGE_S = 400 * 24 * 3600;
const RENEW_BELOW_S = 300 * 24 * 3600; // renew once it's been a few months
const TRIES = 10; const TRY_WINDOW_MS = 15 * 60 * 1000;

// Constant-time string comparison (hash first so lengths always match).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signingKey(env = process.env) {
  const secret = (env.SESSION_SECRET || '').trim();
  return crypto.createHash('sha256').update(secret ? `selfhub-session:${secret}` : `selfhub-session:${env.SELF_HUB_USER}:${env.SELF_HUB_PASS}`).digest();
}
const sign = (payload, env) => crypto.createHmac('sha256', signingKey(env)).update(payload).digest('base64url');
function makeToken(nowS = Math.floor(Date.now() / 1000), env = process.env) {
  const payload = `v1.${nowS + MAX_AGE_S}`;
  return `${payload}.${sign(payload, env)}`;
}
// → seconds left, or 0 if it isn't a valid, unexpired token.
function checkToken(token, nowS = Math.floor(Date.now() / 1000), env = process.env) {
  const m = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return 0;
  if (!safeEqual(sign(m[1], env), m[3])) return 0;
  const left = Number(m[2]) - nowS;
  return left > 0 ? left : 0;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setSession(req, res) {
  res.append('Set-Cookie', `${COOKIE}=${makeToken()}; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}

// Where to go after signing in: only a path on this site.
function safeNext(v) {
  const s = String(v || '/');
  return /^\/(?![\/\\])[^\s]*$/.test(s) && !s.startsWith('/login') ? s : '/';
}

const attempts = new Map(); // ip → [timestamps]
function tooMany(ip, now = Date.now()) {
  const list = (attempts.get(ip) || []).filter((t) => now - t < TRY_WINDOW_MS);
  attempts.set(ip, list);
  if (attempts.size > 5000) attempts.clear();
  return list.length >= TRIES;
}
const noteFail = (ip) => { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function loginPage(next, error) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Self Hub — sign in</title>
<style>
:root{--bg:#14181d;--panel:#1b2129;--panel2:#212832;--line:#2c3540;--line2:#3a4552;--ink:#e7ebef;--ink2:#9aa7b4;--ink3:#5d6a78;--amber:#e0a458;--amber-dim:#8a6c3e;--amber-bg:#2b2013;--red:#c9615a}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
main{max-width:360px;margin:12vh auto 0;padding:0 16px}
h1{font-size:15px;font-weight:500;letter-spacing:.04em;margin:0 0 4px}
p{font-size:12px;color:var(--ink3);margin:0 0 20px;font-family:ui-monospace,Menlo,Consolas,monospace}
label{display:block;font-size:11px;color:var(--ink2);margin:12px 0 5px}
input{width:100%;background:var(--panel2);border:1px solid var(--line2);border-radius:6px;color:var(--ink);padding:11px 12px;font-size:16px}
button{width:100%;margin-top:18px;background:var(--amber-bg);border:1px solid var(--amber-dim);color:var(--amber);padding:12px;border-radius:6px;font-size:15px;cursor:pointer}
.err{color:var(--red);font-size:13px;margin-top:12px}
</style></head><body><main>
<h1>SELF HUB</h1><p>Sign in once; this device stays signed in.</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
${error ? `<div class="err">${esc(error)}</div>` : ''}
</form></main></body></html>`;
}

function readForm(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return resolve(req.body);
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    req.on('error', () => resolve({}));
  });
}

function basicAuth(req, res, next) {
  const user = process.env.SELF_HUB_USER;
  const pass = process.env.SELF_HUB_PASS;
  const sentinelUser = process.env.SENTINEL_USER;
  const sentinelPass = process.env.SENTINEL_PASS;

  // If credentials aren't configured, fail closed rather than leaving the app open.
  if (!user || !pass) {
    res.status(500).send('Server auth is not configured. Set SELF_HUB_USER and SELF_HUB_PASS.');
    return;
  }

  // ---- the login page ----
  if (req.path === '/login' && req.method === 'GET') {
    if (checkToken(cookies(req)[COOKIE])) return res.redirect(303, safeNext(req.query.next));
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(loginPage(safeNext(req.query.next)));
  }
  if (req.path === '/login' && req.method === 'POST') {
    return readForm(req).then((b) => {
      const ip = req.ip || req.socket.remoteAddress || '?';
      const to = safeNext(b.next);
      res.set('Cache-Control', 'no-store');
      if (tooMany(ip)) return res.status(429).type('html').send(loginPage(to, 'Too many tries. Wait 15 minutes and try again.'));
      if (safeEqual(b.username || '', user) & safeEqual(b.password || '', pass)) {
        attempts.delete(ip);
        setSession(req, res);
        return res.redirect(303, to);
      }
      noteFail(ip);
      return res.status(401).type('html').send(loginPage(to, 'Wrong username or password.'));
    });
  }
  if (req.path === '/logout' && req.method === 'POST') {
    clearSession(req, res);
    return res.redirect(303, '/login');
  }

  // ---- a signed-in device ----
  const left = checkToken(cookies(req)[COOKIE]);
  if (left) {
    if (left < RENEW_BELOW_S) setSession(req, res);
    return next();
  }

  // ---- programs (Sentinel, scripts) and old bookmarks: Basic Auth ----
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      const reqUser = decoded.slice(0, sep);
      const reqPass = decoded.slice(sep + 1);
      const isOwner = safeEqual(reqUser, user) & safeEqual(reqPass, pass);
      const isSentinel = Boolean(sentinelUser && sentinelPass) && (safeEqual(reqUser, sentinelUser) & safeEqual(reqPass, sentinelPass || ''));
      if (isOwner) {
        // The browser's old Basic prompt: give it a cookie so it never has to ask again.
        if (req.accepts(['html', 'json']) === 'html' && req.method === 'GET') setSession(req, res);
        return next();
      }
      if (isSentinel) {
        req.isSentinel = true;
        return next();
      }
    }
  }

  // ---- signed out ----
  // Pages go to the login page; the API answers 401 without the header that makes browsers pop their own prompt.
  if (req.method === 'GET' && !req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html') {
    return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
  }
  res.status(401).json({ error: 'Sign in required', login: '/login' });
}

module.exports = { basicAuth, makeToken, checkToken, COOKIE };
