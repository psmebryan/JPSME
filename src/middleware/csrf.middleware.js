const crypto = require('crypto');
const { error } = require('../utils/apiResponse');

// Double-submit CSRF protection: token lives in the session and must be echoed
// back by the client (via header) on every state-changing request.

// Creates the token if the session has none yet. Writing it is what makes
// express-session store the session (saveUninitialized is false), so this is
// only called where a token is actually needed.
function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

// Runs on every request, but only creates a token for a signed-in user (whose
// session is stored anyway) or a session that already has one. An anonymous
// visitor reading the home page, an event or an article gets no session at
// all: issuing a token to everyone wrote a sessions row for every page view,
// including every bot's, which is database load and table growth for nothing.
//
// Anonymous pages that do have a form opt in with withCsrfToken on their
// route. As a safety net, public/js/api.js fetches a token from
// /api/csrf-token before any POST made from a page that rendered without one.
function issueCsrfToken(req, res, next) {
  if (req.session.user || req.session.csrfToken) ensureCsrfToken(req);
  res.locals.csrfToken = req.session.csrfToken || '';
  next();
}

// Route-level opt-in for a page that an anonymous visitor submits a form from
// (login, register, contact, ...).
function withCsrfToken(req, res, next) {
  res.locals.csrfToken = ensureCsrfToken(req);
  next();
}

// Compared with timingSafeEqual, not ===, for the same reason as the Brevo
// webhook token check and PayMongo signature check — a byte-by-byte === lets
// response timing leak how much of the token an attacker guessed correctly.
// Length is checked first since timingSafeEqual throws on mismatched buffer
// lengths rather than returning false.
function verifyCsrfToken(req, res, next) {
  const tokenFromClient = req.get('X-CSRF-Token') || req.body?._csrf;
  const expected = req.session.csrfToken;

  if (!tokenFromClient || !expected) {
    return error(res, 'Invalid or missing CSRF token', 403);
  }

  const providedBuf = Buffer.from(String(tokenFromClient));
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return error(res, 'Invalid or missing CSRF token', 403);
  }

  next();
}

module.exports = { issueCsrfToken, withCsrfToken, ensureCsrfToken, verifyCsrfToken };
