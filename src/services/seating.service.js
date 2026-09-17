const prisma = require('../config/prisma');
const config = require('../config');
const AppError = require('../utils/AppError');
const auditService = require('./audit.service');

// Assigned seating, per event.
//
// The rule the whole thing is built on: an event owns its own seating, and no
// two events share a seat. There is no global seat map. A 100-seat seminar, a
// 2,000-seat convention, banquet tables and an event with no seating at all are
// the same code with different rows.
//
// Where state lives, and why:
//
//   Seat            who has it RIGHT NOW — held, assigned, blocked. One row,
//                   three columns, changed only by conditional UPDATEs.
//   SeatAssignment  append-only history of how it got there.
//
// Splitting them is not tidiness. Claiming a seat has to be a single statement
// that either wins or loses, or two people tapping A15 at the same instant both
// get it — and that is the failure this feature would actually be judged on.
// Deriving "who has A15" by reading the log would mean read-then-write, which
// is exactly the race.

// How long a seat is held while somebody is deciding.
//
// Long enough to read a map, pick, and confirm; short enough that a browser
// closed mid-choice does not park a seat for the afternoon. Expiry is evaluated
// on read rather than swept by a job — a sweep on a host that restarts
// processes without warning is a hold that never expires at all, which is worse
// than one that lingers a few seconds.
const HOLD_MS = 5 * 60 * 1000;

// --- reading ----------------------------------------------------------------

// The states a seat can be in, worked out at read time.
//
// OCCUPIED is not stored. It means "assigned to somebody who is inside", which
// is two facts that already live elsewhere — storing it as a third would give
// the map its own opinion, and the map would eventually be wrong.
//
//   AVAILABLE  nobody's
//   HELD       somebody is choosing it right now
//   ASSIGNED   theirs, and they have not been seen inside yet
//   OCCUPIED   theirs, and they are inside
//   AWAY       theirs, and they have stepped out — still theirs, for now
//   BLOCKED    not in use
//
// AWAY is the one an organiser actually acts on: it is a seat that looks empty
// from across the room but is not free. It becomes free on its own once the
// grace period runs out — see releaseAbandonedSeats.
function seatState(seat, now, presence) {
  if (seat.isBlocked) return 'BLOCKED';
  if (seat.assignedRegistrationId) {
    const where = presence.get(seat.assignedRegistrationId);
    if (where && where.state === 'INSIDE') return 'OCCUPIED';
    if (where && where.state === 'AWAY') return 'AWAY';
    return 'ASSIGNED';
  }
  if (seat.heldUntil && seat.heldUntil > now) return 'HELD';
  return 'AVAILABLE';
}

// Where everybody with a seat currently is, in one query rather than one per
// seat.
//
// Read from the hall doors, which are now the only doors an event has. There
// was a venue entrance too, and its scans drove this — but for a single-hall
// event it asked a question the hall door had already answered, so the station
// was removed and this reads the halls directly.
//
//   INSIDE  in one of this event's halls right now
//   AWAY    has been in one and walked out — the seat is still theirs, for now
//   absent  never came in at all, which is ASSIGNED, not abandoned
async function presenceFor(eventId) {
  const rows = await prisma.roomAttendance.findMany({
    where: { room: { eventId: Number(eventId) } },
    select: { eventRegistrationId: true, state: true, lastExitedAt: true },
  });

  const presence = new Map();
  rows.forEach((row) => {
    // INSIDE anywhere wins: somebody in hall B has plainly not gone home just
    // because they left hall A.
    if (row.state === 'INSIDE') {
      presence.set(row.eventRegistrationId, { state: 'INSIDE', since: null });
      return;
    }
    const seen = presence.get(row.eventRegistrationId);
    if (seen && seen.state === 'INSIDE') return;
    if (!row.lastExitedAt) return;
    // The most recent exit across every hall — that is the one the grace period
    // is counted from.
    if (!seen || !seen.since || row.lastExitedAt > seen.since) {
      presence.set(row.eventRegistrationId, { state: 'AWAY', since: row.lastExitedAt });
    }
  });
  return presence;
}

