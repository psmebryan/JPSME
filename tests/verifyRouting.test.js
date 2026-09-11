// Tests for getting an unverified person to the field they need.
//
// Logging in with an unverified address is refused, correctly. But the login
// page's only offer was "Didn't get your verification code?", which resends one
// — and there is no field on that page to type a code into, and nothing pointed
// at the page that has one. So the code arrived and the journey ended: resend,
// receive, nowhere to go, resend again.
//
// Three things fix it, and all three are checked here:
//   - the refusal is tagged EMAIL_NOT_VERIFIED, so the page can act on the
//     reason rather than on the wording of a sentence
//   - a blocked login sends them to /verify-email with the address filled in
//   - so does asking for a code from a page that cannot accept one
//
// The service half runs against the real dev database; the page half runs the
// real auth.js against a stub DOM.

const fs = require('fs');
const path = require('path');

const sheetsPath = require.resolve('../src/services/sheetsSync.service');
require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: { syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {} },
};

const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const AppError = require('../src/utils/AppError');

const TAG = '__verifyroute__';
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

const PASSWORD = 'correct-horse-staple';
let passwordHash = null;
let seq = 0;

async function makeUser({ verified = false, status = 'APPROVED' } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'ROUTE', lastName: `USER${seq}`,
      email: `${TAG}${seq}@example.test`,
      password: passwordHash, status, role: 'USER',
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

// --- the page ---------------------------------------------------------------

// Runs the real public/js/auth.js against enough of a DOM to submit a form and
// see where it tries to navigate.
function runLoginPage({ email, rejectWith, path: pagePath = '/login' }) {
  const handlers = {};
  const loginForm = {
    id: 'login-form',
    addEventListener: (type, fn) => { handlers.login = fn; },
    elements: {},
  };
  const resendForm = {
    id: 'resend-verification-form',
    addEventListener: (type, fn) => { handlers.resend = fn; },
    reset() {},
  };

  const nav = { href: null };
  const toasts = [];
  const timers = [];

  const byId = { 'login-form': loginForm, 'resend-verification-form': resendForm };
  const sandbox = {
    document: {
      getElementById: (id) => byId[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') handlers.ready = fn; },
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
      body: { appendChild() {} },
    },
    window: { location: { get href() { return nav.href; }, set href(v) { nav.href = v; }, pathname: pagePath, search: '' } },
    // Iterable as well as gettable: the handler runs Object.fromEntries over
    // it before anything else, so a get-only stub makes the whole submit throw
    // before reaching the branch under test.
    FormData: function FormDataStub() {
      const entries = [['email', email], ['password', 'x']];
      return {
        get: (k) => { const hit = entries.find((e) => e[0] === k); return hit ? hit[1] : null; },
        [Symbol.iterator]: () => entries[Symbol.iterator](),
      };
    },
    URLSearchParams: function URLSearchParamsStub() { return { get: () => null }; },
    apiFetch: async () => { if (rejectWith) throw rejectWith; return { message: 'ok', data: { user: {} } }; },
    showToast: (m) => toasts.push(m),
    withPending: async (form, label, fn) => fn(),
    setTimeout: (fn) => { timers.push(fn); return 1; },
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    encodeURIComponent,
  };

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8');
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));

  // auth.js binds everything inside DOMContentLoaded, so nothing exists until
  // that fires. Running it here is what a real page load does.
  if (handlers.ready) handlers.ready();

  return { handlers, nav, toasts, runTimers: () => timers.forEach((t) => t()) };
}

async function main() {
  await cleanup();
  passwordHash = await bcrypt.hash(PASSWORD, 4);

  // --- the reason is machine-readable --------------------------------------

  await test('an unverified login is refused with a code, not just a sentence', async () => {
    // The page branches on this. Matching the message text instead would keep
    // working right up until somebody rewords it, and then the redirect would
    // vanish with no test failing.
    const user = await makeUser({ verified: false });
    let threw = null;
    try { await authService.login(user.email, PASSWORD); } catch (err) { threw = err; }

    assert(threw, 'login was refused');
    assertEqual(threw.statusCode, 403, 'forbidden');
    assertEqual(threw.code, 'EMAIL_NOT_VERIFIED', 'and tagged with the reason');
  });

  await test('a verified account logs in and carries no code', async () => {
    const user = await makeUser({ verified: true });
    const result = await authService.login(user.email, PASSWORD);
    assertEqual(result.email, user.email, 'logged in');
  });

  await test('a wrong password is NOT tagged as unverified', async () => {
    // Otherwise a mistyped password would bounce somebody to a verification
    // page they have no business on, and hide the real problem.
    const user = await makeUser({ verified: false });
    let threw = null;
    try { await authService.login(user.email, 'not-the-password'); } catch (err) { threw = err; }
    assert(threw, 'refused');
    assertEqual(threw.code, null, 'no misleading tag');
  });

  await test('AppError carries no code unless one is given', async () => {
    assertEqual(new AppError('plain', 400).code, null, 'default is null');
  });

  // --- the page acts on it --------------------------------------------------

  await test('a blocked login is taken to the verification page, address filled in', async () => {
    const err = Object.assign(new Error('Please verify your email address before logging in'), {
      status: 403, code: 'EMAIL_NOT_VERIFIED',
    });
    const page = runLoginPage({ email: 'ana@example.com', rejectWith: err });
    await page.handlers.login({ preventDefault() {} });
    page.runTimers();

    assertEqual(page.nav.href, '/verify-email?email=ana%40example.com', 'sent to the code field');
  });

  await test('any other login failure stays put and just says so', async () => {
    const err = Object.assign(new Error('Invalid email or password'), { status: 401, code: null });
    const page = runLoginPage({ email: 'ana@example.com', rejectWith: err });
    await page.handlers.login({ preventDefault() {} });
    page.runTimers();

    assertEqual(page.nav.href, null, 'no redirect');
    assert(page.toasts.some((t) => /Invalid email or password/.test(t)), 'the real reason is shown');
  });

  await test('asking for a code from the login page lands on the page that accepts one', async () => {
    // The dead end itself: the login page has a resend button and no field to
    // type the result into.
    const page = runLoginPage({ email: 'ana@example.com' });
    await page.handlers.resend({ preventDefault() {} });
    page.runTimers();

    assertEqual(page.nav.href, '/verify-email?email=ana%40example.com', 'sent to the code field');
  });

  await test('asking from the verification page itself does not bounce you', async () => {
    // Already where the field is; navigating would throw away anything typed.
    const page = runLoginPage({ email: 'ana@example.com', path: '/verify-email' });
    await page.handlers.resend({ preventDefault() {} });
    page.runTimers();

    assertEqual(page.nav.href, null, 'stays put');
  });

  // --- the page offers a way in at all --------------------------------------

  await test('the login page links to the verification page for someone who has a code', async () => {
    const ejs = require('ejs');
    const file = path.join(__dirname, '..', 'views', 'login.ejs');
    const html = ejs.render(fs.readFileSync(file, 'utf8'), { cspNonce: 'n', currentUser: null }, { filename: file });

    assert(html.includes('/verify-email'), 'the link exists at all');
    assert(/Already have a code/i.test(html), 'and says what it is for');
    assert(html.includes('resend-verification-form'), 'the resend form is still there for those without one');
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
