// Tests for the site bar's solid-on-scroll behaviour.
//
// This suite exists because of one bug, and the bug is worth stating in full
// because the code that caused it looks obviously correct:
//
//   nav.classList.toggle('is-scrolled', window.scrollY > 8);
//
// The bar is STICKY, so it is still in the document's flow, so its height is
// part of the document's height. Going solid shortens it by 16px, which takes
// 16px off the page. The browser then keeps the content visually anchored by
// moving scrollY the same 16px — back under the threshold that shrank the bar.
// The class comes off, the 16px returns, scrollY returns, and the class goes
// back on. At frame rate, that is the bar vibrating in place.
//
// It only showed up at some widths because the content height has to land in a
// narrow band for the shrink to move scrollY across the threshold at all, which
// is exactly what made it look random.
//
// The fix is hysteresis: two thresholds, with a gap wider than the height the
// bar gives back. The last test here deliberately re-creates the old
// single-threshold logic and asserts that this harness DOES catch it — without
// that, a passing suite would prove nothing.

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
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'navbar.js'), 'utf8');

// Line endings normalised: the working tree here is CRLF, so a multi-line
// pattern written with \n silently matches nothing.
function readSrc() {
  var parts = Array.prototype.slice.call(arguments);
  return fs.readFileSync(path.join.apply(path, [ROOT].concat(parts)), 'utf8').replace(/\r\n/g, '\n');
}
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tailwind.css'), 'utf8');

// --- the two numbers the fix depends on -------------------------------------

function barHeights() {
  const tall = /\.jp-nav-inner\{[^}]*height:(\d+)px/.exec(CSS);
  const short = /\.jp-nav\.is-scrolled \.jp-nav-inner\{[^}]*height:(\d+)px/.exec(CSS);
  assert(tall && short, 'both bar heights are declared in the stylesheet');
  return { tall: Number(tall[1]), short: Number(short[1]) };
}

function thresholds() {
  const up = /SHRINK_AT\s*=\s*(\d+)/.exec(SOURCE);
  const down = /GROW_BELOW\s*=\s*(\d+)/.exec(SOURCE);
  assert(up && down, 'both thresholds are named constants in navbar.js');
  return { shrinkAt: Number(up[1]), growBelow: Number(down[1]) };
}

// --- a page that behaves the way a real one does -----------------------------

// Runs the real navbar.js against a stub DOM and returns a rig that can be
// scrolled. `decide` lets the last test swap in the old buggy logic instead.
function makePage({ contentHeight, viewport = 800, heights = barHeights(), decide = null }) {
  let scrollY = 0;
  let isScrolled = false;
  const frames = [];
  const scrollListeners = [];

  const nav = {
    classList: {
      add: (c) => { if (c === 'is-scrolled') isScrolled = true; },
      remove: (c) => { if (c === 'is-scrolled') isScrolled = false; },
      contains: (c) => (c === 'is-scrolled' ? isScrolled : false),
      toggle: (c, force) => { if (c === 'is-scrolled') isScrolled = force; },
    },
  };

  const win = {
    innerWidth: 1280,
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    addEventListener: (type, fn) => { if (type === 'scroll') scrollListeners.push(fn); },
  };
  Object.defineProperty(win, 'scrollY', { get: () => scrollY });
  Object.defineProperty(win, 'pageYOffset', { get: () => scrollY });

  const doc = {
    documentElement: { classList: { toggle: () => {} } },
    getElementById: (id) => (id === 'siteNav' ? nav : null),
    addEventListener: () => {},
  };

  if (decide) {
    // The control case: drive the stub directly with alternative logic.
    scrollListeners.push(() => win.requestAnimationFrame(() => decide(nav, scrollY)));
  } else {
    const sandbox = { document: doc, window: win };
    const keys = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func
    new Function(...keys, SOURCE)(...keys.map((k) => sandbox[k]));
  }

  function navHeight() { return isScrolled ? heights.short : heights.tall; }
  function maxScroll() { return Math.max(0, contentHeight + navHeight() - viewport); }

  return {
    get isScrolled() { return isScrolled; },
    get scrollY() { return scrollY; },

    // One frame of the browser's loop:
    //   1. the scroll event fires and the handler queues its rAF
    //   2. the rAF runs and may change the class, changing the bar's height
    //   3. the page above the fold gets shorter or taller, and the browser
    //      keeps the content anchored by moving scrollY the same amount
    //   4. scrollY is clamped to what the document now allows
    // Step 3 is the one that closes the loop, and it is not optional — it is
    // what a browser does.
    frame(userDelta = 0) {
      scrollY = Math.max(0, Math.min(scrollY + userDelta, maxScroll()));
      const before = navHeight();
      scrollListeners.forEach((fn) => fn());
      frames.splice(0, frames.length).forEach((fn) => fn());
      const after = navHeight();
      scrollY = Math.max(0, scrollY + (after - before));
      scrollY = Math.max(0, Math.min(scrollY, maxScroll()));
      return isScrolled;
    },
  };
}

