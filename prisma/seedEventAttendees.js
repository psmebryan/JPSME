// Dummy attendees registered to one event, for trying the door and the seat map
// without waiting for real people.
//
//   npm run seed:attendees -- --event "Stage"
//   npm run seed:attendees -- --event 1001708 --count 40
//   npm run seed:attendees -- --event "Stage" --clean
//
// Every account uses the suffix below, and --clean deletes strictly by that
// exact suffix — never a loose pattern, so a real member cannot be caught by it.
// Deliberately a different suffix from seedDummyUsers' @dummy.test, so cleaning
// one set never takes the other with it.
//
// Registrations go through qr.service.assignRegistrationIdentity, the same
// function a real registration uses, so these tickets are indistinguishable
// from real ones at the door rather than a lookalike that behaves differently.

const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const qrService = require('../src/services/qr.service');
const organizationService = require('../src/services/organization.service');

const DUMMY_DOMAIN = '@attendee.test';
const PASSWORD = 'Dummy123!';

const FIRST = [
  'Juan', 'Maria', 'Jose', 'Ana', 'Pedro', 'Rosa', 'Carlo', 'Liza', 'Mark', 'Grace',
  'Paulo', 'Divine', 'Rico', 'Jenny', 'Allan', 'Mae', 'Bryan', 'Kim', 'Noel', 'Faith',
  'Arvin', 'Trisha', 'Dennis', 'Joy', 'Elmer', 'Sheila', 'Ryan', 'Carmela', 'Edgar', 'Nina',
];
const LAST = [
  'Dela Cruz', 'Santos', 'Reyes', 'Bautista', 'Ocampo', 'Villanueva', 'Mendoza', 'Aquino',
  'Navarro', 'Del Rosario', 'Gatchalian', 'Panganiban', 'Salazar', 'Tolentino', 'Ramos',
];

// A spread of states, so the door has something to refuse and the map has
// something other than one colour. Proportions, not counts — they scale with
// whatever --count is asked for.
const MIX = [
  { status: 'REGISTERED', share: 0.8, note: 'normal ticket' },
  { status: 'PENDING_PAYMENT', share: 0.1, note: 'refused at the door as UNPAID' },
  { status: 'CANCELLED', share: 0.1, note: 'refused at the door as CANCELLED' },
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const has = (name) => process.argv.includes(`--${name}`);

async function findEvent(which) {
  if (!which) throw new Error('Which event? Pass --event "Title" or --event <id>');

  if (/^\d+$/.test(which)) {
    const byId = await prisma.event.findUnique({ where: { id: Number(which) } });
    if (byId) return byId;
  }

  const matches = await prisma.event.findMany({
    where: { title: { contains: which } },
    orderBy: { startDate: 'desc' },
  });
  if (!matches.length) throw new Error(`No event matches "${which}"`);
  if (matches.length > 1) {
    // Named rather than guessed: seeding forty people onto the wrong event is
    // tedious to undo by hand.
    throw new Error(
      `"${which}" matches ${matches.length} events. Use --event <id>:\n`
      + matches.map((e) => `  ${e.id}  ${e.title}  (${new Date(e.startDate).toLocaleDateString()})`).join('\n')
    );
  }
  return matches[0];
}

async function clean(event) {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DUMMY_DOMAIN } },
    select: { id: true },
  });
  const ids = users.length ? users.map((u) => u.id) : [0];

  const registrations = await prisma.eventRegistration.findMany({
    where: { userId: { in: ids }, eventId: event.id },
    select: { id: true },
  });
  const regIds = registrations.length ? registrations.map((r) => r.id) : [0];

  // Seats and attendance first: both point at the registration, and one of them
  // (seats) only sets null on delete, which would leave the plan looking
  // occupied by nobody.
  await prisma.seat.updateMany({
    where: { OR: [{ assignedRegistrationId: { in: regIds } }, { heldByRegistrationId: { in: regIds } }] },
    data: { assignedRegistrationId: null, heldByRegistrationId: null, heldUntil: null },
  });
  await prisma.seatAssignment.deleteMany({ where: { registrationId: { in: regIds } } });
  await prisma.roomAttendance.deleteMany({ where: { eventRegistrationId: { in: regIds } } });
  await prisma.eventCheckIn.deleteMany({ where: { eventRegistrationId: { in: regIds } } });
  const removed = await prisma.eventRegistration.deleteMany({ where: { id: { in: regIds } } });

  // The accounts go only if they are registered for nothing else.
  const orphans = await prisma.user.findMany({
    where: { id: { in: ids }, registrations: { none: {} } },
    select: { id: true },
  });
  await prisma.user.deleteMany({ where: { id: { in: orphans.length ? orphans.map((o) => o.id) : [0] } } });

  console.log(`Removed ${removed.count} registrations and ${orphans.length} accounts from "${event.title}".`);
}

