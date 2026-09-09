const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const qrService = require('./qr.service');
const eventService = require('./event.service');
const auditService = require('./audit.service');

// Everything the door does. The rule this file exists to enforce is that the
// browser decides nothing: the scanner page posts a string and renders whatever
// verdict comes back. A scan that is refused is refused here, on the server,
// with a row written either way.

// --- who may run a door ----------------------------------------------------

// A main admin can check in at any event. A chapter admin can check in only at
// an event they have been explicitly granted, and only while that grant is
// live. Everyone else, including a chapter admin with no grant, is refused.
//
// The grant is per event rather than per account on purpose: authority to scan
// at the National Convention should confer nothing at a chapter's own seminar,
// and should stop mattering when the convention ends rather than sitting on
// someone's account indefinitely.
async function canCheckIn(sessionUser, eventId) {
  if (!sessionUser) return false;
  if (sessionUser.role === 'ADMIN') return true;
  if (sessionUser.role !== 'CHAPTER_ADMIN') return false;

  const grant = await prisma.eventCheckInStaff.findUnique({
    where: { eventId_userId: { eventId: Number(eventId), userId: Number(sessionUser.id) } },
  });
  return Boolean(grant && !grant.revokedAt);
}

async function assertCanCheckIn(sessionUser, eventId) {
  if (!(await canCheckIn(sessionUser, eventId))) {
    throw new AppError('You do not have check-in access for this event', 403);
  }
}

// --- granting and revoking (main admin only; enforced at the route) --------

async function listCheckInStaff(eventId) {
  return prisma.eventCheckInStaff.findMany({
    where: { eventId: Number(eventId) },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      grantedByUser: { select: { id: true, firstName: true, lastName: true } },
      revokedByUser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { grantedAt: 'desc' },
  });
}

async function grantCheckInAccess({ eventId, userId, adminUserId, ipAddress = null }) {
  const [event, user] = await Promise.all([
    prisma.event.findUnique({ where: { id: Number(eventId) } }),
    prisma.user.findUnique({ where: { id: Number(userId) } }),
  ]);
  if (!event) throw new AppError('Event not found', 404);
  if (!user) throw new AppError('User not found', 404);
  // A main admin already has access everywhere, so granting them one is a no-op
  // that would only make the staff list misleading about who needed it.
  if (user.role === 'ADMIN') throw new AppError('Main admins can already check in at every event', 400);
  if (user.role !== 'CHAPTER_ADMIN') throw new AppError('Only a chapter admin can be given check-in access', 400);

  // Upsert rather than create: re-granting someone whose access was revoked
  // revives the existing row (clearing revokedAt) instead of accumulating a
  // second row for the same person at the same event.
  const grant = await prisma.eventCheckInStaff.upsert({
    where: { eventId_userId: { eventId: Number(eventId), userId: Number(userId) } },
    update: { revokedAt: null, revokedBy: null, grantedBy: Number(adminUserId), grantedAt: new Date() },
    create: { eventId: Number(eventId), userId: Number(userId), grantedBy: Number(adminUserId) },
  });

  await auditService.log({
    action: 'CHECKIN_ACCESS_GRANTED',
    actorId: adminUserId,
    targetUserId: Number(userId),
    metadata: { eventId: Number(eventId), eventTitle: event.title },
    ipAddress,
  });
  return grant;
}

async function revokeCheckInAccess({ eventId, userId, adminUserId, ipAddress = null }) {
  const existing = await prisma.eventCheckInStaff.findUnique({
    where: { eventId_userId: { eventId: Number(eventId), userId: Number(userId) } },
  });
  if (!existing) throw new AppError('That person does not have check-in access for this event', 404);

  // Soft revoke — the row stays so "who could scan here, and who let them" is
  // still answerable afterwards. Deleting it would erase exactly the record an
  // audit of a disputed admission would need.
  const revoked = await prisma.eventCheckInStaff.update({
    where: { id: existing.id },
    data: { revokedAt: new Date(), revokedBy: Number(adminUserId) },
  });

  await auditService.log({
    action: 'CHECKIN_ACCESS_REVOKED',
    actorId: adminUserId,
    targetUserId: Number(userId),
    metadata: { eventId: Number(eventId) },
    ipAddress,
  });
  return revoked;
}

// --- the module's own landing page ------------------------------------------

