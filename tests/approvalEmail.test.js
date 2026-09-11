// Tests for which of the two membership emails a person gets, and when.
//
// There used to be one email. It fired when an admin approved an account and
// said "your JPSME membership has been approved" — to everybody, including the
// majority who had never paid. Approval and membership are different facts:
// approval means an admin accepted the account, membership means the fee is
// paid and the year is current. So they are now two emails:
//
//   ACCOUNT_APPROVED  — sent on approval. Says the account works. True of a
//                       non-member, which most approved accounts are.
//   MEMBER_APPROVED   — sent when a membership payment clears. The only
//                       message allowed to say somebody is a member.
//
// And an account whose address is not verified can no longer be approved at
// all, rather than being approved into a state where it cannot log in.
//
// Runs against the real dev database. The mailer is stubbed, so nothing is sent
// and the assertions are on exactly which messages would be.

// Stubbed before anything requires it — emailVerification.service destructures
// these at module load, so a later stub would be ignored.
const sent = [];
let lastCode = null;
const mailPath = require.resolve('../src/services/mail.service');
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: {
    sendVerificationEmail: (user, code) => { lastCode = code; sent.push({ kind: 'VERIFICATION', to: user.email }); },
    sendMemberApprovedEmail: (user) => { sent.push({ kind: 'MEMBER', to: user.email }); },
    sendAccountApprovedEmail: (user) => { sent.push({ kind: 'ACCOUNT', to: user.email }); },
    sendEventRegistrationEmail: () => {},
    sendEventInvitationEmail: () => {},
  },
};

// Fire-and-forget in the real code and irrelevant here; stubbed so the suite
// never reaches for Google's API.
const sheetsPath = require.resolve('../src/services/sheetsSync.service');
require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: { syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {} },
};

const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const userService = require('../src/services/user.service');
const authService = require('../src/services/auth.service');
const emailVerificationService = require('../src/services/emailVerification.service');

const TAG = '__approvalmail__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    sent.length = 0;
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

const kinds = () => sent.map((m) => m.kind).join(',');

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.length ? users.map((u) => u.id) : [0];
  await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
const PASSWORD = 'correct-horse-staple';
let passwordHash = null;
const A_YEAR_AWAY = () => new Date(Date.now() + 365 * 86400000);

async function makeUser({ verified = false, status = 'PENDING', paid = false } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'APPR', lastName: `USER${seq}`,
      email: `${TAG}${seq}@example.test`,
      password: passwordHash,
      status,
      role: 'USER',
      emailVerifiedAt: verified ? new Date() : null,
      membershipExpiresAt: paid ? A_YEAR_AWAY() : null,
    },
  });
}