// The seats an organiser can actually do something about: taken, but whoever
// they belong to has walked out.
//
// Scanning a plan of several hundred squares for orange ones is not a job
// anybody can do at a live event, which is why this exists as a list. Ordered
// longest-away first, because that is the order they become reassignable in.
//
// Nothing here is released — this only reports. Freeing a seat early is a
// deliberate act, and it goes through releaseSeat like any other.
async function listSteppedOut(eventId) {
  const graceMs = config.jobs.seatGraceMs;
  // Released first, so this list and the seat map agree. Without it a seat
  // already past its grace period shows here as "still theirs" right up until
  // somebody looks at the plan, which frees it — two screens disagreeing about
  // the same seat is worse than either being a moment stale.
  await releaseAbandonedSeats(eventId);

  const presence = await presenceFor(eventId);

  const away = [...presence.entries()].filter(([, where]) => where.state === 'AWAY');
  if (!away.length) return [];

  const seats = await prisma.seat.findMany({
    where: {
      section: { eventId: Number(eventId) },
      assignedRegistrationId: { in: away.map(([id]) => id) },
    },
    include: {
      section: { select: { name: true } },
      assignedTo: { select: { id: true, fullName: true, registrationNumber: true } },
    },
  });

  const since = new Map(away);
  const now = Date.now();

  return seats
    .map((seat) => {
      const at = since.get(seat.assignedRegistrationId).since;
      const awayMs = now - at.getTime();
      return {
        seatId: seat.id,
        label: seat.label,
        section: seat.section.name,
        registrationId: seat.assignedRegistrationId,
        name: seat.assignedTo ? seat.assignedTo.fullName : null,
        registrationNumber: seat.assignedTo ? seat.assignedTo.registrationNumber : null,
        leftAt: at,
        minutesAway: Math.floor(awayMs / 60000),
        // How much longer it is theirs. The useful number is the one facing
        // forwards: an operator deciding whether to wait or reassign wants to
        // know how long the wait is, not how long it has already been.
        freesInMinutes: Math.max(0, Math.ceil((graceMs - awayMs) / 60000)),
      };
    })
    .sort((a, b) => a.leftAt - b.leftAt);
}

// Gives back the seats of people who left and did not come back.
//
// Written rather than derived, because the point is that the seat becomes
// assignable to somebody else — a state the map merely *displayed* would still
// refuse the next person who tried to take it.
//
// There is no job runner in this app, so this runs at the start of the reads
// and writes that care, the same way an expired hold is cleaned up when it is
// next looked at. A seat nobody is looking at costs nothing by staying assigned
// a little longer.
async function releaseAbandonedSeats(eventId) {
  const graceMs = config.jobs.seatGraceMs;
  const cutoff = new Date(Date.now() - graceMs);

  // Out of every hall, and last seen leaving one longer ago than the grace
  // period. Somebody still INSIDE anywhere is excluded outright.
  const rows = await prisma.roomAttendance.findMany({
    where: { room: { eventId: Number(eventId) } },
    select: { eventRegistrationId: true, state: true, lastExitedAt: true },
  });

  const stillInside = new Set();
  const lastExit = new Map();
  rows.forEach((row) => {
    if (row.state === 'INSIDE') { stillInside.add(row.eventRegistrationId); return; }
    if (!row.lastExitedAt) return;
    const seen = lastExit.get(row.eventRegistrationId);
    if (!seen || row.lastExitedAt > seen) lastExit.set(row.eventRegistrationId, row.lastExitedAt);
  });

  const ids = [...lastExit.entries()]
    .filter(([id, at]) => !stillInside.has(id) && at < cutoff)
    .map(([id]) => id);
  if (!ids.length) return 0;

  const seats = await prisma.seat.findMany({
    where: { assignedRegistrationId: { in: ids }, section: { eventId: Number(eventId) } },
    select: { id: true, assignedRegistrationId: true },
  });
  if (!seats.length) return 0;

  let released = 0;
  for (const seat of seats) {
    // Conditional on still being assigned to the same person, so a seat somebody
    // was reassigned to in the meantime is not taken off them.
    const freed = await prisma.seat.updateMany({
      where: { id: seat.id, assignedRegistrationId: seat.assignedRegistrationId },
      data: { assignedRegistrationId: null, heldByRegistrationId: null, heldUntil: null },
    });
    if (freed.count !== 1) continue;
    released += 1;
    // Logged like any other release, so the seat's history says where it went
    // rather than the person simply vanishing from it.
    await prisma.seatAssignment.create({
      data: { seatId: seat.id, registrationId: seat.assignedRegistrationId, action: 'RELEASED' },
    });
  }
  return released;
}

