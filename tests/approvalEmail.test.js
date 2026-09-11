// Tests for when the "your membership has been approved" email is allowed to go
// out.
//
// The bug: an account whose address is still unverified appears in the admin's
// approvals queue like any other, and approving one sent the approval email
// immediately. The member then held two emails that contradicted each other —
// "here is your verification code" and "you have been approved" — while logging
// in still answered "please verify your email address before logging in".
//
// The approval itself was never wrong. Only the email was premature, so the
// email is what waits: it is sent at verification instead, the first moment it
// is both true and going to an address we know they own.
//
// Runs against the real dev database. The mailer is stubbed, so nothing is
// actually sent and the assertions are on exactly which messages would be.

const path = require('path');

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
    sendMemberApprovedEmail: (user) => { sent.push({ kind: 'APPROVED', to: user.email }); },
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
  exports: {
    syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
  },
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

const kinds = () => sent.map((m) => m.kind);

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

async function makeUser({ verified = false, status = 'PENDING' } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'APPR', lastName: `USER${seq}`,
      email: `${TAG}${seq}@example.test`,
      password: passwordHash,
      status,
      role: 'USER',
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
}

async function main() {
  await cleanup();
  passwordHash = await bcrypt.hash(PASSWORD, 4); // low cost: this is a fixture, not a stored credential

  // --- the normal path is untouched -----------------------------------------

  await test('approving a verified member still emails them, exactly as before', async () => {
    const user = await makeUser({ verified: true });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds().join(','), 'APPROVED', 'one approval email');
  });

  await test('re-approving an already-approved member still sends nothing', async () => {
    // The pre-existing guard against a redundant transition; kept working.
    const user = await makeUser({ verified: true, status: 'APPROVED' });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds().length, 0, 'no duplicate email');
  });

  await test('rejecting sends nothing, verified or not', async () => {
    const user = await makeUser({ verified: true });
    await userService.setStatus(user.id, 'REJECTED');
    assertEqual(kinds().length, 0, 'silence');
  });

  // --- the bug --------------------------------------------------------------

  await test('approving an unverified account does NOT tell them they are in', async () => {
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds().length, 0, 'the approval email is held back');
  });

  await test('but the approval itself still happens and is still audited', async () => {
    // Only the email waits. Holding the status back instead would lose the
    // admin's decision, or the payment confirmation that caused it.
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED', { reason: 'MEMBERSHIP_PAYMENT_CONFIRMED' });

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assertEqual(after.status, 'APPROVED', 'the account is approved');

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'USER_STATUS_CHANGED', targetUserId: user.id },
    });
    assert(entry, 'the status change is recorded');
  });

  await test('login still refuses them, which is why the email had to wait', async () => {
    // The contradiction the bug produced: an email saying they were accepted,
    // and a login saying they were not. This pins the two together.
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED');

    let message = 'logged in';
    try {
      await authService.login(user.email, PASSWORD);
    } catch (err) {
      message = err.message;
    }
    assert(/verify your email/i.test(message), `login should refuse an unverified account, got: ${message}`);
  });

  // --- the held email is delivered later ------------------------------------

  await test('verifying afterwards sends the approval email that was held', async () => {
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED');
    assertEqual(kinds().length, 0, 'nothing yet');

    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);

    assertEqual(kinds().join(','), 'APPROVED', 'the held email goes out now');
    assertEqual(sent[0].to, user.email, 'to the address they just proved they own');
  });

  await test('verifying while still pending sends nothing, so nothing is jumped', async () => {
    // A member who verifies before an admin has approved them must not be told
    // they are approved.
    const user = await makeUser({ verified: false, status: 'PENDING' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds().length, 0, 'no approval email');
  });

  await test('a rejected account that verifies is not congratulated', async () => {
    const user = await makeUser({ verified: false, status: 'REJECTED' });
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    assertEqual(kinds().length, 0, 'no approval email');
  });

  await test('the whole ordinary journey produces exactly one of each email', async () => {
    // Register, verify, then get approved — the path most members take. The
    // change must not have added a second approval email to it.
    const user = await makeUser({ verified: false });
    await emailVerificationService.issueVerificationCode(user);
    await emailVerificationService.verifyEmailCode(user.email, lastCode);
    await userService.setStatus(user.id, 'APPROVED');

    assertEqual(kinds().join(','), 'VERIFICATION,APPROVED', 'one code, then one approval');
  });

  await test('and so does the reversed journey, approved first then verified', async () => {
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED');
    await emailVerificationService.issueVerificationCode(user);
    await emailVerificationService.verifyEmailCode(user.email, lastCode);

    assertEqual(kinds().join(','), 'VERIFICATION,APPROVED', 'same two emails, same order');
  });

  await test('a wrong code sends nothing, held approval included', async () => {
    const user = await makeUser({ verified: false });
    await userService.setStatus(user.id, 'APPROVED');
    await emailVerificationService.issueVerificationCode(user);
    sent.length = 0;

    const wrong = String((Number(lastCode) + 1) % 1000000).padStart(6, '0');
    let threw = false;
    try {
      await emailVerificationService.verifyEmailCode(user.email, wrong);
    } catch (err) {
      threw = true;
    }
    assert(threw, 'a wrong code is rejected');
    assertEqual(kinds().length, 0, 'and releases nothing');
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
