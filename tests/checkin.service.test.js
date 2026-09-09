// Tests for checkin.service.js — the door. This is the security-critical
// surface of the whole feature, so the matrix here is deliberately exhaustive:
// who may run a door, every refusal reason, and what happens when two scanners
// hit the same ticket at the same instant.
//
// Runs against the real dev database, same as the other suites. The concurrency
// case fires genuinely simultaneous calls rather than sequential ones, because
// a read-then-write race looks perfectly correct when tested in order.

const prisma = require('../src/config/prisma');
const qrService = require('../src/services/qr.service');
const checkinService = require('../src/services/checkin.service');
const checkinReportService = require('../src/services/checkinReport.service');

const TAG = '__CHKTEST__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function assertRejects(fn, statusCode, msg) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  assert(threw, `${msg} — it did not throw at all`);
  assertEqual(threw.statusCode, statusCode, msg);
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG.toLowerCase() } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const guard = ids.length ? ids : [0];
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const eventIds = events.length ? events.map((e) => e.id) : [0];

  await prisma.eventCheckIn.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.eventCheckInStaff.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: guard } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: guard } } });
  await prisma.eventRegistration.deleteMany({ where: { userId: { in: guard } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.user.deleteMany({ where: { id: { in: guard } } });
}

let seq = 0;
async function makeUser(role = 'USER') {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'Chk', lastName: `${role}${seq}`,
      email: `${TAG.toLowerCase()}${seq}@example.test`,
      password: 'x', status: 'APPROVED', role,
    },
  });
}

async function makeEvent(feeCentavos = 0) {
  seq += 1;
  return prisma.event.create({
    data: { title: `${TAG} Event ${seq}`, startDate: new Date(Date.now() + 86400000), feeCentavos, isPublished: true },
  });
}

// A confirmed, ticketed registration — what a scanner should admit.
async function makeTicketedRegistration(event, status = 'REGISTERED') {
  const member = await makeUser('USER');
  const reg = await prisma.eventRegistration.create({
    data: {
      userId: member.id, eventId: event.id, status,
      fullName: `${TAG} Member ${seq}`, email: member.email,
    },
  });
  const ticketed = await qrService.assignRegistrationIdentity(prisma, reg.id);
  return { member, registration: ticketed };
}

