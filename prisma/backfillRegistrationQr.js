// One-off, re-runnable: gives every already-confirmed event registration the QR
// identity that registrations created from now on get automatically.
//
// Needed because the phase 1 migration added qrToken/registrationNumber as
// nullable columns without backfilling them — the migration could not mint
// tokens, since generating a cryptographically random value per row is
// application work, not SQL. Any registration that reached REGISTERED before
// this feature shipped therefore has no ticket and would be turned away at the
// door with INVALID_QR.
//
//   node prisma/backfillRegistrationQr.js            # do it
//   node prisma/backfillRegistrationQr.js --dry-run  # just report
//
// Only touches REGISTERED rows with no token yet. PENDING_PAYMENT and CANCELLED
// registrations are skipped on purpose: neither is entitled to a working ticket,
// and minting one for them is precisely the bypass the whole design avoids.
// Safe to run repeatedly — a row that already has a token is left alone, so this
// can be run again after a partial failure without reissuing anyone's ticket.

const prisma = require('../src/config/prisma');
const qrService = require('../src/services/qr.service');

const BATCH_SIZE = 200;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const pending = await prisma.eventRegistration.count({
    where: { status: 'REGISTERED', qrToken: null },
  });
  const alreadyDone = await prisma.eventRegistration.count({
    where: { status: 'REGISTERED', qrToken: { not: null } },
  });

  console.log(`Confirmed registrations needing a ticket: ${pending}`);
  console.log(`Already have one (left untouched):        ${alreadyDone}`);

  if (!pending) {
    console.log('\nNothing to do.');
    return;
  }
  if (dryRun) {
    console.log('\n--dry-run: no changes written.');
    return;
  }

  let done = 0;
  let failed = 0;

  // Paged by id rather than by skip/take: every row processed stops matching
  // the `qrToken: null` filter, so an offset-based page would step over rows
  // that shifted into the window behind it.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await prisma.eventRegistration.findMany({
      where: { status: 'REGISTERED', qrToken: null },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    if (!batch.length) break;

    for (const row of batch) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await qrService.assignRegistrationIdentity(prisma, row.id);
        done += 1;
      } catch (err) {
        // One bad row must not abandon the rest — the run is resumable, so
        // report and carry on rather than leaving the remainder unticketed.
        failed += 1;
        console.error(`  registration ${row.id}: ${err.message}`);
      }
    }
    console.log(`  ...${done} ticketed`);
  }

  console.log(`\nDone. ${done} ticketed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