// The whole map for an event, grouped the way it is drawn: sections, then rows.
//
// `forRegistrationId` marks the caller's own seat, so an attendee's map can
// show "yours" distinctly from "somebody else's" without the page having to
// work it out — and without ever sending it other people's names.
async function getSeatMap(eventId, { forRegistrationId = null, includeNames = false } = {}) {
  // Before drawing anything: seats whose owner left and stayed away are free
  // again, and a map that shows them as taken is a map that sends the next
  // person to a seat the service will refuse them.
  await releaseAbandonedSeats(eventId);

  const sections = await prisma.seatingSection.findMany({
    where: { eventId: Number(eventId) },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    include: {
      room: { select: { id: true, name: true } },
      seats: {
        orderBy: [{ rowLabel: 'asc' }, { number: 'asc' }, { label: 'asc' }],
        include: includeNames
          ? { assignedTo: { select: { id: true, fullName: true, registrationNumber: true } } }
          : undefined,
      },
    },
  });

  const presence = await presenceFor(eventId);

  const now = new Date();

  return sections.map((section) => {
    const rows = new Map();
    section.seats.forEach((seat) => {
      const state = seatState(seat, now, presence);
      const key = seat.rowLabel || '';
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({
        id: seat.id,
        label: seat.label,
        number: seat.number,
        type: seat.type,
        state,
        // Never the holder's identity unless the caller is entitled to it. An
        // attendee picking a seat has no business learning who is in A14.
        mine: Boolean(forRegistrationId) && seat.assignedRegistrationId === Number(forRegistrationId),
        // When they walked out, so a staff screen can say "away 14 minutes"
        // rather than just "away". Admin-only for the same reason names are:
        // an attendee has no business knowing another attendee's movements.
        awaySince: includeNames && state === 'AWAY' && presence.get(seat.assignedRegistrationId)
          ? presence.get(seat.assignedRegistrationId).since
          : null,
        occupant: includeNames && seat.assignedTo
          ? { id: seat.assignedTo.id, name: seat.assignedTo.fullName, registrationNumber: seat.assignedTo.registrationNumber }
          : null,
      });
    });

    const seats = section.seats.map((seat) => seatState(seat, now, presence));
    return {
      id: section.id,
      name: section.name,
      room: section.room,
      rows: [...rows.entries()].map(([label, list]) => ({ label, seats: list })),
      counts: {
        total: seats.length,
        available: seats.filter((s) => s === 'AVAILABLE').length,
        held: seats.filter((s) => s === 'HELD').length,
        assigned: seats.filter((s) => s === 'ASSIGNED').length,
        occupied: seats.filter((s) => s === 'OCCUPIED').length,
        away: seats.filter((s) => s === 'AWAY').length,
        blocked: seats.filter((s) => s === 'BLOCKED').length,
      },
    };
  });
}

// The seats a desk can offer right now — unblocked, unassigned, and not under
// a live hold. Ordered the way a plan is read, so the first suggestion is the
// front of the room rather than whichever row was generated first.
//
// Capped rather than returning every free seat: a desk picker with two thousand
// entries is not a picker, and the staff member is choosing from the front of a
// section, not scrolling.
async function listAvailableSeats(eventId, { sectionId = null, limit = 300 } = {}) {
  // The desk is about to be shown these as free, so the ones whose owner has
  // gone home need to actually be free first.
  await releaseAbandonedSeats(eventId);

  const now = new Date();
  const where = {
    section: { eventId: Number(eventId) },
    isBlocked: false,
    assignedRegistrationId: null,
    OR: [{ heldUntil: null }, { heldUntil: { lt: now } }],
  };
  if (sectionId) where.sectionId = Number(sectionId);

  const seats = await prisma.seat.findMany({
    where,
    orderBy: [{ sectionId: 'asc' }, { rowLabel: 'asc' }, { number: 'asc' }],
    take: Math.min(1000, Number(limit) || 300),
    include: { section: { select: { id: true, name: true } } },
  });

  return seats.map((seat) => ({
    id: seat.id,
    label: seat.label,
    type: seat.type,
    rowLabel: seat.rowLabel,
    sectionId: seat.sectionId,
    sectionName: seat.section.name,
  }));
}