// Which events this person may run a door for, newest first, each carrying the
// counts the list needs. A main admin sees every event; a chapter admin sees
// only the ones granted to them, so the page is never a list of doors they
// cannot open.
async function listCheckInEvents(sessionUser, { scope = 'current' } = {}) {
  if (!sessionUser) return [];

  const where = {};
  if (sessionUser.role === 'CHAPTER_ADMIN') {
    const grants = await prisma.eventCheckInStaff.findMany({
      where: { userId: Number(sessionUser.id), revokedAt: null },
      select: { eventId: true },
    });
    if (!grants.length) return [];
    where.id = { in: grants.map((g) => g.eventId) };
  } else if (sessionUser.role !== 'ADMIN') {
    return [];
  }

  const now = new Date();
  // "current" is the default because a door is run on the day: an operator
  // opening this page is nearly always looking for the event happening now, not
  // one from last year. Past stays reachable for reporting after the fact.
  if (scope === 'current') Object.assign(where, eventService.notEndedWhere(now));
  else if (scope === 'past') Object.assign(where, eventService.hasEndedWhere(now));

  const events = await prisma.event.findMany({
    where,
    orderBy: { startDate: scope === 'past' ? 'desc' : 'asc' },
    take: 50,
  });

  // One pass per event rather than a grouped query: this list is capped at 50
  // and runs on a page nobody is standing at a door using, so clarity wins over
  // shaving a round trip.
  return Promise.all(events.map(async (event) => ({
    event,
    stats: await getEventCheckInStats(event.id),
  })));
}