async function main() {
  await cleanup();

  const admin = await makeUser('ADMIN');
  const adminSession = { id: admin.id, role: 'ADMIN' };

  // --- who may run a door ---------------------------------------------------

  await test('a main admin can check in at any event, with no grant needed', async () => {
    const event = await makeEvent();
    assertEqual(await checkinService.canCheckIn(adminSession, event.id), true, 'admin has access');
  });

  await test('a chapter admin with no grant is refused', async () => {
    const event = await makeEvent();
    const chapter = await makeUser('CHAPTER_ADMIN');
    const session = { id: chapter.id, role: 'CHAPTER_ADMIN' };
    assertEqual(await checkinService.canCheckIn(session, event.id), false, 'no access by default');
    await assertRejects(
      () => checkinService.checkInByScan({ eventId: event.id, rawScan: 'x', staffUser: session }),
      403, 'scanning is refused',
    );
  });

  await test('a granted chapter admin can check in at that event only', async () => {
    const granted = await makeEvent();
    const other = await makeEvent();
    const chapter = await makeUser('CHAPTER_ADMIN');
    const session = { id: chapter.id, role: 'CHAPTER_ADMIN' };

    await checkinService.grantCheckInAccess({ eventId: granted.id, userId: chapter.id, adminUserId: admin.id });
    assertEqual(await checkinService.canCheckIn(session, granted.id), true, 'access at the granted event');
    assertEqual(await checkinService.canCheckIn(session, other.id), false, 'and nowhere else');
  });

  await test('revoking access takes it away, and re-granting gives it back', async () => {
    const event = await makeEvent();
    const chapter = await makeUser('CHAPTER_ADMIN');
    const session = { id: chapter.id, role: 'CHAPTER_ADMIN' };

    await checkinService.grantCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });
    await checkinService.revokeCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });
    assertEqual(await checkinService.canCheckIn(session, event.id), false, 'revoked');

    await checkinService.grantCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });
    assertEqual(await checkinService.canCheckIn(session, event.id), true, 'restored');

    const rows = await prisma.eventCheckInStaff.count({ where: { eventId: event.id, userId: chapter.id } });
    assertEqual(rows, 1, 'and it revived the existing row rather than stacking a second grant');
  });

  await test('revocation is soft, so who held access and who gave it stays answerable', async () => {
    const event = await makeEvent();
    const chapter = await makeUser('CHAPTER_ADMIN');
    await checkinService.grantCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });
    await checkinService.revokeCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });

    const [grant] = await checkinService.listCheckInStaff(event.id);
    assert(grant, 'the record survives revocation');
    assertEqual(grant.grantedBy, admin.id, 'who granted it');
    assertEqual(grant.revokedBy, admin.id, 'who revoked it');
    assert(grant.revokedAt, 'when it was revoked');
  });

  await test('an ordinary member cannot be given check-in access', async () => {
    const event = await makeEvent();
    const member = await makeUser('USER');
    await assertRejects(
      () => checkinService.grantCheckInAccess({ eventId: event.id, userId: member.id, adminUserId: admin.id }),
      400, 'refused',
    );
  });

  await test('an ordinary member cannot run a door even with a session', async () => {
    const event = await makeEvent();
    const member = await makeUser('USER');
    assertEqual(await checkinService.canCheckIn({ id: member.id, role: 'USER' }, event.id), false, 'no access');
  });

  // --- the happy path -------------------------------------------------------

  await test('a valid ticket is admitted and the time is recorded', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const out = await checkinService.checkInByScan({
      eventId: event.id,
      rawScan: qrService.buildQrPayload(registration.qrToken),
      staffUser: adminSession,
      scannerIdentifier: 'ENTRANCE-02',
    });

    assertEqual(out.ok, true, 'admitted');
    assertEqual(out.result, 'SUCCESS', 'verdict');
    assertEqual(out.participant.registrationNumber, registration.registrationNumber, 'the right person');
    assert(out.checkedInAt, 'admission time returned');

    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assert(after.checkedInAt, 'and persisted');
  });

  await test('the scan is logged with the station that made it', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    await checkinService.checkInByScan({
      eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession,
      scannerIdentifier: 'ENTRANCE-04', ipAddress: '203.0.113.7', userAgent: 'ScannerKiosk/1.0',
    });

    const log = await prisma.eventCheckIn.findFirst({
      where: { eventRegistrationId: registration.id }, orderBy: { id: 'desc' },
    });
    assert(log, 'a scan row was written');
    assertEqual(log.result, 'SUCCESS', 'result recorded');
    assertEqual(log.scannerIdentifier, 'ENTRANCE-04', 'station recorded');
    assertEqual(log.scannedBy, admin.id, 'operator recorded');
    assertEqual(log.ipAddress, '203.0.113.7', 'origin recorded');
    assertEqual(log.action, 'CHECK_IN', 'action recorded');
  });

  // --- refusals -------------------------------------------------------------

  await test('scanning the same ticket twice admits once and reports the duplicate', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const first = await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    const second = await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });

    assertEqual(first.result, 'SUCCESS', 'first admitted');
    assertEqual(second.ok, false, 'second refused');
    assertEqual(second.result, 'ALREADY_CHECKED_IN', 'and says why');
    assertEqual(second.checkedInAt.getTime(), first.checkedInAt.getTime(), 'the original admission time is not overwritten');
    assertEqual(second.participant.name, registration.fullName, 'staff can still see who it is');
  });

  await test("a ticket for another event is refused at this door and NOT admitted", async () => {
    const eventA = await makeEvent();
    const eventB = await makeEvent();
    const { registration } = await makeTicketedRegistration(eventA);

    const out = await checkinService.checkInByScan({
      eventId: eventB.id, rawScan: registration.qrToken, staffUser: adminSession, scannerIdentifier: 'ENTRANCE-01',
    });

    assertEqual(out.ok, false, 'refused');
    assertEqual(out.result, 'WRONG_EVENT', 'verdict');
    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assertEqual(after.checkedInAt, null, 'and they were not let in anywhere');

    const log = await prisma.eventCheckIn.findFirst({ where: { eventId: eventB.id }, orderBy: { id: 'desc' } });
    assertEqual(log.eventId, eventB.id, 'the refusal is logged against the door it happened at, not the ticket\'s own event');
  });

  await test('an unrecognised code is refused without naming anybody', async () => {
    const event = await makeEvent();
    const out = await checkinService.checkInByScan({
      eventId: event.id, rawScan: 'PSME-EVENT:' + qrService.generateQrToken(), staffUser: adminSession,
    });
    assertEqual(out.result, 'INVALID_QR', 'verdict');
    assertEqual(out.participant, null, 'nobody to name');
  });

  await test('junk from a scanner pointed at the wrong thing is refused, not crashed on', async () => {
    const event = await makeEvent();
    for (const junk of ['4006381333931', 'https://example.com/x', "' OR 1=1 --", '']) {
      const out = await checkinService.checkInByScan({ eventId: event.id, rawScan: junk, staffUser: adminSession });
      assertEqual(out.result, 'INVALID_QR', `rejected: ${JSON.stringify(junk)}`);
    }
  });

  await test('a cancelled registration is refused, and the door is told why', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    await prisma.eventRegistration.update({ where: { id: registration.id }, data: { status: 'CANCELLED' } });

    const out = await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    assertEqual(out.result, 'CANCELLED', 'verdict names the real reason, not "unknown code"');
    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assertEqual(after.checkedInAt, null, 'not admitted');
  });

  await test('an unpaid registration for a paid event is refused', async () => {
    const event = await makeEvent(50000);
    const member = await makeUser('USER');
    const reg = await prisma.eventRegistration.create({
      data: {
        userId: member.id, eventId: event.id, status: 'PENDING_PAYMENT',
        fullName: `${TAG} Unpaid`, email: member.email,
      },
    });
    // Force a token onto an unpaid row — the state the system never produces —
    // purely to prove the door refuses on status even if one somehow existed.
    await prisma.eventRegistration.update({
      where: { id: reg.id }, data: { qrToken: qrService.generateQrToken() },
    });
    const withToken = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });

    const out = await checkinService.checkInByScan({ eventId: event.id, rawScan: withToken.qrToken, staffUser: adminSession });
    assertEqual(out.result, 'UNPAID', 'refused for non-payment');
    const after = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });
    assertEqual(after.checkedInAt, null, 'not admitted');
  });

  await test('a rejected account is refused even with a valid ticket', async () => {
    const event = await makeEvent();
    const { member, registration } = await makeTicketedRegistration(event);
    await prisma.user.update({ where: { id: member.id }, data: { status: 'REJECTED' } });

    const out = await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    assertEqual(out.result, 'REJECTED', 'refused');
  });

  await test('a regenerated ticket admits, and the replaced one no longer does', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    const oldToken = registration.qrToken;
    const reissued = await qrService.regenerateQr({ registrationId: registration.id, adminUserId: admin.id });

    const dead = await checkinService.checkInByScan({ eventId: event.id, rawScan: oldToken, staffUser: adminSession });
    assertEqual(dead.result, 'INVALID_QR', 'the old printout is turned away');

    const live = await checkinService.checkInByScan({ eventId: event.id, rawScan: reissued.qrToken, staffUser: adminSession });
    assertEqual(live.result, 'SUCCESS', 'the reissued one works');
  });

  await test('every refusal leaves a row, so the door reports are not just successes', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    await checkinService.checkInByScan({ eventId: event.id, rawScan: 'nonsense', staffUser: adminSession });
    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });

    const rows = await prisma.eventCheckIn.findMany({ where: { eventId: event.id }, orderBy: { id: 'asc' } });
    assertEqual(rows.length, 3, 'all three scans recorded');
    assertEqual(rows.map((r) => r.result).join(','), 'INVALID_QR,SUCCESS,ALREADY_CHECKED_IN', 'in order, with their real verdicts');
    assertEqual(rows[0].eventRegistrationId, null, 'the unmatched scan points at no registration');
  });

  // --- concurrency ----------------------------------------------------------

  await test('ten scanners hitting one ticket at the same instant admit exactly once', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const results = await Promise.all(
      Array.from({ length: 10 }, (unused, i) => checkinService.checkInByScan({
        eventId: event.id,
        rawScan: registration.qrToken,
        staffUser: adminSession,
        scannerIdentifier: `ENTRANCE-${String(i + 1).padStart(2, '0')}`,
      })),
    );

    const successes = results.filter((r) => r.result === 'SUCCESS');
    const duplicates = results.filter((r) => r.result === 'ALREADY_CHECKED_IN');
    assertEqual(successes.length, 1, 'exactly one scanner won');
    assertEqual(duplicates.length, 9, 'every other scanner was told it was already used');

    const rows = await prisma.eventCheckIn.count({ where: { eventRegistrationId: registration.id } });
    assertEqual(rows, 10, 'and all ten attempts are on record');
  });

  await test('concurrent scans of DIFFERENT tickets all succeed', async () => {
    const event = await makeEvent();
    const people = await Promise.all(Array.from({ length: 8 }, () => makeTicketedRegistration(event)));

    const results = await Promise.all(people.map((p) => checkinService.checkInByScan({
      eventId: event.id, rawScan: p.registration.qrToken, staffUser: adminSession,
    })));

    assertEqual(results.filter((r) => r.result === 'SUCCESS').length, 8, 'a busy door is not serialised into failures');
  });

  // --- the manual desk ------------------------------------------------------

  await test('manual check-in admits a valid registration and marks it as manual', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const out = await checkinService.checkInManually({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession, scannerIdentifier: 'DESK-01',
    });
    assertEqual(out.result, 'SUCCESS', 'admitted');

    const log = await prisma.eventCheckIn.findFirst({ where: { eventRegistrationId: registration.id }, orderBy: { id: 'desc' } });
    assertEqual(log.action, 'MANUAL_CHECK_IN', 'recorded as a manual admission, not a scan');
  });

  await test('manual check-in cannot be used to walk an unpaid person past the rules', async () => {
    const event = await makeEvent(50000);
    const member = await makeUser('USER');
    const reg = await prisma.eventRegistration.create({
      data: {
        userId: member.id, eventId: event.id, status: 'PENDING_PAYMENT',
        fullName: `${TAG} Unpaid Manual`, email: member.email,
      },
    });

    const out = await checkinService.checkInManually({
      eventId: event.id, registrationId: reg.id, staffUser: adminSession,
    });
    assertEqual(out.result, 'UNPAID', 'the same refusal the scanner would give');
    const after = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });
    assertEqual(after.checkedInAt, null, 'not admitted');
  });

  await test('manual check-in cannot reach a registration from another event', async () => {
    const eventA = await makeEvent();
    const eventB = await makeEvent();
    const { registration } = await makeTicketedRegistration(eventA);

    const out = await checkinService.checkInManually({
      eventId: eventB.id, registrationId: registration.id, staffUser: adminSession,
    });
    assertEqual(out.result, 'WRONG_EVENT', 'refused');
  });

  await test('a chapter admin without a grant cannot use the manual desk either', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    const chapter = await makeUser('CHAPTER_ADMIN');
    await assertRejects(
      () => checkinService.checkInManually({
        eventId: event.id, registrationId: registration.id, staffUser: { id: chapter.id, role: 'CHAPTER_ADMIN' },
      }),
      403, 'refused',
    );
  });

  await test('search finds people by name and registration number, including unpaid ones', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const byNumber = await checkinService.searchRegistrations(event.id, registration.registrationNumber);
    assertEqual(byNumber.length, 1, 'found by registration number');
    assertEqual(byNumber[0].id, registration.id, 'the right one');

    const byName = await checkinService.searchRegistrations(event.id, 'Member');
    assert(byName.length >= 1, 'found by name');

    assertEqual((await checkinService.searchRegistrations(event.id, 'a')).length, 0, 'a single character does not dump the list');
  });

  // --- what the screen shows ------------------------------------------------

  await test('stats count the door correctly', async () => {
    const event = await makeEvent();
    const a = await makeTicketedRegistration(event);
    await makeTicketedRegistration(event);
    await makeTicketedRegistration(event);

    await checkinService.checkInByScan({ eventId: event.id, rawScan: a.registration.qrToken, staffUser: adminSession });

    const stats = await checkinService.getEventCheckInStats(event.id);
    assertEqual(stats.registered, 3, 'registered');
    assertEqual(stats.checkedIn, 1, 'checked in');
    assertEqual(stats.remaining, 2, 'remaining');
    assert(Math.abs(stats.rate - 33.33) < 0.01, `rate should be ~33.33, got ${stats.rate}`);

    const recent = await checkinService.getRecentCheckIns(event.id);
    assertEqual(recent.length, 1, 'only successful admissions appear in the recent feed');
    assertEqual(recent[0].eventRegistration.fullName, a.registration.fullName, 'the right person');
  });

  // --- removing a check-in --------------------------------------------------
  //
  // The correction path. Two things have to be true at once for it to be safe:
  // the person really is no longer admitted (so the count is right and their
  // ticket works again), and the fact that they WERE admitted is still on the
  // record (so a disputed admission can be reconstructed afterwards).

  await test('removing a check-in lets the same ticket be scanned again', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });

    const undo = await checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession,
    });
    assertEqual(undo.ok, true, 'the removal succeeded');
    assertEqual(undo.result, 'UNDONE', 'reported as undone');

    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assertEqual(after.checkedInAt, null, 'no longer checked in');

    // The whole point: the wrong person was let through, so the right one still
    // has to be able to get in on this ticket.
    const again = await checkinService.checkInByScan({
      eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession,
    });
    assertEqual(again.result, 'SUCCESS', 'the ticket admits again');
  });

  await test('removing it does not erase the admission from the door log', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    await checkinService.undoCheckIn({ eventId: event.id, registrationId: registration.id, staffUser: adminSession });

    const rows = await prisma.eventCheckIn.findMany({
      where: { eventId: event.id }, orderBy: { id: 'asc' },
    });
    assertEqual(rows.length, 2, 'the admission and the reversal are both rows');
    assertEqual(rows[0].result, 'SUCCESS', 'the admission stands in the log');
    assertEqual(rows[1].result, 'UNDONE', 'and the reversal is recorded beside it');
    assertEqual(rows[1].action, 'CHECK_OUT', 'as a check-out, not another check-in');
    assertEqual(rows[1].scannedBy, admin.id, 'attributed to whoever removed it');
  });

  await test('the removal is written to the audit log, since it is done by hand', async () => {
    const event = await makeEvent();
    const { member, registration } = await makeTicketedRegistration(event);

    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });
    await checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession, scannerIdentifier: 'ENTRANCE-02',
    });

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'CHECKIN_UNDONE', targetUserId: member.id },
    });
    assert(entry, 'an audit entry exists');
    assertEqual(entry.actorId, admin.id, 'naming who did it');
  });

  await test('removing a check-in that is not there changes nothing', async () => {
    // Two operators can press Remove on the same person a second apart. The
    // second must be a plain "nothing to do", not an error and not a second
    // CHECK_OUT row implying two separate reversals.
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);

    const result = await checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession,
    });
    assertEqual(result.ok, false, 'nothing was removed');
    assertEqual(result.result, 'NOT_CHECKED_IN', 'and it says so plainly');

    const rows = await prisma.eventCheckIn.count({ where: { eventId: event.id } });
    assertEqual(rows, 0, 'no row is written for a reversal that did not happen');
  });

  await test('ten operators removing the same check-in at once record one reversal', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });

    const results = await Promise.all(Array.from({ length: 10 }, () => checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession,
    })));

    assertEqual(results.filter((r) => r.ok).length, 1, 'exactly one removal wins');
    const undone = await prisma.eventCheckIn.count({ where: { eventId: event.id, result: 'UNDONE' } });
    assertEqual(undone, 1, 'and exactly one reversal is logged');
  });

  await test("a check-in cannot be removed from another event's door", async () => {
    // The same scoping the scan path has. An operator granted one event must
    // not be able to reach into another's attendance by posting an id.
    const ours = await makeEvent();
    const theirs = await makeEvent();
    const { registration } = await makeTicketedRegistration(theirs);
    await checkinService.checkInByScan({ eventId: theirs.id, rawScan: registration.qrToken, staffUser: adminSession });

    await assertRejects(
      () => checkinService.undoCheckIn({ eventId: ours.id, registrationId: registration.id, staffUser: adminSession }),
      404, 'refused as not belonging to this door',
    );

    const still = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assert(still.checkedInAt, 'and they are still checked in');
  });

  await test('someone with no access to this door cannot remove a check-in', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession });

    const chapter = await makeUser('CHAPTER_ADMIN');
    await assertRejects(
      () => checkinService.undoCheckIn({
        eventId: event.id, registrationId: registration.id, staffUser: { id: chapter.id, role: 'CHAPTER_ADMIN' },
      }),
      403, 'an ungranted chapter admin is refused',
    );

    const member = await makeUser('USER');
    await assertRejects(
      () => checkinService.undoCheckIn({
        eventId: event.id, registrationId: registration.id, staffUser: { id: member.id, role: 'USER' },
      }),
      403, 'and an ordinary member certainly is',
    );
  });

  await test('an operator running this door can remove a check-in without being a main admin', async () => {
    // Deliberate: the person who needs to correct a mis-scan is the one holding
    // the scanner. A correction only a main admin can make is one that will not
    // happen while a queue is waiting.
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    const chapter = await makeUser('CHAPTER_ADMIN');
    const session = { id: chapter.id, role: 'CHAPTER_ADMIN' };
    await checkinService.grantCheckInAccess({ eventId: event.id, userId: chapter.id, adminUserId: admin.id });

    await checkinService.checkInByScan({ eventId: event.id, rawScan: registration.qrToken, staffUser: session });
    const undo = await checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: session,
    });
    assertEqual(undo.ok, true, 'the granted operator can correct their own mistake');
  });

  await test('the counts and the recent feed both follow a removal', async () => {
    const event = await makeEvent();
    const a = await makeTicketedRegistration(event);
    await makeTicketedRegistration(event);
    await checkinService.checkInByScan({ eventId: event.id, rawScan: a.registration.qrToken, staffUser: adminSession });
    await checkinService.undoCheckIn({ eventId: event.id, registrationId: a.registration.id, staffUser: adminSession });

    const stats = await checkinService.getEventCheckInStats(event.id);
    assertEqual(stats.checkedIn, 0, 'the attendance count drops back');
    assertEqual(stats.remaining, 2, 'and everyone is outstanding again');

    // The scan that admitted them is still in the feed — the door screen shows
    // it as removed rather than pretending it never happened.
    const recent = await checkinService.getRecentCheckIns(event.id);
    assertEqual(recent.length, 1, 'the admission is still listed');
    assertEqual(recent[0].eventRegistration.checkedInAt, null, 'carrying its current state, so the screen can say Removed');
  });

  await test('an undone scan is reported as its own outcome, not as a refusal', async () => {
    const event = await makeEvent();
    const { registration } = await makeTicketedRegistration(event);
    await checkinService.checkInByScan({
      eventId: event.id, rawScan: registration.qrToken, staffUser: adminSession, scannerIdentifier: 'ENTRANCE-07',
    });
    await checkinService.undoCheckIn({
      eventId: event.id, registrationId: registration.id, staffUser: adminSession, scannerIdentifier: 'ENTRANCE-07',
    });

    const stations = await checkinReportService.getStationBreakdown(event.id);
    const station = stations.find((st) => st.station === 'ENTRANCE-07');
    assert(station, 'the station appears in the breakdown');
    assertEqual(station.admitted, 1, 'the admission still counts as one');
    assertEqual(station.undone, 1, 'the reversal is counted separately');
    assertEqual(station.refused, 0, 'and never as somebody being turned away');
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
