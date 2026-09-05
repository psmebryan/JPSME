// Tests for qr.service.js. Runs against the real dev database, same approach as
// tests/organization.service.test.js and tests/paymongo.service.test.js — this
// project has no test framework. Fixtures are clearly tagged and removed in a
// finally block, so a failure mid-run still cleans up after itself.
//
// Covers the parts of QR handling that are easy to get quietly wrong: what a
// gun scanner actually transmits (case, whitespace, its trailing Enter), that
// minting a token twice does not invalidate a ticket someone already saved, and
// that regenerating one really does kill the old code rather than leaving two
// working QRs pointing at the same registration.

const prisma = require('../src/config/prisma');
const qrService = require('../src/services/qr.service');

const TAG = '__QRTEST__';
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

async function cleanup() {
  const regs = await prisma.eventRegistration.findMany({
    where: { fullName: { contains: TAG } },
    select: { id: true, userId: true },
  });
  const userIds = [...new Set(regs.map((r) => r.userId))];
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: userIds.length ? userIds : [0] } } });
  await prisma.eventRegistration.deleteMany({ where: { fullName: { contains: TAG } } });
  await prisma.event.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TAG.toLowerCase() } } });
}

async function main() {
  await cleanup();

  const event = await prisma.event.create({
    data: { title: `${TAG} Convention`, startDate: new Date(Date.now() + 86400000) },
  });
  const user = await prisma.user.create({
    data: {
      firstName: 'Qr', lastName: 'Tester',
      email: `${TAG.toLowerCase()}member@example.test`,
      password: 'not-a-real-hash', status: 'APPROVED',
    },
  });
  // A fresh member per registration: EventRegistration is unique on
  // (userId, eventId), so every case below needs its own registrant rather than
  // reusing one. That constraint is the schema working as intended — one person
  // holds one registration per event — not something to work around.
  let seq = 0;
  async function makeRegistration(status = 'REGISTERED') {
    seq += 1;
    const registrant = await prisma.user.create({
      data: {
        firstName: 'Qr', lastName: `Tester${seq}`,
        email: `${TAG.toLowerCase()}member${seq}@example.test`,
        password: 'not-a-real-hash', status: 'APPROVED',
      },
    });
    return prisma.eventRegistration.create({
      data: {
        userId: registrant.id, eventId: event.id, status,
        fullName: `${TAG} Qr Tester${seq}`, email: registrant.email,
      },
    });
  }

  // --- token generation -----------------------------------------------------

  await test('generateQrToken produces 64 lowercase hex characters', async () => {
    const token = qrService.generateQrToken();
    assert(/^[0-9a-f]{64}$/.test(token), `token was ${token}`);
  });

  await test('generateQrToken does not repeat across 5000 draws', async () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(qrService.generateQrToken());
    assertEqual(seen.size, 5000, 'every generated token should be distinct');
  });

  // --- what the scanner actually sends --------------------------------------

  await test('a payload round-trips back to its token', async () => {
    const token = qrService.generateQrToken();
    assertEqual(qrService.normalizeScannedValue(qrService.buildQrPayload(token)), token, 'round trip');
  });

  await test('scanner quirks are absorbed: Enter, whitespace, caps, stripped prefix', async () => {
    const token = qrService.generateQrToken();
    const payload = qrService.buildQrPayload(token);
    const variants = {
      'trailing CRLF (the scanner Enter)': `${payload}\r\n`,
      'trailing newline': `${payload}\n`,
      'surrounding whitespace': `   ${payload}   `,
      'transmitted in caps': payload.toUpperCase(),
      'prefix stripped by the scanner itself': token,
      'bare token in caps': token.toUpperCase(),
      'space after the prefix': `${qrService.QR_PAYLOAD_PREFIX} ${token}`,
    };
    for (const [label, raw] of Object.entries(variants)) {
      assertEqual(qrService.normalizeScannedValue(raw), token, `should accept ${label}`);
    }
  });

  await test('anything that is not one of our codes is rejected before it reaches the database', async () => {
    const rejects = {
      'empty string': '',
      'whitespace only': '   ',
      'null': null,
      'undefined': undefined,
      'a number': 12345,
      'a shipping barcode': '4006381333931',
      'someone else\'s QR': 'https://example.com/pay/abc123',
      'right length, wrong alphabet': 'z'.repeat(64),
      'one character short': '0'.repeat(63),
      'one character long': '0'.repeat(65),
      'SQL-looking input': "' OR 1=1 --",
    };
    for (const [label, raw] of Object.entries(rejects)) {
      assertEqual(qrService.normalizeScannedValue(raw), null, `should reject ${label}`);
    }
  });

  // --- registration number --------------------------------------------------

  await test('registration number is built from the year and a padded id', async () => {
    assertEqual(
      qrService.buildRegistrationNumber({ id: 123, createdAt: new Date('2026-03-04T00:00:00Z') }),
      'REG-2026-000123',
      'formatted number',
    );
  });

  await test('registration number does not overflow its padding', async () => {
    assertEqual(
      qrService.buildRegistrationNumber({ id: 1234567, createdAt: new Date('2026-01-01T00:00:00Z') }),
      'REG-2026-1234567',
      'ids past six digits keep their digits rather than being truncated',
    );
  });

  // --- minting --------------------------------------------------------------

  await test('assignRegistrationIdentity mints a token and a number', async () => {
    const reg = await makeRegistration();
    const out = await qrService.assignRegistrationIdentity(prisma, reg.id);
    assert(/^[0-9a-f]{64}$/.test(out.qrToken), 'token minted');
    assertEqual(out.registrationNumber, `REG-${reg.createdAt.getFullYear()}-${String(reg.id).padStart(6, '0')}`, 'number minted');
    assert(out.qrGeneratedAt instanceof Date, 'qrGeneratedAt stamped');
  });

  await test('minting twice keeps the first token — a saved ticket is never invalidated', async () => {
    const reg = await makeRegistration();
    const first = await qrService.assignRegistrationIdentity(prisma, reg.id);
    const second = await qrService.assignRegistrationIdentity(prisma, reg.id);
    assertEqual(second.qrToken, first.qrToken, 'token unchanged on the second call');
    assertEqual(second.qrGeneratedAt.getTime(), first.qrGeneratedAt.getTime(), 'timestamp unchanged');
  });

  await test('two registrations never share a token', async () => {
    const a = await qrService.assignRegistrationIdentity(prisma, (await makeRegistration()).id);
    const b = await qrService.assignRegistrationIdentity(prisma, (await makeRegistration()).id);
    assert(a.qrToken !== b.qrToken, 'distinct tokens');
    assert(a.registrationNumber !== b.registrationNumber, 'distinct registration numbers');
  });

  await test('minting works inside a transaction, so a registration cannot commit unticketed', async () => {
    const reg = await makeRegistration();
    const out = await prisma.$transaction(async (tx) => {
      await tx.eventRegistration.update({ where: { id: reg.id }, data: { status: 'REGISTERED' } });
      return qrService.assignRegistrationIdentity(tx, reg.id);
    });
    assert(/^[0-9a-f]{64}$/.test(out.qrToken), 'token minted inside the transaction');
    const persisted = await prisma.eventRegistration.findUnique({ where: { id: reg.id } });
    assertEqual(persisted.qrToken, out.qrToken, 'and it survived the commit');
  });

  // --- resolution -----------------------------------------------------------

  await test('validateQrToken resolves a real ticket to its registration and event', async () => {
    const reg = await makeRegistration();
    const minted = await qrService.assignRegistrationIdentity(prisma, reg.id);
    const { token, registration } = await qrService.validateQrToken(qrService.buildQrPayload(minted.qrToken));
    assertEqual(token, minted.qrToken, 'token echoed back');
    assert(registration, 'registration found');
    assertEqual(registration.id, reg.id, 'the right registration');
    assertEqual(registration.event.id, event.id, 'event eagerly loaded for the door check');
  });

  await test('validateQrToken returns nothing for a well-formed token that was never issued', async () => {
    const { token, registration } = await qrService.validateQrToken(qrService.generateQrToken());
    assert(token !== null, 'the value parsed as one of ours');
    assertEqual(registration, null, 'but resolved to no registration');
  });

  await test('validateQrToken rejects junk without querying at all', async () => {
    const { token, registration } = await qrService.validateQrToken('not-a-psme-code');
    assertEqual(token, null, 'rejected at parse time');
    assertEqual(registration, null, 'no registration');
  });

  // --- regeneration ---------------------------------------------------------

  await test('regenerateQr issues a new token and the old one stops resolving', async () => {
    const reg = await makeRegistration();
    const before = await qrService.assignRegistrationIdentity(prisma, reg.id);
    const after = await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id });

    assert(after.qrToken !== before.qrToken, 'a different token was issued');
    const old = await qrService.validateQrToken(before.qrToken);
    assertEqual(old.registration, null, 'the old QR now resolves to nothing');
    const current = await qrService.validateQrToken(after.qrToken);
    assert(current.registration && current.registration.id === reg.id, 'the new QR works');
  });

  await test('regenerating keeps the registration number stable', async () => {
    const reg = await makeRegistration();
    const before = await qrService.assignRegistrationIdentity(prisma, reg.id);
    const after = await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id });
    assertEqual(after.registrationNumber, before.registrationNumber, 'the human reference does not churn');
  });

  await test('regenerating does not readmit someone already checked in', async () => {
    const reg = await makeRegistration();
    await qrService.assignRegistrationIdentity(prisma, reg.id);
    const admittedAt = new Date('2026-09-01T08:32:14Z');
    await prisma.eventRegistration.update({ where: { id: reg.id }, data: { checkedInAt: admittedAt } });

    const after = await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id });
    assert(after.checkedInAt, 'still marked as checked in');
    assertEqual(after.checkedInAt.getTime(), admittedAt.getTime(), 'the original admission time is untouched');
  });

  await test('regenerateQr is audited, and the dead token is not written to the log', async () => {
    const reg = await makeRegistration();
    const before = await qrService.assignRegistrationIdentity(prisma, reg.id);
    await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id, ipAddress: '203.0.113.9' });

    const log = await prisma.auditLog.findFirst({
      where: { action: 'QR_REGENERATED', targetUserId: reg.userId },
      orderBy: { id: 'desc' },
    });
    assert(log, 'an audit row was written');
    assertEqual(log.actorId, user.id, 'the admin who did it is recorded');
    assertEqual(log.ipAddress, '203.0.113.9', 'the origin is recorded');
    assert(!log.metadata.includes(before.qrToken), 'the revoked token must never appear in the audit log');
    const meta = JSON.parse(log.metadata);
    assertEqual(meta.registrationId, reg.id, 'metadata points at the registration');
    assertEqual(meta.hadPreviousToken, true, 'metadata records that a token was replaced');
  });

  await test('a cancelled registration cannot have a QR regenerated', async () => {
    const reg = await makeRegistration('CANCELLED');
    let threw = null;
    try {
      await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id });
    } catch (err) {
      threw = err;
    }
    assert(threw, 'it should have thrown');
    assertEqual(threw.statusCode, 400, 'rejected as a bad request');
  });

  await test('a registration still awaiting payment cannot have a QR regenerated', async () => {
    const reg = await makeRegistration('PENDING_PAYMENT');
    let threw = null;
    try {
      await qrService.regenerateQr({ registrationId: reg.id, adminUserId: user.id });
    } catch (err) {
      threw = err;
    }
    assert(threw, 'it should have thrown');
    assertEqual(threw.statusCode, 400, 'rejected as a bad request');
  });

  // --- images ---------------------------------------------------------------

  await test('renderQrPng returns a real PNG', async () => {
    const png = await qrService.renderQrPng(qrService.generateQrToken());
    assert(Buffer.isBuffer(png), 'a buffer came back');
    assertEqual(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic bytes');
    assert(png.length > 500, `image looks too small to be a real code (${png.length} bytes)`);
  });

  await test('renderQrSvg returns scalable markup for print', async () => {
    const svg = await qrService.renderQrSvg(qrService.generateQrToken());
    assert(svg.startsWith('<?xml') || svg.startsWith('<svg'), 'starts as SVG');
    assert(svg.includes('viewBox'), 'has a viewBox, so it scales for print');
  });

  await test('renderQrDataUrl returns an embeddable PNG data URI', async () => {
    const url = await qrService.renderQrDataUrl(qrService.generateQrToken());
    assert(url.startsWith('data:image/png;base64,'), `unexpected prefix: ${url.slice(0, 40)}`);
  });

  await test('the encoded image carries no personal information', async () => {
    // The payload is the prefix plus the token and nothing else, so there is
    // nothing in the image to leak. Asserted rather than assumed, because this
    // is the single property the whole privacy argument rests on.
    const reg = await makeRegistration();
    const minted = await qrService.assignRegistrationIdentity(prisma, reg.id);
    const payload = qrService.buildQrPayload(minted.qrToken);
    assertEqual(payload, `${qrService.QR_PAYLOAD_PREFIX}${minted.qrToken}`, 'payload is exactly prefix + token');
    for (const secret of [user.email, 'Qr', 'Tester', String(user.id), String(reg.id), minted.registrationNumber, event.title]) {
      assert(!payload.includes(secret), `payload must not contain ${JSON.stringify(secret)}`);
    }
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
