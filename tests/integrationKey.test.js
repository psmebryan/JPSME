// Tests for the integration-key credential and the route it guards.
//
// The end-to-end behaviour (a real key scanning a real ticket against a running
// server) is exercised separately; what is here are the parts that can be
// checked without a database, plus a handful of STRUCTURAL assertions about the
// route file.
//
// Those structural ones matter more than they look. Two properties of this
// feature are invisible when reading the code and easy to "fix" into oblivion:
//
//   The integration router must NOT carry verifyCsrfToken. Every other POST on
//   this site does, so adding it here looks like correcting an oversight — and
//   it would silently break every integration, because a server-side client has
//   no cookie jar and no CSRF token to send.
//
//   No integration path may contain an event id. The event comes from the key.
//   Adding /:id to these routes would let a key issued for one event be aimed
//   at another by editing a URL.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const ROOT = path.join(__dirname, '..');

// Line endings normalised on read. The working tree here is CRLF, so a
// multi-line pattern written with \n silently matches nothing — which shows up
// as "this function does not exist" rather than as a line-ending problem.
function readSrc(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
}
const service = require('../src/services/integrationKey.service');
const { readPresentedKey } = require('../src/middleware/integrationAuth.middleware');

const ROUTES_RAW = readSrc('src', 'routes', 'api', 'integration.routes.js');

// Comments are stripped before any structural check below. This file's own
// comments explain at length why there is no CSRF middleware here, and prose
// ABOUT an absence must not read as the thing being present.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const ROUTES = stripComments(ROUTES_RAW);
const SERVICE_SRC = readSrc('src', 'services', 'integrationKey.service.js');

// --- the credential ---------------------------------------------------------

test('a key has a public half and a secret half', () => {
  // The split is what makes authentication one indexed lookup instead of a
  // hash against every row in the table.
  const sample = `${service.KEY_PREFIX}${'a'.repeat(12)}_${'b'.repeat(64)}`;
  const match = service.KEY_PATTERN.exec(sample);
  assert(match, 'the documented shape is the shape the pattern accepts');
  assertEqual(match[1], 'a'.repeat(12), 'keyId is the first half');
  assertEqual(match[2], 'b'.repeat(64), 'the secret is the second');
});

test('the secret is 256 bits, which is what makes guessing a non-issue', () => {
  const match = service.KEY_PATTERN.exec(`${service.KEY_PREFIX}${'a'.repeat(12)}_${'b'.repeat(64)}`);
  assertEqual(match[2].length, 64, '64 hex characters = 32 bytes');
});

test('malformed keys are rejected by shape, before any database work', () => {
  [
    '',
    'nonsense',
    'Bearer something',
    `${service.KEY_PREFIX}short_${'b'.repeat(64)}`,
    `${service.KEY_PREFIX}${'a'.repeat(12)}_${'b'.repeat(63)}`,
    `${service.KEY_PREFIX}${'a'.repeat(12)}_${'b'.repeat(65)}`,
    // Uppercase hex: the generator only ever emits lowercase, so accepting
    // both would mean two spellings of one key.
    `${service.KEY_PREFIX}${'A'.repeat(12)}_${'b'.repeat(64)}`,
    `wrongprefix_${'a'.repeat(12)}_${'b'.repeat(64)}`,
  ].forEach((bad) => {
    assert(!service.KEY_PATTERN.test(bad), `rejected: ${JSON.stringify(bad)}`);
  });
});

test('the stored hash is not the secret', () => {
  const secret = 'b'.repeat(64);
  const hash = service.hashSecret(secret);
  assert(hash !== secret, 'storing the secret under another name would not be hashing it');
  assertEqual(hash, crypto.createHash('sha256').update(secret).digest('hex'), 'plain SHA-256 of the secret');
  assertEqual(hash.length, 64, 'a hex digest');
});

test('hashing is deterministic, or no key would ever authenticate twice', () => {
  assertEqual(service.hashSecret('abc'), service.hashSecret('abc'), 'same input, same digest');
  assert(service.hashSecret('abc') !== service.hashSecret('abd'), 'different input, different digest');
});

