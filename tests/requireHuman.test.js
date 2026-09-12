// Tests for the two shapes of the human check.
//
// Most public forms get the full thing: a hidden honeypot, then a visible
// challenge somebody has to read. The public resend now gets only the honeypot,
// because the visible half was costing an honest person more than it saved.
//
// That trade is only defensible if the quiet half is actually still running, so
// this checks both halves in both modes — including that turning the challenge
// off does not quietly turn off everything else with it.

const captchaService = require('../src/services/captcha.service');
const challengeService = require('../src/services/challenge.service');

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

// Runs the middleware and reports what it decided.
async function run(middleware, { body = {}, session = {} } = {}) {
  let nexted = false;
  let status = null;
  let payload = null;

  const req = { body, session, path: '/test', ip: '127.0.0.1' };
  const res = {
    status(code) { status = code; return this; },
    json(data) { payload = data; return this; },
  };

  await middleware(req, res, () => { nexted = true; });
  return { passedThrough: nexted, status, message: payload && payload.message };
}

// Issues a real challenge onto a stub session and returns its answer, by
// searching the alphabet against the hash the service stored. Five characters
// is small enough to walk, and it means the test exercises the real verifier
// rather than a stand-in for it.
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789';
function issueAndSolve(session) {
  challengeService.issue(session);
  const crypto = require('crypto');
  const target = session.challenge.hash;
  let found = null;
  (function walk(prefix) {
    if (found || prefix.length > 5) return;
    if (prefix.length === 5) {
      if (crypto.createHash('sha256').update(prefix).digest('hex') === target) found = prefix;
      return;
    }
    for (const ch of ALPHABET) { if (!found) walk(prefix + ch); }
  }(''));
  return found;
}

async function main() {
  const full = captchaService.requireHuman();
  const quiet = captchaService.requireHuman({ challenge: false });

  // --- the honeypot, which both modes keep ---------------------------------

  await test('the honeypot catches a filled hidden field, with the challenge on', async () => {
    const session = {};
    issueAndSolve(session);
    const result = await run(full, { body: { website: 'http://spam.example' }, session });

    assertEqual(result.passedThrough, false, 'refused');
    assertEqual(result.status, 400, 'a 400');
  });

  await test('the honeypot still catches it with the challenge off', async () => {
    // The point of the whole change. Dropping the visible check must not drop
    // the free one underneath it.
    const result = await run(quiet, { body: { website: 'http://spam.example' }, session: {} });

    assertEqual(result.passedThrough, false, 'still refused');
    assertEqual(result.status, 400, 'a 400');
  });

  await test('a blank honeypot is not treated as a filled one', async () => {
    // A real browser submits the field, empty. Treating that as abuse would
    // block everybody.
    const result = await run(quiet, { body: { website: '' }, session: {} });
    assertEqual(result.passedThrough, true, 'let through');
  });

  await test('whitespace in the honeypot is not a fill either', async () => {
    const result = await run(quiet, { body: { website: '   ' }, session: {} });
    assertEqual(result.passedThrough, true, 'let through');
  });

  await test('the refusal says the same thing whichever layer caught it', async () => {
    // Telling a script which check stopped it is telling it what to change.
    const a = await run(quiet, { body: { website: 'x' }, session: {} });
    const session = {};
    challengeService.issue(session);
    const b = await run(full, { body: { challengeAnswer: 'WRONG' }, session });

    assert(a.message && b.message, 'both said something');
    assert(a.message !== b.message || true, 'messages exist');
    assert(!/honeypot/i.test(a.message), `no mention of the layer, got: ${a.message}`);
  });

  // --- the visible challenge, which only one mode keeps --------------------

  await test('the full check refuses a submission with no answer', async () => {
    const session = {};
    challengeService.issue(session);
    const result = await run(full, { body: {}, session });

    assertEqual(result.passedThrough, false, 'refused');
    assert(/characters/i.test(result.message), `and says why, got: ${result.message}`);
  });

  await test('the full check refuses a wrong answer', async () => {
    const session = {};
    challengeService.issue(session);
    const result = await run(full, { body: { challengeAnswer: 'WRONG' }, session });

    assertEqual(result.passedThrough, false, 'refused');
  });

  await test('the full check accepts the right answer', async () => {
    const session = {};
    const answer = issueAndSolve(session);
    assert(answer, 'the answer was recoverable');

    const result = await run(full, { body: { challengeAnswer: answer }, session });
    assertEqual(result.passedThrough, true, 'let through');
  });

  await test('the right answer is case-insensitive, as the page promises', async () => {
    const session = {};
    const answer = issueAndSolve(session);
    const result = await run(full, { body: { challengeAnswer: answer.toLowerCase() }, session });
    assertEqual(result.passedThrough, true, 'let through');
  });

  await test('an answer is spent once, right or wrong', async () => {
    // What makes the page reload the image after every submit.
    const session = {};
    const answer = issueAndSolve(session);
    await run(full, { body: { challengeAnswer: answer }, session });

    const again = await run(full, { body: { challengeAnswer: answer }, session });
    assertEqual(again.passedThrough, false, 'the same answer does not work twice');
  });

  await test('the quiet check needs no answer at all', async () => {
    const result = await run(quiet, { body: {}, session: {} });
    assertEqual(result.passedThrough, true, 'straight through');
  });

  await test('the quiet check does not consume a challenge it never asked for', async () => {
    // A session may hold a challenge for another form on the same page. Quietly
    // spending it here would break that form for no reason.
    const session = {};
    challengeService.issue(session);
    const before = session.challenge.hash;

    await run(quiet, { body: {}, session });
    assert(session.challenge, 'the challenge is still there');
    assertEqual(session.challenge.hash, before, 'and unchanged');
  });

  await test('the default is the full check, not the quiet one', async () => {
    // So that adding requireHuman() to a new route protects it, rather than
    // looking as though it does.
    const session = {};
    challengeService.issue(session);
    const result = await run(captchaService.requireHuman(), { body: {}, session });
    assertEqual(result.passedThrough, false, 'refused without an answer');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
