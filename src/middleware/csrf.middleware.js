const crypto = require('crypto');
const { error } = require('../utils/apiResponse');

// Double-submit CSRF protection: token lives in the session and must be echoed
// back by the client (via header) on every state-changing request.

function issueCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
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

module.exports = { issueCsrfToken, verifyCsrfToken };
