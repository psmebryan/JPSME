// While maintenance mode is on, everyone but the main admin gets the
// maintenance page (503), with a countdown when an end time is set.
//
// Still reachable during maintenance:
//   - the main admin, everywhere (to do the work and switch it off);
//   - the admin login page and what signing in needs (CSRF token, captcha,
//     the login and logout calls);
//   - PayMongo's and Brevo's webhooks, so a payment made just before the
//     site closed is still confirmed;
//   - GET /api/maintenance, which the maintenance page asks every few
//     seconds so it can reload itself the moment the site is back.
// Static files and uploads are served before this runs (app.js), and the
// health checks before that.

const maintenance = require('../services/maintenance.service');

const OPEN_PATHS = new Set(['/jpsme_admin/login', '/logout', '/api/csrf-token', '/api/captcha', '/api/auth/login', '/api/auth/logout']);
const OPEN_PREFIXES = ['/api/webhooks/'];

const isOpen = (path) => OPEN_PATHS.has(path) || OPEN_PREFIXES.some((p) => path.startsWith(p));

async function maintenanceGate(req, res, next) {
  // The page's own status check, answered whether or not maintenance is on.
  if (req.method === 'GET' && req.path === '/api/maintenance') {
    const s = await maintenance.getState();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, data: { on: s.on, until: s.until, now: new Date().toISOString() } });
  }

  const state = await maintenance.getState();
  if (!state.on) return next();

  // Shown to the main admin on every page while they work (layout banners).
  res.locals.maintenance = state;
  const user = req.session && req.session.user;
  if (user && user.role === 'ADMIN') return next();
  if (isOpen(req.path)) return next();

  // The admin panel, when not signed in: straight to the admin sign-in form,
  // so the main admin can always get back in to end maintenance (an expired
  // session must not leave them looking at the maintenance page).
  const adminPage = req.method === 'GET' && (req.path === '/jpsme_admin' || req.path.startsWith('/jpsme_admin/'));
  if (adminPage && !user) return res.redirect('/jpsme_admin/login');

  const now = Date.now();
  const untilMs = state.until ? new Date(state.until).getTime() : null;
  const retryAfter = untilMs && untilMs > now ? Math.ceil((untilMs - now) / 1000) : 300;
  res.status(503);
  res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('Cache-Control', 'no-store');

  const message = 'JPSME is down for maintenance. Please try again later.';
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.json({ success: false, message, code: 'MAINTENANCE', data: { until: state.until } });
  }
  return res.render('maintenance', {
    layout: false,
    title: 'Under maintenance',
    until: state.until,
    note: state.message,
    serverNow: new Date(now).toISOString(),
    // Someone signed in with another account (a member, or the main admin
    // in the wrong account) gets a way out: sign out, then admin sign-in.
    signedInAs: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email : null,
  });
}

module.exports = { maintenanceGate };