async function main() {
  await cleanup();
  passwordHash = await bcrypt.hash(PASSWORD, 4); // low cost: a fixture, not a stored credential

  // --- approval says "your account works", never "you are a member" ---------

  await test('approving an unpaid account sends the account email, not the membership one', async () => {
    // The whole point. Most approved accounts have never paid, and telling them
    // they are members of JPSME is simply false.
    const user = await makeUser({ verified: true });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds(), 'ACCOUNT', 'the account email only');
  });

  await test('approving someone who HAS paid still sends the account email from here', async () => {
    // Membership is announced by the payment that bought it, not by an admin
    // clicking approve afterwards — otherwise a member who is approved late
    // would be told twice, and a non-member approved late would be told wrongly.
    const user = await makeUser({ verified: true, paid: true });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds(), 'ACCOUNT', 'still the account email');
  });

  await test('re-approving an already-approved account still sends nothing', async () => {
    const user = await makeUser({ verified: true, status: 'APPROVED' });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds(), '', 'no duplicate email');
  });

  await test('the payment path can suppress the account email for its own', async () => {
    // What applyPaymentPaid passes: it approves the account and then sends the
    // membership email itself. Both firing would land two messages a second
    // apart, the weaker one first.
    const user = await makeUser({ verified: true });
    await userService.setStatus(user.id, 'APPROVED', { skipApprovalEmail: true });
    assertEqual(kinds(), '', 'silence, so the caller can send the better one');

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(after.status, 'APPROVED', 'but the approval still happened');
  });

  await test('rejecting sends nothing', async () => {
    const user = await makeUser({ verified: true });
    await userService.setStatus(user.id, 'REJECTED');
    assertEqual(kinds(), '', 'silence');
  });

  // --- an unverified address cannot be approved ------------------------------

  await test('approving an unverified account is refused', async () => {
    const user = await makeUser({ verified: false });
    const err = await assertRejects(
      () => userService.setStatus(user.id, 'APPROVED'),
      400, 'the approval is refused'
    );
    assert(/not been verified/i.test(err.message), `the reason is named, got: ${err.message}`);
  });

  await test('and the refusal leaves the account exactly as it was', async () => {
    // A half-applied approval would be worse than the bug: an account that is
    // approved in the table but was never announced to anybody.
    const user = await makeUser({ verified: false });
    await assertRejects(() => userService.setStatus(user.id, 'APPROVED'), 400, 'refused');

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(after.status, 'PENDING', 'still pending');
    assertEqual(kinds(), '', 'and nothing was sent');

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'USER_STATUS_CHANGED', targetUserId: user.id },
    });
    assert(!entry, 'nothing was written to the audit log either');
  });

  await test('rejecting an unverified account is still allowed', async () => {
    // Turning down an application that never confirmed its address is exactly
    // when you would want to. Only approval is gated.
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'REJECTED');
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(after.status, 'REJECTED', 'the rejection went through');
  });

  await test('the gate matches what login already enforced', async () => {
    // The two rules have to agree, or approval means something login disagrees
    // with — which is exactly how the original bug felt from the outside.
    const user = await makeUser({ verified: false });
    let message = 'logged in';
    try {
      await authService.login(user.email, PASSWORD);
    } catch (err) {
      message = err.message;
    }
    assert(/verify your email/i.test(message), `login refuses an unverified account, got: ${message}`);
  });

  // --- catching up accounts approved before the gate existed -----------------

  await test('verifying an approved unpaid account sends the account email', async () => {
    // setStatus refuses this state now, but accounts approved before the rule
    // existed are still out there and were never told anything.
    const user = await makeUser({ verified: false, status: 'APPROVED' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds(), 'ACCOUNT', 'the account email');
  });

  await test('verifying an approved PAID account sends the membership email instead', async () => {
    // Same catch-up, different person: this one bought a membership, so the
    // message that is true of them is the membership one.
    const user = await makeUser({ verified: false, status: 'APPROVED', paid: true });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds(), 'MEMBER', 'the membership email');
  });

  await test('an expired membership is caught up as an account, not a member', async () => {
    // Paid once, lapsed. Still an ordinary non-member, and telling them their
    // membership is confirmed would be the original bug wearing a different hat.
    const user = await makeUser({ verified: false, status: 'APPROVED' });
    await prisma.user.update({
      where: { id: user.id },
      data: { membershipExpiresAt: new Date(Date.now() - 86400000) },
    });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds(), 'ACCOUNT', 'the account email');
  });

  await test('verifying while still pending sends nothing, so nothing is jumped', async () => {
    const user = await makeUser({ verified: false, status: 'PENDING' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds(), '', 'no approval email');
  });

  await test('a rejected account that verifies is not congratulated', async () => {
    const user = await makeUser({ verified: false, status: 'REJECTED' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds(), '', 'no approval email');
  });

  await test('a wrong code releases nothing', async () => {
    const user = await makeUser({ verified: false, status: 'APPROVED' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;

    const wrong = String((Number(lastCode) + 1) % 1000000).padStart(6, '0');
    await assertRejects(() => emailVerificationService.verifyEmailCode(user.email, wrong), 400, 'rejected');
    assertEqual(kinds(), '', 'and nothing was sent');
  });

  // --- the ordinary journey --------------------------------------------------

  await test('register, verify, get approved: one code email and one account email', async () => {
    const user = await makeUser({ verified: false });
    await emailVerificationService.issueVerificationCode(user);
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds(), 'VERIFICATION,ACCOUNT', 'one code, then one account email');
  });

  await test('setStatus never sends the membership email under any circumstances', async () => {
    // The regression this whole split guards against, stated as one assertion
    // across every approval shape rather than trusting each case above.
    const shapes = [
      { verified: true, status: 'PENDING' },
      { verified: true, status: 'PENDING', paid: true },
      { verified: true, status: 'REJECTED' },
      { verified: true, status: 'REJECTED', paid: true },
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const shape of shapes) {
      // eslint-disable-next-line no-await-in-loop
      const user = await makeUser(shape);
      // eslint-disable-next-line no-await-in-loop
      await userService.setStatus(user.id, 'APPROVED');
    }
    assert(!sent.some((m) => m.kind === 'MEMBER'), `a membership email escaped: ${kinds()}`);
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
