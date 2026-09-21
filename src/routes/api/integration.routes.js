// Machine-to-machine routes: another system scanning one event's tickets.
//
// Mounted at /api/integration. Everything here is authenticated by a bearer
// integration key and NOT by a session, so note two deliberate absences:
//
//   No verifyCsrfToken. CSRF defends cookie-authenticated requests, because a
//   browser sends cookies cross-site on its own. A bearer token is only ever
//   attached on purpose, so there is nothing to forge — and requiring a CSRF
//   token from a server-side client would make the integration impossible to
//   use at all.
//
//   No :eventId in any path. The event is a property of the key. A key issued
//   for one event cannot be aimed at another, because the caller never gets to
//   name one.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { body, query } = require('express-validator');

const { integrationAuth } = require('../../middleware/integrationAuth.middleware');
const integrationApi = require('../../controllers/api/integration.api');

const router = express.Router();

// Cross-origin access, for the integration routes only.
//
// Without this, a browser-based caller never reaches the server at all: the
// browser blocks the request itself and the calling page sees an opaque
// failure with no status code and no body. "Nothing happens when I scan" is
// exactly what that looks like from the other side, which is why this is here
// rather than left for the integrator to discover.
//
// Allow-Origin is "*", and that is safe HERE for one specific reason: these
// routes authenticate with a bearer token and never with a cookie. A browser
// attaches cookies to cross-origin requests on its own; it does not attach an
// Authorization header. So "*" grants no ambient authority to a hostile page —
// it still has to possess the key, and if it possesses the key it did not need
// a browser to use it.
//
// Allow-Credentials is deliberately NOT set. Setting it (which would also
// require naming a specific origin) is what would turn this into a real hole,
// because then the browser WOULD attach the session cookie of anyone who
// happened to be signed in to JPSME.
const ALLOWED_HEADERS = 'Authorization, Content-Type';

function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  // A day, so a scanning client is not paying for a preflight on every scan.
  res.set('Access-Control-Max-Age', '86400');

  // helmet sets Cross-Origin-Resource-Policy: same-origin across the whole
  // site, and that is a SEPARATE gate from CORS: with it in place a browser
  // still refuses to hand the response body to a cross-origin caller, even
  // though the request succeeded and Allow-Origin said yes. The symptom is a
  // request that plainly worked in the network tab and an empty result in the
  // code. Relaxed here only, for these routes.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');

  // The preflight. It must answer BEFORE integrationAuth, because a browser
  // sends OPTIONS with no Authorization header at all — authenticating it would
  // return 401 and the browser would never send the real request.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

router.use(cors);


// Same reasoning as the staff scan limiter: sized to stop a runaway client
// loop, not to police real scanning. A convention door moves several hundred
// people through in the first ten minutes, and an integration is likely to be
// one machine behind one IP — so a limit tuned like the login endpoint would
// throttle a real queue, which is the worst failure this feature has.
//
// Keyed on the integration key rather than the IP. A venue commonly NATs every
// device behind one address, so per-IP limiting would let one busy system
// starve another; and a key is the thing actually being rate limited.
const scanLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  // The fallback goes through ipKeyGenerator rather than using req.ip raw.
  // A single IPv6 client is normally handed a whole /64, so keying on the bare
  // address lets one caller present a different "identity" per request and slip
  // the limit entirely; the helper normalises to the prefix. In practice this
  // branch is unreachable — integrationAuth runs first and 401s without a key —
  // but an unreachable branch that is wrong is still wrong the day it stops
  // being unreachable.
  keyGenerator: (req, res) => (
    req.integrationKey ? `ik:${req.integrationKey.id}` : ipKeyGenerator(req, res)
  ),
  message: { success: false, message: 'Too many scans. Please slow down.' },
});

// Listing is a bulk read done a handful of times (at setup, and to reconcile
// afterwards), not a per-person action at a door — so it gets its own, much
// tighter limit. Sharing the scan limiter would let a polling loop burn the
// door's allowance.
const listLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (
    req.integrationKey ? `ik-list:${req.integrationKey.id}` : ipKeyGenerator(req, res)
  ),
  message: { success: false, message: 'Too many roster requests. Please slow down.' },
});

// Length-bounded but not format-checked: deciding what counts as a valid code
// is qr.service's job, and a malformed scan has to come back as a normal
// INVALID_QR verdict the calling system can display — not as a 422 it has to
// special-case.
const scanValidators = [
  body('qrToken').isString().withMessage('A scanned value is required').isLength({ min: 1, max: 512 }),
  body('scannerIdentifier').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
  body('station').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
];

// Confirm a key works and see which event it opens. No rate limit beyond the
// global one: it is called once during setup, not at the door.
router.get('/whoami', integrationAuth, integrationApi.whoami);

// Identify without admitting. Writes nothing.
router.post('/lookup', integrationAuth, scanLimiter, scanValidators, integrationApi.lookup);

// Admit. Records the attendance in this database.
router.post('/checkin', integrationAuth, scanLimiter, scanValidators, integrationApi.checkin);


// The roster for this key's event. Paginated and searchable, and it carries no
// qrToken — a list of tokens is a list of working tickets.
router.get(
  '/registrations',
  integrationAuth, listLimiter,
  [
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 500 }),
    query('q').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
    query('status').optional({ checkFalsy: true }).isIn(['REGISTERED', 'PENDING_PAYMENT', 'CANCELLED']),
    query('checkedIn').optional({ checkFalsy: true }).isIn(['true', 'false']),
  ],
  integrationApi.registrations
);

// Admit somebody who cannot present a scannable code. Same verdict rules as a
// scan — a manual path that is more permissive than the scanner is a way around
// payment.
router.post(
  '/checkin/manual',
  integrationAuth, scanLimiter,
  [
    body('registrationId').optional({ checkFalsy: true }).isInt({ min: 1 }),
    body('registrationNumber').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
    body('scannerIdentifier').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
    body('station').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
  ],
  integrationApi.manualCheckin
);

module.exports = router;
