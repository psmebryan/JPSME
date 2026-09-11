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
  sendVerificationEmail: async (user, code) => { sent.push({ to: user.email, code }); return true; },
  sendMemberApprovedEmail: async () => true,
  sendAccountApprovedEmail: async () => true,
});

const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
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
  const el = Object.assign({
    value: '',
    disabled: false,
    textContent: '',
    type: 'text',
    dataset: {},
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

function runVerifyPage({ pendingEmail = 'ana@example.com', resendWaitMs = 0, reply = null } = {}) {
  const html = renderView('verify-email.ejs', {
    cspNonce: 'n', currentUser: null, logoUrl: '/img/default-logo.svg',
    email: pendingEmail, pendingEmail, resendWaitMs, paymentRequired: false,
  });

  const open = html.lastIndexOf('<script nonce="n">');
  const src = html.slice(open + '<script nonce="n">'.length, html.lastIndexOf('</script>'));
  assert(src.includes('code-digit'), 'found the page script');

  const boxes = [];
  for (let i = 0; i < 6; i += 1) boxes.push(makeEl({}));

  const hidden = makeEl({ type: 'hidden' });
  const emailInput = makeEl({ type: 'hidden', value: pendingEmail });
  const submits = [];
  const form = makeEl({
    requestSubmit() { form.fire('submit', { preventDefault() {} }); },
  });
  const resendButton = makeEl({ textContent: 'Send it again', dataset: { waitMs: String(resendWaitMs) } });
  const resendForm = makeEl({});
  const panel = makeEl({});
  const successPanel = makeEl({});

  const byId = {
    'verify-code-form': form,
    'verify-code-input': hidden,
    'verify-email-input': emailInput,
    'pending-resend-form': resendForm,
    'pending-resend-button': resendButton,
    'verify-panel': panel,
    'verify-success': successPanel,
  };

  const toasts = [];
  const nav = { href: null };
  const ready = [];
  const requests = [];

  const sandbox = {
    document: {
      getElementById: (id) => byId[id] || null,
      querySelectorAll: (sel) => (sel === '.code-digit' ? boxes : []),
      querySelector: () => null,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready.push(fn); },
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
    setInterval: () => 1,
    clearInterval: () => {},
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

  function paste(index, text) {
    boxes[index].fire('paste', {
      preventDefault() {},
      clipboardData: { getData: () => text },
    });
  }

  function key(index, name) {
    boxes[index].fire('keydown', { key: name, preventDefault() {} });
  }

  return { boxes, hidden, form, resendButton, resendForm, panel, successPanel, toasts, nav, submits, requests, type, paste, key };
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
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() + TTL - 20 * 60 * 1000) },
    });

    const outcome = await verification.ensureVerificationCode(user);
    const agoMs = Date.now() - outcome.sentAt;
    assertEqual(outcome.reason, 'still-valid', 'reused');
    assert(agoMs > 19 * 60 * 1000 && agoMs < 21 * 60 * 1000, `about 20 minutes ago, got ${Math.round(agoMs / 60000)}m`);
  });

  await test('a code about to expire is replaced instead of reused', async () => {
    // Ninety seconds is no use to somebody who still has to open their inbox.
    const user = await makeUser();
    await verification.ensureVerificationCode(user);
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() + 90 * 1000) },
    });

    sent.length = 0;
    const outcome = await verification.ensureVerificationCode(user);
    assertEqual(outcome.sent, true, 'a new one was sent');
    assertEqual(sent.length, 1, 'one email');
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

  // --- signing in on the strength of the code ------------------------------

  await test('a verified member is signed in without retyping their password', async () => {
    const user = await makeUser({ verified: true, status: 'APPROVED' });
    const signedIn = await authService.completeVerifiedLogin(user.id);

    assert(signedIn, 'signed in');
    assertEqual(signedIn.email, user.email, 'as themselves');
    assertEqual(signedIn.password, undefined, 'and the hash never leaves the service');
  });

  await test('a first-ever login is still reported as one', async () => {
    // This is what sends a brand-new member to their profile once. Arriving
    // via verification rather than the login form must not skip it.
    const user = await makeUser({ verified: true, lastLoginAt: null });
    const signedIn = await authService.completeVerifiedLogin(user.id);
    assertEqual(signedIn.isFirstLogin, true, 'their first');

    const again = await authService.completeVerifiedLogin(user.id);
    assertEqual(again.isFirstLogin, false, 'and not their second');
  });

  await test('a PENDING member is signed in too', async () => {
    // They need a session to pay. app.js's own gate decides where that session
    // may go; refusing it here would just strand them.
    const user = await makeUser({ verified: true, status: 'PENDING' });
    assert(await authService.completeVerifiedLogin(user.id), 'signed in');
  });

  await test('an unverified account is never signed in this way', async () => {
    const user = await makeUser({ verified: false });
    assertEqual(await authService.completeVerifiedLogin(user.id), null, 'refused');
  });

  await test('a rejected applicant is not signed in', async () => {
    const user = await makeUser({ verified: true, status: 'REJECTED' });
    assertEqual(await authService.completeVerifiedLogin(user.id), null, 'refused');
  });

  await test('staff still sign in on their own page', async () => {
    // The two login forms are deliberately mutually exclusive. Verification
    // must not become a third way in for an admin account.
    for (const role of ['ADMIN', 'CHAPTER_ADMIN']) {
      const user = await makeUser({ verified: true, role });
      assertEqual(await authService.completeVerifiedLogin(user.id), null, `${role} refused`);
    }
  });

  await test('a refusal is null, never a throw', async () => {
    // The verification itself is already committed by the time this is called.
    // A throw here would report a completed verification as a failure and send
    // them round the loop again.
    assertEqual(await authService.completeVerifiedLogin(999999999), null, 'a missing account is just null');
  });

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
    assert(session.pendingVerification.passwordProvenAt > 0, 'and that the password was right');
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

  await test('verifying after that login signs them straight in', async () => {
    // The step this removes: going back to the login form and typing the same
    // password a second time, two minutes after the first.
    const user = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });
    const code = sent[0].code;

    const { res } = await run(authApi.verifyEmailCode, { body: { email: user.email, code }, session });

    assertEqual(res.body.success, true, 'verified');
    assertEqual(res.body.data.loggedIn, true, 'and signed in');
    assertEqual(session.user.email, user.email, 'the session is theirs');
    assertEqual(session.pendingVerification, undefined, 'and the proof is spent, not left lying about');
    assertEqual(res.body.data.redirectTo, '/profile', 'a first login lands on the profile');
  });

  await test('verifying with no such session still verifies, it just does not sign in', async () => {
    // Somebody who verified from a different browser than the one they logged
    // in on. The verification is the thing they came for and must not fail.
    const user = await makeUser({ verified: false });
    sent.length = 0;
    await verification.ensureVerificationCode(user);

    const { res } = await run(authApi.verifyEmailCode, {
      body: { email: user.email, code: sent[0].code },
      session: makeSession(),
    });

    assertEqual(res.body.success, true, 'verified');
    assertEqual(res.body.data.loggedIn, false, 'but not signed in');

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assert(after.emailVerifiedAt, 'and it stuck');
  });

  await test('a password proven too long ago no longer counts', async () => {
    const user = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    await run(authApi.login, { body: { email: user.email, password: PASSWORD }, session });
    // Older than the code it was paired with.
    session.pendingVerification.passwordProvenAt = Date.now() - 31 * 60 * 1000;

    const { res } = await run(authApi.verifyEmailCode, {
      body: { email: user.email, code: sent[0].code }, session,
    });

    assertEqual(res.body.data.loggedIn, false, 'verified, but they type their password again');
  });

  await test('one session cannot be used to sign in as another account', async () => {
    // The check that makes the shortcut safe: the proof is for one account,
    // and it is the account being verified that has to match it.
    const mine = await makeUser({ verified: false });
    const theirs = await makeUser({ verified: false });
    const session = makeSession();
    sent.length = 0;

    await run(authApi.login, { body: { email: mine.email, password: PASSWORD }, session });
    sent.length = 0;
    await verification.ensureVerificationCode(theirs);

    const { res } = await run(authApi.verifyEmailCode, {
      body: { email: theirs.email, code: sent[0].code }, session,
    });

    assertEqual(res.body.data.loggedIn, false, 'no session handed out');
    assertEqual(session.user, undefined, 'and none attached');
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
    assertEqual(good.res.body.data.loggedIn, true, 'and the new one signs them in');
  });


  // --- typing the thing -----------------------------------------------------

  await test('typing six digits fills six boxes and submits on its own', async () => {
    // The last click this flow still had. Six digits is the whole form; there
    // is nothing to confirm afterwards.
    const page = runVerifyPage();
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
    page.paste(0, ' 482 913 ');

    assertEqual(page.boxes.map((b) => b.value).join(''), '482913', 'six digits');
    assertEqual(page.submits.length, 1, 'and it went');
  });

  await test('a phone filling the whole code into the first box still works', async () => {
    // iOS and Android offer the code from the notification and drop all six
    // into the field that asked for it — which is box one.
    const page = runVerifyPage();
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
    '000000'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.hidden.value, '', 'wiped');
    assert(page.toasts.some((t) => /incorrect or has expired/.test(t)), 'and the reason is shown');
  });

  await test('a verified code that signs them in goes somewhere, not to a dead end', async () => {
    const page = runVerifyPage({ reply: { message: 'Email verified', data: { loggedIn: true, redirectTo: '/profile' } } });
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.nav.href, '/profile', 'straight in');
  });

  await test('a verified code without a sign-in shows the panel instead', async () => {
    const page = runVerifyPage({ reply: { message: 'Email verified', data: { loggedIn: false } } });
    '482913'.split('').forEach((d, i) => page.type(i, d));
    await flush();

    assertEqual(page.nav.href, null, 'nowhere to send them');
    assert(page.panel.hiddenBy.includes('hidden'), 'the form is put away');
    assert(page.successPanel.shownBy.includes('hidden'), 'and the confirmation takes its place');
  });

  await test('the resend button starts out counting down the wait already spent', async () => {
    const page = runVerifyPage({ resendWaitMs: 45000 });
    assertEqual(page.resendButton.disabled, true, 'not yet');
    assert(/45s/.test(page.resendButton.textContent), `and says when, got: ${page.resendButton.textContent}`);
  });

  await test('with no wait left the button is ready immediately', async () => {
    const page = runVerifyPage({ resendWaitMs: 0 });
    assertEqual(page.resendButton.disabled, false, 'ready');
    assertEqual(page.resendButton.textContent, 'Send it again', 'and says so plainly');
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

  // --- the pages ------------------------------------------------------------

  const base = { cspNonce: 'n', currentUser: null, logoUrl: '/img/default-logo.svg' };

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
    assert(!html.includes('challenge-answer'), 'no captcha between them and a second code');
    assert(!html.includes('resend-verification-form'), 'and no address to retype');
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
    assert(html.includes('resend-verification-form'), 'the public resend');
    assert(html.includes('challenge-answer'), 'still behind a captcha');
    assert(!/id="pending-resend-button"/.test(html), 'and no session resend it could not use');
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
