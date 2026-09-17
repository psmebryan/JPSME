const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const qrService = require('./qr.service');
const auditService = require('./audit.service');
const config = require('../config');
const { assertCanCheckIn, verdictFor } = require('./checkin.service');

// Room and session attendance: who is inside which hall, right now.
//
// This sits UNDER event arrival check-in rather than replacing it, and the
// distinction is the whole point. Arriving at the venue happens once — that is
// EventRegistration.checkedInAt, a one-shot column the arrival scan gates on.
// Entering a hall happens over and over: in for the keynote, out for coffee, in
// for the technical session. Collapsing the two loses the ability to answer
// either question.
//
// What is stored where:
//
//   EventCheckIn      every scan, including the refusals. Append-only, already
//                     existed, now carries roomId and sessionId.
//   RoomAttendance    one row per person per room, holding only the current
//                     state. Derivable from the history above and deliberately
//                     cached, because it is what makes the scan safe under two
//                     scanners (see roomScan) and occupancy a COUNT rather than
//                     an aggregate over every scan ever taken at that door.

// Room-specific refusals. The event-level ones live in checkin.service, and
// verdictFor() is imported rather than reimplemented so a room door can never
// admit somebody the main entrance would have turned away.
const ROOM_REFUSAL_MESSAGES = {
  ROOM_CLOSED: 'This room is closed.',
  ROOM_FULL: 'This room is at capacity.',
};

function participantView(registration) {
  return {
    name: registration.fullName,
    registrationNumber: registration.registrationNumber,
    organizationPath: registration.organizationPath || null,
  };
}

function roomView(room) {
  return {
    id: room.id, name: room.name, capacity: room.capacity, isOpen: room.isOpen,
  };
}

// --- configuration ----------------------------------------------------------

async function listRooms(eventId) {
  const rooms = await prisma.eventRoom.findMany({
    where: { eventId: Number(eventId) },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });

  // Occupancy for every room in one grouped query rather than one per room —
  // this list is what the live dashboard polls.
  const counts = await prisma.roomAttendance.groupBy({
    by: ['roomId'],
    where: { roomId: { in: rooms.length ? rooms.map((r) => r.id) : [0] }, state: 'INSIDE' },
    _count: { _all: true },
  });
  const inside = new Map(counts.map((c) => [c.roomId, c._count._all]));

  return rooms.map((room) => ({
    ...room,
    occupancy: inside.get(room.id) || 0,
    // Null when the room is uncapped, rather than a number nobody set.
    available: room.capacity == null ? null : Math.max(0, room.capacity - (inside.get(room.id) || 0)),
  }));
}

async function getRoom(eventId, roomId) {
  const room = await prisma.eventRoom.findUnique({ where: { id: Number(roomId) } });
  // Checked rather than trusted: a room id from a URL that belongs to another
  // event must not be usable at this one's door.
  if (!room || room.eventId !== Number(eventId)) throw new AppError('Room not found', 404);
  return room;
}

async function createRoom({ eventId, name, capacity = null, location = null, displayOrder = 0, adminUserId }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new AppError('Room name is required', 400);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const existing = await prisma.eventRoom.findFirst({
    where: { eventId: Number(eventId), name: trimmed },
  });
  // Caught here as well as by the unique index, so the message names the
  // problem instead of surfacing a constraint violation.
  if (existing) throw new AppError('A room with that name already exists for this event', 409);

  const room = await prisma.eventRoom.create({
    data: {
      eventId: Number(eventId),
      name: trimmed,
      capacity: capacity == null || capacity === '' ? null : Number(capacity),
      location: location ? String(location).trim() : null,
      displayOrder: Number(displayOrder) || 0,
    },
  });

  await auditService.log({
    action: 'ROOM_CREATED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), roomId: room.id, name: room.name, capacity: room.capacity },
  });

  return room;
}

async function updateRoom({ eventId, roomId, data = {}, adminUserId }) {
  const room = await getRoom(eventId, roomId);

  const patch = {};
  if (data.name !== undefined) {
    const trimmed = String(data.name || '').trim();
    if (!trimmed) throw new AppError('Room name is required', 400);
    patch.name = trimmed;
  }
  if (data.capacity !== undefined) {
    patch.capacity = data.capacity === null || data.capacity === '' ? null : Number(data.capacity);
  }
  if (data.location !== undefined) patch.location = data.location ? String(data.location).trim() : null;
  if (data.isOpen !== undefined) patch.isOpen = Boolean(data.isOpen);
  if (data.displayOrder !== undefined) patch.displayOrder = Number(data.displayOrder) || 0;

  const updated = await prisma.eventRoom.update({ where: { id: room.id }, data: patch });

  await auditService.log({
    action: 'ROOM_UPDATED',
    actorId: adminUserId,
    // Before and after, because "who closed the hall and when" is the question
    // this gets read for.
    metadata: { eventId: Number(eventId), roomId: room.id, before: roomView(room), after: roomView(updated) },
  });

  return updated;
}

