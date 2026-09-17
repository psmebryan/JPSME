// What a seat does while the person it belongs to comes and goes.
//
// Asked for as: "the stats change to occupied then out then wait for 5-10
// minutes if they did not check in again the seat will be change status to
// unoccupied that we can sign again a another user to that seat".
//
//   OCCUPIED   they are in a hall
//   AWAY       they have walked out — still theirs, for now
//   AVAILABLE  they stayed away past the grace period, so it went back
//
// Presence is read from the hall doors. It used to come from a separate venue
// entrance, which was removed: for a single-hall event "in the building" and
// "in the hall" are the same fact, so the entrance was a third scan that
// answered nothing the hall door had not already answered.
//
// Also covers the two bugs reported alongside it — the registration desk no
// longer blocks anything, and the recent list names each person once rather
// than once per scan.

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});

const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const checkin = require('../src/services/checkin.service');
const rooms = require('../src/services/roomAttendance.service');
const seating = require('../src/services/seating.service');
const config = require('../src/config');

const TAG = '__seatlifetest__';
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

let event;
let admin;
let hall;
let section;
let seq = 0;

async function makeAttendee() {
  const n = (seq += 1);
  const user = await prisma.user.create({
    data: {
      firstName: 'SEATLIFE', lastName: `USER${n}`, email: `${TAG}${n}@example.test`,
      password: 'x', role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
  return prisma.eventRegistration.create({
    data: {
      userId: user.id, eventId: event.id, fullName: `SEATLIFE USER${n}`,
      email: user.email, status: 'REGISTERED', registrationNumber: `${TAG}REG${n}`,
      qrToken: crypto.randomBytes(32).toString('hex'), qrGeneratedAt: new Date(),
    },
  });
}

const seatNamed = (label) => prisma.seat.findFirst({ where: { sectionId: section.id, label } });

const scan = (registration) => rooms.roomScan({
  eventId: event.id, roomId: hall.id, rawScan: registration.qrToken,
  staffUser: admin, scannerIdentifier: 'HALL-01',
});

// A real person enters a hall and leaves it minutes apart; a test does both in
// under a millisecond, which is what the duplicate-scan window exists to
// absorb. Ageing the earlier scans is how a test says "and then, later".
async function scanLater(registration) {
  await prisma.eventCheckIn.updateMany({
    where: { eventRegistrationId: registration.id },
    data: { scannedAt: new Date(Date.now() - (config.jobs.duplicateScanWindowMs + 5000)) },
  });
  return scan(registration);
}

// Pretend they walked out of the hall `minutesAgo` minutes ago.
async function leftAt(registration, minutesAgo) {
  await prisma.roomAttendance.updateMany({
    where: { roomId: hall.id, eventRegistrationId: registration.id },
    data: { state: 'OUTSIDE', lastExitedAt: new Date(Date.now() - minutesAgo * 60000) },
  });
}

const graceMinutes = () => Math.ceil(config.jobs.seatGraceMs / 60000) + 5;

async function stateOf(label) {
  const map = await seating.getSeatMap(event.id);
  return map[0].rows.flatMap((r) => r.seats).find((s) => s.label === label).state;
}

async function cleanup() {
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const ids = events.map((e) => e.id);
  if (ids.length) {
    await prisma.eventCheckIn.deleteMany({ where: { eventId: { in: ids } } });
    const roomRows = await prisma.eventRoom.findMany({ where: { eventId: { in: ids } }, select: { id: true } });
    if (roomRows.length) {
      await prisma.roomAttendance.deleteMany({ where: { roomId: { in: roomRows.map((r) => r.id) } } });
    }
    const sections = await prisma.seatingSection.findMany({ where: { eventId: { in: ids } }, select: { id: true } });
    const sectionIds = sections.map((s) => s.id);
    if (sectionIds.length) {
      const seats = await prisma.seat.findMany({ where: { sectionId: { in: sectionIds } }, select: { id: true } });
      await prisma.seatAssignment.deleteMany({ where: { seatId: { in: seats.map((s) => s.id) } } });
      await prisma.seat.deleteMany({ where: { sectionId: { in: sectionIds } } });
      await prisma.seatingSection.deleteMany({ where: { id: { in: sectionIds } } });
    }
    await prisma.eventRoom.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.eventRegistration.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.event.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
}

async function main() {
  await cleanup();

  admin = await prisma.user.upsert({
    where: { email: `${TAG}admin@example.test` },
    update: {},
    create: {
      firstName: 'SEATLIFE', lastName: 'ADMIN', email: `${TAG}admin@example.test`,
      password: 'x', role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
  event = await prisma.event.create({
    data: {
      title: `${TAG} Convention`, startDate: new Date(Date.now() + 86400000),
      isPublished: true, seatingEnabled: true,
    },
  });
  hall = await rooms.createRoom({ eventId: event.id, name: 'Main Hall', adminUserId: admin.id });
  section = await seating.createSection({
    eventId: event.id, name: 'Main Floor', roomId: hall.id, adminUserId: admin.id,
  });
  await seating.generateSeats({
    eventId: event.id, sectionId: section.id, rows: 3, seatsPerRow: 10, adminUserId: admin.id,
  });

  // --- the desk no longer blocks the door -----------------------------------

  await test('the hall door admits somebody the desk has already checked in', async () => {
    // The reported bug. The desk and the door both claimed checkedInAt through
    // the same one-shot update, so the desk won and the door refused somebody
    // standing in front of it.
    const person = await makeAttendee();
    const desk = await checkin.checkInByScan({
      eventId: event.id, rawScan: person.qrToken, staffUser: admin, scannerIdentifier: 'DESK-01',
    });
    assertEqual(desk.ok, true, 'the desk checked them in');

    const door = await scan(person);
    assertEqual(door.ok, true, 'and the hall let them in');
    assertEqual(door.action, 'CHECK_IN', 'as an entry');
    assertEqual(door.state, 'INSIDE', 'and they are inside');
  });

  await test('the desk does not put anybody in a hall', async () => {
    // Registering is not entering. Someone can collect their badge and seat and
    // stand in the lobby for an hour.
    const person = await makeAttendee();
    await checkin.checkInByScan({
      eventId: event.id, rawScan: person.qrToken, staffUser: admin, scannerIdentifier: 'DESK-01',
    });
    const row = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: hall.id, eventRegistrationId: person.id } },
    });
    assert(!row || row.state === 'OUTSIDE', `not inside, got ${row && row.state}`);
  });

  // --- the recent list ------------------------------------------------------

  await test('the recent list names each person once, not once per scan', async () => {
    // Reported as "3 duplicate name ... when i remove it all 3 been remove".
    // They were three views of one registration all along.
    const person = await makeAttendee();
    await checkin.checkInByScan({ eventId: event.id, rawScan: person.qrToken, staffUser: admin });
    await scan(person);
    await scanLater(person);

    const recent = await checkin.getRecentCheckIns(event.id, 20);
    const mine = recent.filter((r) => r.eventRegistrationId === person.id);
    assertEqual(mine.length, 1, `once, got ${mine.length}`);
  });

  await test('the recent list still shows everybody, just once each', async () => {
    const a = await makeAttendee();
    const b = await makeAttendee();
    await scan(a);
    await scan(b);

    const recent = await checkin.getRecentCheckIns(event.id, 20);
    const ids = recent.map((r) => r.eventRegistrationId);
    assert(ids.includes(a.id) && ids.includes(b.id), 'both are listed');
    assertEqual(new Set(ids).size, ids.length, 'and nobody twice');
  });

  // --- the seat -------------------------------------------------------------

  await test('a seat reads as occupied while its owner is in the hall', async () => {
    const person = await makeAttendee();
    const seat = await seatNamed('A01');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    assertEqual(await stateOf('A01'), 'OCCUPIED', 'they are in it');
  });

  await test('a seat reads as away once its owner walks out', async () => {
    // The state an organiser acts on: looks empty across the hall, is not free.
    const person = await makeAttendee();
    const seat = await seatNamed('A02');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, 1);
    assertEqual(await stateOf('A02'), 'AWAY', 'still theirs, for now');
  });

  await test('a seat is given back once its owner has been gone past the grace period', async () => {
    const person = await makeAttendee();
    const seat = await seatNamed('A03');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, graceMinutes());

    assertEqual(await stateOf('A03'), 'AVAILABLE', 'free again');
    const fresh = await seatNamed('A03');
    assertEqual(fresh.assignedRegistrationId, null, 'and actually unassigned, not merely drawn that way');
  });

  await test('a released seat can really be given to somebody else', async () => {
    // The point of releasing it. A seat that only LOOKS free still refuses the
    // next person who tries to take it.
    const gone = await makeAttendee();
    const next = await makeAttendee();
    const seat = await seatNamed('A04');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: gone.id, actorId: admin.id });
    await scan(gone);
    await leftAt(gone, graceMinutes());

    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: next.id, actorId: admin.id });
    const fresh = await seatNamed('A04');
    assertEqual(fresh.assignedRegistrationId, next.id, 'it is the new person\'s now');
  });

  await test('somebody who came back keeps their seat', async () => {
    // The grace period exists for exactly this person.
    const person = await makeAttendee();
    const seat = await seatNamed('A05');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, 60);
    await scanLater(person);

    await seating.getSeatMap(event.id);
    const fresh = await seatNamed('A05');
    assertEqual(fresh.assignedRegistrationId, person.id, 'the seat is still theirs');
    assertEqual(await stateOf('A05'), 'OCCUPIED', 'and they are back in it');
  });

  await test('a seat belonging to somebody who never arrived is not treated as abandoned', async () => {
    // Never entered means never left. Releasing these would hand out the seats
    // of everybody who is merely running late.
    const person = await makeAttendee();
    const seat = await seatNamed('A06');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });

    assertEqual(await stateOf('A06'), 'ASSIGNED', 'waiting for them, not free');
    const fresh = await seatNamed('A06');
    assertEqual(fresh.assignedRegistrationId, person.id, 'and still theirs');
  });

  await test('giving a seat back is recorded, not silent', async () => {
    // Somebody will ask why their seat went. The history has to answer.
    const person = await makeAttendee();
    const seat = await seatNamed('A07');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, graceMinutes());
    await seating.getSeatMap(event.id);

    const history = await seating.getSeatHistory(event.id, seat.id);
    assert(history.some((h) => h.action === 'RELEASED'),
      `the release is logged, got ${history.map((h) => h.action).join(' → ')}`);
  });

  await test('the desk is not offered a seat whose owner is merely away', async () => {
    const person = await makeAttendee();
    const seat = await seatNamed('B01');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, 1);

    const free = await seating.listAvailableSeats(event.id, { limit: 500 });
    assert(!free.some((s) => s.label === 'B01'), 'B01 is not on offer');
  });

  await test('the desk IS offered a seat whose owner has gone for good', async () => {
    const person = await makeAttendee();
    const seat = await seatNamed('B02');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, graceMinutes());

    const free = await seating.listAvailableSeats(event.id, { limit: 500 });
    assert(free.some((s) => s.label === 'B02'), 'B02 is back on offer');
  });

  await test('inside-now falls when somebody leaves, while arrived does not', async () => {
    const person = await makeAttendee();
    await scan(person);
    const busy = await checkin.getEventCheckInStats(event.id);

    await scanLater(person);
    const quiet = await checkin.getEventCheckInStats(event.id);

    assertEqual(quiet.checkedIn, busy.checkedIn, 'arrived is cumulative');
    assertEqual(quiet.insideNow, busy.insideNow - 1, 'inside now is not');
  });

  // --- seeing which seats can be given away ---------------------------------

  await test('the stepped-out list names who left and which seat is theirs', async () => {
    // Asked for as: somewhere to see the occupied seats "so that we can check
    // in other to those who left and not comeback in the room". A colour on a
    // plan of several hundred squares is not something anybody can scan at a
    // live event; this is the list they act from.
    const person = await makeAttendee();
    const seat = await seatNamed('C01');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, 3);

    const away = await seating.listSteppedOut(event.id);
    const mine = away.find((row) => row.label === 'C01');
    assert(mine, `C01 is listed, got ${away.map((r) => r.label).join(', ') || 'nothing'}`);
    assertEqual(mine.name, person.fullName, 'named, so staff know who to look for');
    assertEqual(mine.minutesAway, 3, 'and how long they have been gone');
  });

  await test('it says how much longer the seat is theirs', async () => {
    // The number facing forwards is the useful one: an operator deciding
    // whether to wait or reassign wants to know how long the wait is.
    const person = await makeAttendee();
    const seat = await seatNamed('C02');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, 4);

    const row = (await seating.listSteppedOut(event.id)).find((r) => r.label === 'C02');
    const expected = Math.ceil(config.jobs.seatGraceMs / 60000) - 4;
    assertEqual(row.freesInMinutes, expected, 'counts down to when it frees itself');
  });

  await test('somebody still in the hall is not on the list', async () => {
    const person = await makeAttendee();
    const seat = await seatNamed('C03');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);

    const away = await seating.listSteppedOut(event.id);
    assert(!away.some((r) => r.label === 'C03'), 'they are in their seat, not gone');
  });

  await test('the list and the seat map never disagree about a seat', async () => {
    // A seat past its grace period used to sit on this list as "still theirs"
    // until somebody happened to open the plan, which freed it. Two screens
    // disagreeing about one seat is worse than either being a moment stale.
    const person = await makeAttendee();
    const seat = await seatNamed('C04');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: person.id, actorId: admin.id });
    await scan(person);
    await leftAt(person, graceMinutes());

    const away = await seating.listSteppedOut(event.id);
    assert(!away.some((r) => r.label === 'C04'), 'not listed as still theirs');
    assertEqual(await stateOf('C04'), 'AVAILABLE', 'and the plan agrees it is free');
  });

  await test('the longest-gone person is first, because that seat frees first', async () => {
    const a = await makeAttendee();
    const b = await makeAttendee();
    const seatA = await seatNamed('C05');
    const seatB = await seatNamed('C06');
    await seating.assignSeat({ eventId: event.id, seatId: seatA.id, registrationId: a.id, actorId: admin.id });
    await seating.assignSeat({ eventId: event.id, seatId: seatB.id, registrationId: b.id, actorId: admin.id });
    await scan(a);
    await scan(b);
    await leftAt(a, 6);
    await leftAt(b, 2);

    const away = await seating.listSteppedOut(event.id);
    const order = away.filter((r) => ['C05', 'C06'].includes(r.label)).map((r) => r.label);
    assertEqual(order.join(','), 'C05,C06', 'longest away first');
  });

  await test('a seat freed by hand goes immediately, without waiting out the grace', async () => {
    // The whole point of the Free button: an organiser who knows somebody has
    // gone home should not have to wait ten minutes to seat the next person.
    const gone = await makeAttendee();
    const next = await makeAttendee();
    const seat = await seatNamed('C07');
    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: gone.id, actorId: admin.id });
    await scan(gone);
    await leftAt(gone, 1);

    await seating.releaseSeat({ eventId: event.id, seatId: seat.id, actorId: admin.id });
    assertEqual(await stateOf('C07'), 'AVAILABLE', 'free at once');

    await seating.assignSeat({ eventId: event.id, seatId: seat.id, registrationId: next.id, actorId: admin.id });
    const fresh = await seatNamed('C07');
    assertEqual(fresh.assignedRegistrationId, next.id, 'and the next person has it');
  });

  await test('the seating page can actually draw an away seat', async () => {
    // The state was added to the service before the page knew about it, so an
    // AWAY seat rendered with no colour class at all on first paint.
    const fs = require('fs');
    const path = require('path');
    const view = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'event-seating.ejs'), 'utf8');
    assert(/AWAY:\s*'bg-/.test(view), 'the server-rendered map has a colour for it');
    assert(/'away','Stepped out'/.test(view), 'and it is counted');
    assert(/AWAY: 'Stepped out'/.test(view), 'and in the legend');
    assert(/data-away-list/.test(view), 'and the list is on the page');
  });

  // --- the station that was removed -----------------------------------------

  await test('nothing is left pointing at the venue entrance', async () => {
    // It was removed rather than hidden, so a stale route or a dead nav tab
    // would be a link straight to a 500.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const files = [
      'src/routes/pages.routes.js',
      'src/routes/api/event.routes.js',
      'src/controllers/pages.controller.js',
      'src/controllers/api/checkin.api.js',
      'src/services/checkin.service.js',
      'views/partials/event-ops-nav.ejs',
    ];
    files.forEach((rel) => {
      const body = fs.readFileSync(path.join(root, rel), 'utf8');
      assert(!/venueScan|checkin\/venue|adminEventCheckInPage/.test(body), `${rel} still references it`);
    });
    assert(!fs.existsSync(path.join(root, 'views/admin/event-checkin.ejs')), 'the page is gone');
    assert(!fs.existsSync(path.join(root, 'public/js/checkin.js')), 'its script is gone');
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
