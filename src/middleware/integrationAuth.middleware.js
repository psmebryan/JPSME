// Authenticates another system by its integration key.
//
// This is the one authenticated path on the site that is NOT a browser session,
// and every difference from apiAuth follows from that:
//
//   NO CSRF. CSRF protects cookie-authenticated requests, because a browser
//   attaches cookies to cross-site requests automatically. A bearer token is
//   not attached automatically by anything — the caller has to put it there on
//   purpose — so there is no forgery to prevent, and demanding a CSRF token
//   from a server-to-server client would only make the integration impossible.
//
//   NO SESSION. req.session.user stays empty. Downstream code must not treat an
//   integration call as a signed-in user, and the door log records the scan
//   with scannedBy = NULL rather than borrowing somebody's identity.
//
//   ONE EVENT. The key carries its event; the caller never names one. A key
//   issued for last year's convention cannot be aimed at this year's by editing
//   a URL, because there is no URL to edit.

const integrationKeyService = require('../services/integrationKey.service');
const { error } = require('../utils/apiResponse');

// Accepts "Authorization: Bearer <key>", and also a bare "Authorization: <key>"
// — enough integrations get that wrong that rejecting it buys nothing but a
// support conversation. Nothing else: no query string, and no request body.
// A credential in a URL ends up in access logs, browser history, and the
// Referer header of anything that page later links to.
function readPresentedKey(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return (match ? match[1] : header.trim()).trim();
}

async function integrationAuth(req, res, next) {
  const presented = readPresentedKey(req);
  if (!presented) {
    return error(res, 'An integration key is required', 401, null, 'NO_INTEGRATION_KEY');
  }

  try {
    const key = await integrationKeyService.authenticate(presented);
    // One message for every failure — unknown key, wrong secret, revoked. Which
    // part of a credential was wrong is exactly the feedback that turns
    // guessing into a search, and the caller has no legitimate use for it.
    if (!key) {
      return error(res, 'Invalid or revoked integration key', 401, null, 'INVALID_INTEGRATION_KEY');
    }

    req.integrationKey = key;
    integrationKeyService.touch(key);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { integrationAuth, readPresentedKey };
