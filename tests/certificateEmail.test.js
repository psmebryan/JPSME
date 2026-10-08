// Tests for emailing event certificates (certificate.service:
// queueEventCertificateEmails + sendEventCertificateEmail).
//
// What has to hold:
//   - nothing goes out on registration; an admin's "Send" queues them
//   - "Send to everyone" skips anyone already emailed or already queued, and
//     stops at the per-press limit, reporting the rest
//   - sending generates a missing certificate, attaches the PDF, marks it
//     emailed and releases it for download from the member's profile
//   - Regenerate clears "emailed", so the corrected one can be sent
//   - a cancelled registration is never sent to
//
// Runs against the dev database with the mail transport stubbed: nothing is
// actually emailed. Throwaway rows only, cleaned up at the end.

const assert = require('assert');

require('dotenv').config();

// Stub the mail service BEFORE anything loads it.
const mailPath = require.resolve('../src/services/mail.service');
const sent = [];
let failNextSend = false;
require.cache[mailPath] = {
  id: mailPath, filename: mailPath, loaded: true,
  exports: {
    async sendEventCertificateEmail(user, event, pdf, filename) {
      if (failNextSend) { failNextSend = false; return false; }
      sent.push({ to: user.email, event: event.title, bytes: pdf.length, filename });
      return true;
    },
  },
};

const prisma = require('../src/config/prisma');
const certificateService = require('../src/services/certificate.service');

const TAG = '__certmail__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

let seq = 0;
async function makeMember() {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'Cert', middleInitial: 'Q', lastName: `Member${seq}`,
      email: `m${seq}.${TAG}@example.test`, password: 'x', passwordSetAt: new Date(),
      emailVerifiedAt: new Date(), status: 'APPROVED', role: 'USER',
    },
  });
}

