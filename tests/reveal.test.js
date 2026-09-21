// Tests for the home page's motion.
//
// One property matters more than every animation detail put together: if this
// script does not run, the page must still be readable. The hidden state lives
// behind [data-motion="on"], which only this file sets — so JavaScript off, a
// 404 after a bad deploy, or an error thrown earlier on the page all leave a
// complete page rather than a column of invisible sections.
//
// That is the failure this suite exists to prevent. A marketing page that is
// blank for some readers is far worse than one that never animated.
//
// Runs the real public/js/reveal.js against a stub DOM, and checks the shipped
// stylesheet for the rules it depends on.

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'reveal.js'), 'utf8');

// --- a DOM, only as far as this file reaches --------------------------------

function makeEl(classes) {
  const el = {
    className: classes || '',
    textContent: '',
    dataset: {},
    classList: {
      add(c) { el.className = `${el.className} ${c}`.trim(); },
      contains(c) { return el.className.split(/\s+/).includes(c); },
    },
  };
  return el;
}

function runPage({ reducedMotion = false, hasObserver = true, targets = [], counters = [] } = {}) {
  const root = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } };
  const observed = [];
  const unobserved = [];
  const observers = [];
  const frames = [];
  let now = 0;

  function FakeObserver(cb, opts) {
    const inst = {
      options: opts,
      observe: (el) => { observed.push(el); inst.targets.push(el); },
      unobserve: (el) => { unobserved.push(el); },
      targets: [],
      // Drive the callback the way a real scroll would.
      trigger: (els) => cb(els.map((el) => ({ target: el, isIntersecting: true })), inst),
      triggerMiss: (els) => cb(els.map((el) => ({ target: el, isIntersecting: false })), inst),
    };
    observers.push(inst);
    return inst;
  }

  const sandbox = {
    document: {
      documentElement: root,
      readyState: 'complete',
      querySelectorAll: (sel) => {
        if (sel === '.reveal') return targets;
        if (sel === '[data-count-to]') return counters;
        return [];
      },
      addEventListener: () => {},
    },
    window: {
      matchMedia: (q) => ({ matches: reducedMotion && q.includes('reduce') }),
    },
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
  };
  if (hasObserver) sandbox.window.IntersectionObserver = FakeObserver;

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, 'IntersectionObserver', SOURCE)(
    ...keys.map((k) => sandbox[k]), FakeObserver
  );

  return {
    root,
    observers,
    observed,
    unobserved,
    get motion() { return root.attributes['data-motion']; },
    // Run the counter's animation frames forward to a point in time.
    advanceTo(ms) {
      now = ms;
      const queued = frames.splice(0, frames.length);
      queued.forEach((fn) => fn(ms));
    },
    get pendingFrames() { return frames.length; },
  };
}

// --- the tests --------------------------------------------------------------

