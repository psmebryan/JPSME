// Tests for making a scanner gun work at a door.
//
// This behaviour was written for the venue entrance. That station has been
// removed — for a single-hall event it asked a question the hall door had
// already answered — but the handling had to survive the removal, because it is
// the part that makes a gun work at all, and the hall door is now the station
// that needs it most.
//
// The failure it prevents is specific and awful at a live door: a gun's suffix
// is configurable (Enter, Tab, or nothing), and a page that only listens for
// Enter looks broken on the other two — the code lands in the box and nothing
// happens, which reads as "the scanner is broken" rather than "the scanner is
// configured differently".
//
// Runs the real public/js/scanner-input.js against a stub DOM.

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
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'scanner-input.js'), 'utf8');

const TOKEN = 'a'.repeat(64);

function makeEl() {
  const el = {
    value: '',
    focused: 0,
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    fire(type, event) { (el.listeners[type] || []).forEach((fn) => fn(event || {})); },
    focus() { el.focused += 1; },
    closest: () => null,
  };
  return el;
}

function runPage({ isTypingElsewhere = () => false } = {}) {
  const input = makeEl();
  const scanned = [];
  const timers = [];
  const docListeners = {};

  const sandbox = {
    document: {
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    },
    window: { addEventListener: () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval: () => 1,
  };

  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  const attach = new Function(...keys, `${SOURCE}; return attachScanner;`)(...keys.map((k) => sandbox[k]));
  const api = attach({ input, onScan: (v) => scanned.push(v), isTypingElsewhere });

  return {
    input,
    scanned,
    api,
    // Everything the gun types, then whichever suffix it is set to send.
    type(value) { input.value = value; input.fire('input'); },
    settle() { timers.filter((t) => !t.cancelled && t.ms === 80).forEach((t) => { t.cancelled = true; t.fn(); }); },
    tab() { input.fire('keydown', { key: 'Tab', preventDefault() { this.prevented = true; } }); },
    clickBody(target) {
      const e = { target: target || { closest: () => null } };
      (docListeners.click || []).forEach((fn) => fn(e));
    },
  };
}

// --- the tests --------------------------------------------------------------

test('a gun that sends no suffix at all still submits', () => {
  // The case that looks most like a broken scanner: the code appears in the box
  // and nothing whatsoever happens.
  const page = runPage();
  page.type(TOKEN);
  page.settle();
  assertEqual(page.scanned.length, 1, 'one scan');
  assertEqual(page.scanned[0], TOKEN, 'the code');
});

test('a gun that sends Tab submits, and does not move focus away', () => {
  // Focus leaving the box is fatal here: the next scan is typed into nothing.
  const page = runPage();
  page.type(TOKEN);
  const event = { key: 'Tab', prevented: false, preventDefault() { this.prevented = true; } };
  page.input.fire('keydown', event);
  assertEqual(page.scanned.length, 1, 'it submitted');
  assertEqual(event.prevented, true, 'and Tab was swallowed');
});

test('typing the code and pressing Tab sends it exactly once', () => {
  // The settle timer and the Tab handler both want to fire. Two submits at a
  // door toggle means the person is checked in and straight back out.
  const page = runPage();
  page.type(TOKEN);
  page.tab();
  page.settle();
  assertEqual(page.scanned.length, 1, `exactly one, got ${page.scanned.length}`);
});

test('the prefixed form a gun may send is accepted too', () => {
  const page = runPage();
  page.type(`PSME-EVENT:${TOKEN}`);
  page.settle();
  assertEqual(page.scanned.length, 1, 'recognised as complete');
});

test('a half-typed code is not submitted', () => {
  // A gun types in a burst; every intermediate value fires an input event.
  const page = runPage();
  for (let i = 1; i < 64; i += 1) page.type('a'.repeat(i));
  page.settle();
  assertEqual(page.scanned.length, 0, 'nothing went early');

  page.type(TOKEN);
  page.settle();
  assertEqual(page.scanned.length, 1, 'and then the whole thing, once');
});

test('something that is not one of our codes is left alone', () => {
  // A shipping label, or somebody's bank QR.
  const page = runPage();
  page.type('https://example.com/not-a-ticket');
  page.settle();
  assertEqual(page.scanned.length, 0, 'not submitted');
});

test('focus is taken back when the page is clicked', () => {
  const page = runPage();
  const before = page.input.focused;
  page.clickBody();
  assert(page.input.focused > before, 'focus returned to the scan box');
});

test('focus is NOT stolen from somebody typing in another field', () => {
  // The station name is typed by hand at the start of a shift. Yanking focus
  // mid-word would make it impossible to fill in.
  const page = runPage({ isTypingElsewhere: () => true });
  const before = page.input.focused;
  page.clickBody();
  assertEqual(page.input.focused, before, 'left alone');
});

test('a click on a real control does not yank focus either', () => {
  const page = runPage();
  const before = page.input.focused;
  page.clickBody({ closest: (sel) => (sel.includes('button') ? {} : null) });
  assertEqual(page.input.focused, before, 'the button keeps it');
});

test('the beep never throws, even where audio is blocked', () => {
  // Sound is a nicety. A browser that refuses it must not break a scan.
  const page = runPage();
  page.api.beep(true);
  page.api.beep(false);
  assert(true, 'no exception escaped');
});

test('the room door actually loads and uses it', () => {
  // The station it was written for is gone; this is the one that needs it now.
  const view = fs.readFileSync(path.join(ROOT, 'views', 'admin', 'room-scan.ejs'), 'utf8');
  assert(/scanner-input\.js/.test(view), 'the door page loads it');
  const script = fs.readFileSync(path.join(ROOT, 'public', 'js', 'rooms.js'), 'utf8');
  assert(/attachScanner\(/.test(script), 'and the door script attaches it');
  assert(/scanner\.beep\(/.test(script), 'including the audible verdict');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
