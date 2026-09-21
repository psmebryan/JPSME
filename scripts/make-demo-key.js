// Mints an integration key for a real local event and prints a ticket to scan,
// so the harness at /integration-demo can be tried in one step.
//
// Development convenience only. It creates a real, working credential — which
// is fine against a local database of test data and is not something to point
// at anything else.
//
//   node scripts/make-demo-key.js
const { PrismaClient } = require('@prisma/client');
const integrationKeyService = require('../src/services/integrationKey.service');
const prisma = new PrismaClient();

(async () => {
  // The event with the most scannable, not-yet-checked-in tickets.
  const regs = await prisma.eventRegistration.findMany({
    where: { qrToken: { not: null }, status: 'REGISTERED' },
    select: { eventId: true, fullName: true, qrToken: true, registrationNumber: true, checkedInAt: true },
  });
  const byEvent = new Map();
  regs.forEach((r) => byEvent.set(r.eventId, (byEvent.get(r.eventId) || []).concat(r)));
  const [eventId, list] = [...byEvent.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const event = await prisma.event.findUnique({ where: { id: eventId } });

  // Reuse an existing demo key if one is already active, so running this twice
  // does not litter the event with credentials.
  const existing = await prisma.eventIntegrationKey.findFirst({
    where: { eventId, revokedAt: null, label: 'Local demo' },
  });
  if (existing) {
    console.log('A "Local demo" key already exists for this event (keyId ' + existing.keyId + ').');
    console.log('Its secret cannot be shown again — revoking it and issuing a fresh one.\n');
    await prisma.eventIntegrationKey.update({
      where: { id: existing.id }, data: { revokedAt: new Date() },
    });
  }

  const { plaintext } = await integrationKeyService.createKey({
    eventId, label: 'Local demo', adminUserId: null,
  });

  const notIn = list.filter((r) => !r.checkedInAt);
  console.log('EVENT      : ' + event.title + '  (id ' + event.id + ')');
  console.log('TICKETS    : ' + list.length + ' scannable, ' + notIn.length + ' not yet checked in');
  console.log('');
  console.log('KEY (paste into the demo page):');
  console.log('  ' + plaintext);
  console.log('');
  console.log('A TICKET TO SCAN (paste into the scan box, or make a QR of it):');
  const sample = (notIn[0] || list[0]);
  console.log('  PSME-EVENT:' + sample.qrToken);
  console.log('  ^ this is ' + sample.fullName + ' (' + sample.registrationNumber + ')');
  console.log('');
  console.log('Open: http://localhost:3000/integration-demo');
  await prisma.$disconnect();
})();
