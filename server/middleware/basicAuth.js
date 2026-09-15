// HTTP Basic Auth via environment variables — same approach as Cattle Manager.
// Set SELF_HUB_USER and SELF_HUB_PASS in Railway's environment variables.
//
// SENTINEL_USER / SENTINEL_PASS are optional, separate credentials for the
// future Sentinel service, so it never needs your own personal login and
// can be rotated or revoked independently.

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

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const reqUser = decoded.slice(0, sep);
    const reqPass = decoded.slice(sep + 1);
    if (reqUser === user && reqPass === pass) {
      next();
      return;
    }
    if (sentinelUser && sentinelPass && reqUser === sentinelUser && reqPass === sentinelPass) {
      req.isSentinel = true;
      next();
      return;
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Self Hub"');
  res.status(401).send('Authentication required.');
}

module.exports = { basicAuth };