// Everything an attendee needs to know about their own place at an event:
// their seat, whether they have arrived, which room they are in, and how they
// have moved. Assembled here rather than in the page so the ticket, the profile
// and the PDF cannot drift into telling them different things.
//
// Deliberately scoped to one registration and carrying nobody else's details —
// this is the one seating read a member is allowed to make.
async function getAttendeeView(registrationId) {
  const registration = await prisma.eventRegistration.findUnique({
    where: { id: Number(registrationId) },
    select: { id: true, eventId: true, checkedInAt: true },
  });
  if (!registration) return null;

  const seat = await getSeatFor(registration.id);

  // Where they are now, and where they have been. Both read from the same
  // tables the doors write to, so a ticket cannot claim they are inside a hall
  // they walked out of.
  const attendance = await prisma.roomAttendance.findMany({
    where: { eventRegistrationId: registration.id },
    include: { room: { select: { id: true, name: true } } },
    orderBy: { updatedAt: 'desc' },
  });

  const currentRoom = attendance.find((a) => a.state === 'INSIDE');

  const history = await prisma.eventCheckIn.findMany({
    where: { eventRegistrationId: registration.id, result: 'SUCCESS' },
    orderBy: { scannedAt: 'asc' },
    include: { room: { select: { name: true } }, session: { select: { name: true } } },
  });

  return {
    seat,
    checkedInAt: registration.checkedInAt,
    currentRoom: currentRoom ? { name: currentRoom.room.name, since: currentRoom.lastEnteredAt } : null,
    history: history.map((row) => ({
      at: row.scannedAt,
      action: row.action,
      // A row with no room is the venue door rather than a hall.
      room: row.room ? row.room.name : null,
      session: row.session ? row.session.name : null,
    })),
  };
}

async function getSeatFor(registrationId) {
  const seat = await prisma.seat.findFirst({
    where: { assignedRegistrationId: Number(registrationId) },
    include: { section: { include: { room: { select: { id: true, name: true } } } } },
  });
  if (!seat) return null;
  return {
    id: seat.id,
    label: seat.label,
    type: seat.type,
    section: seat.section.name,
    room: seat.section.room ? seat.section.room.name : null,
  };
}

// --- configuration ----------------------------------------------------------

async function setSeatingEnabled({ eventId, enabled, adminUserId }) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const updated = await prisma.event.update({
    where: { id: event.id },
    data: { seatingEnabled: Boolean(enabled) },
  });

  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: { eventId: event.id, seatingEnabled: updated.seatingEnabled },
  });
  return updated;
}

async function listSections(eventId) {
  return prisma.seatingSection.findMany({
    where: { eventId: Number(eventId) },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    include: {
      room: { select: { id: true, name: true } },
      _count: { select: { seats: true } },
    },
  });
}

async function getSection(eventId, sectionId) {
  const section = await prisma.seatingSection.findUnique({ where: { id: Number(sectionId) } });
  // Checked, never trusted: a section id from a URL belonging to another event
  // must not be reachable from this one.
  if (!section || section.eventId !== Number(eventId)) throw new AppError('Section not found', 404);
  return section;
}

async function createSection({ eventId, name, roomId = null, displayOrder = 0, adminUserId }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new AppError('Section name is required', 400);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  if (roomId) {
    const room = await prisma.eventRoom.findUnique({ where: { id: Number(roomId) } });
    if (!room || room.eventId !== Number(eventId)) throw new AppError('Room not found for this event', 404);
  }

  const clash = await prisma.seatingSection.findFirst({ where: { eventId: Number(eventId), name: trimmed } });
  // Caught here as well as by the unique index, so the message names the
  // problem rather than surfacing a constraint violation.
  if (clash) throw new AppError('A section with that name already exists for this event', 409);

  const section = await prisma.seatingSection.create({
    data: {
      eventId: Number(eventId),
      roomId: roomId ? Number(roomId) : null,
      name: trimmed,
      displayOrder: Number(displayOrder) || 0,
    },
  });

  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), sectionId: section.id, created: section.name },
  });
  return section;
}

