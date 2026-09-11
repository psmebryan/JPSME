// Tests for resending a verification code, and for being able to tell why it
// did nothing.
//
// Two of the three outcomes send no email, deliberately: the endpoint answers
// identically whether the address is unknown, already verified, or genuinely
// waiting, so it cannot be used to discover who has an account. That silence is
// right for the response and was wrong for the server log — it made "the resend
// button is broken" and "the resend button correctly did nothing" the same
// observation, and the natural conclusion was that email delivery had failed.
//
// So each outcome is now logged. These tests pin down which emails go out AND
// which line gets written, because the log line is the only thing that makes a
// working system distinguishable from a broken one here.
//
// Runs against the real dev database with the mailer and logger stubbed.

const sent = [];
const logged = [];
let deliverable = true;

const mailPath = require.resolve('../src/services/mail.service');
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: {
    // Returns true the way a real successful send does. `deliverable` lets a
    // test play the provider refusing, which is a different outcome from
    // "nothing to send" and has to be logged differently.
    sendVerificationEmail: (user, code) => { sent.push({ to: user.email, code }); return deliverable; },
    sendMemberApprovedEmail: () => {},
    sendAccountApprovedEmail: () => {},
    sendEventRegistrationEmail: () => {},
    sendEventInvitationEmail: () => {},
  },
};

const loggerPath = require.resolve('../src/utils/logger');
const realLogger = require('../src/utils/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: Object.assign({}, realLogger, {
    info: (message, meta) => { logged.push({ message, meta }); },
    warn: (message, meta) => { logged.push({ message, meta }); },
    error: (message, meta) => { logged.push({ message, meta }); },
  }),
};

const prisma = require('../src/config/prisma');
const emailVerificationService = require('../src/services/emailVerification.service');

const TAG = '__resendtest__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    sent.length = 0;
    logged.length = 0;
    deliverable = true;
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

const loggedMessages = () => logged.map((l) => l.message).join(' | ');

let seq = 0;
async function makeUser({ verified = false, email = null } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'RESEND', lastName: `USER${seq}`,
      email: email || `${TAG}${seq}@example.test`,
      password: 'x', status: 'PENDING', role: 'USER',
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.length ? users.map((u) => u.id) : [0];
  await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await cleanup();

  await test('an unverified account gets a fresh code', async () => {
    const user = await makeUser({ verified: false });
    await emailVerificationService.resendVerification(user.email);

    assertEqual(sent.length, 1, 'one email');
    assertEqual(sent[0].to, user.email, 'to them');
    assert(/^\d{6}$/.test(sent[0].code), `a six-digit code, got ${sent[0].code}`);
    assert(/new code sent/.test(loggedMessages()), `logged as sent, got: ${loggedMessages()}`);
  });

  await test('requesting again replaces the code rather than adding a second', async () => {
    // The stored code is a single row per user; a second request must not leave
    // the first one working, or a leaked code stays usable indefinitely.
    const user = await makeUser({ verified: false });
    await emailVerificationService.resendVerification(user.email);
    const first = sent[0].code;
    await emailVerificationService.resendVerification(user.email);
    const second = sent[1].code;

    const rows = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    assertEqual(rows, 1, 'still one code on file');

    await assertRejectsVerify(user.email, first, 'the older code no longer works');
    const ok = await emailVerificationService.verifyEmailCode(user.email, second);
    assert(ok, 'the newer one does');
  });

  await test('an already-verified account gets nothing, and the log says why', async () => {
    // This is what "the resend button is not working" turned out to be. It is
    // correct behaviour; it was simply indistinguishable from a fault.
    const user = await makeUser({ verified: true });
    await emailVerificationService.resendVerification(user.email);

    assertEqual(sent.length, 0, 'no email, by design');
    assert(/already verified/.test(loggedMessages()), `the log names the reason, got: ${loggedMessages()}`);
  });

  await test('an unknown address gets nothing, and the log distinguishes it', async () => {
    // A different cause with the same symptom: usually an address that does not
    // match what was stored. Telling the two apart in the log is the point.
    await emailVerificationService.resendVerification(`${TAG}nobody@example.test`);

    assertEqual(sent.length, 0, 'no email, by design');
    assert(/no account/.test(loggedMessages()), `the log names the reason, got: ${loggedMessages()}`);
  });

  await test('the three outcomes are logged distinguishably', async () => {
    // If two of them logged the same line, the log would be no more use than
    // the response is.
    const waiting = await makeUser({ verified: false });
    const done = await makeUser({ verified: true });

    const lines = [];
    for (const address of [waiting.email, done.email, `${TAG}ghost@example.test`]) {
      logged.length = 0;
      // eslint-disable-next-line no-await-in-loop
      await emailVerificationService.resendVerification(address);
      lines.push(loggedMessages());
    }
    assertEqual(new Set(lines).size, 3, `three distinct log lines, got: ${JSON.stringify(lines)}`);
  });

  await test('address matching is case and whitespace insensitive', async () => {
    // The route lowercases too, but the service must not depend on that — it is
    // called directly from registration as well.
    const user = await makeUser({ verified: false, email: `${TAG}case@example.test` });
    await emailVerificationService.resendVerification(`  ${TAG.toUpperCase()}CASE@EXAMPLE.TEST  `);
    assertEqual(sent.length, 1, 'found despite the case and padding');
    assertEqual(sent[0].to, user.email, 'the right account');
  });

  await test('a provider that refuses is NOT reported as sent', async () => {
    // The first version of this logging said "new code sent" whether or not the
    // provider took it, because the send reports its own failure and returns
    // quietly. That turned a visible outage into a silent one, which is worse
    // than the silence it was written to fix.
    const user = await makeUser({ verified: false });
    deliverable = false;
    await emailVerificationService.resendVerification(user.email);

    assert(!/new code sent/.test(loggedMessages()), `must not claim success, got: ${loggedMessages()}`);
    assert(/did not accept it/.test(loggedMessages()), `says the provider refused, got: ${loggedMessages()}`);
  });

  await test('a refused send still leaves a usable code on file', async () => {
    // The code is stored before the send, on purpose: the person can ask again
    // once the provider is working, and an admin can read it to them.
    const user = await makeUser({ verified: false });
    deliverable = false;
    await emailVerificationService.resendVerification(user.email);

    const rows = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    assertEqual(rows, 1, 'the code is on file');
    const ok = await emailVerificationService.verifyEmailCode(user.email, sent[0].code);
    assert(ok, 'and it still verifies');
  });

  await test('nothing throws on a blank or missing address', async () => {
    // The validator rejects these first, but the service is called from
    // elsewhere and must not fall over.
    await emailVerificationService.resendVerification('');
    await emailVerificationService.resendVerification(null);
    await emailVerificationService.resendVerification(undefined);
    assertEqual(sent.length, 0, 'nothing sent');
  });
}

async function assertRejectsVerify(email, code, message) {
  let threw = null;
  try { await emailVerificationService.verifyEmailCode(email, code); } catch (err) { threw = err; }
  assert(threw, `${message} — it was accepted`);
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