async function deleteRoom({ eventId, roomId, adminUserId }) {
  const room = await getRoom(eventId, roomId);

  // Refused once anybody has been scanned there. Deleting would cascade the
  // attendance rows away and set roomId to null on the scan log, quietly
  // turning "entered Main Hall" into "entered somewhere". Closing the room is
  // the thing they actually want.
  const scans = await prisma.eventCheckIn.count({ where: { roomId: room.id } });
  if (scans > 0) {
    throw new AppError(
      'This room has attendance recorded against it. Close it instead of deleting it.',
      409,
      'ROOM_HAS_ATTENDANCE'
    );
  }

  await prisma.eventRoom.delete({ where: { id: room.id } });
  await auditService.log({
    action: 'ROOM_DELETED',
    actorId: adminUserId,
    metadata: { eventId: Number(eventId), roomId: room.id, name: room.name },
  });
  return { id: room.id };
}

// --- sessions ---------------------------------------------------------------

async function listSessions(eventId) {
  return prisma.eventSession.findMany({
    where: { eventId: Number(eventId) },
    orderBy: [{ startTime: 'asc' }, { name: 'asc' }],
    include: { room: { select: { id: true, name: true } } },
  });
}

async function createSession({ eventId, roomId = null, name, startTime = null, endTime = null }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new AppError('Session name is required', 400);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  // Checked rather than trusted, same as everywhere else a room id arrives from
  // outside: a session must not be attached to another event's room.
  if (roomId) await getRoom(eventId, roomId);

  const start = startTime ? new Date(startTime) : null;
  const end = endTime ? new Date(endTime) : null;
  // A window that ends before it starts would simply never match, and the scan
  // would silently record no session — a configuration mistake that only shows
  // up in a report months later.
  if (start && end && end < start) throw new AppError('The session ends before it starts', 400);

  return prisma.eventSession.create({
    data: {
      eventId: Number(eventId),
      roomId: roomId ? Number(roomId) : null,
      name: trimmed,
      startTime: start,
      endTime: end,
    },
  });
}

async function deleteSession({ eventId, sessionId }) {
  const session = await prisma.eventSession.findUnique({ where: { id: Number(sessionId) } });
  if (!session || session.eventId !== Number(eventId)) throw new AppError('Session not found', 404);
  // Scans keep their sessionId via SetNull rather than blocking the delete: a
  // session is a label on a time window, and removing it should not refuse to
  // let anyone tidy up a mistyped schedule.
  await prisma.eventSession.delete({ where: { id: session.id } });
  return { id: session.id };
}

// Which session is running in a room at a given moment. Recorded on the scan so
// a report can say who was present for Technical Session 1 without inferring it
// from timestamps months later, when the schedule has been edited.
async function currentSessionFor(roomId, at = new Date()) {
  return prisma.eventSession.findFirst({
    where: {
      roomId: Number(roomId),
      startTime: { lte: at },
      endTime: { gte: at },
    },
    orderBy: { startTime: 'desc' },
  });
}

// --- the scan ---------------------------------------------------------------

