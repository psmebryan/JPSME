const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const expressLayouts = require('express-ejs-layouts');

const config = require('./config');
const prisma = require('./config/prisma');
const logger = require('./utils/logger');
const pagesRoutes = require('./routes/pages.routes');
const apiRoutes = require('./routes/api');
const { issueCsrfToken } = require('./middleware/csrf.middleware');
const AppError = require('./utils/AppError');
const settingsService = require('./services/settings.service');
const sessionStore = require('./config/sessionStore');

const app = express();

// Only trust X-Forwarded-* headers when we know there's an actual reverse proxy
// in front (set TRUST_PROXY=true once deployed behind one) — trusting them
// blindly lets clients spoof their IP and dodge the rate limiters below.
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// Health checks — mounted before every other middleware (session, CSRF,
// helmet, static) on purpose: a load balancer or uptime monitor can hit
// these every few seconds, and they must never create a session row (the
// MySQL-backed session store would otherwise fill with one row per health
// check), depend on CSRF state, or wait behind any other middleware.
// - /health: liveness only — the process is up and Express is handling
//   requests. No dependency checks, so it can't report "unhealthy" just
//   because the database is slow.
// - /health/db: readiness — a real query, so a DB outage or connection-pool
//   exhaustion shows up here even though /health still reports fine. Timeout-
//   raced against a fixed budget so a hung connection fails fast instead of
//   hanging the health check itself indefinitely (defeating its purpose).
// - /health/dependencies: which external providers are actually configured
//   (booleans only, never the credential values) — checks configuration
//   presence, not live reachability, so hitting this endpoint never spends
//   a real PayMongo/Brevo/Google API call.
const HEALTH_DB_TIMEOUT_MS = 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/health/db', async (req, res) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Database health check timed out')), HEALTH_DB_TIMEOUT_MS)),
    ]);
    res.status(200).json({ status: 'ok', database: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'down' });
  }
});

app.get('/health/dependencies', (req, res) => {
  res.status(200).json({
    status: 'ok',
    dependencies: {
      database: !!config.database.url,
      email: config.email.provider === 'brevo' ? !!config.email.brevoApiKey : true,
      payment: config.payment.provider === 'paymongo' ? !!config.payment.paymongoSecretKey : true,
      googleSheets: !!(config.googleSheets.sheetId && config.googleSheets.serviceAccountEmail && config.googleSheets.serviceAccountPrivateKey),
    },
  });
});

// Every request gets a correlation id — generated fresh, or reused from an
// upstream X-Request-Id header if one arrives already set (e.g. from a
// future reverse proxy/load balancer) — echoed back as a response header so
// a client-reported issue can be traced to its exact server-side log lines.
// req.log is a child logger with this id attached to every field
// automatically; a route handler that wants request-scoped structured
// logging uses req.log instead of the bare logger. Mounted after the health
// checks (and before everything else) so frequent monitor pings never
// generate a log line, but every real request does — logged once, at
// completion, with the method/path/status/duration together rather than
// scattered across whatever a handler happened to console.log along the way.
app.use((req, res, next) => {
  req.id = req.get('X-Request-Id') || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  req.log = logger.child({ requestId: req.id });

  const startedAt = Date.now();
  res.on('finish', () => {
    req.log.info('request completed', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

app.use(compression());

// Per-request nonce so the handful of legitimate inline <script>/<style> tags
// across the views can be explicitly authorized without weakening the CSP
// with a blanket 'unsafe-inline'. Available on every view via res.locals.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        imgSrc: ["'self'", 'data:'],
        frameSrc: ["'self'", 'https://online.anyflip.com'],
      },
    },
  })
);

// Captures the exact raw bytes alongside the parsed body — the PayMongo webhook
// handler needs the untouched raw body to verify its signature (any reformatting
// invalidates it), while every other route just uses the normal parsed req.body.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'jpsme.sid', // avoid the express-session default 'connect.sid', which fingerprints the stack to anyone probing the site
    secret: config.session.secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

app.use(issueCsrfToken);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Uploaded files always get a fresh random filename (upload.middleware.js), so a
// "same" URL never serves different content — long caching is safe here.
//
// SECURITY-LOAD-BEARING ORDERING: this must stay registered after helmet()
// above, not before. Profile images/logos/sponsor logos allow SVG uploads,
// and an SVG can embed a <script> — verifyImageSignature.js only checks that
// the file looks like an image, it doesn't sanitize SVG content. What
// actually neutralizes that is the CSP header helmet attaches to every
// response, including this static one: script-src has no 'unsafe-inline'
// and a per-request nonce a pre-uploaded file could never contain, so a
// malicious SVG opened directly in a browser tab has its embedded script
// blocked. Moving this static mount before helmet (e.g. "for performance")
// would silently remove that protection.
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), { maxAge: '7d', etag: true }));

// Everything else (app JS/CSS/images) lives at a FIXED filename that does
// change as the app is developed — long caching here would silently serve
// stale JS to anyone who'd already loaded the page (this is exactly what
// broke the admin sidebar's Emails dropdown for a while). etag-based
// revalidation keeps repeat loads cheap (a 304 costs almost nothing) while
// guaranteeing new content is picked up on the very next request.
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true }));

// Make the logged-in user and CSRF token available to every view.
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// Page routes render the site logo in the navbar, so resolve it once here.
// API routes don't render views, so they skip this DB lookup.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    res.locals.logoUrl = await settingsService.getLogoUrl().catch(() => '/img/default-logo.svg');
  }
  next();
});

// A USER account that's PENDING (email verified, not yet admin-approved) can
// log in — auth.service.js allows that specifically so they can complete their
// membership payment, since the admin's approval decision is informed by
// seeing that payment status. Everywhere else, confine them to the payment
// flow until an admin approves the account.
const PENDING_USER_ALLOWED_PREFIXES = ['/membership-payment', '/logout', '/api/payments', '/api/auth/logout', '/api/csrf-token'];
app.use((req, res, next) => {
  const user = req.session.user;
  if (!user || user.role !== 'USER' || user.status !== 'PENDING') return next();

  const allowed = PENDING_USER_ALLOWED_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (allowed) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ success: false, message: 'Please complete your membership payment first' });
  }
  return res.redirect('/membership-payment');
});

app.use('/', pagesRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found', layout: 'layout' });
});

// Centralized error handler: an AppError is always something a service threw
// on purpose with a message we already decided is safe to show, regardless of
// its status code (a 502/503/504 gateway failure still gets a specific,
// helpful message here) — but any 5xx, known or not, is still worth a server
// log since it's operationally significant. Anything that ISN'T an AppError is
// an unexpected internal error — the client only ever sees a generic message
// for those, no matter what raw error text it carries.
app.use((err, req, res, next) => {
  const isKnownError = err instanceof AppError;
  const statusCode = isKnownError ? err.statusCode : 500;
  const safeMessage = isKnownError ? err.message : 'Something went wrong. Please try again.';
  if (statusCode >= 500) {
    (req.log || logger).error('unhandled request error', { err, method: req.method, path: req.originalUrl });
  }

  if (req.path.startsWith('/api/')) {
    return res.status(statusCode).json({ success: false, message: safeMessage });
  }

  return res.status(statusCode).render('error', {
    title: 'Error',
    layout: 'layout',
    message: safeMessage,
  });
});

module.exports = app;
