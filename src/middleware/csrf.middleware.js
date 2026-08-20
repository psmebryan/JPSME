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

function verifyCsrfToken(req, res, next) {
  const tokenFromClient = req.get('X-CSRF-Token') || req.body?._csrf;
  if (!tokenFromClient || tokenFromClient !== req.session.csrfToken) {
    return error(res, 'Invalid or missing CSRF token', 403);
  }
  next();
}

module.exports = { issueCsrfToken, verifyCsrfToken };
