// Tests for what a paid membership actually unlocks.
//
// The Certificate of Membership is the document that says somebody IS a member
// of JPSME. It was gated on User.status === 'APPROVED', which is a different
// question entirely — approval means an admin accepted the account, and most
// approved accounts have never paid. Any of them could download a certificate
// of a membership they had not bought.
//
// It is now gated on membership, in three places that must all agree:
//   - membership.service, which decides what membership means at all
//   - the route middleware, so "who may have this" is visible in the routing
//   - certificate.service, as the backstop a new handler cannot forget
//
// Runs against the real dev database.

const prisma = require('../src/config/prisma');
const membershipService = require('../src/services/membership.service');
const certificateService = require('../src/services/certificate.service');
const { requireActiveMembership } = require('../src/middleware/membership.middleware');

const TAG = '__memberaccess__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

async function assertRejects(fn, statusCode, message) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  assert(threw, `${message} — it did not throw at all`);
  assertEqual(threw.statusCode, statusCode, message);
  return threw;
}

// Stands in for Express. Records whichever of the two outcomes the middleware
// reaches, so a test can assert on the response as well as on next().
function runMiddleware(user) {
  return new Promise((resolve) => {
    const req = { session: { user } };
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ passed: false, res: this }); return this; },
    };
    requireActiveMembership(req, res, (err) => resolve({ passed: !err, err, req }));
  });
}

let seq = 0;
const DAYS = (n) => new Date(Date.now() + n * 86400000);

async function makeUser({ status = 'APPROVED', expiresAt = null } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'MEM', lastName: `USER${seq}`,
      email: `${TAG}${seq}@example.test`,
      password: 'x', status, role: 'USER',
      emailVerifiedAt: new Date(),
      membershipExpiresAt: expiresAt,
    },
  });
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.length ? users.map((u) => u.id) : [0];
  await prisma.payment.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await cleanup();

  // --- what membership means -------------------------------------------------

  await test('approval on its own is not membership', async () => {
    // The original bug in one line: APPROVED and paid are unrelated facts.
    const user = await makeUser({ status: 'APPROVED', expiresAt: null });
    const membership = await membershipService.getMembershipStatus(user.id);
    assertEqual(membership.tier, 'NON_MEMBER', 'an approved account that never paid');
    assertEqual(membership.state, 'NONE', 'and it has never paid, rather than lapsed');
    assertEqual(await membershipService.isActiveMember(user.id), false, 'not an active member');
  });

  await test('a paid year inside its validity is membership', async () => {
    const user = await makeUser({ expiresAt: DAYS(200) });
    assertEqual(await membershipService.isActiveMember(user.id), true, 'an active member');
  });

  await test('a lapsed year is not, and stays distinguishable from never having paid', async () => {
    // Only EXPIRED is something to renew; NONE is somebody who never started.
    const user = await makeUser({ expiresAt: DAYS(-1) });
    const membership = await membershipService.getMembershipStatus(user.id);
    assertEqual(membership.tier, 'NON_MEMBER', 'no longer a member');
    assertEqual(membership.state, 'EXPIRED', 'but lapsed, not absent');
  });

  // --- the certificate -------------------------------------------------------

  await test('a member can render their certificate', async () => {
    const user = await makeUser({ expiresAt: DAYS(200) });
    const pdf = await certificateService.renderMembershipCertificateForUser(user.id);
    assert(Buffer.isBuffer(pdf) && pdf.length > 0, 'a PDF came back');
    assertEqual(pdf.subarray(0, 4).toString(), '%PDF', 'and it really is one');
  });

  await test('an approved non-member cannot, which is the bug this closes', async () => {
    const user = await makeUser({ status: 'APPROVED', expiresAt: null });
    const err = await assertRejects(
      () => certificateService.renderMembershipCertificateForUser(user.id),
      403, 'refused'
    );
    assert(/payment is confirmed/i.test(err.message), `says why, got: ${err.message}`);
  });

  await test('a lapsed member is told to renew, not that they were never a member', async () => {
    // Two different situations deserve two different sentences — "not a member"
    // would send somebody who paid last year hunting for a fault.
    const user = await makeUser({ expiresAt: DAYS(-1) });
    const err = await assertRejects(
      () => certificateService.renderMembershipCertificateForUser(user.id),
      403, 'refused'
    );
    assert(/expired/i.test(err.message), `names the expiry, got: ${err.message}`);
  });

  await test('a pending account is refused before membership is even considered', async () => {
    const user = await makeUser({ status: 'PENDING', expiresAt: DAYS(200) });
    await assertRejects(
      () => certificateService.renderMembershipCertificateForUser(user.id),
      403, 'refused'
    );
  });

  // --- the route gate --------------------------------------------------------

  await test('the middleware lets a member through and hands the handler the membership', async () => {
    const user = await makeUser({ expiresAt: DAYS(200) });
    const outcome = await runMiddleware({ id: user.id });
    assert(outcome.passed, 'next() was called');
    assertEqual(outcome.req.membership.tier, 'MEMBER', 'and the lookup is not repeated downstream');
  });

  await test('the middleware turns a non-member away with 403', async () => {
    const user = await makeUser({ expiresAt: null });
    const outcome = await runMiddleware({ id: user.id });
    assert(!outcome.passed, 'next() was not called');
    assertEqual(outcome.res.statusCode, 403, 'forbidden, not unauthorised');
    assert(/members/i.test(outcome.res.body.message), `says what it is for, got: ${outcome.res.body.message}`);
  });

  await test('the middleware tells a lapsed member to renew', async () => {
    const user = await makeUser({ expiresAt: DAYS(-1) });
    const outcome = await runMiddleware({ id: user.id });
    assert(!outcome.passed, 'turned away');
    assert(/expired/i.test(outcome.res.body.message), `names the expiry, got: ${outcome.res.body.message}`);
  });

  await test('the middleware refuses a request with no session at all', async () => {
    const outcome = await runMiddleware(null);
    assert(!outcome.passed, 'turned away');
    assertEqual(outcome.res.statusCode, 401, 'unauthenticated, not forbidden');
  });

  await test('membership is read live, so a session outlasting the year stops working', async () => {
    // The reason this middleware queries rather than reading the session: a
    // session minted while somebody was a member must stop opening this door
    // the moment their year runs out.
    const user = await makeUser({ expiresAt: DAYS(200) });
    const session = { id: user.id };
    assert((await runMiddleware(session)).passed, 'a member gets through');

    await prisma.user.update({ where: { id: user.id }, data: { membershipExpiresAt: DAYS(-1) } });
    assert(!(await runMiddleware(session)).passed, 'the same session no longer does');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