// Changing a section after it exists — in practice, attaching the room somebody
// forgot to pick, or that was lost when a room was deleted.
//
// Worth having rather than "delete and rebuild": rebuilding means regenerating
// the seats, and the seats may already be on people's tickets.
async function updateSection({ eventId, sectionId, data = {}, adminUserId }) {
  const section = await getSection(eventId, sectionId);
  const patch = {};

  if (data.name !== undefined) {
    const trimmed = String(data.name || '').trim();
    if (!trimmed) throw new AppError('Section name is required', 400);
    patch.name = trimmed;
  }
  if (data.displayOrder !== undefined) patch.displayOrder = Number(data.displayOrder) || 0;
  if (data.roomId !== undefined) {
    if (data.roomId === null || data.roomId === '') {
      patch.roomId = null;
    } else {
      const room = await prisma.eventRoom.findUnique({ where: { id: Number(data.roomId) } });
      if (!room || room.eventId !== Number(eventId)) throw new AppError('Room not found for this event', 404);
      patch.roomId = room.id;
    }
  }

  const updated = await prisma.seatingSection.update({ where: { id: section.id }, data: patch });
  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), sectionId: section.id, before: { roomId: section.roomId }, after: { roomId: updated.roomId } },
  });
  return updated;
}

async function deleteSection({ eventId, sectionId, adminUserId }) {
  const section = await getSection(eventId, sectionId);

  // Refused once anybody holds a seat in it. Deleting would cascade their seats
  // away — the attendee would arrive with A15 on their ticket and no A15 would
  // exist. Blocking the seats is the thing an admin actually wants.
  const taken = await prisma.seat.count({
    where: { sectionId: section.id, assignedRegistrationId: { not: null } },
  });
  if (taken > 0) {
    throw new AppError(
      `${taken} seat${taken === 1 ? '' : 's'} in this section ${taken === 1 ? 'is' : 'are'} assigned. Release them first, or block the section instead.`,
      409,
      'SECTION_HAS_ASSIGNMENTS'
    );
  }

  await prisma.seatingSection.delete({ where: { id: section.id } });
  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), sectionId: section.id, deleted: section.name },
  });
  return { id: section.id };
}

// Row labels: A, B, ... Z, AA, AB. Spreadsheet columns, because that is the
// convention every venue already prints on its chairs.
function letterFor(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Builds a block of seats in one go.
//
// The common case by a wide margin: a venue is rows of equal length, and typing
// six hundred seats by hand is not a thing anybody will do. Uneven rows are
// made by generating the rectangle and blocking or deleting what is not there.
async function generateSeats({
  eventId, sectionId, rows, seatsPerRow, startNumber = 1,
  rowLabelStyle = 'LETTERS', rowLabelStart = 0, type = 'REGULAR', pad = 2, adminUserId,
}) {
  const section = await getSection(eventId, sectionId);

  const rowCount = Number(rows);
  const perRow = Number(seatsPerRow);
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 200) {
    throw new AppError('Rows must be between 1 and 200', 400);
  }
  if (!Number.isInteger(perRow) || perRow < 1 || perRow > 200) {
    throw new AppError('Seats per row must be between 1 and 200', 400);
  }

  const start = Number(startNumber) || 1;
  const labels = [];
  for (let r = 0; r < rowCount; r += 1) {
    const rowLabel = rowLabelStyle === 'NUMBERS'
      ? String(Number(rowLabelStart) + r + 1)
      : letterFor(Number(rowLabelStart) + r);
    for (let s = 0; s < perRow; s += 1) {
      const number = start + s;
      labels.push({
        sectionId: section.id,
        rowLabel,
        number,
        // "A01", not "A1" — so a printed list sorts the way a person expects
        // and A10 does not come before A2.
        label: `${rowLabel}${String(number).padStart(Number(pad) || 0, '0')}`,
        type,
      });
    }
  }

  // Told before anything is written, rather than failing halfway through and
  // leaving the section half-built.
  const existing = await prisma.seat.findMany({
    where: { sectionId: section.id, label: { in: labels.map((l) => l.label) } },
    select: { label: true },
  });
  if (existing.length) {
    throw new AppError(
      `${existing.length} of those seats already exist (${existing.slice(0, 3).map((e) => e.label).join(', ')}${existing.length > 3 ? '…' : ''}).`,
      409,
      'SEATS_EXIST'
    );
  }

  // createMany rather than a loop: 2,000 seats is one statement, and none of
  // them needs its id back.
  const created = await prisma.seat.createMany({ data: labels });

  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: {
      eventId: Number(eventId), sectionId: section.id,
      generated: created.count, rows: rowCount, seatsPerRow: perRow,
    },
  });
  return { created: created.count };
}

