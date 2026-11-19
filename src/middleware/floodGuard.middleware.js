// Flood guard: blocks an IP address that sends too many requests too fast.
//
// What it is for: one address hammering the site (a script, a scraper, a
// single-machine "DDoS"). It counts requests per IP in a short window and, past
// the limit, refuses every request from that IP for a while with 429, before
// any session, database or template work. A real distributed attack comes from
// thousands of addresses at once and has to be stopped at Cloudflare, in front
// of this server; see the Cloudflare notes in the README.
//
// Why the default is 100 requests in 10 seconds and not 100 a minute: one IP is
// not one person. A campus or a venue's wifi arrives as a single address, and
// this site is busiest exactly when a room of students signs up or checks in
// together. Ten requests a second, sustained for ten seconds, is far beyond a
// room of people clicking, and well within what a flood sends.
//
// Not counted: static files (/css, /js, /img: cheap, and cached by Cloudflare),
// PayMongo's webhooks (signed, with their own limit) and the check-in
// integration (keyed, with its own limits; one server fronts every scanner).
//
// Settings (environment):
//   FLOOD_GUARD             on | off. Default: on in production, off elsewhere
//   FLOOD_MAX_REQUESTS      requests allowed per window per IP. Default 100
//   FLOOD_WINDOW_SECONDS    the window. Default 10
//   FLOOD_BLOCK_MINUTES     how long an IP stays blocked. Default 15
//   FLOOD_ALLOWLIST         comma-separated IPs never blocked (e.g. the office)
//
// The counts live in this process's memory: a restart clears them, and if the
// host runs several Node processes each keeps its own. That is fine for a
// backstop; Cloudflare's rate limiting rule is the shared one.

const net = require('net');

// Cloudflare's edge ranges (https://www.cloudflare.com/ips/). A request whose
// proxy-resolved address is one of these came through Cloudflare, so the
// visitor's own address is the CF-Connecting-IP header Cloudflare sets. From
// anywhere else that header is ignored: anyone can send it.
const CLOUDFLARE_RANGES = {
  ipv4: [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  ],
  ipv6: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'],
};
const cloudflare = new net.BlockList();
CLOUDFLARE_RANGES.ipv4.forEach((r) => { const [a, p] = r.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); });
CLOUDFLARE_RANGES.ipv6.forEach((r) => { const [a, p] = r.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); });

const stripMapped = (ip) => (typeof ip === 'string' && ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

function isCloudflare(ip) {
  const clean = stripMapped(ip);
  const family = net.isIP(clean);
  if (!family) return false;
  return cloudflare.check(clean, family === 4 ? 'ipv4' : 'ipv6');
}

// Makes req.ip the visitor's address when the request came through Cloudflare.
// Every rate limiter and audit entry in the app reads req.ip, so they all get
// the real visitor instead of a Cloudflare edge shared by many people.
function realClientIp(req, res, next) {
  const seen = req.ip;
  if (isCloudflare(seen)) {
    const header = String(req.get('CF-Connecting-IP') || '').trim();
    if (net.isIP(header)) {
      Object.defineProperty(req, 'ip', { value: header, configurable: true, enumerable: true });
    }
  }
  next();
}

const SKIP = /^\/(css|js|img)\/|^\/favicon\.ico$|^\/api\/webhooks(\/|$)|^\/api\/integration(\/|$)/;
const MAX_TRACKED = 100000;

const numberEnv = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

function settings() {
  const flag = String(process.env.FLOOD_GUARD || '').trim().toLowerCase();
  const enabled = flag ? ['on', 'true', '1', 'yes'].includes(flag) : process.env.NODE_ENV === 'production';
  return {
    enabled,
    max: numberEnv('FLOOD_MAX_REQUESTS', 100, 10, 100000),
    windowMs: numberEnv('FLOOD_WINDOW_SECONDS', 10, 1, 3600) * 1000,
    blockMs: numberEnv('FLOOD_BLOCK_MINUTES', 15, 1, 1440) * 60 * 1000,
    allow: new Set(String(process.env.FLOOD_ALLOWLIST || '').split(',').map((s) => stripMapped(s.trim())).filter(Boolean)),
  };
}

function createFloodGuard({ logger, now = () => Date.now() } = {}) {
  const opts = settings();
  const counts = new Map(); // ip -> { start, count }
  const blocked = new Map(); // ip -> { until, since, requests }

  // Old entries go every minute so memory stays bounded.
  const sweep = setInterval(() => {
    const t = now();
    for (const [ip, c] of counts) if (t - c.start >= opts.windowMs) counts.delete(ip);
    for (const [ip, b] of blocked) {
      if (b.until <= t) {
        blocked.delete(ip);
        if (logger) logger.info('flood guard: block lifted', { ip, refusedWhileBlocked: b.requests });
      }
    }
  }, 60 * 1000);
  if (sweep.unref) sweep.unref();

  function refuse(req, res, until) {
    const retryAfter = Math.max(1, Math.ceil((until - now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    const minutes = Math.ceil(retryAfter / 60);
    const message = `Too many requests from your network. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
      return res.status(429).json({ success: false, message });
    }
    return res.status(429).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Too many requests</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0f172a"><h1 style="font-size:1.25rem">Too many requests</h1><p>${message}</p></body>`);
  }

  function guard(req, res, next) {
    if (!opts.enabled || SKIP.test(req.path)) return next();
    const ip = stripMapped(req.ip || '');
    if (!ip || opts.allow.has(ip)) return next();
    const t = now();

    const b = blocked.get(ip);
    if (b) {
      if (b.until > t) {
        b.requests += 1;
        return refuse(req, res, b.until);
      }
      blocked.delete(ip);
    }

    let c = counts.get(ip);
    if (!c || t - c.start >= opts.windowMs) {
      if (!c && counts.size >= MAX_TRACKED) counts.clear(); // a flood of addresses: start over rather than grow
      c = { start: t, count: 0 };
      counts.set(ip, c);
    }
    c.count += 1;
    if (c.count > opts.max) {
      counts.delete(ip);
      const until = t + opts.blockMs;
      blocked.set(ip, { until, since: t, requests: 1 });
      if (logger) {
        logger.warn('flood guard: IP blocked', {
          ip, requests: c.count, windowSeconds: opts.windowMs / 1000, blockMinutes: opts.blockMs / 60000, method: req.method, path: req.originalUrl.slice(0, 200),
        });
      }
      return refuse(req, res, until);
    }
    return next();
  }

  // For the admin page and for tests.
  guard.blockedList = () => {
    const t = now();
    return [...blocked].filter(([, b]) => b.until > t).map(([ip, b]) => ({ ip, since: new Date(b.since), until: new Date(b.until), refused: b.requests }))
      .sort((a, b) => b.since - a.since);
  };
  guard.unblock = (ip) => blocked.delete(stripMapped(String(ip || '').trim()));
  guard.settings = () => ({ enabled: opts.enabled, max: opts.max, windowSeconds: opts.windowMs / 1000, blockMinutes: opts.blockMs / 60000, allowlist: [...opts.allow] });
  guard.reset = () => { counts.clear(); blocked.clear(); };
  return guard;
}

module.exports = { createFloodGuard, realClientIp, isCloudflare };
