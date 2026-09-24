// Tests for password reset and for an administrator changing a member's
// credentials.
//
// These run without a database. The behavioural end-to-end (real tokens against
// real rows) is exercised separately; what is pinned here are the properties
// that are invisible in the code and easy to undo with a well-meaning edit.
//
// Three of them matter more than the rest:
//
//   The request endpoint must not reveal whether an address has an account.
//   Returning "no account with that email" reads like a helpful error and is a
//   free membership check for anyone holding a list of addresses — and this
//   site's members are students whose addresses are guessable from their names.
//
//   The reset token must never be stored, logged, or echoed. Only a hash goes
//   in the table, and the plaintext lives just long enough to be put in an
//   email.
//
//   A password change must end the sessions that were open under the old one.
//   A reset exists because the password may be in somebody else's hands; one
//   that leaves that person signed in has not locked anybody out.

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

// Line endings normalised: the working tree mixes LF and CRLF, and a
// multi-line pattern written with \n silently matches nothing in a CRLF file.
function readSrc(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const service = require('../src/services/passwordReset.service');
const SERVICE_SRC = readSrc('src', 'services', 'passwordReset.service.js');
const AUTH_API = readSrc('src', 'controllers', 'api', 'auth.api.js');
const AUTH_ROUTES = readSrc('src', 'routes', 'api', 'auth.routes.js');
const ADMIN_ROUTES = readSrc('src', 'routes', 'api', 'admin.routes.js');
const USER_SERVICE = readSrc('src', 'services', 'user.service.js');

// --- the token --------------------------------------------------------------

test('the token is hashed with the account mixed in', () => {
  // Salting with the user id means a leaked digest cannot be matched against a
  // precomputed table without also knowing which account it belongs to — and
  // it is why the same token is worthless against a different user.
  const a = service.hashToken(1, 'abc');
  const b = service.hashToken(2, 'abc');
  assert(a !== b, 'the same token hashes differently for different accounts');
  assertEqual(a, crypto.createHash('sha256').update('1:abc').digest('hex'), 'plain sha256 of "<id>:<token>"');
});

test('hashing is deterministic, or no link would ever open', () => {
  assertEqual(service.hashToken(7, 'tok'), service.hashToken(7, 'tok'), 'same inputs, same digest');
});

test('the link is long enough to be unguessable on its own', () => {
  // A six-digit code is safe for verification because it is short-lived AND
  // attempt-limited AND already tied to a known account. A reset link is handed
  // to anyone who can type an address, so it gets real entropy instead.
  const bytes = /TOKEN_BYTES\s*=\s*(\d+)/.exec(SERVICE_SRC);
  assert(bytes, 'the token length is a named constant');
  assert(Number(bytes[1]) >= 32, `at least 32 bytes, got ${bytes[1]}`);
});

test('the link expires, and not in a week', () => {
  const ttl = service.TOKEN_TTL_MS;
  assert(ttl > 0, 'there is an expiry');
  assert(ttl <= 24 * 60 * 60 * 1000, `a reset link is not a standing key, got ${ttl}ms`);
});

test('the token is compared in constant time', () => {
  assert(/timingSafeEqual/.test(SERVICE_SRC), 'uses crypto.timingSafeEqual');
  assert(/presented\.length !== stored\.length/.test(SERVICE_SRC),
    'and guards length first, since timingSafeEqual throws rather than returning false on a mismatch');
});

test('only the hash is stored', () => {
  const issue = /async function issueResetLink\([\s\S]*?\n\}/.exec(SERVICE_SRC);
  assert(issue, 'issueResetLink exists');
  assert(/tokenHash/.test(issue[0]), 'a hash is written');
  assert(!/data:[\s\S]{0,200}\btoken\b\s*[,}]/.test(issue[0]),
    'the plaintext token is never a column value');
});

// --- no account enumeration --------------------------------------------------