async function deleteSeat({ eventId, seatId, adminUserId }) {
  const seat = await loadSeat(eventId, seatId);
  if (seat.assignedRegistrationId) {
    throw new AppError('That seat is assigned. Release it first.', 409, 'SEAT_ASSIGNED');
  }
  await prisma.seat.delete({ where: { id: seat.id } });
  await auditService.log({
    action: 'SEATING_UPDATED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), seatId: seat.id, deleted: seat.label },
  });
  return { id: seat.id };
}

// Blocking leaves an assignment alone on purpose: closing a row after tickets
// went out should stop new people taking seats in it without silently evicting
// the ones already there. The map shows both facts.
async function setSeatBlocked({ eventId, seatId, blocked, adminUserId }) {
  const seat = await loadSeat(eventId, seatId);
  const updated = await prisma.seat.update({
    where: { id: seat.id },
    data: { isBlocked: Boolean(blocked) },
  });

  await prisma.seatAssignment.create({
    data: { seatId: seat.id, action: blocked ? 'BLOCKED' : 'UNBLOCKED', actorId: adminUserId || null },
  });
  return updated;
}

// --- claiming ---------------------------------------------------------------

async function loadSeat(eventId, seatId) {
  const seat = await prisma.seat.findUnique({
    where: { id: Number(seatId) },
    include: { section: true },
  });
  if (!seat || seat.section.eventId !== Number(eventId)) throw new AppError('Seat not found', 404);
  return seat;
}

async function assertSeatable(eventId, registrationId) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  if (!event.seatingEnabled) throw new AppError('This event does not use assigned seating', 400, 'SEATING_DISABLED');

  const registration = await prisma.eventRegistration.findUnique({ where: { id: Number(registrationId) } });
  if (!registration || registration.eventId !== Number(eventId)) {
    throw new AppError('Registration not found for this event', 404);
  }
  // The same gate the door applies. Somebody who has not paid does not get to
  // reserve the best seat in the hall and settle up later.
  if (registration.status === 'PENDING_PAYMENT') {
    throw new AppError('Complete your payment before choosing a seat', 403, 'UNPAID');
  }
  if (registration.status !== 'REGISTERED') {
    throw new AppError('This registration cannot choose a seat', 403);
  }
  return registration;
}

// A tentative claim while somebody decides.
//
// The whole statement is the concurrency control. It matches only a seat that
// is unblocked, unassigned, and either never held or held by an expired hold —
// so of two people tapping A15 in the same instant, MySQL lets exactly one
// through and the other gets a row count of zero. There is no window between
// checking and taking, because there is no check.
async function holdSeat({ eventId, seatId, registrationId }) {
  await assertSeatable(eventId, registrationId);
  // The seat being claimed may be one whose owner left and stayed away. Freeing
  // it here is what makes the claim below succeed rather than refuse.
  await releaseAbandonedSeats(eventId);
  const seat = await loadSeat(eventId, seatId);

  const now = new Date();
  const until = new Date(now.getTime() + HOLD_MS);

  // Any seat this registration was already holding is let go first — picking a
  // different seat should not leave the first one parked for five minutes.
  await releaseExpiredOrOwnHolds(registrationId, seat.id);

  const claim = await prisma.seat.updateMany({
    where: {
      id: seat.id,
      isBlocked: false,
      assignedRegistrationId: null,
      OR: [
        { heldUntil: null },
        { heldUntil: { lt: now } },
        // Re-holding a seat you already hold extends it rather than failing,
        // which is what a page refresh looks like from here.
        { heldByRegistrationId: Number(registrationId) },
      ],
    },
    data: { heldByRegistrationId: Number(registrationId), heldUntil: until },
  });

  if (claim.count !== 1) {
    const current = await prisma.seat.findUnique({ where: { id: seat.id } });
    return {
      ok: false,
      reason: current.isBlocked ? 'BLOCKED' : (current.assignedRegistrationId ? 'TAKEN' : 'HELD_BY_SOMEONE_ELSE'),
      message: current.isBlocked
        ? 'That seat is not available.'
        : 'Somebody just took that seat. Please pick another.',
    };
  }

  await prisma.seatAssignment.create({
    data: { seatId: seat.id, registrationId: Number(registrationId), action: 'HELD' },
  });

  return { ok: true, seatId: seat.id, label: seat.label, heldUntil: until, holdMs: HOLD_MS };
}