async function cleanup() {
  const events = await prisma.event.findMany({ where: { title: { contains: TAG } }, select: { id: true } });
  const eventIds = events.map((e) => e.id);
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const jobs = await prisma.job.findMany({ where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL' }, select: { id: true, payload: true } });
  const mine = jobs.filter((j) => { try { return eventIds.includes(JSON.parse(j.payload).eventId); } catch (e) { return false; } });
  if (mine.length) await prisma.job.deleteMany({ where: { id: { in: mine.map((j) => j.id) } } });
  for (const id of eventIds) {
    // eslint-disable-next-line no-await-in-loop
    await certificateService.deleteEventCertificateAssets(id).catch(() => {});
  }
  if (eventIds.length) {
    await prisma.eventCertificate.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.eventRegistration.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.certificateTemplate.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function queuedFor(eventId) {
  const jobs = await prisma.job.findMany({ where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL', status: 'PENDING' }, select: { payload: true } });
  return jobs.map((j) => JSON.parse(j.payload)).filter((p) => p.eventId === eventId).map((p) => p.userId).sort();
}

async function main() {
  await cleanup();
  const event = await prisma.event.create({
    data: { title: `${TAG} Conference`, startDate: new Date(), isPublished: true },
  });
  const [a, b, c, gone] = [await makeMember(), await makeMember(), await makeMember(), await makeMember()];
  for (const u of [a, b, c, gone]) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.eventRegistration.create({
      data: { userId: u.id, eventId: event.id, fullName: `${u.firstName} ${u.lastName}`, email: u.email, status: u === gone ? 'CANCELLED' : 'REGISTERED' },
    });
  }

  await test('"Send to everyone" queues every registered member, and stops at the per-press limit', async () => {
    const res = await certificateService.queueEventCertificateEmails({ eventId: event.id, adminUserId: a.id, limit: 2 });
    assert.strictEqual(res.queued, 2, 'two queued');
    assert.strictEqual(res.remaining, 1, 'the third waits for the next press');
    assert.strictEqual(res.total, 3, 'the cancelled registration is not counted at all');
    const again = await certificateService.queueEventCertificateEmails({ eventId: event.id, adminUserId: a.id, limit: 250 });
    assert.strictEqual(again.alreadyQueued, 2, 'the two already queued are not queued twice');
    assert.strictEqual(again.queued, 1, 'only the one left over is added');
  });

  await test('sending generates the certificate, attaches the PDF, marks it emailed and releases it', async () => {
    const res = await certificateService.sendEventCertificateEmail({ eventId: event.id, userId: a.id, adminUserId: a.id });
    assert.strictEqual(res.sent, true);
    const mail = sent.find((m) => m.to === a.email);
    assert(mail, 'an email went to the member');
    assert(mail.bytes > 1000, 'with a real PDF attached');
    assert(/\.pdf$/.test(mail.filename), 'named as a PDF');
    const cert = await prisma.eventCertificate.findUnique({ where: { eventId_userId: { eventId: event.id, userId: a.id } } });
    assert(cert.emailedAt, 'marked as emailed');
    assert.strictEqual(cert.released, true, 'released for download');
    const onProfile = await certificateService.getCertifiedEventIds(a.id, [event.id]);
    assert(onProfile.has(event.id), 'and it shows as downloadable on their profile');
  });

  await test('a send the provider refuses is not marked, so the next press retries it', async () => {
    failNextSend = true;
    const res = await certificateService.sendEventCertificateEmail({ eventId: event.id, userId: b.id, adminUserId: a.id });
    assert.strictEqual(res.sent, false);
    const cert = await prisma.eventCertificate.findUnique({ where: { eventId_userId: { eventId: event.id, userId: b.id } } });
    assert.strictEqual(cert.emailedAt, null, 'not marked as emailed');
  });

  await test('already-emailed members are skipped; Regenerate clears that so the corrected one can go', async () => {
    await prisma.job.deleteMany({ where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL', payload: { contains: `"eventId":${event.id},` } } });
    const before = await certificateService.queueEventCertificateEmails({ eventId: event.id, adminUserId: a.id });
    assert.strictEqual(before.alreadySent, 1, 'member A was already emailed');
    assert(!(await queuedFor(event.id)).includes(a.id), 'and is not queued again');

    await prisma.job.deleteMany({ where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL', payload: { contains: `"eventId":${event.id},` } } });
    await certificateService.generateEventCertificatesBulk({ eventId: event.id, userIds: [a.id], adminUserId: a.id, force: true });
    const cert = await prisma.eventCertificate.findUnique({ where: { eventId_userId: { eventId: event.id, userId: a.id } } });
    assert.strictEqual(cert.emailedAt, null, 'regenerating clears "emailed"');
    const after = await certificateService.queueEventCertificateEmails({ eventId: event.id, userIds: [a.id], adminUserId: a.id });
    assert.strictEqual(after.queued, 1, 'so the corrected certificate is sent');
  });

  await test('"Send again" sends to someone already emailed, on purpose', async () => {
    await prisma.job.deleteMany({ where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL', payload: { contains: `"eventId":${event.id},` } } });
    await certificateService.sendEventCertificateEmail({ eventId: event.id, userId: c.id, adminUserId: a.id });
    const res = await certificateService.queueEventCertificateEmails({ eventId: event.id, userIds: [c.id], resend: true, adminUserId: a.id });
    assert.strictEqual(res.queued, 1);
  });

  await test('a cancelled registration is never sent a certificate', async () => {
    const res = await certificateService.sendEventCertificateEmail({ eventId: event.id, userId: gone.id, adminUserId: a.id });
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'NOT_REGISTERED');
    assert(!sent.some((m) => m.to === gone.email), 'no email to them');
  });

  await test('the registrant list can be searched by name or email', async () => {
    const byEmail = await certificateService.listEventCertificateStatus(event.id, 'all', b.email);
    assert.deepStrictEqual(byEmail.map((r) => r.userId), [b.id], 'email finds exactly that member');
    const byName = await certificateService.listEventCertificateStatus(event.id, 'all', c.lastName);
    assert.deepStrictEqual(byName.map((r) => r.userId), [c.id], 'last name finds exactly that member');
    const none = await certificateService.listEventCertificateStatus(event.id, 'all', 'zz-nobody-zz');
    assert.strictEqual(none.length, 0, 'no match, no rows');
    const all = await certificateService.listEventCertificateStatus(event.id, 'all', '');
    assert.strictEqual(all.length, 3, 'an empty search lists every registered member');
  });

  await test('the certificate prints first name, middle initial and last name', async () => {
    // eslint-disable-next-line global-require
    const { fullName } = require('../src/utils/templateTokens');
    assert.strictEqual(fullName(a), `Cert Q. ${a.lastName}`);
  });
}

main()
  .catch((err) => { console.error('Test run failed:', err); failed += 1; })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed:', e.message));
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
