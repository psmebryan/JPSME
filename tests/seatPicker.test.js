// Tests for the page where an attendee picks their own seat.
//
// The API for this existed and was tested long before any page called it, so
// assigned seating worked only if a staff member did the assigning. What is
// covered here is the half that was missing: the page, and the script that
// drives it.
//
// Two properties matter more than the rest.
//
// It must not leak who is sitting where. The attendee map deliberately carries
// no names, and the renderer must not invent a way to show one — every state
// that is not "free" and not "yours" has to look identical.
//
// And it must not repaint under somebody's finger. The plan is being changed by
// other people while it is on screen, so the refresh timer has to hold off
// while a hold is running, or the wrong seat gets confirmed.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

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

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'seat-picker.js'), 'utf8');
const VIEW = path.join(ROOT, 'views', 'event-seat.ejs');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- the page ---------------------------------------------------------------

function renderView(locals) {
  return ejs.render(fs.readFileSync(VIEW, 'utf8'), Object.assign({
    event: { id: 7, title: 'Regional Convention', seatingEnabled: true },
    blocked: null,
    mySeat: null,
    holdMs: 300000,
  }, locals), { filename: VIEW });
}

// --- the script, against a stub DOM -----------------------------------------

function makeEl(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    listeners: {},
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    fire(type, event) { (el.listeners[type] || []).forEach((fn) => fn(event)); },
    querySelector: () => null,
  };
  const parts = () => String(el.className || '').split(/\s+/).filter(Boolean);
  el.classList = {
    add(c) { const s = new Set(parts()); s.add(c); el.className = [...s].join(' '); },
    remove(c) { const s = new Set(parts()); s.delete(c); el.className = [...s].join(' '); },
    contains(c) { return parts().includes(c); },
  };
  return el;
}

const SECTION = (seats) => ([{
  id: 1,
  name: 'Main Floor',
  room: { id: 2, name: 'Main Hall' },
  rows: [{ label: 'A', seats }],
  counts: { total: seats.length, available: seats.filter((s) => s.state === 'AVAILABLE').length },
}]);

function runPage(plan = {}) {
  const {
    sections = SECTION([
      { id: 11, label: 'A01', state: 'AVAILABLE', mine: false, occupant: null },
      { id: 12, label: 'A02', state: 'ASSIGNED', mine: true, occupant: null },
      { id: 13, label: 'A03', state: 'ASSIGNED', mine: false, occupant: null },
      { id: 14, label: 'A04', state: 'BLOCKED', mine: false, occupant: null },
      { id: 15, label: 'A05', state: 'OCCUPIED', mine: false, occupant: null },
      { id: 16, label: 'A06', state: 'HELD', mine: false, occupant: null },
    ]),
    mySeat = { label: 'A02', section: 'Main Floor', room: 'Main Hall' },
    responses = {},      // path fragment -> payload or Error
  } = plan;

  const parts = {};
  ['map', 'message', 'hold-panel', 'hold-label', 'hold-countdown', 'confirm',
    'give-up', 'has-seat', 'no-seat', 'seat-label', 'seat-where'].forEach((key) => {
    parts[key] = makeEl('div');
  });

  const root = makeEl('div');
  root.dataset = { eventId: '7', holdMs: '300000' };
  root.querySelector = (sel) => {
    const key = (sel.match(/^\[data-(.+)\]$/) || [])[1];
    return parts[key] || null;
  };

  const calls = [];
  const intervals = [];
  let nowMs = 1000000;

  const sandbox = {
    document: {
      hidden: false,
      querySelector: (sel) => (sel === '[data-seat-picker]' ? root : null),
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') sandbox.__ready.push(fn); },
    },
    window: { addEventListener: () => {} },
    apiFetch: async (url, options) => {
      calls.push({ url, method: (options && options.method) || 'GET' });
      const key = Object.keys(responses).find((k) => url.includes(k));
      const answer = key ? responses[key] : null;
      if (answer instanceof Error) throw answer;
      if (answer) return answer;
      if (url.includes('my-map')) return { data: { sections, mySeat, holdMs: 300000 } };
      return { data: { ok: true } };
    },
    withPending: async (target, text, run) => run(),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    // A real Date, with only `now` frozen: the script also does
    // `new Date(heldUntil).getTime()`, which a plain { now } object cannot do.
    Date: class extends Date { static now() { return nowMs; } },
    __ready: [],
  };

  const keys = Object.keys(sandbox).filter((k) => k !== '__ready');
  // eslint-disable-next-line no-new-func
  new Function(...keys, '__ready', SOURCE)(...keys.map((k) => sandbox[k]), sandbox.__ready);
  sandbox.__ready.forEach((fn) => fn());

  return {
    parts,
    calls,
    get html() { return parts.map.innerHTML; },
    advance: (ms) => { nowMs += ms; },
    // The refresh timer is the long one; the countdown ticks every second.
    refresh: () => { const t = intervals.find((i) => i.ms > 5000); if (t) t.fn(); },
    tick: () => { const t = intervals.find((i) => i.ms === 1000); if (t) t.fn(); },
    clickSeat: (seatId) => {
      const button = makeEl('button');
      button.dataset = { seatId: String(seatId) };
      parts.map.fire('click', { target: { closest: (sel) => (sel === '[data-seat-id]' ? button : null) } });
    },
    click: (key) => parts[key].fire('click', { target: parts[key] }),
    hide: () => { sandbox.document.hidden = true; },
  };
}