test('the secret is compared in constant time', () => {
  // A fast hash is the right choice for a 256-bit random secret, but it is not
  // a reason to leak how many characters of it matched.
  assert(/timingSafeEqual/.test(SERVICE_SRC), 'the comparison uses crypto.timingSafeEqual');
  assert(/ba\.length !== bb\.length/.test(SERVICE_SRC),
    'and guards the length first, since timingSafeEqual throws on a mismatch rather than returning false');
});

test('publicView never carries anything secret', () => {
  const view = service.publicView({
    id: 1, eventId: 2, label: 'Gate', keyId: 'abc', secretHash: 'DEADBEEF',
    createdAt: new Date(), lastUsedAt: null, revokedAt: null,
  });
  const serialised = JSON.stringify(view);
  assert(!serialised.includes('DEADBEEF'), 'the hash does not travel to the browser either');
  assert(!('secretHash' in view), 'and is not on the object at all');
  assertEqual(view.active, true, 'a key with no revokedAt is active');
});

test('a revoked key reads as inactive', () => {
  const view = service.publicView({
    id: 1, eventId: 2, label: 'Gate', keyId: 'abc', secretHash: 'x',
    createdAt: new Date(), lastUsedAt: null, revokedAt: new Date(),
  });
  assertEqual(view.active, false, 'revoked is not active');
});

// --- reading the credential off a request -----------------------------------

test('the key is read from the Authorization header', () => {
  const key = `${service.KEY_PREFIX}${'a'.repeat(12)}_${'b'.repeat(64)}`;
  assertEqual(readPresentedKey({ get: () => `Bearer ${key}` }), key, 'standard bearer form');
  assertEqual(readPresentedKey({ get: () => `bearer ${key}` }), key, 'case-insensitive scheme');
  assertEqual(readPresentedKey({ get: () => `  Bearer   ${key}  ` }), key, 'tolerant of spacing');
  assertEqual(readPresentedKey({ get: () => key }), key, 'a bare key, which integrations often send');
  assertEqual(readPresentedKey({ get: () => undefined }), null, 'no header at all');
});

test('a credential is never accepted from the URL', () => {
  // A key in a query string ends up in access logs, in browser history, and in
  // the Referer header of anything the page later links to.
  const src = readSrc('src', 'middleware', 'integrationAuth.middleware.js');
  assert(!/req\.query/.test(src), 'the middleware does not look at the query string');
  assert(!/req\.body/.test(src), 'nor at the body');
});

// --- the route's structural guarantees --------------------------------------

test('the integration routes carry no CSRF check, deliberately', () => {
  // If this ever fails, read the comment at the top of this file before
  // "fixing" it. CSRF defends cookie-authenticated requests; a bearer token is
  // never attached automatically, so there is nothing to forge — and requiring
  // a CSRF token from a server-side client makes the integration unusable.
  assert(!/verifyCsrfToken/.test(ROUTES),
    'no verifyCsrfToken on the integration router');
});

test('no integration route names an event', () => {
  // The event is a property of the key. A path parameter would let a key issued
  // for one event be pointed at another by editing a URL.
  const paths = [...ROUTES.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)].map((m) => m[2]);
  assert(paths.length >= 3, `found the routes, got ${JSON.stringify(paths)}`);
  paths.forEach((p) => {
    assert(!p.includes(':'), `no path parameter in "${p}" — the key carries the event`);
  });
});

