// Tests for getting a code into somebody's hands and out of them again.
//
// The flow this replaces asked an unverified member to do the following, in
// order: sign in, be refused, land on a page demanding a 6-digit code, not have
// one (the code issued at registration dies after 30 minutes), scroll past the
// form to a second card, retype the address they had just typed, read
// characters out of a captcha image, press send, go to their inbox, come back,
// type the code, then go back to the login page and type their password again.
//
// Thirteen steps for "prove you own this inbox". What is checked here is the
// three that removed most of them:
//
//   - signing in sends the code itself, which is safe precisely because it
//     happens after bcrypt agreed — so it cannot be aimed at somebody else's
//     inbox and needs no captcha in front of it
//   - it reuses an outstanding code rather than mailing a second one that
//     silently kills the first
//   - finishing verification signs them in, because the password was already
//     proven minutes earlier in the same session
//
// The service half runs against the real dev database. Mail is stubbed: these
// addresses do not exist, and every send from a test run is a soft bounce on
// the real provider's reputation.

const path = require('path');
const fs = require('fs');

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const sent = [];
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});
stub('../src/services/mail.service', {
  sendVerificationEmail: async (user, code, ttlMs) => { sent.push({ to: user.email, code, ttlMs }); return true; },
  sendMemberApprovedEmail: async () => true,
  sendAccountApprovedEmail: async () => true,
});

const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const verification = require('../src/services/emailVerification.service');
const authApi = require('../src/controllers/api/auth.api');

const TAG = '__verifyflow__';
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
async function makeUser({ verified = false, status = 'APPROVED', role = 'USER', lastLoginAt = null } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'FLOW', lastName: `USER${seq}`,
      email: `${TAG}${seq}@example.test`,
      password: passwordHash, status, role,
      emailVerifiedAt: verified ? new Date() : null,
      lastLoginAt,
    },
  });
}

// --- enough of express to run a controller ---------------------------------
//
// The controllers are where the session handoff lives — the one piece of this
// that no service test can reach, because the whole idea is that something is
// remembered between two requests.

