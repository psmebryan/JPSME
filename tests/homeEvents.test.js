// Tests for the home page's event cards.
//
// They list what is coming up, soonest first, and only fill spare places with
// the most recently finished events, which say "Event Ended" and offer no
// "Register Now". Before, every published event was listed by date, so a
// finished one stayed first and kept reading "Registration Open".
//
// Uses the dev database through the service (with a chosen "now", so the
// result does not depend on what else is in the database) and renders the
// real home template with fixed events.

require('dotenv').config();

const assert = require('assert');
const ejs = require('ejs');
const path = require('path');
const prisma = require('../src/config/prisma');
const eventService = require('../src/services/event.service');

const TAG = `__he${Date.now()}`;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}\n      ${err.message}`);
    failed += 1;
  }
}

const render = (events) => ejs.renderFile(path.join(__dirname, '..', 'views', 'index.ejs'), {
  events, stats: {}, sponsors: [], title: 'Home', cspNonce: 'n', logoUrl: null, currentUser: null,
});
const card = (over) => ({
  id: 1, title: `${TAG} Conference`, modality: 'FACE_TO_FACE', location: 'SMX', feeCentavos: 0,
  description: 'x', capacity: null, endDate: null, _count: { registrations: 0 }, ...over,
});

async function main() {
  // Far in the future, so nothing else in the database counts as upcoming.
  const now = new Date(Date.UTC(2999, 0, 1));
  const made = [];
  try {
    const mk = (title, days) => prisma.event.create({
      data: { title: `${TAG} ${title}`, isPublished: true, startDate: new Date(now.getTime() + days * 864e5) },
    }).then((e) => { made.push(e.id); return e; });
    const soon = await mk('Soon', 2);
    const later = await mk('Later', 9);
    const past = await mk('Past', -3);

    await test('upcoming events come first, soonest first, and finished ones only fill spare places', async () => {
      const list = await eventService.listHomeEvents(3, now);
      assert.deepStrictEqual(list.slice(0, 3).map((e) => e.id), [soon.id, later.id, past.id]);
      assert.deepStrictEqual(list.map((e) => e.hasEnded), [false, false, true]);
      const two = await eventService.listHomeEvents(2, now);
      assert.deepStrictEqual(two.map((e) => e.id), [soon.id, later.id], 'no finished event while upcoming ones fill the row');
    });

    await test('a finished event reads "Event Ended", never "Register Now"', async () => {
      const ended = card({ startDate: new Date(Date.now() - 16 * 864e5) });
      ended.hasEnded = eventService.hasEventEnded(ended);
      const html = await render([ended]);
      assert(html.includes('Event Ended') && html.includes('View Event'));
      assert(!html.includes('Registration Open') && !/Register Now/.test(html));
    });

    await test('an upcoming event still reads "Registration Open" and "Register Now"', async () => {
      const open = card({ startDate: new Date(Date.now() + 5 * 864e5) });
      open.hasEnded = eventService.hasEventEnded(open);
      const html = await render([open]);
      assert(html.includes('Registration Open') && /Register Now/.test(html) && !html.includes('Event Ended'));
    });

    await test('a multi-day event is not ended until its last day', async () => {
      const running = card({ startDate: new Date(Date.now() - 864e5), endDate: new Date(Date.now() + 864e5) });
      assert.strictEqual(eventService.hasEventEnded(running), false);
    });
  } finally {
    await prisma.event.deleteMany({ where: { id: { in: made } } }).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
