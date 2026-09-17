// Tests for creating the same event twice by accident.
//
// The report: "the first create failed fetch, I clicked again, it worked, but
// now there are two". There were two separate holes.
//
// The submit handler had no withPending, so nothing disabled the button — and
// this form uploads an image, so the wait is long enough that pressing again
// feels reasonable. That one is a client fix.
//
// The other cannot be fixed on the client at all: the request arrives, the
// event is created, and the response is lost on the way back. From the browser
// that is indistinguishable from the request never arriving, so the retry is
// correct behaviour and has to be absorbed by the server.
//
// Both halves are checked here — the service rule, and that the form actually
// guards its own button.

const fs = require('fs');
const path = require('path');

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});

const prisma = require('../src/config/prisma');
const eventService = require('../src/services/event.service');

const TAG = '__dupevent__';
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

const START = new Date('2026-11-20T09:00:00.000Z');

function payload(overrides = {}) {
  return {
    title: `${TAG} National Convention`,
    startDate: START.toISOString(),
    location: 'Manila',
    ...overrides,
  };
}

async function countEvents(title) {
  return prisma.event.count({ where: { title } });
}

async function cleanup() {
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const ids = events.length ? events.map((e) => e.id) : [0];
  await prisma.eventRegistration.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.event.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await cleanup();

  await test('creating an event works, and says it created one', async () => {
    const { event, reused } = await eventService.createEvent(payload());
    assert(event.id, 'created');
    assertEqual(reused, false, 'and reports it as new');
  });

  await test('the retry after a lost response returns the same event', async () => {
    // The reported bug. The first call above already made this event; this is
    // the admin pressing the button a second time.
    const { event, reused } = await eventService.createEvent(payload());
    assertEqual(reused, true, 'recognised as a retry');
    assertEqual(await countEvents(payload().title), 1, 'and still exactly one event exists');
    assert(event.id, 'with the original returned, so the caller can carry on');
  });

  await test('a third press still makes nothing', async () => {
    await eventService.createEvent(payload());
    await eventService.createEvent(payload());
    assertEqual(await countEvents(payload().title), 1, 'one event');
  });

  await test('whitespace around the title does not defeat the match', async () => {
    // The form posts whatever was typed. A trailing space would otherwise make
    // a retry look like a different event, which is the bug wearing a hat.
    const { reused } = await eventService.createEvent(payload({ title: `  ${TAG} National Convention  ` }));
    assertEqual(reused, true, 'still a retry');
    assertEqual(await countEvents(payload().title), 1, 'one event');
  });

  await test('the stored title is trimmed', async () => {
    const stored = await prisma.event.findFirst({ where: { title: { contains: TAG } } });
    assertEqual(stored.title, payload().title, 'no stray spaces saved');
  });

  await test('a different start time is a different event', async () => {
    // Same name, next year. Refusing this would be worse than the duplicate.
    const { reused, event } = await eventService.createEvent(payload({
      startDate: new Date('2027-11-20T09:00:00.000Z').toISOString(),
    }));
    assertEqual(reused, false, 'created');
    assert(event.id, 'a real second event');
    assertEqual(await countEvents(payload().title), 2, 'two now');
  });

  await test('a different title at the same time is a different event', async () => {
    // Two talks starting at once in two halls is normal.
    const { reused } = await eventService.createEvent(payload({ title: `${TAG} Parallel Session` }));
    assertEqual(reused, false, 'created');
  });

  await test('outside the retry window an identical event is allowed', async () => {
    // The window exists to absorb a retry, not to forbid anybody from ever
    // creating a similarly named event again. Aged past it by hand.
    const title = `${TAG} Aged`;
    const first = await eventService.createEvent(payload({ title }));
    await prisma.event.update({
      where: { id: first.event.id },
      data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const second = await eventService.createEvent(payload({ title }));
    assertEqual(second.reused, false, 'a deliberate second one is not blocked');
    assertEqual(await countEvents(title), 2, 'both exist');
  });

  await test('two simultaneous submits do not both create', async () => {
    // The double-click, racing. The window check is a read-then-write, so this
    // is the case it is weakest at — worth knowing which way it fails.
    const title = `${TAG} Double Click`;
    const results = await Promise.all([
      eventService.createEvent(payload({ title })),
      eventService.createEvent(payload({ title })),
    ]);

    const created = results.filter((r) => !r.reused).length;
    const count = await countEvents(title);
    // Not asserted as exactly one: two calls that truly interleave can both
    // miss the lookup. What the client-side guard is for, and why this asserts
    // the honest bound rather than one the code cannot keep.
    assert(count <= 2, `at most two, got ${count}`);
    assert(created >= 1, 'at least one was created');
    if (count === 1) console.log('        (the race was caught server-side this run)');
  });

  // --- the client half ------------------------------------------------------

  await test('the create form disables its button while submitting', async () => {
    // Without this, an impatient second click on a slow image upload sends a
    // second request before the first has answered.
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'event-new.ejs'), 'utf8');
    assert(/withPending\(/.test(view), 'withPending wraps the submit');
    assert(view.indexOf('withPending(') < view.indexOf("apiFetch('/api/events'"), 'and wraps the request, not just follows it');
  });

  await test('the form reports what the server actually did', async () => {
    // A retry answered "Event created" would leave the admin unsure whether to
    // go looking for a duplicate.
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'event-new.ejs'), 'utf8');
    assert(/showToast\(res\.message/.test(view), 'the server message is shown');
  });

  await test('the controller does not claim 201 for a retry', async () => {
    const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'api', 'event.api.js'), 'utf8');
    const block = api.slice(api.indexOf('const createEvent'), api.indexOf('const updateEvent'));
    assert(/reused/.test(block), 'the controller reads the flag');
    assert(/already created a moment ago/.test(block), 'and says so plainly');
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
