// Tests for what the challenge box says when it cannot show a challenge.
//
// The bug: the registration page's captcha stopped loading and sat on
// "Loading…" for ever. The form could not be submitted and nothing on the page
// said why.
//
// Two faults met. The whole API shares one abuse budget per address — and one
// address is not one person, since a campus arrives as a single IP — so a busy
// signup session ran it out and /api/captcha started answering 429. And the
// loader only ever caught a *network* failure: an HTTP error is not one, so a
// 429 fell straight through the "no svg, give up quietly" branch and left the
// placeholder text in place.
//
// Runs the real public/js/captcha.js against a stub DOM, so what is checked is
// the file that ships.

const fs = require('fs');
const path = require('path');

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

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'captcha.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// `response` is what /api/captcha answers with, or an Error to fail the fetch.
function runPage({ response, hasSlot = true } = {}) {
  const image = {
    textContent: '',
    innerHTML: '',
    classList: { add() {}, remove() {} },
  };
  const answer = { value: '', name: 'challengeAnswer' };
  const refreshListeners = [];
  const refresh = { addEventListener: (type, fn) => refreshListeners.push(fn) };

  const slot = {
    querySelector: (sel) => {
      if (sel === '[data-challenge-image]') return image;
      if (sel === '[name="challengeAnswer"]') return answer;
      if (sel === '[data-challenge-refresh]') return refresh;
      return null;
    },
  };

  const ready = [];
  const sandbox = {
    document: {
      querySelectorAll: (sel) => (sel === '[data-challenge]' && hasSlot ? [slot] : []),
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready.push(fn); },
    },
    fetch: async () => {
      if (response instanceof Error) throw response;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => {
          if (response.malformed) throw new Error('not json');
          return response.body;
        },
      };
    },
    setTimeout: (fn) => { fn(); return 1; },
  };

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, SOURCE)(...keys.map((k) => sandbox[k]));
  ready.forEach((fn) => fn());

  return { image, answer, refresh: () => refreshListeners.forEach((fn) => fn()) };
}

const OK = { status: 200, body: { success: true, data: { svg: '<svg id="challenge"></svg>' } } };

async function main() {
  await test('an ordinary load puts the image on the page', async () => {
    const page = runPage({ response: OK });
    await flush();
    assert(page.image.innerHTML.includes('<svg'), `the image, got: ${page.image.innerHTML || page.image.textContent}`);
  });

  await test('a rate-limited load says so, instead of saying nothing', async () => {
    // The exact failure reported: the box sat on "Loading…" and the form could
    // not be sent. A 429 is not a network error, so the catch never ran.
    const page = runPage({
      response: { status: 429, body: { success: false, message: 'Too many requests. Please try again later.' } },
    });
    await flush();

    assert(!/Loading/.test(page.image.textContent), 'not still loading');
    assert(/too many/i.test(page.image.textContent), `names the cause, got: ${page.image.textContent}`);
    assert(/wait a minute/i.test(page.image.textContent), `and what to do, got: ${page.image.textContent}`);
  });

  await test('any other server error names its status', async () => {
    // So a report can say which one, rather than "it did not work".
    const page = runPage({ response: { status: 500, body: { success: false } } });
    await flush();
    assert(/error 500/i.test(page.image.textContent), `got: ${page.image.textContent}`);
  });

  await test('a dead connection is told apart from a refusal', async () => {
    const page = runPage({ response: new Error('network down') });
    await flush();
    assert(/connection/i.test(page.image.textContent), `got: ${page.image.textContent}`);
  });

  await test('a 200 with no image is a misconfiguration, and says that', async () => {
    // The server answers this way when it believes Turnstile is running. If
    // the page has drawn the built-in box anyway, the two halves disagree
    // about which check is in force — which is a deployment with one key set.
    const page = runPage({ response: { status: 200, body: { success: true, data: { svg: null } } } });
    await flush();
    assert(/misconfigured/i.test(page.image.textContent), `got: ${page.image.textContent}`);
    assert(!/Loading/.test(page.image.textContent), 'and does not sit there loading');
  });

  await test('an unreadable body fails like a dead connection, not silently', async () => {
    const page = runPage({ response: { status: 200, malformed: true } });
    await flush();
    assert(page.image.textContent.length > 0, 'says something');
    assert(!/Loading/.test(page.image.textContent), 'and it is not "Loading…"');
  });

  await test('a stale answer is cleared whenever a new image is fetched', async () => {
    // The challenge is single-use, so an answer typed against the old image is
    // one the server is guaranteed to reject.
    const page = runPage({ response: OK });
    await flush();
    page.answer.value = 'OLD12';
    page.refresh();
    assertEqual(page.answer.value, '', 'wiped before the new image arrives');
  });

  await test('a page with no challenge on it does nothing at all', async () => {
    // Every page loads this script; only some draw a box.
    const page = runPage({ response: OK, hasSlot: false });
    await flush();
    assertEqual(page.image.textContent, '', 'nothing touched');
  });

  await test('the refusal is recoverable — refresh tries again', async () => {
    // A dead end would be a form nobody can ever submit. The button that
    // reloads the image is the way out, and it has to work after a failure.
    let first = true;
    const image = { textContent: '', innerHTML: '', classList: { add() {}, remove() {} } };
    const answer = { value: '' };
    const refreshListeners = [];
    const slot = {
      querySelector: (sel) => {
        if (sel === '[data-challenge-image]') return image;
        if (sel === '[name="challengeAnswer"]') return answer;
        if (sel === '[data-challenge-refresh]') return { addEventListener: (t, fn) => refreshListeners.push(fn) };
        return null;
      },
    };
    const ready = [];
    const sandbox = {
      document: {
        querySelectorAll: () => [slot],
        addEventListener: (t, fn) => { if (t === 'DOMContentLoaded') ready.push(fn); },
      },
      fetch: async () => {
        if (first) { first = false; return { ok: false, status: 429, json: async () => ({}) }; }
        return { ok: true, status: 200, json: async () => OK.body };
      },
      setTimeout: (fn) => { fn(); return 1; },
    };
    const keys = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func
    new Function(...keys, SOURCE)(...keys.map((k) => sandbox[k]));
    ready.forEach((fn) => fn());
    await flush();
    assert(/too many/i.test(image.textContent), 'refused first');

    refreshListeners.forEach((fn) => fn());
    await flush();
    assert(image.innerHTML.includes('<svg'), 'and the image arrives on the retry');
  });

  await test('the budget is large enough for a room of people on one address', async () => {
    // A campus arrives as a single IP, and the registration page spends
    // several requests a visit. The old 300 was twenty a minute for everyone
    // behind that address put together.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api', 'index.js'), 'utf8');
    const max = Number((source.match(/max:\s*(\d+)/) || [])[1]);
    assert(max >= 900, `the shared baseline, got ${max}`);
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
