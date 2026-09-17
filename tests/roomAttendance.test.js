// Tests for room and session attendance.
//
// The distinction this whole feature rests on: arriving at the venue happens
// once, entering a hall happens repeatedly. EventRegistration.checkedInAt stays
// the one-shot arrival column the existing scan path gates on; room state lives
// in room_attendance and flips with every scan.
//
// The parts worth testing hardest are the ones a busy door will find: two
// scanners on the same ticket at the same instant, a full room, and whether the
// history survives being walked in and out of five times.

const path = require('path');

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});

const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const rooms = require('../src/services/roomAttendance.service');

const TAG = '__roomtest__';
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

let admin = null;
let event = null;
let seq = 0;

// A staff user the service will accept. canCheckIn() lets a main ADMIN run any
// door, so no per-event grant is needed here.
async function ensureAdmin() {
  admin = await prisma.user.create({
    data: {
      firstName: 'ROOM', lastName: 'ADMIN', email: `${TAG}admin@example.test`,
      password: 'x', role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
}

async function makeEvent() {
  return prisma.event.create({
    data: {
      title: `${TAG} Convention`,
      startDate: new Date(Date.now() + 86400000),
      isPublished: true,
    },
  });
}

async function makeAttendee({ status = 'REGISTERED' } = {}) {
  // Captured, not read from the shared counter later. The registration number
  // below is built after an await, and the concurrency tests call this four
  // times at once — reading `seq` at that point returns whatever the other
  // three have since bumped it to, and two registrations collide on a unique
  // column. The failure looked like a product bug and was entirely this.
  const n = (seq += 1);
  const user = await prisma.user.create({
    data: {
      firstName: 'ROOM', lastName: `ATTENDEE${n}`, email: `${TAG}${n}@example.test`,
      password: 'x', role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
  return prisma.eventRegistration.create({
    data: {
      userId: user.id,
      eventId: event.id,
      fullName: `ROOM ATTENDEE${n}`,
      email: user.email,
      status,
      registrationNumber: `${TAG}REG${n}`,
      qrToken: crypto.randomBytes(32).toString('hex'),
      qrGeneratedAt: new Date(),
    },
  });
}

const scan = (room, registration) => rooms.roomScan({
  eventId: event.id, roomId: room.id, rawScan: registration.qrToken,
  staffUser: admin, scannerIdentifier: 'HALL-01',
});

// The same scan, but meant as a later one.
//
// A real person enters a hall and leaves it minutes apart; a test does both in
// under a millisecond, which is exactly what the duplicate-scan window exists
// to absorb. Ageing the earlier scans first is how a test says "and then, some
// time later" without sleeping for eight seconds a dozen times.
async function scanLater(room, registration) {
  await prisma.eventCheckIn.updateMany({
    where: { eventRegistrationId: registration.id },
    data: { scannedAt: new Date(Date.now() - 60000) },
  });
  return scan(room, registration);
}

async function cleanup() {
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const ids = events.length ? events.map((e) => e.id) : [0];
  await prisma.eventCheckIn.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventRoom.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventSession.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventRegistration.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.event.deleteMany({ where: { id: { in: ids } } });
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const userIds = users.length ? users.map((u) => u.id) : [0];
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  await cleanup();
  await ensureAdmin();
  event = await makeEvent();

  // --- configuration --------------------------------------------------------

  await test('a room belongs to one event and reports its own occupancy', async () => {
    const room = await rooms.createRoom({ eventId: event.id, name: 'Main Hall', capacity: 500, adminUserId: admin.id });
    assertEqual(room.eventId, event.id, 'owned by the event');

    const list = await rooms.listRooms(event.id);
    const main = list.find((r) => r.id === room.id);
    assertEqual(main.occupancy, 0, 'nobody inside yet');
    assertEqual(main.available, 500, 'all of it available');
  });

  await test('an uncapped room reports no capacity rather than zero', async () => {
    // Null and 0 mean opposite things here, and a dashboard that shows "0
    // available" for an uncapped hall is worse than showing nothing.
    const room = await rooms.createRoom({ eventId: event.id, name: 'Foyer', adminUserId: admin.id });
    const list = await rooms.listRooms(event.id);
    const foyer = list.find((r) => r.id === room.id);
    assertEqual(foyer.capacity, null, 'uncapped');
    assertEqual(foyer.available, null, 'and says so');
  });

  await test('two rooms cannot share a name at one event', async () => {
    let threw = null;
    try {
      await rooms.createRoom({ eventId: event.id, name: 'Main Hall', adminUserId: admin.id });
    } catch (err) { threw = err; }
    assert(threw, 'refused');
    assertEqual(threw.statusCode, 409, 'as a conflict');
  });

  await test('the same room name is fine at a different event', async () => {
    // Rooms are owned by the event, not the building. Two conventions in the
    // same ballroom must not share a row.
    const other = await makeEvent();
    const room = await rooms.createRoom({ eventId: other.id, name: 'Main Hall', adminUserId: admin.id });
    assertEqual(room.eventId, other.id, 'its own row');
  });

  await test('a room from another event is not usable at this door', async () => {
    const other = await makeEvent();
    const foreign = await rooms.createRoom({ eventId: other.id, name: 'Elsewhere', adminUserId: admin.id });

    let threw = null;
    try { await rooms.getRoom(event.id, foreign.id); } catch (err) { threw = err; }
    assert(threw, 'refused');
    assertEqual(threw.statusCode, 404, 'and not even acknowledged');
  });

  // --- the state machine ----------------------------------------------------

  const hall = (await rooms.listRooms(event.id)).find((r) => r.name === 'Main Hall');

  await test('the first scan at a room is an entry', async () => {
    const person = await makeAttendee();
    const result = await scan(hall, person);

    assertEqual(result.ok, true, 'admitted');
    assertEqual(result.action, 'CHECK_IN', 'an entry');
    assertEqual(result.state, 'INSIDE', 'and they are inside');
    assertEqual(result.occupancy, 1, 'occupancy counted');
  });

  await test('the next scan is an exit, with no button pressed', async () => {
    // The whole scanner design: staff scan, the server decides direction.
    const person = await makeAttendee();
    await scan(hall, person);
    const out = await scanLater(hall, person);

    assertEqual(out.action, 'CHECK_OUT', 'an exit');
    assertEqual(out.state, 'OUTSIDE', 'and they are outside');
  });

  await test('in, out, in, out, in — and the history keeps all five', async () => {
    const person = await makeAttendee();
    const actions = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      actions.push((await scanLater(hall, person)).action);
    }
    assertEqual(actions.join(','), 'CHECK_IN,CHECK_OUT,CHECK_IN,CHECK_OUT,CHECK_IN', 'alternating');

    const history = await rooms.getAttendanceHistory(person.id);
    const roomMoves = history.filter((h) => h.room === 'Main Hall');
    assertEqual(roomMoves.length, 5, 'every movement kept');
    assertEqual(roomMoves[0].action, 'CHECK_IN', 'in order');
    assertEqual(roomMoves[4].action, 'CHECK_IN', 'ending inside');
  });

  await test('entry count and timestamps track the visits', async () => {
    const person = await makeAttendee();
    await scanLater(hall, person);
    await scanLater(hall, person);
    await scanLater(hall, person);

    const row = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: hall.id, eventRegistrationId: person.id } },
    });
    assertEqual(row.entryCount, 2, 'two separate visits');
    assertEqual(row.state, 'INSIDE', 'currently in');
    assert(row.firstEnteredAt, 'first arrival kept');
    assert(row.lastExitedAt, 'and the exit between them');
    assert(row.firstEnteredAt <= row.lastEnteredAt, 'first is not after last');
  });

  await test('two rooms are tracked independently', async () => {
    const workshop = await rooms.createRoom({ eventId: event.id, name: 'Workshop Room', capacity: 100, adminUserId: admin.id });
    const person = await makeAttendee();

    await scan(hall, person);
    const inWorkshop = await scan(workshop, person);

    assertEqual(inWorkshop.action, 'CHECK_IN', 'entering the workshop');

    const hallRow = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: hall.id, eventRegistrationId: person.id } },
    });
    assertEqual(hallRow.state, 'INSIDE', 'still inside the hall — the rooms do not talk to each other');
  });

  // --- arrival stays separate ----------------------------------------------

  await test('a room entry also marks arrival for somebody who skipped the desk', async () => {
    // People walk straight into the hall. Sending them back to registration is
    // not a thing door staff can do, so the arrival is recorded here too.
    const person = await makeAttendee();
    assertEqual(person.checkedInAt, null, 'has not arrived yet');

    const result = await scan(hall, person);
    assertEqual(result.alsoMarkedArrived, true, 'and is told so');

    const fresh = await prisma.eventRegistration.findUnique({ where: { id: person.id } });
    assert(fresh.checkedInAt, 'arrival stamped');
  });

  await test('arrival is stamped once, not on every room entry', async () => {
    // checkedInAt is the FIRST arrival and the column the main entrance scan
    // gates on. A room scan must never reset it.
    const person = await makeAttendee();
    await scan(hall, person);
    const first = await prisma.eventRegistration.findUnique({ where: { id: person.id } });

    await scan(hall, person); // out
    await scan(hall, person); // in again
    const later = await prisma.eventRegistration.findUnique({ where: { id: person.id } });

    assertEqual(later.checkedInAt.getTime(), first.checkedInAt.getTime(), 'unchanged');
  });

  await test('the arrival is logged as its own scan, separate from the room one', async () => {
    const person = await makeAttendee();
    await scan(hall, person);

    const scans = await prisma.eventCheckIn.findMany({
      where: { eventRegistrationId: person.id }, orderBy: { id: 'asc' },
    });
    const venue = scans.filter((s) => s.roomId === null);
    const room = scans.filter((s) => s.roomId === hall.id);
    assertEqual(venue.length, 1, 'one venue-door row');
    assertEqual(room.length, 1, 'and one hall row');
  });

  // --- refusals -------------------------------------------------------------

  await test('an unpaid registration is refused at the room, as at the entrance', async () => {
    // Same verdictFor() as the main door, imported rather than reimplemented —
    // a side door must not be a way past payment.
    const person = await makeAttendee({ status: 'PENDING_PAYMENT' });
    const result = await scan(hall, person);

    assertEqual(result.ok, false, 'refused');
    assertEqual(result.result, 'UNPAID', 'for the right reason');
  });

  await test('a cancelled registration is refused', async () => {
    const person = await makeAttendee({ status: 'CANCELLED' });
    assertEqual((await scan(hall, person)).result, 'CANCELLED', 'refused');
  });

  await test('an unrecognised code is refused and still logged', async () => {
    const before = await prisma.eventCheckIn.count({ where: { eventId: event.id, result: 'INVALID_QR' } });
    const result = await rooms.roomScan({
      eventId: event.id, roomId: hall.id, rawScan: 'not-a-real-token', staffUser: admin,
    });

    assertEqual(result.result, 'INVALID_QR', 'refused');
    const after = await prisma.eventCheckIn.count({ where: { eventId: event.id, result: 'INVALID_QR' } });
    assertEqual(after, before + 1, 'and recorded — the failures are what the door report is about');
  });

  await test('a closed room refuses entry without losing its history', async () => {
    const closable = await rooms.createRoom({ eventId: event.id, name: 'Closing Soon', adminUserId: admin.id });
    const person = await makeAttendee();
    await scan(closable, person);

    await rooms.updateRoom({ eventId: event.id, roomId: closable.id, data: { isOpen: false }, adminUserId: admin.id });
    const refused = await rooms.roomScan({
      eventId: event.id, roomId: closable.id, rawScan: person.qrToken, staffUser: admin,
    });

    assertEqual(refused.result, 'ROOM_CLOSED', 'refused');
    const history = await rooms.getAttendanceHistory(person.id);
    assert(history.some((h) => h.room === 'Closing Soon'), 'the earlier entry is still there');
  });

  await test('a full room refuses the next person', async () => {
    const tiny = await rooms.createRoom({ eventId: event.id, name: 'Tiny Room', capacity: 1, adminUserId: admin.id });
    const first = await makeAttendee();
    const second = await makeAttendee();

    assertEqual((await scan(tiny, first)).ok, true, 'first one in');
    const turned = await scan(tiny, second);

    assertEqual(turned.ok, false, 'second refused');
    assertEqual(turned.result, 'ROOM_FULL', 'because the room is full');
  });

  await test('somebody already inside a full room can still leave', async () => {
    // The capacity check must only guard entry. Trapping people inside a full
    // room is the obvious way to get this wrong.
    const tiny = (await rooms.listRooms(event.id)).find((r) => r.name === 'Tiny Room');
    const inside = await prisma.roomAttendance.findFirst({ where: { roomId: tiny.id, state: 'INSIDE' } });
    const person = await prisma.eventRegistration.findUnique({ where: { id: inside.eventRegistrationId } });

    await prisma.eventCheckIn.updateMany({
      where: { eventRegistrationId: person.id },
      data: { scannedAt: new Date(Date.now() - 60000) },
    });
    const out = await rooms.roomScan({
      eventId: event.id, roomId: tiny.id, rawScan: person.qrToken, staffUser: admin,
    });
    assertEqual(out.action, 'CHECK_OUT', 'let out');
  });

  // --- the double scan ------------------------------------------------------

  await test('scanning twice in a moment does not undo the first scan', async () => {
    // The failure this exists for. The door decides direction from where the
    // person is, so without a window a repeat scan does the OPPOSITE — a gun
    // that double-fires marks somebody as having left the hall they are walking
    // into, and both scans are true rows in an append-only log.
    const person = await makeAttendee();
    const first = await scan(hall, person);
    assertEqual(first.action, 'CHECK_IN', 'in');

    const again = await scan(hall, person);
    assertEqual(again.duplicate, true, 'recognised as a repeat');
    assertEqual(again.result, 'DUPLICATE_SCAN', 'and named as one');
    assertEqual(again.state, 'INSIDE', 'they are still inside');

    const row = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: hall.id, eventRegistrationId: person.id } },
    });
    assertEqual(row.state, 'INSIDE', 'the state did not flip');
    assertEqual(row.entryCount, 1, 'and it was not counted as a second visit');
  });

  await test('a duplicate is not an error — nothing went wrong', async () => {
    // Rendering it red would send an operator looking for a problem that does
    // not exist. The person is fine; the scan simply did nothing.
    const person = await makeAttendee();
    await scan(hall, person);
    const again = await scan(hall, person);

    assertEqual(again.ok, true, 'not a refusal');
    assert(/already scanned/i.test(again.message), `and says so, got: ${again.message}`);
    assert(/\d+s ago/.test(again.message), 'with how long ago');
  });

  await test('the repeat is recorded, so a misbehaving scanner is visible', async () => {
    const person = await makeAttendee();
    await scan(hall, person);
    await scan(hall, person);
    await scan(hall, person);

    const duplicates = await prisma.eventCheckIn.count({
      where: { eventRegistrationId: person.id, result: 'DUPLICATE_SCAN' },
    });
    assertEqual(duplicates, 2, 'both repeats logged');
  });

  await test('a deliberate exit past the window still works', async () => {
    // The window absorbs an accident. It must not stop somebody actually
    // leaving a few minutes later.
    const person = await makeAttendee();
    await scan(hall, person);

    // Aged past the window by hand rather than waiting eight seconds.
    await prisma.eventCheckIn.updateMany({
      where: { eventRegistrationId: person.id, roomId: hall.id },
      data: { scannedAt: new Date(Date.now() - 60000) },
    });

    const out = await scan(hall, person);
    assertEqual(out.duplicate, undefined, 'not treated as a repeat');
    assertEqual(out.action, 'CHECK_OUT', 'they left');
  });

  await test('the window is per room, not per person', async () => {
    // Walking out of one hall and straight into the next is normal, and the two
    // scans are seconds apart at different doors.
    const other = await rooms.createRoom({ eventId: event.id, name: 'Next Door', adminUserId: admin.id });
    const person = await makeAttendee();

    await scan(hall, person);
    const elsewhere = await scan(other, person);

    assertEqual(elsewhere.duplicate, undefined, 'a different door is a different scan');
    assertEqual(elsewhere.action, 'CHECK_IN', 'admitted');
  });

  await test('a duplicate does not disturb the occupancy count', async () => {
    const room = await rooms.createRoom({ eventId: event.id, name: 'Counting Room', adminUserId: admin.id });
    const a = await makeAttendee();
    const b = await makeAttendee();
    await scan(room, a);
    await scan(room, b);

    const repeat = await scan(room, a);
    assertEqual(repeat.occupancy, 2, 'still two inside');

    const inside = await prisma.roomAttendance.count({ where: { roomId: room.id, state: 'INSIDE' } });
    assertEqual(inside, 2, 'and the table agrees');
  });

  await test('a refused scan does not start a window', async () => {
    // An UNPAID ticket presented twice should be refused twice, not shrugged
    // off the second time as a duplicate of a scan that admitted nobody.
    const person = await makeAttendee({ status: 'PENDING_PAYMENT' });
    const first = await scan(hall, person);
    const second = await scan(hall, person);

    assertEqual(first.result, 'UNPAID', 'refused');
    assertEqual(second.result, 'UNPAID', 'and refused again, with the real reason');
  });

  // --- concurrency ----------------------------------------------------------

  await test('two scanners on one ticket at the same instant produce one entry', async () => {
    // The race the conditional UPDATE exists for. Read-then-write would let
    // both scans admit, and occupancy would be permanently one too high.
    const person = await makeAttendee();
    const results = await Promise.all([scan(hall, person), scan(hall, person)]);

    const actions = results.map((r) => r.action).filter(Boolean).sort();
    const row = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: hall.id, eventRegistrationId: person.id } },
    });

    // One of them entered. The other either exited (a legitimate second scan)
    // or lost the race — never two entries, and never a state that is neither.
    assert(actions.includes('CHECK_IN') || row.state === 'INSIDE', `one entry happened, got ${actions.join(',')}`);
    assertEqual(row.entryCount <= 1, true, `counted once, got ${row.entryCount}`);
    assert(['INSIDE', 'OUTSIDE'].includes(row.state), 'and the state is one of the two');
  });

  await test('a capped room does not overfill under simultaneous entries', async () => {
    const capped = await rooms.createRoom({ eventId: event.id, name: 'Capped Two', capacity: 2, adminUserId: admin.id });
    const people = await Promise.all([makeAttendee(), makeAttendee(), makeAttendee(), makeAttendee()]);

    await Promise.all(people.map((p) => scan(capped, p)));

    const inside = await prisma.roomAttendance.count({ where: { roomId: capped.id, state: 'INSIDE' } });
    assert(inside <= 2, `never more than the capacity, got ${inside}`);
  });

  // --- monitoring -----------------------------------------------------------

  await test('occupancy adds up across rooms', async () => {
    const summary = await rooms.getOccupancy(event.id);
    const sum = summary.rooms.reduce((n, r) => n + r.occupancy, 0);
    assertEqual(summary.totalInside, sum, 'the total is the sum of the rooms');
  });

  await test('who is inside can be listed, newest arrival first', async () => {
    const listRoom = await rooms.createRoom({ eventId: event.id, name: 'Listing Room', adminUserId: admin.id });
    const a = await makeAttendee();
    const b = await makeAttendee();
    await scan(listRoom, a);
    await scan(listRoom, b);

    const inside = await rooms.listInside(event.id, listRoom.id);
    assertEqual(inside.length, 2, 'both listed');
    assert(inside[0].name && inside[0].registrationNumber, 'named, so staff can find them');
    assert(inside[0].since, 'with how long they have been in');
  });

  await test('somebody who left is no longer listed as inside', async () => {
    const listRoom = (await rooms.listRooms(event.id)).find((r) => r.name === 'Listing Room');
    const inside = await rooms.listInside(event.id, listRoom.id);
    const person = await prisma.eventRegistration.findUnique({ where: { id: inside[0].registrationId } });

    await scanLater(listRoom, person);
    const after = await rooms.listInside(event.id, listRoom.id);
    assertEqual(after.length, inside.length - 1, 'one fewer');
  });

  // --- corrections ----------------------------------------------------------

  await test('an admin can put somebody out by hand, and it is audited', async () => {
    const room = await rooms.createRoom({ eventId: event.id, name: 'Override Room', adminUserId: admin.id });
    const person = await makeAttendee();
    await scan(room, person);

    await rooms.overrideRoomState({
      eventId: event.id, roomId: room.id, registrationId: person.id, state: 'OUTSIDE', staffUser: admin,
    });

    const row = await prisma.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: person.id } },
    });
    assertEqual(row.state, 'OUTSIDE', 'moved out');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ROOM_ATTENDANCE_OVERRIDDEN', actorId: admin.id },
      orderBy: { id: 'desc' },
    });
    assert(audit, 'audited');
    const meta = JSON.parse(audit.metadata);
    assertEqual(meta.before, 'INSIDE', 'recording what it was');
    assertEqual(meta.after, 'OUTSIDE', 'and what it became');
  });

  await test('an override into the state they are already in is refused', async () => {
    const room = (await rooms.listRooms(event.id)).find((r) => r.name === 'Override Room');
    const row = await prisma.roomAttendance.findFirst({ where: { roomId: room.id } });

    let threw = null;
    try {
      await rooms.overrideRoomState({
        eventId: event.id, roomId: room.id, registrationId: row.eventRegistrationId,
        state: 'OUTSIDE', staffUser: admin,
      });
    } catch (err) { threw = err; }
    assert(threw, 'refused rather than writing a no-op scan row');
  });

  await test('a room with attendance cannot be deleted, only closed', async () => {
    // Deleting would cascade the attendance away and null the roomId on the
    // scan log, turning "entered Main Hall" into "entered somewhere".
    let threw = null;
    try {
      await rooms.deleteRoom({ eventId: event.id, roomId: hall.id, adminUserId: admin.id });
    } catch (err) { threw = err; }

    assert(threw, 'refused');
    assertEqual(threw.code, 'ROOM_HAS_ATTENDANCE', 'and says why');
  });

  await test('an unused room can be deleted', async () => {
    const spare = await rooms.createRoom({ eventId: event.id, name: 'Never Used', adminUserId: admin.id });
    await rooms.deleteRoom({ eventId: event.id, roomId: spare.id, adminUserId: admin.id });

    const gone = await prisma.eventRoom.findUnique({ where: { id: spare.id } });
    assertEqual(gone, null, 'deleted');
  });

  // --- sessions -------------------------------------------------------------

  await test('a scan records the session that was running at the time', async () => {
    const room = await rooms.createRoom({ eventId: event.id, name: 'Session Hall', adminUserId: admin.id });
    const session = await prisma.eventSession.create({
      data: {
        eventId: event.id, roomId: room.id, name: 'Technical Session 1',
        startTime: new Date(Date.now() - 3600000),
        endTime: new Date(Date.now() + 3600000),
      },
    });

    const person = await makeAttendee();
    const result = await scan(room, person);

    assert(result.session, 'the session is reported back to the scanner');
    assertEqual(result.session.id, session.id, 'the right one');

    const row = await prisma.eventCheckIn.findFirst({
      where: { eventRegistrationId: person.id, roomId: room.id }, orderBy: { id: 'desc' },
    });
    assertEqual(row.sessionId, session.id, 'and stored on the scan');
  });

  await test('a scan outside any session window records no session', async () => {
    const room = await rooms.createRoom({ eventId: event.id, name: 'Quiet Hall', adminUserId: admin.id });
    await prisma.eventSession.create({
      data: {
        eventId: event.id, roomId: room.id, name: 'Yesterday',
        startTime: new Date(Date.now() - 172800000),
        endTime: new Date(Date.now() - 86400000),
      },
    });

    const person = await makeAttendee();
    const result = await scan(room, person);
    assertEqual(result.session, null, 'nothing running');
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
