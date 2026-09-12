// Tests for the login-bounces-you-back-to-login bug.
//
// Symptom: log in, land on the login page again, no error. Try once more and it
// works. From outside it looks like a flaky password.
//
// Cause: captcha.js reloaded the challenge image 400ms after ANY form submit on
// the page, including the login form, which has no challenge on it at all.
// /api/captcha writes to the session, and express-session saves the whole
// object at the end of a request. A login takes about 400ms, so the captcha
// request read the session a moment before login saved the user into it, and
// saved its own older copy a moment after — putting the logged-out session
// back. The login had genuinely succeeded; the session holding it was gone.
//
// Two fixes, both checked here: the page no longer fetches a challenge for a
// form that has none, and the endpoint reloads the session before writing so a
// concurrent save cannot be undone by it.

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) {
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

// --- the page ---------------------------------------------------------------

// Runs the real captcha.js against a stub DOM and reports whether submitting a
// given form causes a fetch of /api/captcha.
function submitFormAndSeeIfItFetches({ formHasChallenge, pageHasChallengeSlot = true }) {
  const fetched = [];
  const timers = [];
  let submitHandler = null;
  let readyHandler = null;

  const slot = {
    querySelector: (sel) => {
      if (sel === '[data-challenge-image]') {
        return { textContent: '', innerHTML: '', classList: { add() {}, remove() {} } };
      }
      if (sel === '[data-challenge-refresh]') return { addEventListener() {} };
      if (sel === '[name="challengeAnswer"]') return { value: '' };
      return null;
    },
  };

  const form = {
    querySelector: (sel) => (sel === '[name="challengeAnswer"]' && formHasChallenge ? { value: '' } : null),
  };

  const sandbox = {
    document: {
      querySelectorAll: () => (pageHasChallengeSlot ? [slot] : []),
      addEventListener: (type, fn) => {
        if (type === 'DOMContentLoaded') readyHandler = fn;
        if (type === 'submit') submitHandler = fn;
      },
    },
    // Shaped like a real Response: captcha.js reads ok and status to tell a
    // refusal from a success, and a stub without them is a stub that cannot
    // reach the success path at all.
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ data: { svg: '<svg></svg>' } }) };
    },
    setTimeout: (fn) => { timers.push(fn); return 1; },
  };

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'captcha.js'), 'utf8');
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));

  if (readyHandler) readyHandler();
  fetched.length = 0; // the load on page open is expected; only the submit matters

  if (submitHandler) submitHandler({ target: form });
  timers.forEach((t) => t());

  return fetched;
}

test('submitting the login form does NOT fetch a challenge', () => {
  // The bug. The login form carries no challenge, so there was never anything
  // to refresh — the fetch was pure collateral, and it cost the session.
  const fetched = submitFormAndSeeIfItFetches({ formHasChallenge: false });
  assertEqual(fetched.length, 0, `no fetch, got: ${JSON.stringify(fetched)}`);
});

test('submitting a form that DOES carry a challenge still refreshes it', () => {
  // The behaviour worth keeping: the answer is spent whether or not it was
  // right, so the image on screen is stale and typing it again cannot work.
  const fetched = submitFormAndSeeIfItFetches({ formHasChallenge: true });
  assertEqual(fetched.length, 1, `one fetch, got: ${JSON.stringify(fetched)}`);
  assert(String(fetched[0]).includes('/api/captcha'), 'of the challenge endpoint');
});

test('a page with no challenge on it binds nothing at all', () => {
  const fetched = submitFormAndSeeIfItFetches({ formHasChallenge: true, pageHasChallengeSlot: false });
  assertEqual(fetched.length, 0, 'nothing to refresh, nothing fetched');
});

test('a submit event with no usable target is ignored rather than thrown on', () => {
  // Submit events bubble from anywhere, and the handler is registered in the
  // capture phase on document.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'captcha.js'), 'utf8');
  assert(/typeof form\.querySelector !== 'function'/.test(src), 'the guard is present');
});

// --- the endpoint -----------------------------------------------------------

test('the challenge endpoint reloads the session before writing to it', () => {
  // Defence in depth: even if something else starts fetching a challenge
  // alongside a login again, reloading first means the copy about to be saved
  // includes whatever landed in the meantime.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'index.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/captcha'"), src.indexOf("router.use('/auth'"));
  assert(/req\.session\.reload/.test(route), 'reload is called');
  assert(route.indexOf('reload') < route.indexOf('challengeService.issue('), 'before the write, not after');
});

test('a session that has never been stored still gets a challenge', () => {
  // reload fails for a brand-new session, which is every first-time visitor.
  // There is nothing to clobber in that case, so it must proceed rather than
  // hang or error.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'index.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/captcha'"), src.indexOf("router.use('/auth'"));
  assert(/typeof req\.session\.reload !== 'function'/.test(route), 'the no-reload path exists');
  // The callback form ignores the error argument, which is what makes a failed
  // reload fall through to issuing normally.
  assert(/reload\(\(\) =>/.test(route), 'a failed reload still issues');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