// One scan, either direction. The staff member presses nothing but Scan; the
// server decides whether this is an entry or an exit from where the person
// currently is.
//
// The concurrency story is the same conditional-UPDATE trick arrival check-in
// already uses, applied twice. Reading the state and then writing it would be a
// race — two scanners both read OUTSIDE and both admit. Instead the row is
// ensured to exist, then the entry transition is attempted as a single
// statement constrained to `state = OUTSIDE`; if it changed a row, this scan is
// the entry. If it did not, the exit transition is attempted, constrained to
// `state = INSIDE`. Exactly one of the two can win, whichever order two
// simultaneous scans arrive in.
async function roomScan({
  eventId, roomId, rawScan, staffUser,
  scannerIdentifier = null, ipAddress = null, userAgent = null,
}) {
  await assertCanCheckIn(staffUser, eventId);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const room = await getRoom(eventId, roomId);
  const { registration } = await qrService.validateQrToken(rawScan);

  // The same rules as the main entrance, evaluated by the same function.
  const verdict = verdictFor(registration, eventId);
  const refusal = verdict !== 'SUCCESS'
    ? verdict
    : (!room.isOpen ? 'ROOM_CLOSED' : null);

  if (refusal) {
    await recordRoomScan({
      registration, eventId, roomId: room.id, sessionId: null,
      result: refusal, action: 'CHECK_IN', staffUser, scannerIdentifier, ipAddress, userAgent,
    });
    return {
      ok: false,
      result: refusal,
      room: roomView(room),
      message: ROOM_REFUSAL_MESSAGES[refusal] || refusalMessageFor(refusal),
      participant: registration ? participantView(registration) : null,
    };
  }

  const session = await currentSessionFor(room.id);
  const now = new Date();

  // The same ticket, at this door, seconds ago.
  //
  // This door decides direction from where the person currently is, which is
  // what makes it one button — and also means a repeat scan does the OPPOSITE
  // of the first. A scanner gun that double-fires, or an operator re-scanning
  // because they could not tell whether the first one took, marked somebody as
  // having left the hall they were walking into. Both scans were true entries
  // in an append-only log, so there was nothing to recover afterwards.
  //
  // So a scan inside the window repeats the last one instead of reversing it:
  // nothing changes, and the operator is told the person is already inside.
  // Recorded, because a gun double-firing all morning is worth noticing.
  const windowMs = config.jobs.duplicateScanWindowMs;
  if (windowMs > 0) {
    const recent = await prisma.eventCheckIn.findFirst({
      where: {
        eventRegistrationId: registration.id,
        roomId: room.id,
        result: 'SUCCESS',
        scannedAt: { gte: new Date(now.getTime() - windowMs) },
      },
      orderBy: { scannedAt: 'desc' },
    });

    if (recent) {
      const [state, occupancy] = await Promise.all([
        prisma.roomAttendance.findUnique({
          where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: registration.id } },
          select: { state: true },
        }),
        prisma.roomAttendance.count({ where: { roomId: room.id, state: 'INSIDE' } }),
      ]);
      const current = state ? state.state : 'OUTSIDE';
      const secondsAgo = Math.max(1, Math.round((now - recent.scannedAt) / 1000));

      await recordRoomScan({
        registration, eventId, roomId: room.id, sessionId: session ? session.id : null,
        result: 'DUPLICATE_SCAN', action: recent.action,
        staffUser, scannerIdentifier, ipAddress, userAgent,
      });

      return {
        // Not a refusal: nothing went wrong and the person is fine. Rendering
        // this red would send an operator looking for a problem that does not
        // exist — and rendering it as ENTERED again would be a lie about what
        // just happened.
        ok: true,
        duplicate: true,
        result: 'DUPLICATE_SCAN',
        action: recent.action,
        state: current,
        room: roomView(room),
        session: session ? { id: session.id, name: session.name } : null,
        occupancy,
        participant: participantView(registration),
        message: `Already scanned ${secondsAgo}s ago — still ${current.toLowerCase()}.`,
        at: recent.scannedAt,
      };
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Locked only when the room is capped. An uncapped room needs no ordering
    // between entries, and a lock taken per scan at a busy door is worth
    // avoiding when it buys nothing.
    if (room.capacity != null) {
      await tx.$queryRawUnsafe('SELECT id FROM `event_rooms` WHERE id = ? FOR UPDATE', room.id);
    }

    await tx.roomAttendance.upsert({
      where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: registration.id } },
      create: { roomId: room.id, eventRegistrationId: registration.id, state: 'OUTSIDE' },
      update: {},
    });

    const current = await tx.roomAttendance.findUnique({
      where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: registration.id } },
    });

    // Entering a full room is refused before the transition is attempted. The
    // lock above is what makes the count trustworthy at this instant.
    if (current.state === 'OUTSIDE' && room.capacity != null) {
      const inside = await tx.roomAttendance.count({ where: { roomId: room.id, state: 'INSIDE' } });
      if (inside >= room.capacity) return { refusal: 'ROOM_FULL', occupancy: inside };
    }

    const entered = await tx.roomAttendance.updateMany({
      where: { roomId: room.id, eventRegistrationId: registration.id, state: 'OUTSIDE' },
      data: { state: 'INSIDE', lastEnteredAt: now, entryCount: { increment: 1 } },
    });

    let action;
    if (entered.count === 1) {
      action = 'CHECK_IN';
      // Set once, on the first ever entry. A separate statement because a
      // conditional column update is not expressible in the one above.
      await tx.roomAttendance.updateMany({
        where: { roomId: room.id, eventRegistrationId: registration.id, firstEnteredAt: null },
        data: { firstEnteredAt: now },
      });
    } else {
      const left = await tx.roomAttendance.updateMany({
        where: { roomId: room.id, eventRegistrationId: registration.id, state: 'INSIDE' },
        data: { state: 'OUTSIDE', lastExitedAt: now },
      });
      // Neither transition matched, which means another scan landed between the
      // upsert and here and the state is already what this one would have made
      // it. Reporting the losing scan honestly is better than guessing.
      if (left.count !== 1) return { refusal: 'ALREADY_CHECKED_IN' };
      action = 'CHECK_OUT';
    }

    // Arriving at a hall door without having been checked in at the main
    // entrance is normal — people walk straight in. Rather than send them back,
    // the arrival is recorded here too, as its own row, so both facts are true
    // and the arrival report is not missing everyone who skipped the desk.
    let alsoArrived = false;
    if (action === 'CHECK_IN') {
      const claim = await tx.eventRegistration.updateMany({
        where: { id: registration.id, checkedInAt: null },
        data: { checkedInAt: now },
      });
      if (claim.count === 1) {
        alsoArrived = true;
        await recordRoomScan({
          registration, eventId, roomId: null, sessionId: null,
          result: 'SUCCESS', action: 'CHECK_IN', staffUser, scannerIdentifier, ipAddress, userAgent,
        }, tx);
      }
    }

    await recordRoomScan({
      registration, eventId, roomId: room.id, sessionId: session ? session.id : null,
      result: 'SUCCESS', action, staffUser, scannerIdentifier, ipAddress, userAgent,
    }, tx);

    const occupancy = await tx.roomAttendance.count({ where: { roomId: room.id, state: 'INSIDE' } });
    return { action, alsoArrived, occupancy };
  });

  if (outcome.refusal) {
    await recordRoomScan({
      registration, eventId, roomId: room.id, sessionId: session ? session.id : null,
      result: outcome.refusal, action: 'CHECK_IN', staffUser, scannerIdentifier, ipAddress, userAgent,
    });
    return {
      ok: false,
      result: outcome.refusal,
      room: roomView(room),
      occupancy: outcome.occupancy,
      message: ROOM_REFUSAL_MESSAGES[outcome.refusal] || 'That scan could not be completed.',
      participant: participantView(registration),
    };
  }

  return {
    ok: true,
    result: 'SUCCESS',
    action: outcome.action,
    state: outcome.action === 'CHECK_IN' ? 'INSIDE' : 'OUTSIDE',
    room: roomView(room),
    session: session ? { id: session.id, name: session.name } : null,
    occupancy: outcome.occupancy,
    // Surfaced so the scanner can say so — somebody who never passed the front
    // desk should be told they have just been marked as arrived.
    alsoMarkedArrived: Boolean(outcome.alsoArrived),
    participant: participantView(registration),
    message: outcome.action === 'CHECK_IN' ? `Entered ${room.name}.` : `Left ${room.name}.`,
    at: now,
  };
}

