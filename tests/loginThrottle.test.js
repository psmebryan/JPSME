// Tests for the human check on sign-in after repeated failures (M4) and the
// per-account lock (M2).
//
// Runs the real app against the dev database. Only the human check itself is
// stubbed: a submission passes it when challengeAnswer is "PASS", so the tests
// can exercise "check required" and "check passed" without Cloudflare or the
// challenge image. No mail is sent: the test account is verified and active.

require('dotenv').config();
// Each test runs from its own address (X-Forwarded-For, honoured because of
// this), so the per-address counts and the route's own per-IP rate limit do
// not carry over from one test to the next.
process.env.TRUST_PROXY = 'true';
const assert = require('assert');
const bcrypt = require('bcryptjs');

// --- the stubbed human check -------------------------------------------------
const captchaPath = require.resolve('../src/services/captcha.service');
const HONEYPOT_FIELD = 'website';
const failedHoneypot = (body) => typeof (body && body[HONEYPOT_FIELD]) === 'string' && body[HONEYPOT_FIELD].trim() !== '';
require.cache[captchaPath] = {
  id: captchaPath, filename: captchaPath, loaded: true,
  exports: {
    HONEYPOT_FIELD,
    failedHoneypot,
    isTurnstileConfigured: () => false,
    verifyTurnstileToken: async () => ({ ok: false }),
    requireHuman: ({ challenge = true } = {}) => (req, res, next) => {
      if (failedHoneypot(req.body)) return res.status(400).json({ success: false, code: 'HUMAN_CHECK_FAILED', message: 'bot' });
      if (!challenge) return next();
      if (req.body && req.body.challengeAnswer === 'PASS') return next();
      return res.status(400).json({ success: false, code: 'HUMAN_CHECK_FAILED', message: 'We could not verify that you are human.' });
    },
  },
};

const app = require('../src/app');
const prisma = require('../src/config/prisma');
const loginThrottle = require('../src/services/loginThrottle.service');