// True when the bar never settles: the tail of the run keeps flipping.
function oscillates(page, frames = 40, userDelta = 0) {
  const seen = [];
  for (let i = 0; i < frames; i += 1) seen.push(page.frame(userDelta));
  const tail = seen.slice(-8);
  return tail.some((v) => v !== tail[0]);
}

// --- the tests ---------------------------------------------------------------

test('the hysteresis gap is wider than the height the bar gives back', () => {
  // The whole fix is this inequality. If somebody later changes the bar's
  // heights, or narrows the gap, the loop comes straight back — so it is
  // asserted against the real stylesheet rather than trusted to a comment.
  const { tall, short } = barHeights();
  const { shrinkAt, growBelow } = thresholds();
  const given = tall - short;
  const gap = shrinkAt - growBelow;
  assert(gap > given,
    `the gap between the thresholds (${shrinkAt} - ${growBelow} = ${gap}px) must exceed ` +
    `the height the bar gives back when it goes solid (${tall} - ${short} = ${given}px)`);
});

test('the bar does not vibrate on a page barely taller than the viewport', () => {
  // Sweeps the band where the bug lived: every content height for which the
  // shrink is enough to move scrollY across a threshold. One of these is the
  // width the bug was reported at.
  const bad = [];
  for (let content = 700; content <= 900; content += 1) {
    const page = makePage({ contentHeight: content });
    page.frame(60); // scroll down into it
    if (oscillates(page)) bad.push(content);
  }
  assertEqual(bad.length, 0, `settles at every content height, but flipped forever at: ${bad.slice(0, 8).join(', ')}`);
});

test('it does not vibrate while the reader is still scrolling', () => {
  // The visible version of the bug: momentum keeps pushing scrollY up while
  // the shrink keeps pulling it back down.
  const bad = [];
  for (let content = 700; content <= 900; content += 5) {
    const page = makePage({ contentHeight: content });
    if (oscillates(page, 40, 6)) bad.push(content);
  }
  assertEqual(bad.length, 0, `settles under a continuing scroll, but flipped at: ${bad.slice(0, 8).join(', ')}`);
});

test('it still goes solid once the page is genuinely scrolled', () => {
  // The fix must not be "never shrink", which would also pass the tests above.
  const page = makePage({ contentHeight: 4000 });
  page.frame(400);
  assert(page.isScrolled, 'the bar goes solid on a long page');
});

test('and returns to full height back at the top', () => {
  const page = makePage({ contentHeight: 4000 });
  page.frame(400);
  assert(page.isScrolled, 'solid on the way down');
  page.frame(-400);
  assert(!page.isScrolled, 'tall again at the top');
});

test('a short page that cannot scroll never shrinks the bar', () => {
  const page = makePage({ contentHeight: 200 });
  for (let i = 0; i < 10; i += 1) page.frame(50);
  assert(!page.isScrolled, 'nothing to scroll, nothing to react to');
});

