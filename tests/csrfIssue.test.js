// Tests for when a CSRF token (and so a stored session) is created.
//
// Issuing a token to every visitor wrote a sessions row for every page view,
// bots included. Now only signed-in users, sessions that already hold a token,
// and pages that opt in with withCsrfToken get one. No database needed.

const assert = require('assert');
const { issueCsrfToken, withCsrfToken, ensureCsrfToken } = require('../src/middleware/csrf.middleware');

function run(mw, session) {
  const req = { session };
  const res = { locals: {} };
  mw(req, res, () => {});
  return { req, res };
}

// An anonymous visitor reading a page: nothing is written to the session.
let r = run(issueCsrfToken, {});
assert.strictEqual(r.req.session.csrfToken, undefined, 'no token for an anonymous reader');
assert.strictEqual(r.res.locals.csrfToken, '', 'the page renders an empty token');

// A signed-in user always has one.
r = run(issueCsrfToken, { user: { id: 1 } });
assert.match(r.req.session.csrfToken, /^[0-9a-f]{64}$/, 'signed-in users get a token');
assert.strictEqual(r.res.locals.csrfToken, r.req.session.csrfToken);

// An existing token is kept, not replaced.
r = run(issueCsrfToken, { csrfToken: 'a'.repeat(64) });
assert.strictEqual(r.res.locals.csrfToken, 'a'.repeat(64), 'an existing token is reused');

// A form page opts in for an anonymous visitor.
r = run(withCsrfToken, {});
assert.match(r.res.locals.csrfToken, /^[0-9a-f]{64}$/, 'withCsrfToken creates one');
assert.strictEqual(r.req.session.csrfToken, r.res.locals.csrfToken);

// ensureCsrfToken is idempotent.
const session = {};
assert.strictEqual(ensureCsrfToken({ session }), ensureCsrfToken({ session }));

console.log('CSRF issue tests passed');