function refusalMessageFor(verdict) {
  return {
    INVALID_QR: 'QR code not recognised.',
    WRONG_EVENT: 'This code is registered for a different event.',
    CANCELLED: 'This registration was cancelled.',
    UNPAID: 'Payment for this registration has not been confirmed.',
    NOT_REGISTERED: 'This person is not registered for this event.',
    REJECTED: 'This account was rejected.',
  }[verdict] || 'This registration cannot be admitted.';
}

// Writes the scan row. Takes an optional transaction client so a scan recorded
// as part of a state change commits or rolls back with it.
async function recordRoomScan({
  registration, eventId, roomId, sessionId, result, action,
  staffUser, scannerIdentifier, ipAddress, userAgent,
}, client = prisma) {
  return client.eventCheckIn.create({
    data: {
      eventRegistrationId: registration ? registration.id : null,
      eventId: Number(eventId),
      roomId: roomId ? Number(roomId) : null,
      sessionId: sessionId ? Number(sessionId) : null,
      scannedBy: staffUser && staffUser.id ? Number(staffUser.id) : null,
      scannerIdentifier: scannerIdentifier || null,
      action,
      result,
      ipAddress: ipAddress || null,
      userAgent: userAgent ? String(userAgent).slice(0, 1000) : null,
    },
  });
}

// --- monitoring -------------------------------------------------------------