// Lets go of any hold this registration has, other than one it is about to use.
// Called before taking a new hold so choosing again does not strand the first
// seat, and on release so a cancelled choice frees immediately.
async function releaseExpiredOrOwnHolds(registrationId, exceptSeatId = null) {
  const where = {
    heldByRegistrationId: Number(registrationId),
    assignedRegistrationId: null,
  };
  if (exceptSeatId) where.id = { not: Number(exceptSeatId) };

  await prisma.seat.updateMany({ where, data: { heldByRegistrationId: null, heldUntil: null } });
}

// A refusal that has to undo the writes made before it was discovered.
// Prisma rolls an interactive transaction back only when the callback throws,
// so a "no" that must not keep its half-finished work is carried out as an
// exception and unwrapped by the caller.
class SeatRefusal extends Error {
  constructor(payload) {
    super(payload.message || 'Seat refused');
    this.payload = payload;
  }
}

// Turns a hold into the real thing.
//
// Constrained to the hold this registration actually has, and to one that has
// not expired — so a page left open for an hour cannot confirm a seat somebody
// else has since taken.
//
// Moving seats is the reason this is a transaction. Seat.assignedRegistrationId
// is unique, which is what stops one person holding two seats — so confirming a
// second seat cannot succeed until the first is let go. Doing that as two plain
// statements has a failure that matters: release the old seat, lose the race
// for the new one, and the person is left with no seat at all, having started
// with a perfectly good one. Inside a transaction the lost race throws, the
// release rolls back, and they keep what they had.
async function confirmSeat({ eventId, seatId, registrationId, actorId = null }) {
  await assertSeatable(eventId, registrationId);
  const seat = await loadSeat(eventId, seatId);
  const now = new Date();
  const regId = Number(registrationId);

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // What they are sitting on now, if anything. Read inside the transaction
      // so it cannot change under us between the read and the release.
      const previous = await tx.seat.findFirst({ where: { assignedRegistrationId: regId } });
      const moving = previous && previous.id !== seat.id;

      if (moving) {
        await tx.seat.updateMany({
          where: { id: previous.id, assignedRegistrationId: regId },
          data: { assignedRegistrationId: null, heldByRegistrationId: null, heldUntil: null },
        });
      }

      // The whole statement is still the concurrency control: only a seat that
      // is unassigned and held by this registration, unexpired, matches.
      const claim = await tx.seat.updateMany({
        where: {
          id: seat.id,
          assignedRegistrationId: null,
          heldByRegistrationId: regId,
          heldUntil: { gt: now },
        },
        data: {
          assignedRegistrationId: regId,
          heldByRegistrationId: null,
          heldUntil: null,
        },
      });

      if (claim.count !== 1) {
        const current = await tx.seat.findUnique({ where: { id: seat.id } });
        if (current && current.assignedRegistrationId === regId) {
          // Already theirs. A double-tap on Confirm, which should read as
          // success — and nothing was released, since previous IS this seat.
          return { ok: true, seatId: seat.id, label: seat.label, alreadyYours: true };
        }
        throw new SeatRefusal({
          ok: false,
          reason: current && current.assignedRegistrationId ? 'TAKEN' : 'HOLD_EXPIRED',
          message: current && current.assignedRegistrationId
            ? 'Somebody else has that seat now. Please pick another.'
            : 'Your hold on that seat expired. Please pick it again.',
        });
      }

      await tx.seatAssignment.create({
        data: { seatId: seat.id, registrationId: regId, action: 'ASSIGNED', actorId },
      });
      if (moving) {
        // Logged as its own event so the history of the seat they left says
        // where it went, rather than the seat simply going quiet.
        await tx.seatAssignment.create({
          data: { seatId: previous.id, registrationId: regId, action: 'RELEASED', actorId },
        });
      }

      return {
        ok: true,
        seatId: seat.id,
        label: seat.label,
        movedFrom: moving ? previous.label : null,
      };
    });
  } catch (err) {
    // A refusal rolled the release back; anything else is a real failure.
    if (err instanceof SeatRefusal) return err.payload;
    throw err;
  }

  // Any other hold this person was sitting on is no longer theirs to keep.
  // Outside the transaction: it is tidying, and must not be able to fail the
  // confirmation that has already succeeded.
  await releaseExpiredOrOwnHolds(registrationId, seat.id);

  return result;
}