// Chapter admins who could be given a door. Main admins are excluded because
// they already have every door, and offering to grant them one would make the
// staff list read as though they needed it.
async function listGrantableUsers() {
  return prisma.user.findMany({
    where: { role: 'CHAPTER_ADMIN' },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
}

// --- the scan ---------------------------------------------------------------

// Only what the door needs on screen. Notably not the registrant's email or
// phone: the check-in screen faces a queue, and anyone standing behind the
// person being admitted can read it.
function participantView(registration) {
  return {
    name: registration.fullName,
    registrationNumber: registration.registrationNumber,
    organizationPath: registration.organizationPath || null,
  };
}

async function recordScan(tx, {
  registration, eventId, result, action, staffUserId, scannerIdentifier, ipAddress, userAgent,
}) {
  return tx.eventCheckIn.create({
    data: {
      eventRegistrationId: registration ? registration.id : null,
      eventId: Number(eventId),
      scannedBy: staffUserId ? Number(staffUserId) : null,
      scannerIdentifier: scannerIdentifier || null,
      action,
      result,
      ipAddress: ipAddress || null,
      // Truncated: some scanners and kiosk browsers send very long strings, and
      // this column is a diagnostic aid, not something worth failing a check-in
      // over.
      userAgent: userAgent ? String(userAgent).slice(0, 1000) : null,
    },
  });
}

// Decides the verdict for a registration at a given door. Pure logic over rows
// already loaded — no writes — so the scan path and the manual-search path
// cannot drift into applying different rules, which is the exact way a manual
// override quietly becomes a way around payment.
function verdictFor(registration, eventId) {
  if (!registration) return 'INVALID_QR';
  if (registration.eventId !== Number(eventId)) return 'WRONG_EVENT';
  if (registration.status === 'CANCELLED') return 'CANCELLED';
  // A paid event's registration only reaches REGISTERED through
  // applyPaymentPaid, so "still PENDING_PAYMENT" IS "has not paid". No separate
  // payment lookup is needed or wanted here — a second source of truth about
  // whether someone paid is a second thing that can disagree.
  if (registration.status === 'PENDING_PAYMENT') return 'UNPAID';
  if (registration.status !== 'REGISTERED') return 'NOT_REGISTERED';
  if (registration.user && registration.user.status === 'REJECTED') return 'REJECTED';
  return 'SUCCESS';
}

const REFUSAL_MESSAGES = {
  INVALID_QR: 'QR code not recognised.',
  WRONG_EVENT: 'This code is registered for a different event.',
  CANCELLED: 'This registration was cancelled.',
  UNPAID: 'Payment for this registration has not been confirmed.',
  NOT_REGISTERED: 'This person is not registered for this event.',
  REJECTED: 'This account was rejected.',
};

// The scanner path. `rawScan` is whatever the gun typed into the input, sent
// through unchanged — parsing it is the server's job, not the page's.
async function checkInByScan({
  eventId, rawScan, staffUser, scannerIdentifier = null, ipAddress = null, userAgent = null,
  action = 'CHECK_IN',
}) {
  await assertCanCheckIn(staffUser, eventId);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const { registration } = await qrService.validateQrToken(rawScan);
  return applyVerdict({
    event, registration, staffUser, scannerIdentifier, ipAddress, userAgent, action,
  });
}

// The manual-search path (§22). It goes through the identical verdict and the
// identical atomic admission — searching someone up by name must never be a way
// to admit a person the scanner would have turned away.
async function checkInManually({
  eventId, registrationId, staffUser, scannerIdentifier = null, ipAddress = null, userAgent = null,
}) {
  await assertCanCheckIn(staffUser, eventId);

  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const registration = await prisma.eventRegistration.findUnique({
    where: { id: Number(registrationId) },
    include: { user: { select: { id: true, status: true } } },
  });

  return applyVerdict({
    event, registration, staffUser, scannerIdentifier, ipAddress, userAgent,
    action: 'MANUAL_CHECK_IN',
  });
}

async function applyVerdict({
  event, registration, staffUser, scannerIdentifier, ipAddress, userAgent, action,
}) {
  const eventId = event.id;
  const verdict = verdictFor(registration, eventId);

  // Refusals: log the attempt and stop. Nothing about the registration changes,
  // and the reason is returned so the door can say something more useful than
  // "no" — but never anything that was not already on the ticket in front of
  // them.
  if (verdict !== 'SUCCESS') {
    await prisma.$transaction((tx) => recordScan(tx, {
      // A WRONG_EVENT scan is logged against the door it happened at, not the
      // event the code belongs to — that is the question staff will ask.
      registration, eventId, result: verdict, action,
      staffUserId: staffUser.id, scannerIdentifier, ipAddress, userAgent,
    }));

    return {
      ok: false,
      result: verdict,
      message: REFUSAL_MESSAGES[verdict] || 'This registration cannot be checked in.',
      // Naming the person on a WRONG_EVENT or ALREADY_CHECKED_IN refusal is what
      // lets staff resolve it at the desk. Not shown for INVALID_QR, where there
      // is nobody to name.
      participant: registration ? participantView(registration) : null,
    };
  }

  // The admission itself. One conditional UPDATE is the whole concurrency
  // story: MySQL applies it atomically, so of two scanners hitting the same
  // ticket at the same instant exactly one matches `checkedInAt: null` and gets
  // a row count of 1. The loser gets 0 and is told ALREADY_CHECKED_IN. No
  // read-then-write, and therefore no window between checking and claiming.
  const outcome = await prisma.$transaction(async (tx) => {
    const claim = await tx.eventRegistration.updateMany({
      where: { id: registration.id, checkedInAt: null },
      data: { checkedInAt: new Date() },
    });

    const won = claim.count === 1;
    const result = won ? 'SUCCESS' : 'ALREADY_CHECKED_IN';
    await recordScan(tx, {
      registration, eventId, result, action,
      staffUserId: staffUser.id, scannerIdentifier, ipAddress, userAgent,
    });
    return { won, result };
  });

  const fresh = await prisma.eventRegistration.findUnique({
    where: { id: registration.id },
    select: { checkedInAt: true },
  });

  if (!outcome.won) {
    return {
      ok: false,
      result: 'ALREADY_CHECKED_IN',
      message: 'This person has already been checked in.',
      participant: participantView(registration),
      checkedInAt: fresh.checkedInAt,
    };
  }

  return {
    ok: true,
    result: 'SUCCESS',
    message: 'Checked in.',
    participant: participantView(registration),
    checkedInAt: fresh.checkedInAt,
  };
}

// --- taking an admission back ----------------------------------------------

// The correction a door actually needs. Someone scans the person behind the one
// they meant to, two people present the same code and the first one through was
// the wrong one, a member is admitted a moment before staff spot a problem —
// without this the only remedy is a database edit, which at a live event means
// no remedy at all.
//
// Deliberately available to anyone who can run this door, not main admins only.
// The person who needs it is the operator who just made the mistake, standing
// at the entrance; a correction they cannot make is a correction that does not
// happen. The cost is that a reversed ticket can be used again, so the reversal
// is recorded twice over — a CHECK_OUT/UNDONE row in the door log, and an audit
// entry naming the operator — rather than being made quiet and convenient.
//
// Nothing is deleted. The SUCCESS row that admitted them stays exactly where it
// was; this adds the row that says it was taken back. "Nobody was ever admitted
// on this ticket" and "somebody was admitted and then removed" are different
// facts, and a report that cannot tell them apart is worse than no report.
async function undoCheckIn({
  eventId, registrationId, staffUser, scannerIdentifier = null, ipAddress = null, userAgent = null,
}) {
  await assertCanCheckIn(staffUser, eventId);

  const registration = await prisma.eventRegistration.findUnique({
    where: { id: Number(registrationId) },
  });
  // Scoped to this door for the same reason a scan is: an operator granted the
  // convention must not be able to reach into a chapter seminar's attendance by
  // posting an id that belongs to it.
  if (!registration || registration.eventId !== Number(eventId)) {
    throw new AppError('That registration is not for this event', 404);
  }

  // The mirror image of the admission claim: one conditional UPDATE, so two
  // operators pressing Remove on the same person produce one reversal and one
  // "already not checked in" — never two CHECK_OUT rows for a single admission.
  const outcome = await prisma.$transaction(async (tx) => {
    const release = await tx.eventRegistration.updateMany({
      where: { id: registration.id, checkedInAt: { not: null } },
      data: { checkedInAt: null },
    });

    const won = release.count === 1;
    if (won) {
      await recordScan(tx, {
        registration, eventId, result: 'UNDONE', action: 'CHECK_OUT',
        staffUserId: staffUser.id, scannerIdentifier, ipAddress, userAgent,
      });
    }
    return { won };
  });

  if (!outcome.won) {
    return {
      ok: false,
      result: 'NOT_CHECKED_IN',
      message: 'This person is not checked in, so there is nothing to remove.',
      participant: participantView(registration),
    };
  }

  await auditService.log({
    action: 'CHECKIN_UNDONE',
    actorId: staffUser.id,
    targetUserId: registration.userId,
    metadata: {
      eventId: Number(eventId),
      registrationId: registration.id,
      registrationNumber: registration.registrationNumber,
      station: scannerIdentifier || null,
    },
    ipAddress,
  });

  return {
    ok: true,
    result: 'UNDONE',
    message: 'Check-in removed. This ticket can be scanned again.',
    participant: participantView(registration),
  };
}

// --- what the door screen shows --------------------------------------------

async function getEventCheckInStats(eventId) {
  const id = Number(eventId);
  const [registered, checkedIn, pendingPayment] = await Promise.all([
    prisma.eventRegistration.count({ where: { eventId: id, status: 'REGISTERED' } }),
    prisma.eventRegistration.count({ where: { eventId: id, status: 'REGISTERED', checkedInAt: { not: null } } }),
    prisma.eventRegistration.count({ where: { eventId: id, status: 'PENDING_PAYMENT' } }),
  ]);
  return {
    registered,
    checkedIn,
    remaining: registered - checkedIn,
    pendingPayment,
    rate: registered ? Math.round((checkedIn / registered) * 10000) / 100 : 0,
  };
}

async function getRecentCheckIns(eventId, limit = 10) {
  return prisma.eventCheckIn.findMany({
    where: { eventId: Number(eventId), result: 'SUCCESS' },
    orderBy: { scannedAt: 'desc' },
    take: limit,
    include: {
      // checkedInAt is the registration's state *now*, not what it was at the
      // moment of the scan — that is what makes the list able to show a row as
      // removed rather than pretending the person is still inside, and what
      // decides whether a Remove button is offered against it at all.
      eventRegistration: {
        select: {
          id: true, fullName: true, registrationNumber: true, checkedInAt: true,
        },
      },
    },
  });
}

// Fallback lookup for the desk (§22): find the person, then check them in
// through the same rules. Returns everyone matching regardless of status, so
// staff can see "they are here but unpaid" rather than "no such person" — the
// refusal still comes from checkInManually, not from hiding them here.
async function searchRegistrations(eventId, term) {
  const search = (term || '').trim();
  if (search.length < 2) return [];

  return prisma.eventRegistration.findMany({
    where: {
      eventId: Number(eventId),
      OR: [
        { fullName: { contains: search } },
        { email: { contains: search } },
        { registrationNumber: { contains: search } },
      ],
    },
    select: {
      id: true, fullName: true, registrationNumber: true,
      status: true, checkedInAt: true, organizationPath: true,
    },
    orderBy: { fullName: 'asc' },
    take: 20,
  });
}

module.exports = {
  canCheckIn,
  listCheckInEvents,
  listGrantableUsers,
  assertCanCheckIn,
  listCheckInStaff,
  grantCheckInAccess,
  revokeCheckInAccess,
  checkInByScan,
  checkInManually,
  undoCheckIn,
  getEventCheckInStats,
  getRecentCheckIns,
  searchRegistrations,
  verdictFor,
};