test('every integration route is authenticated', () => {
  const handlers = [...ROUTES.matchAll(/router\.(?:get|post|put|delete)\(\s*'[^']+',([^;]*?)\);/gs)];
  assert(handlers.length >= 3, 'found the route definitions');
  handlers.forEach((m) => {
    assert(/integrationAuth/.test(m[1]), `integrationAuth is on every route, missing from: ${m[0].slice(0, 60)}`);
  });
});

test('the scan limiter is keyed on the key, not the venue IP', () => {
  // A venue NATs every device behind one address, so per-IP limiting would let
  // one busy system starve another.
  assert(/keyGenerator/.test(ROUTES), 'a custom key generator is set');
  assert(/req\.integrationKey\.id/.test(ROUTES), 'and it keys on the integration key');
  assert(/ipKeyGenerator/.test(ROUTES),
    'the IP fallback goes through ipKeyGenerator, or an IPv6 caller can rotate addresses within its /64 to slip the limit');
});

// --- the door log ------------------------------------------------------------

test('an integration scan is recorded as having no human scanner', () => {
  const src = readSrc('src', 'services', 'checkin.service.js');
  assert(/const staffUserId = staffUser \? staffUser\.id : null;/.test(src),
    'applyVerdict tolerates a scan with no signed-in operator behind it');
  assert(/staffUser: null,/.test(src),
    'and the integration path passes null rather than borrowing somebody identity');
});

test('the integration path reuses the staff verdict logic rather than copying it', () => {
  // Two implementations of "may this person be admitted" is how two doors end
  // up disagreeing about a cancelled or unpaid registration.
  const src = readSrc('src', 'services', 'checkin.service.js');
  // Anchored on a closing brace at column 0 followed by a newline. The obvious
  // [\s\S]*?\n\} stops at the brace that closes the DESTRUCTURED PARAMETER
  // instead, capturing the signature and none of the body — which made this
  // test pass or fail on the shape of the argument list rather than on what the
  // function actually does.
  const fn = /async function checkInByIntegration\([\s\S]*?\n\}\n/.exec(src);
  assert(fn, 'checkInByIntegration exists');
  assert(/applyVerdict\(/.test(fn[0]), 'it goes through applyVerdict, the same path a staff scan takes');
  assert(!/updateMany/.test(fn[0]), 'it does not claim the admission itself');
});

// --- the roster --------------------------------------------------------------

test('the roster never hands out qrTokens', () => {
  // The single most dangerous field this feature could grow. A token is not an
  // identifier, it is the credential that admits somebody — so a roster
  // carrying tokens is a file of working tickets, and anyone who obtains a copy
  // can produce a valid QR for every attendee on it.
  //
  // The other system never needs them: it reads a token off the physical ticket
  // at the door. registrationNumber is what it searches and reconciles by, and
  // that is printed on the ticket and useless as a credential on its own.
  // Comments stripped first: the select block carries a comment naming the
  // fields that are deliberately ABSENT, and prose about an absence must not
  // read as the thing being present.
  const src = stripComments(readSrc('src', 'services', 'checkin.service.js'));
  const fn = /async function listRegistrationsForIntegration\([\s\S]*?\n\}\n/.exec(src);
  assert(fn, 'listRegistrationsForIntegration exists');

  const select = /select:\s*\{([\s\S]*?)\},/.exec(fn[0]);
  assert(select, 'it selects an explicit column list rather than returning whole rows');
  assert(!/qrToken/.test(select[1]), 'qrToken is not among the selected columns');
  assert(!/email/.test(select[1]), 'nor email — a roster copied into another system is a copy of personal data');
  assert(/registrationNumber/.test(select[1]), 'registrationNumber is, since that is the safe reference');
});

test('the roster is paginated and bounded', () => {
  // A national convention runs to thousands of rows. An unpaged list is a
  // request that works in testing and times out on the day.
  const src = readSrc('src', 'services', 'checkin.service.js');
  const fn = /async function listRegistrationsForIntegration\([\s\S]*?\n\}\n/.exec(src)[0];
  assert(/Math\.min\(Math\.max\(Number\(pageSize\)/.test(fn),
    'pageSize is clamped, so a caller cannot ask for the whole table in one request');
  assert(/skip:/.test(fn) && /take,/.test(fn), 'it pages');
});

test('the manual path is not a way around the scanner rules', () => {
  // A manual check-in more permissive than a scan is a way around payment, and
  // it is the first thing anybody would find.
  const src = readSrc('src', 'services', 'checkin.service.js');
  const fn = /async function checkInManuallyByIntegration\([\s\S]*?\n\}\n/.exec(src);
  assert(fn, 'checkInManuallyByIntegration exists');
  assert(/applyVerdict\(/.test(fn[0]), 'it goes through the same verdict path as a scan');
  assert(!/updateMany/.test(fn[0]), 'and does not claim the admission itself');
  assert(/staffUser: null/.test(fn[0]), 'recorded with no human scanner behind it');
});

test('listing has its own rate limit, separate from the door', () => {
  // Sharing the scan limiter would let a polling loop burn the door's
  // allowance at exactly the wrong moment.
  assert(/listLimiter/.test(ROUTES), 'a separate limiter exists');
  const rosterRoute = /router\.get\(\s*'\/registrations'[\s\S]*?\);/.exec(ROUTES);
  assert(rosterRoute && /listLimiter/.test(rosterRoute[0]), 'the roster route uses it');
  const scanRoute = /router\.post\(\s*'\/checkin'[\s\S]*?\);/.exec(ROUTES);
  assert(scanRoute && /scanLimiter/.test(scanRoute[0]), 'while the door keeps the scan limiter');
});

// --- cross-origin access -----------------------------------------------------

test('the integration routes allow cross-origin callers', () => {
  // Without this a browser-based client never reaches the server: the browser
  // blocks the request itself, and the calling page sees a failure with no
  // status and no body. "Nothing happens when I scan" is what that looks like
  // from the other side.
  assert(/Access-Control-Allow-Origin/.test(ROUTES), 'Allow-Origin is set');
  const allowed = /ALLOWED_HEADERS\s*=\s*'([^']+)'/.exec(ROUTES);
  assert(allowed && /Authorization/i.test(allowed[1]),
    'and Authorization is an allowed header, or the key can never be sent');
});

test('the preflight answers before authentication', () => {
  // A browser sends OPTIONS with no Authorization header at all. If
  // integrationAuth ran first it would 401 the preflight, and the browser would
  // never send the real request — an integration that fails before it starts.
  const corsFn = /function cors\([\s\S]*?\n\}/.exec(ROUTES);
  assert(corsFn, 'the cors middleware exists');
  assert(/OPTIONS[\s\S]{0,80}sendStatus\(204\)/.test(corsFn[0]),
    'OPTIONS is answered inside the cors middleware');
  const corsAt = ROUTES.indexOf('router.use(cors)');
  const firstRoute = ROUTES.search(/router\.(get|post)\(/);
  assert(corsAt !== -1 && corsAt < firstRoute, 'and router.use(cors) runs before any route');
});

test('credentials are NOT allowed cross-origin', () => {
  // This is the line between "safe" and "a real hole". Allow-Origin: * is fine
  // while auth is a bearer token, because a browser never attaches one by
  // itself. Turning on Allow-Credentials would make the browser attach the
  // SESSION COOKIE of anyone signed in to JPSME, which is exactly the ambient
  // authority this avoids.
  assert(!/Allow-Credentials/i.test(ROUTES), 'Access-Control-Allow-Credentials is never set');
});

test('Cross-Origin-Resource-Policy is relaxed for these routes only', () => {
  // A second, separate gate from CORS. helmet sets CORP: same-origin across the
  // whole site; with that in place a browser still refuses to hand the response
  // body to a cross-origin caller even though the request succeeded and
  // Allow-Origin said yes. The symptom is a request that plainly worked in the
  // network tab and an empty result in the code.
  assert(/Cross-Origin-Resource-Policy['"]\s*,\s*['"]cross-origin/.test(ROUTES),
    'the integration routes set CORP: cross-origin');

  // And nowhere else. Relaxing it globally would drop a protection the rest of
  // the site relies on.
  const app = readSrc('src', 'app.js');
  assert(!/crossOriginResourcePolicy/.test(app) || /same-origin/.test(app),
    'the app-wide policy is not loosened');
});

// --- the local test harness --------------------------------------------------

test('the integration demo page cannot ship to production', () => {
  // It is a page with a scanner that talks to a check-in API. Harmless without
  // a key, but not something to leave reachable on a live site — and "remember
  // not to link to it" is not a control.
  const ctrl = readSrc('src', 'controllers', 'pages.controller.js');
  const fn = /const integrationDemoPage = asyncHandler\([\s\S]*?\n\}\);\n/.exec(ctrl);
  assert(fn, 'integrationDemoPage exists');
  assert(/config\.isProduction/.test(fn[0]) && /404/.test(fn[0]),
    'it 404s when NODE_ENV is production');
});

test('the demo page is a real client, not a shortcut', () => {
  // Its whole value is being an HONEST stand-in: if it reached into a session,
  // or called an internal endpoint, it would prove nothing about whether the
  // other system can work.
  const view = readSrc('views', 'integration-demo.ejs');
  assert(/\/api\/integration/.test(view), 'it calls the public integration API');
  assert(/Authorization/.test(view) && /Bearer/.test(view), 'authenticating with a bearer key');
  assert(!/currentUser/.test(view), 'and uses no session at all');
  assert(!/csrfToken/.test(view), 'and no CSRF token, like a real external caller');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