async function open(plan) {
  const page = runPage(plan);
  for (let i = 0; i < 6; i += 1) await flush();
  return page;
}

// --- the tests --------------------------------------------------------------

async function main() {
  // --- the page itself ------------------------------------------------------

  await test('somebody who is not registered is told to register, not shown a plan', async () => {
    const html = renderView({ blocked: { reason: 'NOT_REGISTERED', message: 'You are not registered for this event yet.' } });
    assert(/not registered/i.test(html), 'says why');
    assert(/\/events\/7"/.test(html), 'and links to the event so they can');
    assert(!/data-map/.test(html), 'no empty seat plan is drawn');
  });

  await test('an unpaid registration is sent to pay rather than refused flatly', async () => {
    const html = renderView({ blocked: { reason: 'UNPAID', message: 'Your payment is still pending. Once it clears you can choose a seat.' } });
    assert(/payment/i.test(html), 'names the reason');
    assert(/\/profile/.test(html), 'and points somewhere useful');
  });

  await test('an event without assigned seating says so plainly', async () => {
    const html = renderView({ blocked: { reason: 'SEATING_OFF', message: 'This event does not use assigned seating — any seat is fine.' } });
    assert(/any seat is fine/i.test(html), `got: ${html.slice(0, 200)}`);
  });

  await test('an existing seat is on the page before any fetch returns', async () => {
    // The page has to say something true the moment it opens.
    const html = renderView({ mySeat: { label: 'C14', section: 'Balcony', room: 'Main Hall' } });
    assert(/C14/.test(html), 'the seat itself');
    assert(/Balcony/.test(html), 'and where it is');
  });

  await test('with no seat yet, it invites them to pick one', async () => {
    const html = renderView({ mySeat: null });
    assert(/have not chosen one yet/i.test(html), `got: ${html.slice(0, 400)}`);
  });

  await test('the page carries the hold length the server actually uses', async () => {
    // Hardcoding five minutes in the page would drift the moment HOLD_MS moved.
    const html = renderView({ holdMs: 300000 });
    assert(/data-hold-ms="300000"/.test(html), 'passed through from the service');
  });

  // --- drawing --------------------------------------------------------------

  await test('a free seat is a button, and everything else is not', async () => {
    // A span cannot be tabbed to or activated, so the plan cannot offer a seat
    // it will only refuse.
    const page = await open();
    const buttons = page.html.match(/<button[^>]*data-seat-id="(\d+)"/g) || [];
    assertEqual(buttons.length, 1, `only the free seat, got ${buttons.length}`);
    assert(/data-seat-id="11"/.test(page.html), 'and it is A01');
  });

  await test('their own seat is marked as theirs', async () => {
    const page = await open();
    assert(/seat-mine[^>]*>A02|A02/.test(page.html), 'A02 is drawn');
    const mine = page.html.match(/class="seat seat-mine"[^>]*>([^<]+)</);
    assertEqual(mine && mine[1], 'A02', 'and it carries the "mine" style');
  });

  await test('held, assigned and occupied seats are indistinguishable', async () => {
    // Which of the three a seat is would say something about the person in it.
    const page = await open();
    ['A03', 'A05', 'A06'].forEach((label) => {
      const re = new RegExp(`class="seat seat-taken"[^>]*>${label}<`);
      assert(re.test(page.html), `${label} reads as simply taken`);
    });
  });

  await test('no attendee name reaches the page, even if the payload carried one', async () => {
    // Belt and braces: the API strips names for this map, and the renderer has
    // no code path that would print one if that ever changed.
    const page = await open({
      sections: SECTION([{ id: 21, label: 'A01', state: 'ASSIGNED', mine: false, occupant: { id: 3, name: 'MARIA AQUINO' } }]),
    });
    assert(!/MARIA/i.test(page.html), 'the name is nowhere on the page');
  });

  await test('a seat label is escaped, not injected', async () => {
    const page = await open({
      sections: SECTION([{ id: 31, label: '<img src=x onerror=1>', state: 'AVAILABLE', mine: false, occupant: null }]),
    });
    assert(!/<img/.test(page.html), 'no tag was created');
    assert(/&lt;img/.test(page.html), 'it is shown as text');
  });

  await test('an empty plan says so instead of showing a blank frame', async () => {
    const page = await open({ sections: [] });
    assert(/no seat plan/i.test(page.html), `got: ${page.html}`);
  });

  await test('a plan that will not load explains itself', async () => {
    const page = await open({ responses: { 'my-map': new Error('Server unavailable') } });
    assert(/Server unavailable/.test(page.html), `got: ${page.html}`);
  });

  // --- choosing -------------------------------------------------------------

  await test('tapping a free seat holds it and starts the clock', async () => {
    const page = await open({
      responses: { '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1000000 + 300000).toISOString() } } },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();

    assert(page.calls.some((c) => c.url.includes('/seats/11/hold') && c.method === 'POST'), 'the hold was requested');
    assert(!page.parts['hold-panel'].classList.contains('hidden'), 'the hold panel is showing');
    assertEqual(page.parts['hold-label'].textContent, 'A01', 'and names the seat');
    assertEqual(page.parts['hold-countdown'].textContent, '5:00', 'with the time left');
  });

  await test('a seat taken a moment ago is a message, not an error', async () => {
    // This happens constantly the instant a map opens, and must read as normal.
    const page = await open({
      responses: { '/hold': { data: { ok: false, reason: 'HELD_BY_SOMEONE_ELSE', message: 'Somebody just took that seat. Please pick another.' } } },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();

    assert(/Somebody just took/.test(page.parts.message.textContent), `got: ${page.parts.message.textContent}`);
    assert(page.parts['hold-panel'].classList.contains('hidden'), 'and no hold is claimed');
  });

  await test('confirming reports the seat as theirs', async () => {
    const page = await open({
      responses: {
        '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1300000).toISOString() } },
        '/confirm': { data: { ok: true, seatId: 11, label: 'A01' } },
      },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();
    page.click('confirm');
    for (let i = 0; i < 6; i += 1) await flush();

    assert(page.calls.some((c) => c.url.includes('/seats/11/confirm')), 'the confirm was sent');
    assert(/A01 is yours/.test(page.parts.message.textContent), `got: ${page.parts.message.textContent}`);
    assert(page.parts['hold-panel'].classList.contains('hidden'), 'the hold panel is put away');
  });

  await test('a hold that lapsed before confirm is explained, not retried silently', async () => {
    const page = await open({
      responses: {
        '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1300000).toISOString() } },
        '/confirm': { data: { ok: false, reason: 'HOLD_EXPIRED', message: 'Your hold on that seat expired. Please pick it again.' } },
      },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();
    page.click('confirm');
    for (let i = 0; i < 6; i += 1) await flush();

    assert(/expired/i.test(page.parts.message.textContent), `got: ${page.parts.message.textContent}`);
    assert(page.parts['hold-panel'].classList.contains('hidden'), 'the stale hold is dropped');
  });

  await test('giving up releases the seat', async () => {
    const page = await open({
      responses: { '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1300000).toISOString() } } },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();
    page.click('give-up');
    for (let i = 0; i < 6; i += 1) await flush();

    assert(page.calls.some((c) => c.url.includes('/seats/11/give-up')), 'the release was sent');
    assert(page.parts['hold-panel'].classList.contains('hidden'), 'and the panel closed');
  });

  await test('the countdown runs out on screen rather than promising a dead seat', async () => {
    const page = await open({
      responses: { '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1000000 + 300000).toISOString() } } },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();

    page.advance(120000);
    page.tick();
    assertEqual(page.parts['hold-countdown'].textContent, '3:00', 'it counts down');

    page.advance(200000);
    page.tick();
    for (let i = 0; i < 4; i += 1) await flush();
    assert(page.parts['hold-panel'].classList.contains('hidden'), 'and drops the hold when it lapses');
    assert(/expired/i.test(page.parts.message.textContent), `saying so, got: ${page.parts.message.textContent}`);
  });

  // --- keeping up without getting in the way --------------------------------

  await test('the plan refreshes on its own while nothing is held', async () => {
    const page = await open();
    const before = page.calls.length;
    page.refresh();
    await flush();
    assert(page.calls.length > before, 'it re-fetched');
  });

  await test('the plan does NOT refresh while a hold is being decided', async () => {
    // Repainting under somebody's finger mid-choice is how the wrong seat gets
    // confirmed.
    const page = await open({
      responses: { '/hold': { data: { ok: true, seatId: 11, label: 'A01', heldUntil: new Date(1300000).toISOString() } } },
    });
    page.clickSeat(11);
    for (let i = 0; i < 6; i += 1) await flush();

    const before = page.calls.length;
    page.refresh();
    await flush();
    assertEqual(page.calls.length, before, 'nothing was fetched');
  });

  await test('a hidden tab does not keep polling', async () => {
    // A hall of several hundred phones in pockets should not all be asking for
    // the plan every twenty seconds.
    const page = await open();
    page.hide();
    const before = page.calls.length;
    page.refresh();
    await flush();
    assertEqual(page.calls.length, before, 'nothing was fetched while hidden');
  });

  // --- wiring ---------------------------------------------------------------

  await test('the ticket offers the way in, but only where seating is on', async () => {
    const ticket = fs.readFileSync(path.join(ROOT, 'views', 'event-ticket.ejs'), 'utf8');
    assert(/seatingEnabled/.test(ticket), 'gated on the event actually using seats');
    assert(/\/seat"/.test(ticket), 'and links to the picker');
  });

  await test('the route is registered behind a login', async () => {
    const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'pages.routes.js'), 'utf8');
    assert(/'\/events\/:id\/seat', ensureAuth, pages\.eventSeatPickerPage/.test(routes),
      'the seat page requires a session');
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
