// Tests for what sign-up waits on.
//
// Reported as: "why the registration stuck up in the creating but the email
// code already send?" — the button sat on "Creating your account…" long after
// the code had landed in the inbox.
//
// The cause was the order of things. registerUser awaited the verification
// email, and that send is an HTTPS call to Brevo's API with a fifteen-second
// client timeout. The mail went out, then the request carried on waiting for
// the provider to finish answering, and only then did the browser hear back.
// So the email genuinely did arrive first — the form was not stuck, it was
// waiting on something that had already done its job.
//
// Sign-up now hands the whole send to the job queue and returns. Two things
// have to stay true for that to be safe, and both are tested here: the code is
// still minted and sent (by the worker, a couple of seconds later), and the
// plaintext code never sits in a job row.
//
// Runs against the dev database with the mailer and logger stubbed.

const sent = [];
const logged = [];

const mailPath = require.resolve('../src/services/mail.service');
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: {
    // A real send is an HTTPS round trip; this one is free. Any test that
    // measures time is therefore measuring everything EXCEPT the provider,
    // which is the point — the provider is what was removed from the path.
    sendVerificationEmail: (user, code) => { sent.push({ to: user.email, code }); return true; },
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
    info: (m, meta) => { logged.push({ m, meta }); },
    warn: (m, meta) => { logged.push({ m, meta }); },
    error: (m, meta) => { logged.push({ m, meta }); },
  }),
};

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});

const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const emailVerificationService = require('../src/services/emailVerification.service');
const handlers = require('../src/jobs/handlers');

const TAG = '__signupqueue__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    sent.length = 0;
    logged.length = 0;
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

let org;
let seq = 0;

async function signUp() {
  seq += 1;
  return authService.registerUser({
    firstName: 'QUEUE',
    lastName: `TEST${seq}`,
    email: `${TAG}${seq}@example.test`,
    password: 'Dummy123!',
    organizationId: org.id,
  });
}

const jobsFor = (userId) => prisma.job.findMany({
  where: { type: 'SEND_VERIFICATION_EMAIL' },
}).then((rows) => rows.filter((j) => {
  const payload = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
  return payload && payload.userId === userId;
}));

// The queue is written to without being awaited, so a test has to let the
// microtask that writes it actually run before looking.
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  // Every job this file could have queued, identified by its users being gone.
  const jobs = await prisma.job.findMany({ where: { type: 'SEND_VERIFICATION_EMAIL' } });
  const orphans = [];
  for (const job of jobs) {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    if (!payload || !payload.userId) continue;
    const stillThere = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!stillThere) orphans.push(job.id);
  }
  if (orphans.length) await prisma.job.deleteMany({ where: { id: { in: orphans } } });
}

async function main() {
  await cleanup();
  org = await prisma.organization.findFirst({ where: { isActive: true } });
  assert(org, 'the dev database needs at least one active organization');

  await test('signing up does not wait for the mail provider', async () => {
    // The whole bug. With the mailer stubbed this cannot measure the provider
    // itself, so it asserts the structural fact instead: nothing was sent
    // during the call, because sending is no longer part of it.
    const user = await signUp();
    assertEqual(sent.length, 0, 'no send happened inside the request');
    assert(user && user.id, 'and the account was still created');
  });

  await test('the send is handed to the job queue instead', async () => {
    const user = await signUp();
    await settle();
    const jobs = await jobsFor(user.id);
    assertEqual(jobs.length, 1, `one job queued, got ${jobs.length}`);
    assertEqual(jobs[0].status, 'PENDING', 'waiting for the worker');
  });

  await test('the plaintext code is never written into a job row', async () => {
    // A job row outlives the code it carries. Only the hash is ever stored,
    // and it is stored by the handler, not by whoever queued it.
    const user = await signUp();
    await settle();
    const [job] = await jobsFor(user.id);
    const raw = typeof job.payload === 'string' ? job.payload : JSON.stringify(job.payload);
    assert(!/\d{6}/.test(raw), `no six-digit code in the payload, got ${raw}`);
    assertEqual(Object.keys(JSON.parse(raw)).join(','), 'userId', 'the payload is just the user id');
  });

  await test('the worker mints a code and sends it', async () => {
    // The half that matters most: the email must still go out. A fast response
    // that never emails anybody is a worse bug than the slow one.
    const user = await signUp();
    await settle();
    await handlers.SEND_VERIFICATION_EMAIL({ userId: user.id });

    assertEqual(sent.length, 1, 'exactly one email');
    assertEqual(sent[0].to, user.email, 'to the person who signed up');
    assert(/^\d{6}$/.test(String(sent[0].code)), `a six-digit code, got ${sent[0].code}`);
  });

  await test('the code the worker sends is the one the page will accept', async () => {
    // Minting in the handler means the stored hash and the emailed code are
    // written by the same call. If they ever came apart, every sign-up would
    // email a code that does not work.
    const user = await signUp();
    await handlers.SEND_VERIFICATION_EMAIL({ userId: user.id });

    const result = await emailVerificationService.verifyEmailCode(user.email, sent[0].code);
    assert(result, 'the emailed code verified');
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    assert(fresh.emailVerifiedAt, 'and the account is verified');
  });

  await test('a job for somebody already verified sends nothing', async () => {
    // The worker can run long after the row was queued — they may have used a
    // code from a resend in the meantime.
    const user = await signUp();
    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    await handlers.SEND_VERIFICATION_EMAIL({ userId: user.id });
    assertEqual(sent.length, 0, 'nothing sent');
  });

  await test('a job for a deleted account fails quietly rather than retrying', async () => {
    const user = await signUp();
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await handlers.SEND_VERIFICATION_EMAIL({ userId: user.id });
    assertEqual(sent.length, 0, 'nothing sent, and no exception escaped');
  });

  await test('resend still waits, because it has to report whether it sent', async () => {
    // The deliberate asymmetry. Sign-up queues because nobody is waiting on an
    // answer; resend exists precisely to answer "did it send", and cannot say
    // so honestly without waiting.
    const user = await signUp();
    const before = sent.length;
    const result = await emailVerificationService.resendForPending(user.id);
    assert(sent.length > before, 'the resend sent within the call');
    assertEqual(result.sent, true, 'and reported that it did');
  });

  await test('a queue failure does not take the registration down with it', async () => {
    // The database IS the queue. If enqueue fails, the account has already
    // committed — losing it would be far worse than losing one email, and the
    // Resend button is right there.
    const job = require('../src/services/job.service');
    const real = job.enqueue;
    job.enqueue = async () => { throw new Error('queue is down'); };
    try {
      const user = await signUp();
      await settle();
      assert(user && user.id, 'the account was still created');
      assert(logged.some((l) => /queue the verification email/i.test(l.m || '')),
        'and the failure was logged rather than swallowed');
    } finally {
      job.enqueue = real;
    }
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