async function main() {
  const event = await findEvent(arg('event'));

  if (has('clean')) {
    await clean(event);
    return;
  }

  const count = Math.max(1, Math.min(500, Number(arg('count', 20))));
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // Attached to real organizations where any exist, so the door screen and the
  // exports show a chapter rather than a blank.
  const units = await prisma.organization.findMany({
    where: { type: 'STUDENT_UNIT', isActive: true },
    take: 30,
    select: { id: true },
  });

  // Built from the proportions above, then padded out with normal tickets so
  // the total is exactly what was asked for.
  const plan = [];
  MIX.forEach((band) => {
    const n = Math.floor(count * band.share);
    for (let i = 0; i < n; i += 1) plan.push(band.status);
  });
  while (plan.length < count) plan.push('REGISTERED');

  // Highest existing suffix, so running this twice numbers on from where it
  // stopped instead of colliding on the unique email.
  const existing = await prisma.user.count({ where: { email: { endsWith: DUMMY_DOMAIN } } });

  const made = [];
  for (let i = 0; i < plan.length; i += 1) {
    const n = existing + i + 1;
    const firstName = FIRST[n % FIRST.length];
    const lastName = LAST[(n * 7) % LAST.length];
    const status = plan[i];
    const organizationId = units.length ? units[n % units.length].id : null;

    // eslint-disable-next-line no-await-in-loop
    const user = await prisma.user.create({
      data: {
        firstName: firstName.toUpperCase(),
        lastName: lastName.toUpperCase(),
        email: `attendee${n}${DUMMY_DOMAIN}`,
        password: passwordHash,
        role: 'USER',
        status: 'APPROVED',
        emailVerifiedAt: new Date(),
        organizationId,
      },
    });

    // eslint-disable-next-line no-await-in-loop
    const organizationPath = organizationId
      ? await organizationService.getOrganizationPathLabel(organizationId).catch(() => null)
      : null;

    // eslint-disable-next-line no-await-in-loop
    const registration = await prisma.eventRegistration.create({
      data: {
        userId: user.id,
        eventId: event.id,
        fullName: `${firstName.toUpperCase()} ${lastName.toUpperCase()}`,
        email: user.email,
        status,
        organizationId,
        organizationPath,
      },
    });

    // A CANCELLED registration legitimately has no usable ticket, which is what
    // makes it worth seeding — the door should refuse it on the registration,
    // not because the code is unknown.
    let withQr = registration;
    if (status !== 'CANCELLED') {
      // eslint-disable-next-line no-await-in-loop
      withQr = await qrService.assignRegistrationIdentity(prisma, registration.id);
    }

    made.push({
      name: registration.fullName,
      status,
      registrationNumber: withQr.registrationNumber || '—',
      qrToken: withQr.qrToken || '(no ticket — cancelled)',
    });
  }

  const byStatus = made.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {});
  console.log(`\nAdded ${made.length} attendees to "${event.title}" (id ${event.id}).`);
  console.log(Object.entries(byStatus).map(([s, n]) => `  ${n} ${s}`).join('\n'));
  console.log(`\nAll accounts: password ${PASSWORD}, email attendeeN${DUMMY_DOMAIN}`);

  console.log('\nPaste one of these into the scan box to test a door:\n');
  made.filter((m) => m.status === 'REGISTERED').slice(0, 8).forEach((m) => {
    console.log(`  ${m.registrationNumber}  ${m.name.padEnd(24)} ${m.qrToken}`);
  });

  const refused = made.filter((m) => m.status !== 'REGISTERED');
  if (refused.length) {
    console.log('\nThese should be refused at the door — worth trying too:\n');
    refused.slice(0, 4).forEach((m) => {
      console.log(`  ${m.status.padEnd(16)} ${m.name.padEnd(24)} ${m.qrToken}`);
    });
  }

  console.log(`\nUndo with:  npm run seed:attendees -- --event ${event.id} --clean\n`);
}

main()
  .catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