function makeSession() {
  const session = {
    regenerate(cb) {
      // What express-session actually does: everything in the old session is
      // gone. That is the point — it is a privilege change.
      Object.keys(session).forEach((k) => {
        if (typeof session[k] !== 'function') delete session[k];
      });
      cb(null);
    },
  };
  return session;
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Runs a controller and returns { res, err }.
//
// Waits on the two things express itself waits on — the response being written,
// or next() being called with a failure — and not on the handler's own return
// value: asyncHandler returns undefined, so awaiting that resolves instantly
// and reads the request before it has happened.
async function run(handler, req) {
  const res = makeRes();
  let err = null;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  const write = res.json.bind(res);
  res.json = (payload) => { const out = write(payload); settle(); return out; };

  // A handler that neither answers nor fails is a bug worth seeing as one,
  // rather than as a suite that hangs with no output.
  const bail = setTimeout(() => settle(), 5000);

  handler(req, res, (e) => { err = e || null; settle(); });
  await done;
  clearTimeout(bail);
  return { res, err };
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.length ? users.map((u) => u.id) : [0];
  await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

function renderView(file, locals) {
  const ejs = require('ejs');
  const full = path.join(__dirname, '..', 'views', file);
  return ejs.render(fs.readFileSync(full, 'utf8'), locals, { filename: full });
}


// --- enough of a browser to type six digits into --------------------------
//
// Runs the page's own script, extracted from the rendered view, so what is
// tested is what ships rather than a copy of it.

function makeEl(props) {
  const listeners = {};
  const attrs = {};
  const el = Object.assign({
    value: '',
    disabled: false,
    textContent: '',
    className: '',
    type: 'text',
    dataset: {},
    // The ring is painted with SVG presentation attributes rather than inline
    // style, because styleSrc carries a nonce and no 'unsafe-inline'. Testing
    // through the same surface is the point: an assertion against el.style
    // would pass on code the browser silently ignores.
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
    has(type) { return Boolean((listeners[type] || []).length); },
    focus() { el.focused = true; },
    select() {},
    hiddenBy: [],
    shownBy: [],
    classList: {
      add(name) { el.hiddenBy.push(name); },
      remove(name) { el.shownBy.push(name); },
      toggle() {},
    },
  }, props || {});
  return el;
}

// The submit handler is async, so everything after its first await — the
// toast, the cleared boxes, the redirect — lands a microtask later. Nothing
// that checks a result can read it in the same tick.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function runVerifyPage({
  pendingEmail = 'ana@example.com', resendWaitMs = 0, reply = null,
  expiresInMs = null, codeLifetimeMs = 3 * 60 * 1000, cold = false,
} = {}) {
  const html = renderView('verify-email.ejs', {
    cspNonce: 'n', currentUser: null, logoUrl: '/img/default-logo.svg',
    email: cold ? '' : pendingEmail,
    pendingEmail: cold ? '' : pendingEmail,
    resendWaitMs, paymentRequired: false,
    expiresInMs, codeLifetimeMs,
  });

  const open = html.lastIndexOf('<script nonce="n">');
  const src = html.slice(open + '<script nonce="n">'.length, html.lastIndexOf('</script>'));
  assert(src.includes('code-digit'), 'found the page script');

  const boxes = [];
  for (let i = 0; i < 6; i += 1) boxes.push(makeEl({}));

  const hidden = makeEl({ type: 'hidden' });
  // A cold page renders a real, empty field; a known one renders a hidden
  // input the server already filled.
  const emailInput = cold
    ? makeEl({ type: 'email', value: '' })
    : makeEl({ type: 'hidden', value: pendingEmail });
  const submits = [];
  const form = makeEl({
    requestSubmit() { form.fire('submit', { preventDefault() {} }); },
  });
  const resendButton = makeEl({ textContent: 'Resend', dataset: { waitMs: String(resendWaitMs) } });
  const resendForm = makeEl({});
  const panel = makeEl({});
  const successPanel = makeEl({});
  const ring = makeEl({});
  const submitButton = makeEl({ textContent: 'Verify my email' });
  // Only on the cold page: the hidden field the typed address is carried into,
  // and the form that sends it.
  const carried = cold ? makeEl({ type: 'hidden', value: '', defaultValue: '' }) : null;
  const carriedChallenge = cold ? makeEl({ type: 'hidden', value: '', defaultValue: '' }) : null;
  const carriedToken = cold ? makeEl({ type: 'hidden', value: '', defaultValue: '' }) : null;
  const coldButton = cold ? makeEl({ textContent: 'Resend' }) : null;
  const coldResend = cold ? makeEl({ querySelector: () => coldButton }) : null;
  // The one captcha box on the page, which both the verify form and the cold
  // resend draw their answer from.
  const challengeInput = makeEl({ value: '', name: 'challengeAnswer' });
  const note = makeEl({ textContent: '' });
  const resendPrompt = makeEl({ textContent: '' });
  // Rendered only when the server knows how long is left, so the stub mirrors
  // that: no countdown element at all on a cold arrival.
  const label = expiresInMs === null ? null : makeEl({
    dataset: { expiresIn: String(expiresInMs), lifetime: String(codeLifetimeMs) },
  });

  const byId = {
    'verify-code-form': form,
    'verify-code-input': hidden,
    'verify-email-input': emailInput,
    'pending-resend-form': resendForm,
    'pending-resend-button': resendButton,
    'verify-panel': panel,
    'verify-success': successPanel,
    'expiry-ring': ring,
    'expiry-label': label,
    'expiry-note': note,
    'resend-prompt': resendPrompt,
    'verify-submit': submitButton,
    'resend-verification-form': coldResend,
    'carried-email': carried,
    'carried-challenge': carriedChallenge,
    'carried-token': carriedToken,
    'cold-resend-button': coldButton,
  };

  const toasts = [];
  const nav = { href: null };
  const ready = [];
  const requests = [];
  const intervals = new Map();
  const documentListeners = {};
  let timerId = 0;
  let clockNow = 1000000;

  const sandbox = {
    document: {
      addEventListener: (type, fn) => {
        if (type === 'DOMContentLoaded') { ready.push(fn); return; }
        (documentListeners[type] = documentListeners[type] || []).push(fn);
      },
      getElementById: (id) => byId[id] || null,
      querySelectorAll: (sel) => (sel === '.code-digit' ? boxes : []),
      querySelector: (sel) => (sel === '[name="challengeAnswer"]' ? challengeInput : null),
    },
    window: { location: { get href() { return nav.href; }, set href(v) { nav.href = v; } } },
    showToast: (m) => toasts.push(String(m)),
    withPending: async (target, label, fn) => fn(),
    apiFetch: async (url, options) => {
      requests.push({ url, options });
      submits.push(JSON.parse((options && options.body) || '{}'));
      if (reply instanceof Error) throw reply;
      return reply || { message: 'ok', data: { loggedIn: false } };
    },
    // A clock the test moves by hand. Waiting three real minutes for a code to
    // expire is not a test anybody would run, and a countdown that is only
    // ever observed at full is not a countdown anybody has checked.
    Date: { now: () => clockNow },
    setInterval: (fn) => { const id = (timerId += 1); intervals.set(id, fn); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (fn) => { fn(); return 1; },
  };

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));
  ready.forEach((fn) => fn());

  // Typing: what a browser does is set the box's value and fire `input`.
  function type(index, text) {
    boxes[index].value = text;
    boxes[index].fire('input');
  }

  // The page listens on the document for the challenge box changing, so the
  // stub has to deliver events the same way a browser would.
  challengeInput.addEventListener('input', () => {
    (documentListeners.input || []).forEach((fn) => fn({ target: challengeInput }));
  });

  function paste(index, text) {
    boxes[index].fire('paste', {
      preventDefault() {},
      clipboardData: { getData: () => text },
    });
  }

  function key(index, name) {
    boxes[index].fire('keydown', { key: name, preventDefault() {} });
  }

  // Moves the clock and runs whatever was due, the way a browser would. The
  // list is snapshotted first because a tick can clear its own interval.
  function advance(ms) {
    clockNow += ms;
    Array.from(intervals.values()).forEach((fn) => fn());
  }

  const CIRCUMFERENCE = 2 * Math.PI * 52;
  // How much of the ring is still drawn, 1 at full and 0 when it has run out.
  function ringFraction() {
    const offset = Number(ring.getAttribute('stroke-dashoffset') || 0);
    return 1 - (offset / CIRCUMFERENCE);
  }

  // Typing into the address field, which is what carries it across.
  function typeEmail(value) {
    emailInput.value = value;
    emailInput.fire('input');
  }

  function clickResend() {
    let prevented = false;
    coldButton.fire('click', {
      preventDefault() { prevented = true; },
      stopPropagation() {},
    });
    return prevented;
  }

  function typeChallenge(value) {
    challengeInput.value = value;
    challengeInput.fire('input');
  }

  return {
    boxes, hidden, form, resendButton, resendForm, panel, successPanel, ring, label, note,
    resendPrompt, submitButton, emailInput, carried, carriedChallenge, coldButton, coldResend,
    challengeInput, toasts, nav, submits, requests, type, paste, key,
    advance, ringFraction, typeEmail, typeChallenge, clickResend,
  };
}