async function getOccupancy(eventId) {
  const rooms = await listRooms(eventId);
  return {
    rooms,
    totalInside: rooms.reduce((sum, room) => sum + room.occupancy, 0),
  };
}

async function listInside(eventId, roomId) {
  const room = await getRoom(eventId, roomId);
  const rows = await prisma.roomAttendance.findMany({
    where: { roomId: room.id, state: 'INSIDE' },
    orderBy: { lastEnteredAt: 'desc' },
    include: {
      registration: {
        select: {
          id: true, fullName: true, registrationNumber: true, organizationPath: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    registrationId: row.eventRegistrationId,
    name: row.registration.fullName,
    registrationNumber: row.registration.registrationNumber,
    organizationPath: row.registration.organizationPath,
    since: row.lastEnteredAt,
    entryCount: row.entryCount,
  }));
}

// One person's movements, in order. Read from the scan log rather than from the
// cached state, because the history is the thing being asked for.
async function getAttendanceHistory(registrationId) {
  const scans = await prisma.eventCheckIn.findMany({
    where: { eventRegistrationId: Number(registrationId), result: 'SUCCESS' },
    orderBy: { scannedAt: 'asc' },
    include: {
      room: { select: { id: true, name: true } },
      session: { select: { id: true, name: true } },
    },
  });

  return scans.map((scan) => ({
    at: scan.scannedAt,
    action: scan.action,
    // A row with no room is the venue door, not a hall.
    room: scan.room ? scan.room.name : null,
    session: scan.session ? scan.session.name : null,
    scannerIdentifier: scan.scannerIdentifier,
  }));
}

// --- manual correction ------------------------------------------------------

// The equivalent of undoCheckIn for a room: staff scanned the wrong person, or
// somebody left through a door with no scanner. Recorded as a real scan row so
// the history stays complete, plus an audit entry because it is an
// administrative change to somebody's attendance after the fact.
async function overrideRoomState({
  eventId, roomId, registrationId, state, staffUser, ipAddress = null,
}) {
  await assertCanCheckIn(staffUser, eventId);
  const room = await getRoom(eventId, roomId);

  if (state !== 'INSIDE' && state !== 'OUTSIDE') {
    throw new AppError('State must be INSIDE or OUTSIDE', 400);
  }

  const registration = await prisma.eventRegistration.findUnique({ where: { id: Number(registrationId) } });
  if (!registration || registration.eventId !== Number(eventId)) {
    throw new AppError('Registration not found for this event', 404);
  }

  const now = new Date();
  const before = await prisma.roomAttendance.findUnique({
    where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: registration.id } },
  });

  if (before && before.state === state) {
    throw new AppError(`That person is already marked ${state.toLowerCase()}.`, 409);
  }

  await prisma.$transaction(async (tx) => {
    await tx.roomAttendance.upsert({
      where: { roomId_eventRegistrationId: { roomId: room.id, eventRegistrationId: registration.id } },
      create: {
        roomId: room.id,
        eventRegistrationId: registration.id,
        state,
        firstEnteredAt: state === 'INSIDE' ? now : null,
        lastEnteredAt: state === 'INSIDE' ? now : null,
        lastExitedAt: state === 'OUTSIDE' ? now : null,
        entryCount: state === 'INSIDE' ? 1 : 0,
      },
      update: state === 'INSIDE'
        ? { state, lastEnteredAt: now, entryCount: { increment: 1 } }
        : { state, lastExitedAt: now },
    });

    await recordRoomScan({
      registration, eventId, roomId: room.id, sessionId: null,
      result: 'SUCCESS',
      action: state === 'INSIDE' ? 'MANUAL_CHECK_IN' : 'CHECK_OUT',
      staffUser, scannerIdentifier: 'MANUAL', ipAddress, userAgent: null,
    }, tx);
  });

  await auditService.log({
    action: 'ROOM_ATTENDANCE_OVERRIDDEN',
    actorId: staffUser.id,
    ipAddress,
    metadata: {
      eventId: Number(eventId),
      roomId: room.id,
      registrationId: registration.id,
      before: before ? before.state : 'OUTSIDE',
      after: state,
    },
  });

  return { roomId: room.id, registrationId: registration.id, state };
}

module.exports = {
  listRooms,
  getRoom,
  createRoom,
  updateRoom,
  deleteRoom,
  listSessions,
  createSession,
  deleteSession,
  currentSessionFor,
  roomScan,
  getOccupancy,
  listInside,
  getAttendanceHistory,
  overrideRoomState,
};