test('requesting a link never says whether the account exists', () => {
  const fn = /async function requestReset\([\s\S]*?\n\}/.exec(SERVICE_SRC);
  assert(fn, 'requestReset exists');
  // It returns on a miss rather than throwing. A thrown 404 would be rendered
  // as "no account with that email" by the generic error handler.
  assert(/if \(!user\) return;/.test(fn[0]), 'an unknown address returns quietly');
  assert(!/throw/.test(fn[0]), 'and never throws, which would leak the same fact as an error');
});

test('the controller sends one message for both outcomes', () => {
  const fn = /const forgotPassword = asyncHandler\([\s\S]*?\n\}\);/.exec(AUTH_API);
  assert(fn, 'the handler exists');
  const successCalls = fn[0].match(/success\(/g) || [];
  assertEqual(successCalls.length, 1, 'exactly one reply, so there is no branch to observe');
  assert(!/error\(/.test(fn[0]), 'and no error path that would distinguish the two');
  assert(/If that address has/i.test(fn[0]), 'worded conditionally');
});

test('the mail is queued, not sent inline', () => {
  // Otherwise the RESPONSE TIME leaks the same fact the wording hides: a
  // request that sends mail is measurably slower than one that does not.
  const fn = /async function requestReset\([\s\S]*?\n\}/.exec(SERVICE_SRC)[0];
  assert(/enqueue\(/.test(fn), 'it enqueues');
  assert(!/sendPasswordResetEmail/.test(fn), 'and does not send from the request path');
});

test('the queued job carries no secret', () => {
  // A job row sits in the database until a worker picks it up. A plaintext
  // reset token in it would be a credential at rest, readable by anything with
  // database access, long after the email was sent.
  const fn = /async function requestReset\([\s\S]*?\n\}/.exec(SERVICE_SRC)[0];
  const enqueue = /enqueue\('SEND_PASSWORD_RESET_EMAIL',\s*\{([^}]*)\}/.exec(fn);
  assert(enqueue, 'the enqueue call is there');
  assertEqual(enqueue[1].trim(), 'userId: user.id', 'the payload is a user id and nothing else');

  const handlers = readSrc('src', 'jobs', 'handlers', 'index.js');
  assert(/issueResetLink/.test(handlers), 'the handler mints the token itself');
});

// --- single use ---------------------------------------------------------------

test('a used link cannot be used again, and says so', () => {
  const fn = /async function completeReset\([\s\S]*?\n\}/.exec(SERVICE_SRC);
  assert(fn, 'completeReset exists');
  // The conditional update is the concurrency story: two submissions of one
  // link race on usedAt, and exactly one wins. A read-then-write could apply
  // two different passwords and leave whichever landed second.
  assert(/updateMany\(/.test(fn[0]) && /usedAt: null/.test(fn[0]),
    'the link is claimed with a conditional update, not a read-then-write');
  assert(/claim\.count !== 1/.test(fn[0]), 'and the loser is told so rather than proceeding');
});

test('an expired or used link is distinguished from an invalid one', () => {
  // Telling somebody "invalid" when the truth is "you already did this" is what
  // sends them round the loop three more times. None of these reveal anything:
  // the caller already holds the link.
  ['INVALID', 'EXPIRED', 'USED'].forEach((reason) => {
    assert(new RegExp(`${reason}:`).test(SERVICE_SRC), `${reason} has its own message`);
  });
});

// --- sessions -----------------------------------------------------------------

test('changing a password ends the sessions opened under the old one', () => {
  assert(/revokeSessionsFor/.test(SERVICE_SRC), 'the service can revoke sessions');
  const complete = /async function completeReset\([\s\S]*?\n\}/.exec(SERVICE_SRC)[0];
  assert(/revokeSessionsFor\(/.test(complete), 'and a reset does it');
  assert(/revokeSessionsFor\(/.test(USER_SERVICE), 'and so does an admin setting a password');
});

test('the session sweep cannot fail a password change that already committed', () => {
  const fn = /async function revokeSessionsFor\([\s\S]*?\n\}/.exec(SERVICE_SRC);
  assert(fn, 'revokeSessionsFor exists');
  assert(/try \{/.test(fn[0]) && /catch/.test(fn[0]), 'it swallows its own failures');
  assert(/return 0;/.test(fn[0]), 'and reports nothing revoked rather than throwing');
});

test('a session row that cannot be parsed is left alone', () => {
  // Deleting rows you could not read is how a bad JSON blob signs out the whole
  // site.
  const fn = /async function revokeSessionsFor\([\s\S]*?\n\}/.exec(SERVICE_SRC)[0];
  assert(/catch \(err\) \{ \/\* a row we cannot parse/.test(fn),
    'the parse failure path deletes nothing');
});

// --- the admin actions ---------------------------------------------------------

test('admin credential changes are MAIN_ADMIN only', () => {
  // They sit below router.use(apiAdmin), not with the apiAdminOrChapterAdmin
  // member-management routes: setting a password means being able to sign in as
  // that member.
  const gate = ADMIN_ROUTES.indexOf('router.use(apiAdmin)');
  assert(gate !== -1, 'the main-admin gate exists');
  ['/users/:id/password', '/users/:id/email'].forEach((route) => {
    const at = ADMIN_ROUTES.indexOf(route);
    assert(at !== -1, `${route} is routed`);
    assert(at > gate, `${route} must sit after the apiAdmin gate, not before it`);
  });
});

test('the admin password endpoint never echoes the password back', () => {
  const api = readSrc('src', 'controllers', 'api', 'admin.api.js');
  const fn = /const setUserPassword = asyncHandler\([\s\S]*?\n\}\);/.exec(api);
  assert(fn, 'the handler exists');
  const reply = /success\(res,\s*\{([^}]*)\}/.exec(fn[0]);
  assert(reply, 'it replies with an object');
  assert(!/password/i.test(reply[1]),
    'the response body carries no password — that would put it in logs and browser history');
});

test('changing the email warns the address being replaced', () => {
  // Changing the address is how an account is taken over permanently: every
  // future reset link goes elsewhere and the real owner never finds out. The
  // notice has to go to the OLD inbox, which is the only one they can read.
  const fn = /async function adminChangeEmail\([\s\S]*?\n\}/.exec(USER_SERVICE);
  assert(fn, 'adminChangeEmail exists');
  assert(/previousEmail/.test(fn[0]), 'the old address is captured before the write');
  assert(/SEND_EMAIL_CHANGED_NOTICE/.test(fn[0]), 'and notified');
  const enqueue = /enqueue\('SEND_EMAIL_CHANGED_NOTICE',\s*\{([\s\S]*?)\}\)/.exec(fn[0]);
  assert(enqueue && /previousEmail/.test(enqueue[1]), 'the notice is addressed to the previous address');
});

test('changing the email kills any outstanding reset link', () => {
  // Otherwise whoever held the old inbox still has a working way in.
  const fn = /async function adminChangeEmail\([\s\S]*?\n\}/.exec(USER_SERVICE)[0];
  assert(/passwordResetToken\.deleteMany/.test(fn), 'outstanding links are deleted');
  const pw = /async function adminSetPassword\([\s\S]*?\n\}/.exec(USER_SERVICE)[0];
  assert(/passwordResetToken\.deleteMany/.test(pw), 'and so does setting a password');
});

test('every credential change is audited under its own action', () => {
  // Folding these into one PASSWORD_CHANGED would hide the distinction that
  // matters: a member resetting their own password is routine, an administrator
  // setting a member's password is an administrator who can then sign in as
  // them.
  ['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED'].forEach((a) => {
    assert(SERVICE_SRC.includes(a), `${a} is logged`);
  });
  ['USER_PASSWORD_SET_BY_ADMIN', 'USER_EMAIL_CHANGED_BY_ADMIN'].forEach((a) => {
    assert(USER_SERVICE.includes(a), `${a} is logged`);
  });

  const schema = readSrc('prisma', 'schema.prisma');
  ['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'USER_PASSWORD_SET_BY_ADMIN', 'USER_EMAIL_CHANGED_BY_ADMIN']
    .forEach((a) => assert(new RegExp(`^\\s*${a}$`, 'm').test(schema), `${a} is a real enum value`));
});

test('no credential is ever written to the audit log', () => {
  // The audit log is read by more people, and kept for longer, than anything
  // that should hold a live credential.
  const clean = stripComments(SERVICE_SRC) + stripComments(USER_SERVICE);
  const logs = clean.match(/auditService\.log\(\{[\s\S]*?\}\);/g) || [];
  assert(logs.length >= 4, `found the audit calls, got ${logs.length}`);
  logs.forEach((call) => {
    assert(!/\bpassword\b/i.test(call), `no password in an audit call: ${call.slice(0, 70)}`);
    assert(!/\btoken\b/i.test(call), `no token in an audit call: ${call.slice(0, 70)}`);
  });
});

// --- the routes ----------------------------------------------------------------

test('the public reset endpoints are rate limited and CSRF-checked', () => {
  // These are session-based browser endpoints, unlike the integration API — so
  // unlike that one, they DO need CSRF.
  const forgot = /router\.post\(\s*'\/forgot-password'[\s\S]*?\);/.exec(AUTH_ROUTES);
  assert(forgot, '/forgot-password is routed');
  assert(/verifyCsrfToken/.test(forgot[0]), 'with CSRF');
  assert(/Limiter/.test(forgot[0]), 'and a limiter — each request sends real mail to a real person');

  const reset = /router\.post\(\s*'\/reset-password'[\s\S]*?\);/.exec(AUTH_ROUTES);
  assert(reset, '/reset-password is routed');
  assert(/verifyCsrfToken/.test(reset[0]), 'with CSRF');
  assert(/isLength\(\{ min: 8/.test(reset[0]), 'and the same 8-character floor as registration');
});

test('the reset page checks the link before showing a form', () => {
  // Asking somebody to choose and confirm a new password and only then telling
  // them the link expired is how people give up on an account.
  const view = readSrc('views', 'reset-password.ejs');
  assert(/reset-password\/check/.test(view), 'it asks whether the link is good');
  assert(/hidden/.test(view), 'and the form starts hidden');
});

test('a page that calls apiFetch on load waits for api.js first', () => {
  // The layout loads /js/api.js at the END of <body>, after the page's own
  // markup and after any inline script in it. A script that calls apiFetch
  // while the document is still parsing dies with "apiFetch is not defined".
  //
  // On the reset page that failure was worse than a broken script: the call was
  // inside a try/catch that renders the message to the reader, so a perfectly
  // good link was reported as "This link cannot be used".
  //
  // Only these two pages call apiFetch on load. Everywhere else it is reached
  // from a click handler, by which time the script has long since loaded.
  ['forgot-password.ejs', 'reset-password.ejs'].forEach((file) => {
    const view = readSrc('views', file);
    assert(/function onReady\(/.test(view), `${file} defers until the document is ready`);
    assert(/document\.readyState === 'loading'/.test(view),
      `${file} checks readyState, so it still runs if the event has already fired`);
  });
});

test('the layout really does load api.js after the page body', () => {
  // The premise of the test above. If the layout ever moves the script into
  // <head>, the guard becomes unnecessary — but until then it is load-bearing,
  // and asserting the order stops the two drifting apart silently.
  const layout = readSrc('views', 'layout.ejs');
  const main = layout.indexOf('<main');
  const api = layout.indexOf('/js/api.js');
  assert(main !== -1 && api !== -1, 'both are in the layout');
  assert(api > main, 'api.js is loaded after <main>, which is why inline page scripts must wait');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