const TTL = verification.CODE_TTL_MS;

async function main() {
  await cleanup();
  passwordHash = await bcrypt.hash(PASSWORD, 4);

  // --- one code, not two ----------------------------------------------------

  await test('a fresh account with no code outstanding gets one', async () => {
    const user = await makeUser();
    sent.length = 0;
    const outcome = await verification.ensureVerificationCode(user);

    assertEqual(outcome.sent, true, 'it sent');
    assertEqual(outcome.reason, 'sent', 'and says so');
    assertEqual(sent.length, 1, 'exactly one email');
  });

  await test('the email is told the lifetime rather than repeating it', async () => {
    // The template used to have "30 minutes" written into it. Two places
    // stating a number that only one of them owns is how an email ends up
    // confidently telling somebody the wrong thing.
    const user = await makeUser();
    sent.length = 0;
    await verification.ensureVerificationCode(user);

    assertEqual(sent[0].ttlMs, TTL, 'the same lifetime the code was given');
  });

  await test('an outstanding code is reused rather than replaced', async () => {
    // The failure this prevents: register, then immediately try to log in.
    // Issuing a second code invalidates the first, so the email they are
    // already looking at stops working the moment the next one arrives — and
    // they have no way to tell which of the two in their inbox is live.
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    const before = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    sent.length = 0;
    const outcome = await verification.ensureVerificationCode(user);
    const after = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    assertEqual(outcome.sent, false, 'nothing sent');
    assertEqual(outcome.reason, 'still-valid', 'because the code still works');
    assertEqual(sent.length, 0, 'no second email');
    assertEqual(after.codeHash, before.codeHash, 'the code in their inbox still works');
  });

  await test('the reported send time is when it actually went out', async () => {
    // The page counts a resend cooldown down from this. Reporting "now" for a
    // reused code would restart a wait that was already nearly over.
    //
    // Expressed as a fraction of the lifetime rather than a fixed number of
    // minutes: this test hardcoded "20 minutes ago" and broke the moment the
    // lifetime dropped to three, which is a test measuring the constant rather
    // than the behaviour.
    const elapsed = Math.round(TTL / 3);
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() + TTL - elapsed) },
    });

    const outcome = await verification.ensureVerificationCode(user);
    assertEqual(outcome.reason, 'still-valid', 'reused');
    const agoMs = Date.now() - outcome.sentAt;
    assert(Math.abs(agoMs - elapsed) < 5000, `about ${Math.round(elapsed / 1000)}s ago, got ${Math.round(agoMs / 1000)}s`);
  });

  await test('a code about to expire is replaced instead of reused', async () => {
    // Five seconds is no use to somebody who still has to open their inbox.
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() + 5 * 1000) },
    });

    sent.length = 0;
    const outcome = await verification.ensureVerificationCode(user);
    assertEqual(outcome.sent, true, 'a new one was sent');
    assertEqual(sent.length, 1, 'one email');
  });

  await test('a code lives the two to three minutes it is meant to', async () => {
    const minutes = TTL / 60000;
    assert(minutes >= 2 && minutes <= 3, `between two and three minutes, got ${minutes}`);
  });

  await test('a code issued a moment ago is still reusable', async () => {
    // The invariant that nearly shipped broken: the floor below which a code
    // is not worth reusing was five minutes, which is longer than the whole
    // three-minute lifetime. Nothing would ever have been reusable, and every
    // sign-in would have mailed another code — with no test failing, because
    // reuse was only ever checked against a thirty-minute life.
    const user = await makeUser();
    await verification.ensureVerificationCode(user);

    sent.length = 0;
    const outcome = await verification.ensureVerificationCode(user);
    assertEqual(outcome.reason, 'still-valid', 'reused');
    assertEqual(sent.length, 0, 'no second email a second later');
  });

  await test('the deadline the page counts down to is the row\'s own', async () => {
    // The countdown is only worth showing if it agrees with the check the
    // server will actually make. Computed as now + TTL it would drift by
    // however long the mail provider took to answer.
    const user = await makeUser();
    const outcome = await verification.ensureVerificationCode(user);
    const row = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    assertEqual(outcome.expiresAt, row.expiresAt.getTime(), 'exactly the stored deadline');
  });

  await test('a resend reports the new deadline, not the old one', async () => {
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    const before = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    const outcome = await verification.resendForPending(user.id);
    assert(outcome.expiresAt >= before.expiresAt.getTime(), 'the clock restarted');
    const left = outcome.expiresAt - Date.now();
    assert(left > TTL - 5000 && left <= TTL, `a full lifetime, got ${Math.round(left / 1000)}s`);
  });

  await test('a code whose guesses are used up is replaced', async () => {
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { attempts: verification.MAX_ATTEMPTS },
    });

    const outcome = await verification.ensureVerificationCode(user);
    assertEqual(outcome.sent, true, 'a dead code is not worth reusing');
  });

  // --- who the login path will send to --------------------------------------

  await test('an unverified address gets a code prepared for it', async () => {
    const user = await makeUser({ verified: false });
    const pending = await verification.prepareVerification(user.email);

    assert(pending, 'something to do');
    assertEqual(pending.userId, user.id, 'the right account');
    assertEqual(pending.email, user.email, 'and its stored address');
    assert(typeof pending.sentAt === 'number', 'with a send time the page can count from');
  });

  await test('an already-verified address prepares nothing', async () => {
    const user = await makeUser({ verified: true });
    sent.length = 0;
    assertEqual(await verification.prepareVerification(user.email), null, 'nothing to do');
    assertEqual(sent.length, 0, 'and no email');
  });

  await test('an address with no account prepares nothing', async () => {
    sent.length = 0;
    assertEqual(await verification.prepareVerification(`${TAG}nobody@example.test`), null, 'nothing to do');
    assertEqual(sent.length, 0, 'and no email');
  });

  // --- the resend behind the button ----------------------------------------

  await test('the session resend always issues a new code', async () => {
    // Unlike the login path, which reuses. They pressed the button because
    // what they have does not work — handing back the same code is the one
    // answer that cannot help.
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    const before = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    sent.length = 0;
    const outcome = await verification.resendForPending(user.id);
    const after = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

    assertEqual(outcome.sent, true, 'sent');
    assertEqual(sent.length, 1, 'one email');
    assert(after.codeHash !== before.codeHash, 'a genuinely different code');
    assertEqual(after.attempts, 0, 'with its guesses reset');
  });

  await test('the session resend does nothing for an account already verified', async () => {
    const user = await makeUser({ verified: true });
    sent.length = 0;
    const outcome = await verification.resendForPending(user.id);
    assertEqual(outcome.sent, false, 'nothing sent');
    assertEqual(sent.length, 0, 'no email');
  });

  // --- what confirming an address now does ---------------------------------








  // --- the handoff between two requests ------------------------------------

  await test('a blocked login leaves the next page everything it needs', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    const { err } = await run(authApi.login, {
      body: { email: user.email, password: PASSWORD, context: 'user' },
      session,
    });

    assertEqual(err && err.code, 'EMAIL_NOT_VERIFIED', 'still refused, still tagged');
    assertEqual(sent.length, 1, 'and the code went out without anybody asking for it');
    assert(session.pendingVerification, 'the next page knows who this is');
    assertEqual(session.pendingVerification.email, user.email, 'so it need not be retyped');
    assert(session.pendingVerification.expiresAt > Date.now(), 'and when the code it just sent dies');
  });

  await test('a wrong password leaves nothing behind', async () => {
    // Otherwise the session would vouch for a password that was never given,
    // and the code alone would be enough to get in.
    const user = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    const { err } = await run(authApi.login, {
      body: { email: user.email, password: 'not-the-password', context: 'user' },
      session,
    });

    assertEqual(err && err.statusCode, 401, 'refused');
    assertEqual(err.code, null, 'with no verification tag');
    assertEqual(session.pendingVerification, undefined, 'and nothing remembered');
    assertEqual(sent.length, 0, 'and no email to an address the sender may not own');
  });

  await test('verifying hands them to the login page with the address filled in', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });
    const code = sent[0].code;

    const { res } = await run(authApi.verifyEmailCode, { body: { email: user.email, code }, session });

    assertEqual(res.body.success, true, 'verified');
    assert(res.body.data.redirectTo.startsWith('/login?verified=1&email='), `to the login page, got: ${res.body.data.redirectTo}`);
    assert(res.body.data.redirectTo.includes(encodeURIComponent(user.email)), 'carrying the address');
    assertEqual(session.user, undefined, 'no session handed out');
    assertEqual(session.pendingVerification, undefined, 'and nothing left waiting');
  });

  await test('an address with characters a URL cares about survives the trip', async () => {
    // A + in an address is legal and common (ana+jpsme@…), and is a space once
    // it reaches a query string unencoded — so the login box would prefill with
    // an address that is not theirs and fail on submit.
    const user = await makeUser({ verified: false });
    await prisma.user.update({ where: { id: user.id }, data: { email: `${TAG}plus+tag@example.test` } });
    const session = makeSession();
    sent.length = 0;

    await run(authApi.login, { body: { email: `${TAG}plus+tag@example.test`, password: PASSWORD }, session });
    const { res } = await run(authApi.verifyEmailCode, {
      body: { email: `${TAG}plus+tag@example.test`, code: sent[0].code }, session,
    });

    const back = new URLSearchParams(res.body.data.redirectTo.split('?')[1]).get('email');
    assertEqual(back, `${TAG}plus+tag@example.test`, 'decodes to exactly what was verified');
  });

  await test('verifying from a session that knows nothing still verifies', async () => {
    // Somebody who verified in a different browser from the one they signed in
    // on. The verification is the thing they came for and must not fail.
    const user = await makeUser({ verified: false });
    sent.length = 0;
    await verification.ensureVerificationCode(user);

    const { res } = await run(authApi.verifyEmailCode, {
      body: { email: user.email, code: sent[0].code },
      session: makeSession(),
    });

    assertEqual(res.body.success, true, 'verified');
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assert(after.emailVerifiedAt, 'and it stuck');
  });



  // --- the resend button ----------------------------------------------------

  await test('the resend button is refused without a session that vouches for it', async () => {
    const { res } = await run(authApi.resendPendingVerification, { session: makeSession() });

    assertEqual(res.statusCode, 403, 'refused');
    assertEqual(res.body.code, 'NO_PENDING_VERIFICATION', 'tagged, so the page can send them back to log in');
  });

  await test('pressing it twice in a row does not send two emails', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });

    sent.length = 0;
    const { res } = await run(authApi.resendPendingVerification, { session });

    assertEqual(res.statusCode, 429, 'held off');
    assert(/\d+s/.test(res.body.message), `and says how long, got: ${res.body.message}`);
    assertEqual(sent.length, 0, 'nothing sent');
  });

  await test('once the wait is over it sends, and the wait starts again', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });
    session.pendingVerification.sentAt = Date.now() - 61 * 1000;

    sent.length = 0;
    const { res } = await run(authApi.resendPendingVerification, { session });

    assertEqual(res.statusCode, 200, 'sent');
    assertEqual(sent.length, 1, 'one email');
    assertEqual(sent[0].to, user.email, 'to the address the server remembered, not one they typed');
    assert(session.pendingVerification.sentAt > Date.now() - 5000, 'the cooldown restarts');
  });

  await test('the code from the resend is the one that works', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });
    const stale = sent[sent.length - 1].code;
    session.pendingVerification.sentAt = Date.now() - 61 * 1000;

    sent.length = 0;
    await run(authApi.resendPendingVerification, { session });
    const fresh = sent[0].code;

    assert(stale !== fresh, 'a genuinely new code');
    const bad = await run(authApi.verifyEmailCode, { body: { email: user.email, code: stale }, session });
    assert(bad.err, 'the old one is dead');

    const good = await run(authApi.verifyEmailCode, { body: { email: user.email, code: fresh }, session });
    assertEqual(good.res.body.success, true, 'and the new one is accepted');
  });


  // --- typing the thing -----------------------------------------------------

  await test('typing six digits fills six boxes and submits on its own', async () => {
    // The last click this flow still had. Six digits is the whole form; there
    // is nothing to confirm afterwards.
    const page = runVerifyPage();
    page.typeChallenge('ABCDE');
    '482913'.split('').forEach((d, i) => page.type(i, d));

    assertEqual(page.hidden.value, '482913', 'the code is assembled');
    assertEqual(page.submits.length, 1, 'and sent without pressing anything');
    assertEqual(page.submits[0].code, '482913', 'as typed');
    assertEqual(page.submits[0].email, 'ana@example.com', 'for the address the server knew');
  });

  await test('a pasted code lands in the boxes, spaces and all', async () => {
    // People paste out of the email far more often than they retype, and what
    // comes with it is whatever the selection picked up.
    const page = runVerifyPage();
    page.typeChallenge('ABCDE');
    page.paste(0, ' 482 913 ');

    assertEqual(page.boxes.map((b) => b.value).join(''), '482913', 'six digits');
    assertEqual(page.submits.length, 1, 'and it went');
  });

  await test('a phone filling the whole code into the first box still works', async () => {
    // iOS and Android offer the code from the notification and drop all six
    // into the field that asked for it — which is box one.
    const page = runVerifyPage();
    page.typeChallenge('ABCDE');
    page.type(0, '482913');

    assertEqual(page.hidden.value, '482913', 'spread across the boxes');
    assertEqual(page.submits.length, 1, 'and submitted');
  });

  await test('backspace on an empty box reaches back to the one before it', async () => {
    // Otherwise holding backspace stops dead at the first empty box, and the
    // digits already typed cannot be cleared without clicking each one.
    const page = runVerifyPage();
    page.type(0, '4');
    page.type(1, '8');
    page.type(2, '');           // caret sitting on an empty third box
    page.key(2, 'Backspace');

    assertEqual(page.boxes[1].value, '', 'the digit before it is gone');
    assertEqual(page.hidden.value, '4', 'and the code shrank with it');
  });

  await test('a letter is simply ignored rather than filling a box with junk', async () => {
    const page = runVerifyPage();
    page.type(0, 'x');
    assertEqual(page.boxes[0].value, '', 'nothing kept');
    assertEqual(page.hidden.value, '', 'nothing submitted');
  });

  await test('a rejected code clears the boxes instead of inviting the same guess again', async () => {
    const page = runVerifyPage({ reply: Object.assign(new Error('That code is incorrect or has expired.'), { code: null }) });
    page.typeChallenge('ABCDE');
    '000000'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.hidden.value, '', 'wiped');
    assert(page.toasts.some((t) => /incorrect or has expired/.test(t)), 'and the reason is shown');
  });

  await test('a response with nowhere to go still says it worked', async () => {
    // Not reachable today — the server always sends a destination — but the
    // alternative to this branch is a form that has gone quiet with no way to
    // tell whether the address was confirmed.
    const page = runVerifyPage({ reply: { message: 'Email verified', data: {} } });
    page.typeChallenge('ABCDE');
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.nav.href, null, 'nowhere to send them');
    assert(page.panel.hiddenBy.includes('hidden'), 'the form is put away');
    assert(page.successPanel.shownBy.includes('hidden'), 'and the confirmation takes its place');
  });

  await test('the resend button starts out counting down the wait already spent', async () => {
    const page = runVerifyPage({ resendWaitMs: 45000 });
    assertEqual(page.resendButton.disabled, true, 'not yet');
    assertEqual(page.resendButton.textContent, 'Resend in 45s', 'and says when');
  });

  await test('with no wait left the button is ready immediately', async () => {
    const page = runVerifyPage({ resendWaitMs: 0 });
    assertEqual(page.resendButton.disabled, false, 'ready');
    assertEqual(page.resendButton.textContent, 'Resend', 'and says so plainly');
  });

  await test('the resend asks the server for nothing but a new code', async () => {
    // No address in the body. That is the whole reason this one needs no
    // captcha: there is nothing here for a sender to choose.
    const page = runVerifyPage({ resendWaitMs: 0, reply: { message: 'sent', data: { cooldownMs: 60000 } } });
    page.resendForm.fire('submit', { preventDefault() {} });
    await new Promise((r) => setImmediate(r));

    const call = page.requests[page.requests.length - 1];
    assertEqual(call.url, '/api/auth/verification/resend', 'the session-scoped endpoint');
    assertEqual(call.options.body, undefined, 'and nothing to say');
  });

  // --- watching the code run out --------------------------------------------

  await test('the time left is shown from the moment the page opens', async () => {
    const page = runVerifyPage({ expiresInMs: 180000 });
    assertEqual(page.label.textContent, 'Expires in 3:00', 'as minutes and seconds');
    assert(page.ringFraction() > 0.99, 'with a full ring');
  });

  await test('the ring drains as the code ages', async () => {
    const page = runVerifyPage({ expiresInMs: 180000 });
    page.advance(90000);

    assertEqual(page.label.textContent, 'Expires in 1:30', 'half gone');
    const half = page.ringFraction();
    assert(half > 0.45 && half < 0.55, `the ring is about half drawn, got ${half.toFixed(2)}`);
  });

  await test('the colour changes before the number has to be read', async () => {
    // Somebody glancing at the page should know they are running out without
    // parsing a clock.
    const page = runVerifyPage({ expiresInMs: 180000 });
    assertEqual(page.ring.getAttribute('stroke'), '#4f46e5', 'indigo with plenty of time');

    page.advance(130000); // 50s left
    assertEqual(page.ring.getAttribute('stroke'), '#d97706', 'amber under a minute');

    page.advance(35000); // 15s left
    assertEqual(page.ring.getAttribute('stroke'), '#dc2626', 'red under twenty seconds');
  });

  await test('the page says the code expired rather than letting it fail silently', async () => {
    // The failure this replaces: typing a code that stopped working while it
    // was being typed, and being told only that it was "incorrect or expired"
    // — with no way to tell which, or that any time limit existed.
    const page = runVerifyPage({ expiresInMs: 180000 });
    page.advance(180001);

    assertEqual(page.label.textContent, 'Code expired', 'said plainly');
    assertEqual(page.ringFraction(), 0, 'the ring is empty');
    assert(page.boxes.every((b) => b.disabled), 'and there is nothing left to type into');
    assertEqual(page.submitButton.disabled, true, 'the button will not send it');
    assertEqual(page.submitButton.textContent, 'Code expired', 'and says why');
  });

  await test('an expired page points at the one thing left to do', async () => {
    const page = runVerifyPage({ expiresInMs: 60000 });
    page.advance(60001);

    assert(/new one/i.test(page.note.textContent), `the note offers a resend, got: ${page.note.textContent}`);
    assert(/expired/i.test(page.resendPrompt.textContent), `so does the prompt, got: ${page.resendPrompt.textContent}`);
  });

  await test('a code typed after it expired is not sent to the server', async () => {
    // It would only come back rejected, and "incorrect or expired" after the
    // page already said expired reads as a second, different problem.
    const page = runVerifyPage({ expiresInMs: 30000 });
    page.typeChallenge('ABCDE');
    page.advance(30001);
    page.boxes.forEach((b) => { b.disabled = false; }); // as if the disable had been bypassed
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.submits.length, 0, 'nothing went');
    assert(page.toasts.some((t) => /expired/i.test(t)), 'and it says so');
  });

  await test('the digits are cleared when the code dies, not left to be resubmitted', async () => {
    const page = runVerifyPage({ expiresInMs: 30000 });
    '4829'.split('').forEach((d, i) => page.type(i, d));
    page.advance(30001);

    assertEqual(page.hidden.value, '', 'the half-typed code is gone');
  });

  await test('a resend restarts the clock and the page works again', async () => {
    const page = runVerifyPage({
      expiresInMs: 20000,
      reply: { message: 'sent', data: { cooldownMs: 60000, expiresInMs: 180000 } },
    });
    page.advance(20001);
    assertEqual(page.submitButton.disabled, true, 'expired first');

    page.resendForm.fire('submit', { preventDefault() {} });
    await flush();

    assertEqual(page.label.textContent, 'Expires in 3:00', 'a full lifetime again');
    assert(page.ringFraction() > 0.99, 'and a full ring');
    assert(page.boxes.every((b) => !b.disabled), 'the boxes are usable again');
    assertEqual(page.submitButton.disabled, false, 'and so is the button');
  });

  await test('a cold arrival has no countdown to be wrong about', async () => {
    // Nothing is known about them, so there is no deadline to show — and a
    // timer counting down from a guess would be worse than none.
    const page = runVerifyPage({ expiresInMs: null });
    assertEqual(page.label, null, 'no countdown element');
    assertEqual(page.submitButton.disabled, false, 'and nothing disabled by a clock that never started');
  });

  // --- the check in front of the code ---------------------------------------

  await test('the sixth digit hands over to the captcha instead of submitting', async () => {
    // It used to send on the sixth digit. It cannot now: there is a check in
    // front of the code, and submitting with it blank would fail every time
    // and spend a code doing it.
    const page = runVerifyPage({ expiresInMs: 180000 });
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.submits.length, 0, 'nothing sent yet');
    assertEqual(page.challengeInput.focused, true, 'the caret moved to what is still unanswered');
  });

  await test('with the captcha answered, the sixth digit still sends it', async () => {
    const page = runVerifyPage({ expiresInMs: 180000 });
    page.typeChallenge('ABCDE');
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.submits.length, 1, 'sent without pressing anything');
    assertEqual(page.submits[0].code, '482913', 'as typed');
  });

  await test('a verified code goes to wherever the server says', async () => {
    const page = runVerifyPage({
      expiresInMs: 180000,
      reply: { message: 'Verified', data: { redirectTo: '/login?verified=1&email=ana%40example.com' } },
    });
    page.typeChallenge('ABCDE');
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.nav.href, '/login?verified=1&email=ana%40example.com', 'the login page, address in hand');
  });

  // --- typing the address once ----------------------------------------------

  await test('the address typed for the code is the one the resend uses', async () => {
    const page = runVerifyPage({ cold: true });
    page.typeEmail('  ana@example.com  ');

    assertEqual(page.carried.value, 'ana@example.com', 'carried across, trimmed');
  });

  await test('the carried address survives the form being reset', async () => {
    // auth.js calls form.reset() after a successful send, and reset restores
    // defaultValue — not the value. Without setting both, the address would
    // silently empty itself after the first resend and the second would fail
    // validation with nothing on screen to explain why.
    const page = runVerifyPage({ cold: true });
    page.typeEmail('ana@example.com');

    assertEqual(page.carried.defaultValue, 'ana@example.com', 'a reset restores the address');
  });

  await test('a resend with nothing typed is stopped before it is sent', async () => {
    const page = runVerifyPage({ cold: true });
    const prevented = page.clickResend();

    assertEqual(prevented, true, 'the submit never happens');
    assert(page.toasts.some((t) => /email address above/i.test(t)), `and says what to do, got: ${page.toasts.join(' | ')}`);
  });

  await test('a resend with an address typed is allowed through', async () => {
    const page = runVerifyPage({ cold: true });
    page.typeEmail('ana@example.com');
    page.typeChallenge('ABCDE');
    const prevented = page.clickResend();

    assertEqual(prevented, false, 'nothing in the way');
    assertEqual(page.carried.value, 'ana@example.com', 'and the address goes with it');
  });

  await test('the captcha answer is carried too, not typed twice', async () => {
    const page = runVerifyPage({ cold: true });
    page.typeEmail('ana@example.com');
    page.typeChallenge('ABCDE');

    assertEqual(page.carriedChallenge.value, 'ABCDE', 'carried into the resend');
    assertEqual(page.carriedChallenge.defaultValue, 'ABCDE', 'and survives the reset');
  });

  await test('a resend with the captcha blank is stopped, and says which box', async () => {
    const page = runVerifyPage({ cold: true });
    page.typeEmail('ana@example.com');
    const prevented = page.clickResend();

    assertEqual(prevented, true, 'stopped');
    assert(page.toasts.some((t) => /characters shown/i.test(t)), `names the box, got: ${page.toasts.join(' | ')}`);
  });

  await test('the cold resend waits a minute too, and counts it down', async () => {
    const page = runVerifyPage({ cold: true });
    page.typeEmail('ana@example.com');
    page.typeChallenge('ABCDE');
    page.clickResend();

    assertEqual(page.coldButton.disabled, true, 'not straight away');
    assertEqual(page.coldButton.textContent, 'Resend in 60s', 'and it says how long');

    page.advance(0); // one tick of the interval
    assertEqual(page.coldButton.textContent, 'Resend in 59s', '59, 58 …');
  });

  await test('a known page carries nothing, because nothing is typed', async () => {
    const page = runVerifyPage({ expiresInMs: 180000 });
    assertEqual(page.carried, null, 'no carried field');
    assertEqual(page.coldResend, null, 'and no public resend');
  });

  // --- the pages ------------------------------------------------------------

  const base = { cspNonce: 'n', currentUser: null, logoUrl: '/img/default-logo.svg' };

  await test('the login page arrives filled in when it comes from verification', async () => {
    const html = renderView('login.ejs', Object.assign({}, base, {
      email: 'ana@example.com', justVerified: true,
    }));

    assert(/value="ana@example\.com"/.test(html), 'the address is already there');
    assert(/Email verified/.test(html), 'and it says the verification worked');
  });

  await test('a plain visit to the login page says nothing it should not', async () => {
    const html = renderView('login.ejs', Object.assign({}, base, {}));
    assert(!/Email verified/.test(html), 'no banner nobody earned');
  });

  await test('an address in the link cannot carry markup into the page', async () => {
    const html = renderView('login.ejs', Object.assign({}, base, {
      email: '"><script>alert(1)</script>', justVerified: true,
    }));
    assert(!html.includes('<script>alert(1)</script>'), 'escaped on the way out');
  });

  await test('the login page no longer hides a resend behind a disclosure triangle', async () => {
    const html = renderView('login.ejs', base);
    assert(!/<details/.test(html), 'nothing to open');
    assert(!html.includes('resend-verification-form'), 'no resend form to find');
    assert(!html.includes('challenge-answer'), 'and no captcha to read');
    assert(html.includes('/verify-email'), 'but somebody holding a code can still get to the field');
  });

  await test('a known visitor is asked for the code and nothing else', async () => {
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: 'ana@example.com', pendingEmail: 'ana@example.com', resendWaitMs: 42000, paymentRequired: false,
    }));

    assertEqual((html.match(/class="code-digit/g) || []).length, 6, 'six boxes for six digits');
    assert(/type="hidden" name="email"/.test(html), 'the address is not a field they can get wrong');
    assert(html.includes('>ana@example.com<'), 'it is shown, so they know where to look');
    // Matched on the id attribute, not the bare name: the shared inline script
    // mentions both ids, and a test that cannot tell markup from the script
    // that looks for it is a test that passes when the form is still there.
    assert(!/id="resend-verification-form"/.test(html), 'and no public resend form');
    assert(!/id="carried-email"/.test(html), 'and no address to carry, because none is typed');
    assert(html.includes('data-wait-ms="42000"'), 'the wait already spent is carried over');
  });

  await test('a cold visitor keeps the address field and the captcha', async () => {
    // Nothing is known about them, so the public resend is exactly as
    // protected as it was — it will mail an address the sender chose.
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: '', pendingEmail: '', resendWaitMs: 0, paymentRequired: false,
    }));

    assertEqual((html.match(/class="code-digit/g) || []).length, 6, 'same six boxes');
    assert(/id="verify-email-input" name="email" type="email"/.test(html), 'an address field');
    assert(/id="resend-verification-form"/.test(html), 'the public resend');
    assert(html.includes('challenge-answer'), 'still behind a captcha');
    assert(!/id="pending-resend-button"/.test(html), 'and no session resend it could not use');
  });

  await test('a cold visitor types their address once, not twice', async () => {
    // The resend used to be a second card with a second email input, directly
    // below the field that already had the address in it. Two fields, one
    // answer, and the second under a heading that read like a different task.
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: '', pendingEmail: '', resendWaitMs: 0, paymentRequired: false,
    }));

    assertEqual((html.match(/type="email"/g) || []).length, 1, 'exactly one field to type into');
    assert(/id="carried-email"[^>]*type="hidden"|type="hidden"[^>]*id="carried-email"/.test(html)
      || /<input type="hidden" name="email" id="carried-email"/.test(html), 'the resend carries it instead');
    assert(!html.includes('Need a new code?'), 'and the second card is gone');
  });

  await test('the cold page offers the shorter road before the longer one', async () => {
    // Signing in sends a code by itself and needs no address typed. The
    // captcha is no longer the thing it saves you — that now stands in front
    // of the code for everybody — so the claim is only about the address.
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: '', pendingEmail: '', resendWaitMs: 0, paymentRequired: false,
    }));

    const prompt = html.indexOf("Didn't get the code?");
    const signIn = html.indexOf('sends one automatically');
    const resend = html.indexOf('id="cold-resend-button"');
    assert(prompt > -1 && signIn > prompt, 'the easier way is offered under the prompt');
    assert(signIn < resend, 'and before the form it is an alternative to');
    assert(!/nothing to fill in/.test(html), 'and does not promise a captcha-free trip it cannot give');
  });

  await test('one human check per page, in front of the code', async () => {
    // One, because a session holds one challenge: a second box would show the
    // same image and spend the same answer. In front, because a check behind
    // the code guards nothing that has not already been checked.
    const markup = (locals) => {
      const html = renderView('verify-email.ejs', Object.assign({}, base, locals));
      return html.slice(0, html.lastIndexOf('<script nonce'));
    };

    for (const [name, locals] of [
      ['signed in', { email: 'a@b.com', pendingEmail: 'a@b.com', resendWaitMs: 0, paymentRequired: false }],
      ['cold', { email: '', pendingEmail: '', resendWaitMs: 0, paymentRequired: false }],
    ]) {
      const html = markup(locals);
      assertEqual((html.match(/id="challenge-answer"/g) || []).length, 1, `${name}: exactly one box`);
      assert(html.indexOf('id="challenge-answer"') < html.indexOf('id="verify-submit"'), `${name}: before the button`);
    }
  });

  await test('the cold resend carries the answer rather than asking twice', async () => {
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: '', pendingEmail: '', resendWaitMs: 0, paymentRequired: false,
    }));
    const markup = html.slice(0, html.lastIndexOf('<script nonce'));

    assert(/id="carried-challenge"[^>]*>/.test(markup), 'a hidden field for the answer');
    assert(/id="carried-token"[^>]*>/.test(markup), 'and one for a Turnstile token');
  });

  await test('the verify route actually runs the human check', async () => {
    // Wiring with no other cheap observable: the check lives in the route
    // definition, and a page carrying a captcha the server never looks at is
    // worse than no captcha, because it looks like protection.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'auth.routes.js'), 'utf8');
    const block = routes.slice(routes.indexOf("'/verify-code'"));
    const end = block.indexOf('authApi.verifyEmailCode');
    assert(end > -1, 'found the route');
    assert(block.slice(0, end).includes('requireHuman()'), 'requireHuman stands in front of the handler');
  });

  await test('only the first box asks the phone for the code', async () => {
    // Six boxes each claiming to be the one-time-code field is how a phone
    // ends up filling the same digit six times.
    const html = renderView('verify-email.ejs', Object.assign({}, base, {
      email: 'ana@example.com', pendingEmail: 'ana@example.com', resendWaitMs: 0, paymentRequired: false,
    }));
    assertEqual((html.match(/autocomplete="one-time-code"/g) || []).length, 1, 'exactly one');
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