// The one that matters.
test('nothing is hidden until the script itself says so', () => {
  // The stylesheet's resting state must be visible, with the hidden state
  // behind an attribute only this file sets. Anyone "tidying" the CSS to hide
  // .reveal directly would blank the page for every reader without JS.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tailwind.css'), 'utf8');
  assert(css.includes('.reveal{opacity:1}'), 'the default state of .reveal is visible');
  assert(css.includes('[data-motion=on] .reveal{opacity:0'), 'and it only hides under the attribute');

  // Every rule that hides .reveal must be guarded by the attribute. Checked by
  // looking at what precedes each one rather than by substring, because
  // "[data-motion=on] .reveal{opacity:0" contains the unguarded form.
  const hides = [];
  const re = /([^{}]*)\.reveal\{opacity:0/g;
  let m;
  while ((m = re.exec(css)) !== null) hides.push(m[1]);
  assert(hides.length > 0, 'the hidden state exists at all');
  hides.forEach((prefix) => {
    assert(/\[data-motion=on\]\s*$/.test(prefix),
      `every hiding rule is guarded, but found one preceded by "${prefix.slice(-40)}"`);
  });
});

test('a reader who prefers less motion gets the page untouched', () => {
  const page = runPage({ reducedMotion: true, targets: [makeEl('reveal')] });
  assertEqual(page.motion, undefined, 'the attribute is never set');
  assertEqual(page.observed.length, 0, 'and nothing is even observed');
});

test('a browser without IntersectionObserver gets the page untouched', () => {
  const page = runPage({ hasObserver: false, targets: [makeEl('reveal')] });
  assertEqual(page.motion, undefined, 'nothing is hidden it cannot then reveal');
});

test('otherwise it marks the document and observes every section', () => {
  const a = makeEl('reveal');
  const b = makeEl('reveal');
  const page = runPage({ targets: [a, b] });
  assertEqual(page.motion, 'on', 'the document is marked');
  assertEqual(page.observed.length, 2, 'both sections observed');
});

test('a section reveals when it comes into view', () => {
  const el = makeEl('reveal');
  const page = runPage({ targets: [el] });
  page.observers[0].trigger([el]);
  assert(el.classList.contains('is-visible'), 'it is shown');
});

test('a section still out of view is left alone', () => {
  const el = makeEl('reveal');
  const page = runPage({ targets: [el] });
  page.observers[0].triggerMiss([el]);
  assert(!el.classList.contains('is-visible'), 'not revealed early');
});

test('a revealed section is not watched again', () => {
  // Re-animating on the way back up is what makes a long page feel restless.
  const el = makeEl('reveal');
  const page = runPage({ targets: [el] });
  page.observers[0].trigger([el]);
  assertEqual(page.unobserved.length, 1, 'it stops being observed');
});

test('it fires slightly before the fold, so movement finishes as the eye arrives', () => {
  const page = runPage({ targets: [makeEl('reveal')] });
  const opts = page.observers[0].options;
  assert(/-\d+%/.test(opts.rootMargin), `a negative bottom margin, got ${opts.rootMargin}`);
});

// --- the counters -----------------------------------------------------------

test('a number is already correct in the markup before anything counts', () => {
  // The figure is server-rendered. Counting only ever replaces text that was
  // already right, so a reader who never triggers it still sees the truth.
  const html = fs.readFileSync(path.join(ROOT, 'views', 'index.ejs'), 'utf8');
  assert(/data-count-to="<%= stats\.memberCount %>"><%= stats\.memberCount %>/.test(html),
    'the target and the printed value are the same server-side figure');
});

test('a number counts up and lands exactly on its target', () => {
  const el = makeEl('counter');
  el.dataset.countTo = '128';
  const page = runPage({ counters: [el] });
  page.observers[0].trigger([el]);

  assertEqual(el.textContent, '0', 'it starts from zero');
  page.advanceTo(550);
  const mid = Number(el.textContent);
  assert(mid > 0 && mid < 128, `partway there, got ${mid}`);

  page.advanceTo(5000);
  assertEqual(el.textContent, '128', 'and lands on the exact figure, not near it');
});

test('counting stops rather than running forever', () => {
  const el = makeEl('counter');
  el.dataset.countTo = '40';
  const page = runPage({ counters: [el] });
  page.observers[0].trigger([el]);
  page.advanceTo(5000);
  assertEqual(page.pendingFrames, 0, 'no frame is left queued');
});

test('a figure too small to be worth counting is left as it is', () => {
  // Counting "0" or "1" up looks broken rather than impressive.
  [0, 1].forEach((value) => {
    const el = makeEl('counter');
    el.dataset.countTo = String(value);
    el.textContent = String(value);
    const page = runPage({ counters: [el] });
    page.observers[0].trigger([el]);
    assertEqual(el.textContent, String(value), `left alone at ${value}`);
  });
});

test('a non-numeric target is ignored rather than printing NaN', () => {
  const el = makeEl('counter');
  el.dataset.countTo = 'soon';
  el.textContent = 'soon';
  const page = runPage({ counters: [el] });
  page.observers[0].trigger([el]);
  assertEqual(el.textContent, 'soon', 'untouched');
});

// --- wiring -----------------------------------------------------------------

test('the script is loaded by the home page and nowhere else', () => {
  // Every other page is a working tool. A dashboard whose panels fade in is a
  // dashboard that is slower to read.
  const home = fs.readFileSync(path.join(ROOT, 'views', 'index.ejs'), 'utf8');
  assert(/\/js\/reveal\.js/.test(home), 'the home page loads it');

  const layout = fs.readFileSync(path.join(ROOT, 'views', 'layout.ejs'), 'utf8');
  assert(!/reveal\.js/.test(layout), 'the shared layout does not');
});

test('nothing depends on an inline style attribute', () => {
  // style-src carries a nonce and no 'unsafe-inline', and a nonce does not
  // cover style ATTRIBUTES — so a stagger written as style="--i:3" would be
  // dropped silently. The stagger is nth-child in the stylesheet instead.
  assert(!/\.style\s*=|setProperty\(/.test(SOURCE), 'the script sets no inline styles');

  // EJS comments are stripped first. They never reach the browser, so a
  // comment EXPLAINING why there are no style attributes is not a style
  // attribute — and the check is about the markup, not about the prose
  // describing it.
  const home = fs.readFileSync(path.join(ROOT, 'views', 'index.ejs'), 'utf8')
    .replace(/<%#[\s\S]*?%>/g, '');
  assert(!/\sstyle="/.test(home), 'and the markup carries none either');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
