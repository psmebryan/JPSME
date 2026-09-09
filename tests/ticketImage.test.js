// Tests for public/js/ticket.js — the saved ticket image.
//
// Runs the real file in a stub DOM with a stub canvas that records every call,
// so the layout is checked rather than assumed. The failure this guards against
// is not a crash: it is a card sized for two lines of title being handed three,
// which silently draws the registration number off the bottom edge. Nobody
// notices until a member opens the file at a door.
//
// The stub measures text as a fixed width per character. Real font metrics
// differ, but wrapping and the arithmetic that turns line counts into a canvas
// height do not depend on them being exact — only on longer text producing more
// lines, which it does.

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
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const CHAR_WIDTH = 9;

function makeContext(record) {
  return {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', letterSpacing: '',
    measureText: (t) => ({ width: String(t).length * CHAR_WIDTH }),
    scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    stroke() {}, fill() {},
    fillRect(x, y, w, h) { record.rects.push({ x, y, w, h }); },
    fillText(text, x, y) { record.texts.push({ text, x, y }); },
    drawImage(img, x, y, w, h) { record.images.push({ x, y, w, h }); },
  };
}

// Runs ticket.js against the given ticket data and returns what it drew.
function render(data, { withButton = true, withQr = true } = {}) {
  const record = { rects: [], texts: [], images: [], downloads: [], canvases: [] };

  const cardEl = { id: 'ticket-card-data', dataset: { ...data } };
  const listeners = {};
  const buttonEl = {
    id: 'save-ticket-image',
    textContent: 'Save ticket image',
    addEventListener: (type, fn) => { listeners[type] = fn; },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => '/api/events/1/ticket/qr.png',
  };
  const qrEl = { getAttribute: () => 'data:image/png;base64,iVBORw0KGgo=' };

  const elements = {
    'ticket-card-data': cardEl,
    'save-ticket-image': withButton ? buttonEl : null,
    'ticket-qr': withQr ? qrEl : null,
  };

  const doc = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => {
      if (tag === 'canvas') {
        const canvas = {
          width: 0, height: 0,
          getContext: () => makeContext(record),
          toBlob: (cb) => cb({ size: 1 }),
        };
        record.canvases.push(canvas);
        return canvas;
      }
      return { href: '', download: '', click() { record.downloads.push(this.download); }, remove() {}, style: {} };
    },
    body: { appendChild() {} },
  };

  let loadedImage = null;
  function FakeImage() {
    loadedImage = this;
    this.onload = null;
    this.onerror = null;
    Object.defineProperty(this, 'src', { set() { /* triggered manually below */ } });
  }

  const sandbox = {
    document: doc,
    Image: FakeImage,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    setTimeout: () => {},
    window: { location: { href: '' } },
  };

  const src = fs.readFileSync(path.join(process.cwd(), 'public', 'js', 'ticket.js'), 'utf8');
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => sandbox[k]));

  if (!listeners.click) return { record, ran: false };
  listeners.click({ preventDefault() {} });
  if (loadedImage && loadedImage.onload) loadedImage.onload();
  return { record, ran: true };
}

const BASE = {
  title: 'General Assembly',
  when: 'Fri, 12 September 2026',
  venue: 'Bulacan State University',
  reference: 'REG-2026-000123',
  name: 'BRYAN MICHAEL LAGUTAN',
  organization: 'JPSME National › Luzon › Bulacan › Garcia College of Technology',
  badge: 'Confirmed',
};

const textsOf = (r) => r.texts.map((t) => t.text);

test('the saved image carries everything the card shows, not just the code', () => {
  const { record } = render(BASE);
  const drawn = textsOf(record).join(' | ');
  ['General Assembly', 'Fri, 12 September 2026', 'Bulacan State University',
    'REG-2026-000123', 'BRYAN MICHAEL LAGUTAN', 'Confirmed'].forEach((needle) => {
    assert(drawn.includes(needle), `"${needle}" is in the image`);
  });
  assert(drawn.includes('PSME EVENT'), 'the eyebrow is there');
  assert(drawn.includes('REGISTRATION NUMBER'), 'the number is labelled');
});

test('the QR itself is drawn, square and centred', () => {
  const { record } = render(BASE);
  assertEqual(record.images.length, 1, 'exactly one image');
  const qr = record.images[0];
  assertEqual(qr.w, qr.h, 'square');
  assertEqual(qr.x + qr.w / 2, 360, 'centred on a 720-wide card');
});

test('a long title grows the card instead of overflowing it', () => {
  // The failure mode worth catching: a fixed height would draw the extra title
  // lines over the QR, or push the registration number off the bottom.
  const shortCard = render(BASE).record.canvases[1];
  const longCard = render({
    ...BASE,
    title: 'Regional Convention and General Assembly of Junior Mechanical Engineers 2026',
  }).record.canvases[1];
  assert(longCard.height > shortCard.height, 'taller for a longer title');
});

test('everything drawn stays inside the canvas', () => {
  const { record } = render({
    ...BASE,
    title: 'Regional Convention and General Assembly of Junior Mechanical Engineers 2026',
    organization: 'JPSME National › Luzon › Bulacan › A Very Long Student Unit Name Indeed',
  });
  const canvas = record.canvases[1];
  const height = canvas.height / 2; // drawn at 2x
  record.texts.forEach((t) => {
    assert(t.y > 0 && t.y < height, `"${t.text}" at y=${t.y} is within 0..${height}`);
  });
  record.images.forEach((i) => {
    assert(i.y + i.h <= height, 'the QR fits');
  });
});

test('a member with no organization gets a shorter card, not a gap', () => {
  const withOrg = render(BASE).record.canvases[1];
  const withoutOrg = render({ ...BASE, organization: '' }).record.canvases[1];
  assert(withoutOrg.height < withOrg.height, 'no wasted space');
});

test('the file is named after the registration', () => {
  // "download.png" in a folder of downloads helps nobody find their ticket.
  const { record } = render(BASE);
  assertEqual(record.downloads[0], 'REG-2026-000123.png', 'named by reference');
});

test('a checked-in ticket says so', () => {
  const { record } = render({ ...BASE, badge: 'Checked in' });
  assert(textsOf(record).includes('Checked in'), 'badge reflects the state');
});

test('the image is drawn at 2x for a phone screen', () => {
  const { record } = render(BASE);
  assertEqual(record.canvases[1].width, 1440, '720 logical pixels at 2x');
});

test('it does nothing at all if the page is not the ticket page', () => {
  // ticket.js is a plain script; it must not throw when its elements are absent.
  const { ran } = render(BASE, { withButton: false });
  assertEqual(ran, false, 'no listener bound, no error');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