test('the harness really does catch the bug it was written for', () => {
  // Without this, every test above could be passing vacuously. Re-creates the
  // original single-threshold logic and asserts the rig detects it flipping
  // forever — so a future "simplification" back to one threshold fails loudly
  // rather than silently.
  const single = (nav, y) => nav.classList.toggle('is-scrolled', y > 8);
  const caught = [];
  for (let content = 700; content <= 900; content += 1) {
    const page = makePage({ contentHeight: content, decide: single });
    page.frame(60);
    if (oscillates(page)) caught.push(content);
  }
  assert(caught.length > 0, 'the old single-threshold logic oscillates, and this harness sees it');
});

// --- the dropdown menus ------------------------------------------------------
//
// These guard a bug that is invisible in the code and obvious in the hand: the
// panel sits 12px below its button, and without a bridge across that gap the
// pointer moving from "My Profile"'s button to "My Profile" passes through
// 12px belonging to neither element. That fires mouseleave on the wrapper and
// the menu shuts before it can be clicked.

function navCss() {
  return fs.readFileSync(path.join(ROOT, 'public', 'css', 'tailwind.css'), 'utf8');
}

test('the gap under a dropdown is bridged, and the two match', () => {
  const css = navCss();
  const menu = /\.jp-nav-menu\{[^}]*\}/.exec(css);
  const bridge = /\.jp-nav-menu:before\{[^}]*\}/.exec(css);
  assert(menu, 'the menu rule ships');
  assert(bridge, 'and so does the ::before bridge — without it the gap is a dead zone');

  const gap = /margin-top:([0-9.]+)px/.exec(menu[0]);
  const height = /height:([0-9.]+)px/.exec(bridge[0]);
  assert(gap, 'the menu declares its own gap');
  assert(height, 'the bridge declares a height');
  assertEqual(height[1], gap[1],
    `the bridge must cover the whole gap, but the gap is ${gap[1]}px and the bridge ${height[1]}px`);
  assert(/bottom:100%/.test(bridge[0]), 'and sit directly above the panel');
});

test('the dropdown does not clip its own bridge', () => {
  // overflow-hidden would cut the bridge off and restore the dead zone exactly.
  // It was never needed: the links are rounded-lg inside 6px of padding, so
  // they never reach the container's corners.
  const menu = /\.jp-nav-menu\{[^}]*\}/.exec(navCss())[0];
  assert(!/overflow:hidden/.test(menu),
    'overflow-hidden on .jp-nav-menu clips the ::before bridge away');
});

test('the gap is declared once, not also as a utility in the markup', () => {
  // Two sources for one measurement is how the bridge and the gap drift apart.
  const nav = fs.readFileSync(path.join(ROOT, 'views', 'partials', 'navbar.ejs'), 'utf8');
  const menus = nav.match(/class="jp-nav-menu[^"]*"/g) || [];
  assert(menus.length >= 2, `found the menus, got ${menus.length}`);
  menus.forEach((cls) => {
    assert(!/\bmt-\d/.test(cls), `no margin utility on the menu itself: ${cls}`);
  });
});

test('closing is delayed but opening and clicking are not', () => {
  // A pointer moving diagonally to a lower item can clip the wrapper's corner
  // for a few milliseconds. Closing instantly on that makes the menu feel like
  // it is dodging the cursor.
  const src = readSrc('public', 'js', 'navbar.js');
  const delay = /CLOSE_DELAY\s*=\s*(\d+)/.exec(src);
  assert(delay, 'there is a named close delay');
  const ms = Number(delay[1]);
  assert(ms >= 120 && ms <= 500, `the delay is forgiving but not sticky, got ${ms}ms`);

  assert(/function openNow\(\)[\s\S]{0,140}clearTimeout/.test(src),
    'opening cancels any pending close');
  assert(/mouseleave['"]?\s*,\s*closeSoon/.test(src), 'leaving closes on a delay');
  assert(/mouseenter['"]?\s*,\s*openNow/.test(src), 'entering opens at once');
});

test('a deliberate click is never swallowed by a pending close', () => {
  const src = readSrc('public', 'js', 'navbar.js');
  const click = /btn\.addEventListener\('click'[\s\S]*?\}\);/.exec(src);
  assert(click, 'the button has a click handler');
  assert(/openNow\(\)/.test(click[0]) && /closeNow\(\)/.test(click[0]),
    'it uses the immediate forms, so a click acts now rather than after the grace period');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