const TAG = `__lt${Date.now()}`;
const PASSWORD = 'correct-horse-battery';
const IP_PREFIX = '198.51.100.';
let ipSeq = 0;
let currentIp = null;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await clearAttempts();
    ipSeq += 1;
    currentIp = `${IP_PREFIX}${ipSeq}`;
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}\n      ${err.message}`);
    failed += 1;
  }
}

async function clearAttempts() {
  await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: IP_PREFIX } } });
  await prisma.loginAttempt.deleteMany({ where: { emailKey: { in: usedKeys() } } });
}

const usedEmails = new Set();
function usedKeys() {
  return [...usedEmails].map((e) => loginThrottle.emailKey(e));
}

let base;
// A "browser": its own cookie and CSRF token, taken from the login page.
async function browser(pagePath = '/login') {
  const ip = currentIp;
  const r = await fetch(`${base}${pagePath}`, { headers: { 'X-Forwarded-For': ip } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const html = await r.text();
  const token = (html.match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  return {
    html,
    async post(path, body) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, code: json.code || null, message: json.message };
    },
  };
}

const login = (b, email, password, extra = {}) => usedEmails.add(email) && b.post('/api/auth/login', { email, password, context: 'user', ...extra });

async function main() {
  const user = await prisma.user.create({
    data: {
      firstName: 'Login', lastName: 'Throttle',
      email: `${TAG}@example.invalid`,
      password: await bcrypt.hash(PASSWORD, 4),
      role: 'USER', status: 'APPROVED',
      emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const unknown = `${TAG}-nobody@example.invalid`;

  try {
    await test('no check for the first two failures; the third asks for it', async () => {
      const b = await browser();
      const r1 = await login(b, user.email, 'wrong');
      const r2 = await login(b, user.email, 'wrong');
      const r3 = await login(b, user.email, 'wrong');
      assert.deepStrictEqual([r1.status, r1.code], [401, null]);
      assert.deepStrictEqual([r2.status, r2.code], [401, null]);
      assert.deepStrictEqual([r3.status, r3.code], [401, 'HUMAN_CHECK_REQUIRED'], 'third failure asks for the check');
      assert.strictEqual(r3.message, 'Invalid email or password', 'the message itself is unchanged');
    });

    await test('once required, an attempt without the check is refused, even the right password', async () => {
      const b = await browser();
      for (let i = 0; i < 3; i += 1) await login(b, user.email, 'wrong');
      const r = await login(b, user.email, PASSWORD);
      assert.deepStrictEqual([r.status, r.code], [400, 'HUMAN_CHECK_REQUIRED']);
    });

    await test('clearing cookies does not reset the count', async () => {
      const first = await browser();
      for (let i = 0; i < 3; i += 1) await login(first, user.email, 'wrong');
      const fresh = await browser(); // a new cookie, as after clearing them
      const r = await login(fresh, user.email, PASSWORD);
      assert.strictEqual(r.code, 'HUMAN_CHECK_REQUIRED', 'still required from a fresh browser');
    });

    await test('right password plus a passed check signs in, and clears the count', async () => {
      const b = await browser();
      for (let i = 0; i < 3; i += 1) await login(b, user.email, 'wrong');
      const ok = await login(b, user.email, PASSWORD, { challengeAnswer: 'PASS' });
      assert.strictEqual(ok.status, 200, `signed in (${ok.message})`);
      const { byEmail } = await loginThrottle.status(user.email, '203.0.113.9');
      assert.strictEqual(byEmail, 0, 'account count cleared by the sign-in');
    });

    await test('an unregistered email behaves exactly like a registered one', async () => {
      const seq = async (email) => {
        await clearAttempts();
        ipSeq += 1;
        currentIp = `${IP_PREFIX}${ipSeq}`;
        const b = await browser();
        const out = [];
        for (let i = 0; i < 4; i += 1) {
          const r = await login(b, email, 'wrong');
          out.push([r.status, r.code, r.message]);
        }
        return out;
      };
      const known = await seq(user.email);
      const notKnown = await seq(unknown);
      assert.deepStrictEqual(notKnown, known, 'same statuses, codes and messages');
    });

    await test('three failures from one network ask for the check on any address', async () => {
      const b = await browser();
      for (let i = 0; i < 3; i += 1) await login(b, `${TAG}-x${i}@example.invalid`, 'wrong');
      const r = await login(b, `${TAG}-fresh@example.invalid`, 'wrong');
      assert.strictEqual(r.code, 'HUMAN_CHECK_REQUIRED', 'a never-tried address from the same network');
    });

    await test('the login page draws the check when asked to, or when this network needs it', async () => {
      let b = await browser('/login');
      assert(!b.html.includes('data-login-human-check'), 'not drawn for a normal visit');
      b = await browser('/login?check=1');
      assert(b.html.includes('data-login-human-check'), 'drawn with ?check=1');
      for (let i = 0; i < 3; i += 1) await login(b, `${TAG}-y${i}@example.invalid`, 'wrong');
      b = await browser('/login');
      assert(b.html.includes('data-login-human-check'), 'drawn once this network has failed 3 times');
      b = await browser('/admin/login?check=1');
      assert(b.html.includes('data-login-human-check'), 'admin login too');
    });

    // --- M2: the lock ---------------------------------------------------------

    // Ten failures: three plain, then seven with the check passed (an attempt
    // without it is refused before the password is looked at, so is not one).
    async function failTenTimes(b, email) {
      const out = [];
      for (let i = 0; i < 10; i += 1) {
        const r = await login(b, email, 'wrong', i >= 3 ? { challengeAnswer: 'PASS' } : {});
        out.push([r.status, r.code, r.message]);
      }
      return out;
    }

    await test('ten failures lock the account: right password still works, but only with the check', async () => {
      const b = await browser();
      await failTenTimes(b, user.email);
      const { locked } = await loginThrottle.status(user.email, '203.0.113.9');
      assert(locked, 'locked after ten');
      const without = await login(b, user.email, PASSWORD);
      assert.deepStrictEqual([without.status, without.code], [400, 'HUMAN_CHECK_REQUIRED'], 'not without the check');
      const withCheck = await login(b, user.email, PASSWORD, { challengeAnswer: 'PASS' });
      assert.strictEqual(withCheck.status, 200, 'right password plus the check signs in');
    });

    await test('a sign-in while locked does not lift the lock early', async () => {
      const b = await browser();
      await failTenTimes(b, user.email);
      await login(b, user.email, PASSWORD, { challengeAnswer: 'PASS' });
      const other = await browser(); // another device, after a successful sign-in
      const r = await login(other, user.email, PASSWORD);
      assert.strictEqual(r.code, 'HUMAN_CHECK_REQUIRED', 'still needs the check for the rest of the window');
    });

    await test('the lock looks the same for an unregistered email', async () => {
      await clearAttempts();
      currentIp = `${IP_PREFIX}${(ipSeq += 1)}`;
      const knownSeq = await failTenTimes(await browser(), user.email);
      const knownAfter = await login(await browser(), user.email, 'wrong');
      await clearAttempts();
      currentIp = `${IP_PREFIX}${(ipSeq += 1)}`;
      const unknownSeq = await failTenTimes(await browser(), unknown);
      const unknownAfter = await login(await browser(), unknown, 'wrong');
      assert.deepStrictEqual(unknownSeq, knownSeq, 'same replies on the way to the lock');
      assert.deepStrictEqual([unknownAfter.status, unknownAfter.code, unknownAfter.message],
        [knownAfter.status, knownAfter.code, knownAfter.message], 'and the same once locked');
    });

    await test('LOGIN_FAILED for each failure and one ACCOUNT_LOCKED, never the password', async () => {
      const since = new Date();
      const b = await browser();
      await failTenTimes(b, user.email);
      const rows = await prisma.auditLog.findMany({
        where: { targetUserId: user.id, createdAt: { gte: since }, action: { in: ['LOGIN_FAILED', 'ACCOUNT_LOCKED'] } },
        orderBy: { id: 'asc' },
      });
      assert.strictEqual(rows.filter((r) => r.action === 'LOGIN_FAILED').length, 10, 'ten LOGIN_FAILED');
      const locks = rows.filter((r) => r.action === 'ACCOUNT_LOCKED');
      assert.strictEqual(locks.length, 1, 'one ACCOUNT_LOCKED');
      assert.strictEqual(JSON.parse(locks[0].metadata).email, user.email.toLowerCase());
      assert.strictEqual(locks[0].ipAddress, currentIp, 'records the network');
      assert(rows.every((r) => !String(r.metadata).includes('wrong')), 'the password is never recorded');

      // An unregistered address is audited too, with no account linked.
      const before = new Date();
      const b2 = await browser();
      await login(b2, unknown, 'wrong', { challengeAnswer: 'PASS' }); // this network already needs the check
      const u = await prisma.auditLog.findFirst({ where: { action: 'LOGIN_FAILED', createdAt: { gte: before }, metadata: { contains: unknown } } });
      assert(u && u.targetUserId === null, 'unregistered address audited without an account');
    });

    await test('forgot-password always needs the human check', async () => {
      const b = await browser('/forgot-password');
      assert(/data-challenge|cf-turnstile/.test(b.html), 'the check is on the page');
      const r = await b.post('/api/auth/forgot-password', { email: unknown });
      assert.deepStrictEqual([r.status, r.code], [400, 'HUMAN_CHECK_FAILED'], 'refused without it');
      const ok = await b.post('/api/auth/forgot-password', { email: unknown, challengeAnswer: 'PASS' });
      assert.strictEqual(ok.status, 200, 'accepted with it (unknown address: nothing is sent)');
    });
  } finally {
    server.close();
    await clearAttempts();
    await prisma.auditLog.deleteMany({ where: { targetUserId: user.id } });
    await prisma.auditLog.deleteMany({ where: { action: { in: ['LOGIN_FAILED', 'ACCOUNT_LOCKED'] }, metadata: { contains: TAG } } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