// Gives a seat back. Used by the attendee changing their mind and by an admin
// correcting a mistake; the log records which, via actorId.
async function releaseSeat({ eventId, seatId, registrationId = null, actorId = null }) {
  const seat = await loadSeat(eventId, seatId);

  const where = { id: seat.id };
  // An attendee may only release their own; an admin (actorId set, no
  // registrationId) may release anybody's.
  if (registrationId) where.assignedRegistrationId = Number(registrationId);

  const freed = await prisma.seat.updateMany({
    where,
    data: { assignedRegistrationId: null, heldByRegistrationId: null, heldUntil: null },
  });

  if (freed.count !== 1) throw new AppError('That seat is not assigned to you', 409);

  await prisma.seatAssignment.create({
    data: {
      seatId: seat.id,
      registrationId: registrationId ? Number(registrationId) : seat.assignedRegistrationId,
      action: 'RELEASED',
      actorId,
    },
  });

  if (actorId) {
    await auditService.log({
      action: 'SEAT_OVERRIDDEN',
      actorId,
      metadata: { eventId: Number(eventId), seatId: seat.id, label: seat.label, released: seat.assignedRegistrationId },
    });
  }

  return { ok: true, seatId: seat.id, label: seat.label };
}

// The admin putting somebody in a specific seat, skipping the hold. Used at a
// desk when an attendee cannot or will not use the map.
async function assignSeat({ eventId, seatId, registrationId, actorId }) {
  await assertSeatable(eventId, registrationId);
  await releaseAbandonedSeats(eventId);
  const seat = await loadSeat(eventId, seatId);

  // Whatever they had before, freed — a person has one seat, and moving them
  // must not leave the old one occupied by a ghost.
  const previous = await prisma.seat.findFirst({ where: { assignedRegistrationId: Number(registrationId) } });
  if (previous && previous.id !== seat.id) {
    await releaseSeat({ eventId, seatId: previous.id, actorId });
  }

  const claim = await prisma.seat.updateMany({
    where: { id: seat.id, assignedRegistrationId: null },
    data: { assignedRegistrationId: Number(registrationId), heldByRegistrationId: null, heldUntil: null },
  });

  if (claim.count !== 1) {
    const current = await prisma.seat.findUnique({ where: { id: seat.id } });
    if (current.assignedRegistrationId === Number(registrationId)) {
      return { ok: true, seatId: seat.id, label: seat.label, alreadyYours: true };
    }
    throw new AppError('That seat is already assigned to somebody else', 409, 'SEAT_TAKEN');
  }

  await prisma.seatAssignment.create({
    data: { seatId: seat.id, registrationId: Number(registrationId), action: 'ASSIGNED', actorId },
  });
  await auditService.log({
    action: 'SEAT_OVERRIDDEN',
    actorId,
    metadata: { eventId: Number(eventId), seatId: seat.id, label: seat.label, assignedTo: Number(registrationId) },
  });

  return { ok: true, seatId: seat.id, label: seat.label };
}

async function getSeatHistory(eventId, seatId) {
  const seat = await loadSeat(eventId, seatId);
  const rows = await prisma.seatAssignment.findMany({
    where: { seatId: seat.id },
    orderBy: { at: 'asc' },
    include: {
      registration: { select: { id: true, fullName: true, registrationNumber: true } },
      actor: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return rows.map((row) => ({
    at: row.at,
    action: row.action,
    who: row.registration ? row.registration.fullName : null,
    registrationNumber: row.registration ? row.registration.registrationNumber : null,
    // Present only when an admin did it rather than the attendee — the
    // distinction a dispute turns on.
    by: row.actor ? `${row.actor.firstName} ${row.actor.lastName}` : null,
  }));
}

module.exports = {
  HOLD_MS,
  getSeatMap,
  releaseAbandonedSeats,
  listSteppedOut,
  presenceFor,
  listAvailableSeats,
  getSeatFor,
  getAttendeeView,
  setSeatingEnabled,
  listSections,
  getSection,
  createSection,
  updateSection,
  deleteSection,
  generateSeats,
  deleteSeat,
  setSeatBlocked,
  holdSeat,
  confirmSeat,
  releaseSeat,
  assignSeat,
  getSeatHistory,
  letterFor,
};
