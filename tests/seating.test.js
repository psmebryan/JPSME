// Tests for assigned seating.
//
// The requirement this feature is actually judged on: two people tapping A15 at
// the same instant, and exactly one of them getting it. Everything else here is
// supporting cast.
//
// The second thing worth hammering is the distinction between ASSIGNED and
// OCCUPIED. A seat belongs to somebody from the moment they pick it; they are
// only *in* it once they have walked into the room. An organiser looking at the
// map needs to tell those apart, and the map derives it rather than storing it.

function stub(moduleName, exports) {
  const resolved = require.resolve(moduleName);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../src/services/sheetsSync.service', {
  syncMembership: () => {}, syncInvitations: () => {}, syncEventRegistrations: () => {},
});

const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const seating = require('../src/services/seating.service');
const rooms = require('../src/services/roomAttendance.service');

const TAG = '__seattest__';
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
let section = null;
let seq = 0;

async function makeAttendee({ status = 'REGISTERED', eventId = null } = {}) {
  const n = (seq += 1);
  const user = await prisma.user.create({
    data: {
      firstName: 'SEAT', lastName: `USER${n}`, email: `${TAG}${n}@example.test`,
      password: 'x', role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
  return prisma.eventRegistration.create({
    data: {
      userId: user.id, eventId: eventId || event.id, fullName: `SEAT USER${n}`,
      email: user.email, status, registrationNumber: `${TAG}REG${n}`,
      qrToken: crypto.randomBytes(32).toString('hex'), qrGeneratedAt: new Date(),
    },
  });
}

const seatNamed = (label) => prisma.seat.findFirst({ where: { sectionId: section.id, label } });

async function cleanup() {
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const ids = events.length ? events.map((e) => e.id) : [0];
  const sections = await prisma.seatingSection.findMany({ where: { eventId: { in: ids } }, select: { id: true } });
  const sectionIds = sections.length ? sections.map((s) => s.id) : [0];
  const seats = await prisma.seat.findMany({ where: { sectionId: { in: sectionIds } }, select: { id: true } });
  await prisma.seatAssignment.deleteMany({ where: { seatId: { in: seats.length ? seats.map((s) => s.id) : [0] } } });
  await prisma.seat.deleteMany({ where: { sectionId: { in: sectionIds } } });
  await prisma.seatingSection.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventCheckIn.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventRoom.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.eventRegistration.deleteMany({ where: { eventId: { in: ids } } });
  await prisma.event.deleteMany({ where: { id: { in: ids } } });
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const userIds = users.length ? users.map((u) => u.id) : [0];
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  await cleanup();

  admin = await prisma.user.create({
    data: {
      firstName: 'SEAT', lastName: 'ADMIN', email: `${TAG}admin@example.test`,
      password: 'x', role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(),
    },
  });
  event = await prisma.event.create({
    data: { title: `${TAG} Convention`, startDate: new Date(Date.now() + 86400000), isPublished: true },
  });

  // --- the switch -----------------------------------------------------------

  await test('seating is off until an event turns it on', async () => {
    assertEqual(event.seatingEnabled, false, 'off by default');

    const person = await makeAttendee();
    let threw = null;
    try {
      await seating.holdSeat({ eventId: event.id, seatId: 1, registrationId: person.id });
    } catch (err) { threw = err; }
    assertEqual(threw && threw.code, 'SEATING_DISABLED', 'and nothing can be claimed');
  });

  await test('turning it on is all the configuration a general-admission event needs', async () => {
    const updated = await seating.setSeatingEnabled({ eventId: event.id, enabled: true, adminUserId: admin.id });
    assertEqual(updated.seatingEnabled, true, 'on');
  });

  // --- building a plan ------------------------------------------------------

  await test('a section belongs to one event', async () => {
    section = await seating.createSection({ eventId: event.id, name: 'Main Floor', adminUserId: admin.id });
    assertEqual(section.eventId, event.id, 'owned by this event');
  });

  await test('two sections cannot share a name at one event', async () => {
    let threw = null;
    try { await seating.createSection({ eventId: event.id, name: 'Main Floor', adminUserId: admin.id }); } catch (err) { threw = err; }
    assertEqual(threw && threw.statusCode, 409, 'refused');
  });

  await test('the generator builds a rectangle of seats', async () => {
    const { created } = await seating.generateSeats({
      eventId: event.id, sectionId: section.id, rows: 3, seatsPerRow: 10, adminUserId: admin.id,
    });
    assertEqual(created, 30, 'three rows of ten');

    const a1 = await seatNamed('A01');
    assert(a1, 'labels are padded, so A02 sorts before A10');
    assertEqual(a1.rowLabel, 'A', 'the row is kept');
    assertEqual(a1.number, 1, 'and the number');
  });

  await test('row labels run past Z the way a spreadsheet does', async () => {
    assertEqual(['A', 'B', 'Z', 'AA', 'AB'].join(','), [0, 1, 25, 26, 27].map(seating.letterFor).join(','), 'A B Z AA AB');
  });

  await test('generating over existing seats is refused before anything is written', async () => {
    // Half a section is worse than none: the admin would have to work out which
    // rows made it.
    let threw = null;
    try {
      await seating.generateSeats({ eventId: event.id, sectionId: section.id, rows: 2, seatsPerRow: 10, adminUserId: admin.id });
    } catch (err) { threw = err; }
    assertEqual(threw && threw.code, 'SEATS_EXIST', 'refused');
    assertEqual(await prisma.seat.count({ where: { sectionId: section.id } }), 30, 'and nothing was added');
  });

  await test('an absurd grid is refused rather than attempted', async () => {
    const other = await seating.createSection({ eventId: event.id, name: 'Silly', adminUserId: admin.id });
    let threw = null;
    try {
      await seating.generateSeats({ eventId: event.id, sectionId: other.id, rows: 5000, seatsPerRow: 5000, adminUserId: admin.id });
    } catch (err) { threw = err; }
    assert(threw, 'refused');
    await seating.deleteSection({ eventId: event.id, sectionId: other.id, adminUserId: admin.id });
  });

  await test('a section from another event is not reachable', async () => {
    const other = await prisma.event.create({
      data: { title: `${TAG} Other`, startDate: new Date(), seatingEnabled: true },
    });
    const foreign = await seating.createSection({ eventId: other.id, name: 'Elsewhere', adminUserId: admin.id });

    let threw = null;
    try { await seating.getSection(event.id, foreign.id); } catch (err) { threw = err; }
    assertEqual(threw && threw.statusCode, 404, 'not even acknowledged');
  });

  await test('changing one event\'s plan leaves another\'s alone', async () => {
    // The architectural rule the whole design rests on.
    const other = await prisma.event.findFirst({ where: { title: `${TAG} Other` } });
    const otherSection = await prisma.seatingSection.findFirst({ where: { eventId: other.id } });
    await seating.generateSeats({
      eventId: other.id, sectionId: otherSection.id, rows: 2, seatsPerRow: 2, adminUserId: admin.id,
    });

    assertEqual(await prisma.seat.count({ where: { sectionId: section.id } }), 30, 'this event is untouched');
    assertEqual(await prisma.seat.count({ where: { sectionId: otherSection.id } }), 4, 'and the other has its own');
  });

  // --- choosing -------------------------------------------------------------

  await test('holding a seat reserves it for a few minutes', async () => {
    const person = await makeAttendee();
    const a5 = await seatNamed('A05');
    const held = await seating.holdSeat({ eventId: event.id, seatId: a5.id, registrationId: person.id });

    assertEqual(held.ok, true, 'held');
    assert(held.heldUntil > new Date(), 'with time on it');
  });

  await test('somebody else cannot take a held seat', async () => {
    const other = await makeAttendee();
    const a5 = await seatNamed('A05');
    const refused = await seating.holdSeat({ eventId: event.id, seatId: a5.id, registrationId: other.id });

    assertEqual(refused.ok, false, 'refused');
    assert(/another|pick another/i.test(refused.message), `and says to pick another, got: ${refused.message}`);
  });

  await test('an expired hold frees the seat without a sweep running', async () => {
    // Expiry is evaluated on read. A job that has to run for a hold to expire
    // is a hold that never expires on a host that restarts processes.
    const a5 = await seatNamed('A05');
    await prisma.seat.update({ where: { id: a5.id }, data: { heldUntil: new Date(Date.now() - 1000) } });

    const other = await makeAttendee();
    const taken = await seating.holdSeat({ eventId: event.id, seatId: a5.id, registrationId: other.id });
    assertEqual(taken.ok, true, 'the next person gets it');
  });

  await test('confirming turns a hold into the real thing', async () => {
    const person = await makeAttendee();
    const a6 = await seatNamed('A06');
    await seating.holdSeat({ eventId: event.id, seatId: a6.id, registrationId: person.id });
    const confirmed = await seating.confirmSeat({ eventId: event.id, seatId: a6.id, registrationId: person.id });

    assertEqual(confirmed.ok, true, 'confirmed');
    const fresh = await seatNamed('A06');
    assertEqual(fresh.assignedRegistrationId, person.id, 'assigned');
    assertEqual(fresh.heldUntil, null, 'and the hold is cleared');
  });

  await test('confirming an expired hold is refused, not silently honoured', async () => {
    const person = await makeAttendee();
    const a7 = await seatNamed('A07');
    await seating.holdSeat({ eventId: event.id, seatId: a7.id, registrationId: person.id });
    await prisma.seat.update({ where: { id: a7.id }, data: { heldUntil: new Date(Date.now() - 1000) } });

    const refused = await seating.confirmSeat({ eventId: event.id, seatId: a7.id, registrationId: person.id });
    assertEqual(refused.ok, false, 'refused');
    assertEqual(refused.reason, 'HOLD_EXPIRED', 'for the right reason');
  });

  await test('confirming twice reads as success, not as a collision', async () => {
    const person = await makeAttendee();
    const a8 = await seatNamed('A08');
    await seating.holdSeat({ eventId: event.id, seatId: a8.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: a8.id, registrationId: person.id });

    const again = await seating.confirmSeat({ eventId: event.id, seatId: a8.id, registrationId: person.id });
    assertEqual(again.ok, true, 'still fine');
    assertEqual(again.alreadyYours, true, 'and says why');
  });

  await test('choosing a second seat lets the first one go', async () => {
    // Otherwise a browse through five seats parks five of them.
    const person = await makeAttendee();
    const b1 = await seatNamed('B01');
    const b2 = await seatNamed('B02');
    await seating.holdSeat({ eventId: event.id, seatId: b1.id, registrationId: person.id });
    await seating.holdSeat({ eventId: event.id, seatId: b2.id, registrationId: person.id });

    const first = await seatNamed('B01');
    assertEqual(first.heldUntil, null, 'the first is free again');
  });

  await test('confirming a second seat moves them, and frees the first', async () => {
    // This used to be a 500. The unique index on assignedRegistrationId — the
    // thing that stops one person owning two seats — was also stopping anybody
    // from ever changing their mind, because confirm never let the old seat go.
    // It surfaced the moment attendees could pick for themselves.
    const person = await makeAttendee();
    const b3 = await seatNamed('B03');
    const b4 = await seatNamed('B04');
    await seating.holdSeat({ eventId: event.id, seatId: b3.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: b3.id, registrationId: person.id });

    await seating.holdSeat({ eventId: event.id, seatId: b4.id, registrationId: person.id });
    const moved = await seating.confirmSeat({ eventId: event.id, seatId: b4.id, registrationId: person.id });

    assertEqual(moved.ok, true, 'the move succeeded');
    assertEqual(moved.label, 'B04', 'onto the new seat');
    assertEqual(moved.movedFrom, 'B03', 'and it says where they came from');

    const freed = await seatNamed('B03');
    assertEqual(freed.assignedRegistrationId, null, 'the old seat is free for somebody else');

    const count = await prisma.seat.count({ where: { assignedRegistrationId: person.id } });
    assertEqual(count, 1, `one seat only, got ${count}`);
  });

  await test('a move that loses the race leaves the original seat alone', async () => {
    // The failure that makes the transaction worth having: release the old
    // seat, lose the new one, and somebody who arrived with a perfectly good
    // seat is left with none. The release has to roll back with the claim.
    const person = await makeAttendee();
    const b5 = await seatNamed('B05');
    const b6 = await seatNamed('B06');
    await seating.holdSeat({ eventId: event.id, seatId: b5.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: b5.id, registrationId: person.id });

    await seating.holdSeat({ eventId: event.id, seatId: b6.id, registrationId: person.id });
    // Their hold lapses in the instant before they confirm.
    await prisma.seat.update({ where: { id: b6.id }, data: { heldUntil: new Date(Date.now() - 1000) } });

    const refused = await seating.confirmSeat({ eventId: event.id, seatId: b6.id, registrationId: person.id });
    assertEqual(refused.ok, false, 'the move was refused');
    assertEqual(refused.reason, 'HOLD_EXPIRED', 'for the right reason');

    const kept = await seatNamed('B05');
    assertEqual(kept.assignedRegistrationId, person.id, 'and they still have the seat they started with');
  });

  await test('the seat they left records that they left it', async () => {
    // Otherwise the old seat simply goes quiet in its own history, and nobody
    // reading it later can tell a move from a deletion.
    const person = await makeAttendee();
    const b7 = await seatNamed('B07');
    const b8 = await seatNamed('B08');
    await seating.holdSeat({ eventId: event.id, seatId: b7.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: b7.id, registrationId: person.id });
    await seating.holdSeat({ eventId: event.id, seatId: b8.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: b8.id, registrationId: person.id });

    const history = await seating.getSeatHistory(event.id, b7.id);
    assert(history.some((h) => h.action === 'RELEASED'), `the release is logged, got ${history.map((h) => h.action).join(' → ')}`);
  });

  await test('an unpaid registration cannot reserve a seat', async () => {
    const person = await makeAttendee({ status: 'PENDING_PAYMENT' });
    const c1 = await seatNamed('C01');
    let threw = null;
    try { await seating.holdSeat({ eventId: event.id, seatId: c1.id, registrationId: person.id }); } catch (err) { threw = err; }
    assertEqual(threw && threw.code, 'UNPAID', 'refused, same rule as the door');
  });

  await test('a blocked seat cannot be held', async () => {
    const c2 = await seatNamed('C02');
    await seating.setSeatBlocked({ eventId: event.id, seatId: c2.id, blocked: true, adminUserId: admin.id });

    const person = await makeAttendee();
    const refused = await seating.holdSeat({ eventId: event.id, seatId: c2.id, registrationId: person.id });
    assertEqual(refused.ok, false, 'refused');
    assertEqual(refused.reason, 'BLOCKED', 'because it is blocked');
  });

  // --- the race -------------------------------------------------------------

  await test('two people claiming one seat at the same instant: one wins', async () => {
    // The requirement the whole design exists for.
    const a = await makeAttendee();
    const b = await makeAttendee();
    const c3 = await seatNamed('C03');

    const results = await Promise.all([
      seating.holdSeat({ eventId: event.id, seatId: c3.id, registrationId: a.id }),
      seating.holdSeat({ eventId: event.id, seatId: c3.id, registrationId: b.id }),
    ]);

    const winners = results.filter((r) => r.ok).length;
    assertEqual(winners, 1, `exactly one, got ${winners}`);
  });

  await test('ten at once still produces one holder', async () => {
    const people = await Promise.all(Array.from({ length: 10 }, () => makeAttendee()));
    const c4 = await seatNamed('C04');

    const results = await Promise.all(
      people.map((p) => seating.holdSeat({ eventId: event.id, seatId: c4.id, registrationId: p.id })
        .catch(() => ({ ok: false })))
    );

    assertEqual(results.filter((r) => r.ok).length, 1, 'one winner');
    const seat = await seatNamed('C04');
    assert(seat.heldByRegistrationId, 'and the seat has exactly one holder');
  });

  await test('two confirming the same seat at once: one gets it', async () => {
    const a = await makeAttendee();
    const b = await makeAttendee();
    const c5 = await seatNamed('C05');

    // Both hold it in turn (the second only after the first expires), so both
    // genuinely believe they may confirm — the nastiest version of the race.
    await seating.holdSeat({ eventId: event.id, seatId: c5.id, registrationId: a.id });
    await prisma.seat.update({ where: { id: c5.id }, data: { heldUntil: new Date(Date.now() + 60000), heldByRegistrationId: b.id } });
    await prisma.seat.update({ where: { id: c5.id }, data: { heldByRegistrationId: a.id } });

    const results = await Promise.all([
      seating.confirmSeat({ eventId: event.id, seatId: c5.id, registrationId: a.id }).catch(() => ({ ok: false })),
      seating.confirmSeat({ eventId: event.id, seatId: c5.id, registrationId: b.id }).catch(() => ({ ok: false })),
    ]);

    const seat = await seatNamed('C05');
    assert(seat.assignedRegistrationId === a.id || seat.assignedRegistrationId === b.id, 'one of them has it');
    assertEqual(results.filter((r) => r.ok).length, 1, 'and only one was told yes');
  });

  // --- assigned is not occupied ---------------------------------------------

  await test('a seat is ASSIGNED until its holder walks into the room', async () => {
    // The distinction §20 of the brief is about, and the reason occupancy is
    // derived rather than stored.
    const room = await rooms.createRoom({ eventId: event.id, name: 'Main Hall', adminUserId: admin.id });
    await prisma.seatingSection.update({ where: { id: section.id }, data: { roomId: room.id } });

    const person = await makeAttendee();
    const d1 = await seatNamed('C06');
    await seating.holdSeat({ eventId: event.id, seatId: d1.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: d1.id, registrationId: person.id });

    let map = await seating.getSeatMap(event.id);
    let seat = map[0].rows.flatMap((r) => r.seats).find((s) => s.label === 'C06');
    assertEqual(seat.state, 'ASSIGNED', 'theirs, but they are not here');

    // Walk them in through the real door.
    const registration = await prisma.eventRegistration.findUnique({ where: { id: person.id } });
    await rooms.roomScan({
      eventId: event.id, roomId: room.id, rawScan: registration.qrToken, staffUser: admin,
    });

    map = await seating.getSeatMap(event.id);
    seat = map[0].rows.flatMap((r) => r.seats).find((s) => s.label === 'C06');
    assertEqual(seat.state, 'OCCUPIED', 'now they are in it');
  });

  await test('leaving the room turns the seat to AWAY, not AVAILABLE', async () => {
    // The seat stays theirs when they step out — what changes is that the map
    // says so, because a seat that looks empty across a hall and is not free is
    // exactly what an organiser needs to see. It only becomes AVAILABLE after
    // the grace period, which tests/seatLifecycle.test.js covers.
    const seat = await seatNamed('C06');
    const registration = await prisma.eventRegistration.findUnique({ where: { id: seat.assignedRegistrationId } });
    const room = await prisma.eventRoom.findFirst({ where: { eventId: event.id, name: 'Main Hall' } });

    // Aged first, so this reads as leaving later rather than as a scanner
    // double-firing — which the duplicate-scan window would correctly absorb.
    await prisma.eventCheckIn.updateMany({
      where: { eventRegistrationId: registration.id },
      data: { scannedAt: new Date(Date.now() - 60000) },
    });
    await rooms.roomScan({ eventId: event.id, roomId: room.id, rawScan: registration.qrToken, staffUser: admin });

    const map = await seating.getSeatMap(event.id);
    const view = map[0].rows.flatMap((r) => r.seats).find((s) => s.label === 'C06');
    assertEqual(view.state, 'AWAY', 'still theirs, and visibly stepped out');
    assert(view.state !== 'AVAILABLE', 'and certainly not free for somebody else');

    const fresh = await seatNamed('C06');
    assertEqual(fresh.assignedRegistrationId, registration.id, 'the assignment is untouched');
  });

  // --- the map --------------------------------------------------------------

  await test('the map counts every state', async () => {
    const map = await seating.getSeatMap(event.id);
    const counts = map[0].counts;
    assertEqual(counts.total, 30, 'all thirty seats');
    assert(counts.blocked >= 1, 'the blocked one is counted');
    assert(counts.assigned >= 1, 'and the assigned ones');
  });

  await test('the map does not leak who is sitting where', async () => {
    // An attendee picking a seat has no business learning who is in A14.
    const map = await seating.getSeatMap(event.id);
    const anyName = map[0].rows.flatMap((r) => r.seats).some((s) => s.occupant);
    assertEqual(anyName, false, 'no names by default');
  });

  await test('an admin map does carry the names', async () => {
    const map = await seating.getSeatMap(event.id, { includeNames: true });
    const named = map[0].rows.flatMap((r) => r.seats).filter((s) => s.occupant);
    assert(named.length >= 1, 'names present for the admin view');
    assert(named[0].occupant.name, 'with something to show');
  });

  await test('the map marks the caller\'s own seat', async () => {
    const seat = await seatNamed('C06');
    const map = await seating.getSeatMap(event.id, { forRegistrationId: seat.assignedRegistrationId });
    const mine = map[0].rows.flatMap((r) => r.seats).filter((s) => s.mine);
    assertEqual(mine.length, 1, 'exactly one is theirs');
    assertEqual(mine[0].label, 'C06', 'and it is the right one');
  });

  // --- corrections ----------------------------------------------------------

  await test('an admin can move somebody to another seat', async () => {
    const seat = await seatNamed('C06');
    const registrationId = seat.assignedRegistrationId;
    const target = await seatNamed('C08');

    await seating.assignSeat({ eventId: event.id, seatId: target.id, registrationId, actorId: admin.id });

    const oldSeat = await seatNamed('C06');
    const newSeat = await seatNamed('C08');
    assertEqual(oldSeat.assignedRegistrationId, null, 'the old one is free');
    assertEqual(newSeat.assignedRegistrationId, registrationId, 'and they are in the new one');
  });

  await test('releasing frees the seat and is recorded', async () => {
    const seat = await seatNamed('C08');
    const registrationId = seat.assignedRegistrationId;
    await seating.releaseSeat({ eventId: event.id, seatId: seat.id, actorId: admin.id });

    const fresh = await seatNamed('C08');
    assertEqual(fresh.assignedRegistrationId, null, 'free');

    const history = await seating.getSeatHistory(event.id, seat.id);
    assert(history.some((h) => h.action === 'RELEASED' && h.by), 'the release names the admin who did it');
    assert(history.some((h) => h.action === 'ASSIGNED'), 'and the assignment before it is still there');
  });

  await test('an attendee cannot release somebody else\'s seat', async () => {
    const person = await makeAttendee();
    const other = await makeAttendee();
    const d2 = await seatNamed('C09');
    await seating.holdSeat({ eventId: event.id, seatId: d2.id, registrationId: person.id });
    await seating.confirmSeat({ eventId: event.id, seatId: d2.id, registrationId: person.id });

    let threw = null;
    try {
      await seating.releaseSeat({ eventId: event.id, seatId: d2.id, registrationId: other.id });
    } catch (err) { threw = err; }
    assert(threw, 'refused');

    const fresh = await seatNamed('C09');
    assertEqual(fresh.assignedRegistrationId, person.id, 'still theirs');
  });

  await test('a section with assigned seats cannot be deleted', async () => {
    // Deleting would cascade the seats away, and somebody would arrive holding
    // a ticket for a seat that no longer exists.
    let threw = null;
    try { await seating.deleteSection({ eventId: event.id, sectionId: section.id, adminUserId: admin.id }); } catch (err) { threw = err; }
    assertEqual(threw && threw.code, 'SECTION_HAS_ASSIGNMENTS', 'refused, and says what to do');
  });

  await test('the history reads as a story', async () => {
    const seat = await seatNamed('C09');
    const history = await seating.getSeatHistory(event.id, seat.id);
    assertEqual(history.map((h) => h.action).join(' → '), 'HELD → ASSIGNED', 'held, then taken');
    assert(history[0].who, 'naming who');
    assertEqual(history[0].by, null, 'and no admin, because they chose it themselves');
  });

  await test('a person can find their own seat', async () => {
    const seat = await seatNamed('C09');
    const found = await seating.getSeatFor(seat.assignedRegistrationId);
    assertEqual(found.label, 'C09', 'the right seat');
    assertEqual(found.room, 'Main Hall', 'and where it is');
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
