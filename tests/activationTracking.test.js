// Tests for the Activations page's data and its actions.
//
// The part worth testing hardest is deriveState, because every number and badge
// on that page comes out of it and none of it is stored — a wrong precedence
// rule there shows an admin a member who is fine as broken, or a broken one as
// fine, and nothing else would contradict it.
//
// The Mergo import is tested against real workbooks built in memory with
// ExcelJS, because the whole point of that code is coping with a sheet a person
// has been editing: renamed tabs, reordered rows, Mergo's own status wording.
//
// Runs against the dev database. Throwaway rows only, cleaned up at the end.

const assert = require('assert');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

require('dotenv').config();

const prisma = require('../src/config/prisma');
const tracking = require('../src/services/activationTracking.service');

const TAG = '__acttrack__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

const DAY = 24 * 60 * 60 * 1000;

async function makeMember(label, { activated = false } = {}) {
  return prisma.user.create({
    data: {
      firstName: 'Act', lastName: label,
      email: `${label.toLowerCase()}.${TAG}@example.test`,
      password: await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10),
      passwordSetAt: activated ? new Date() : null,
      emailVerifiedAt: activated ? new Date() : null,
      status: activated ? 'APPROVED' : 'PENDING',
      role: 'USER',
    },
    select: { id: true, email: true, passwordSetAt: true },
  });
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return 0;
  await prisma.activationInvite.deleteMany({ where: { userId: { in: ids } } });
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

// A workbook shaped like the one Mergo hands back.
async function mergoSheet(rows, { sheetName = 'Invites', statusHeader = 'Merge status', includeEmail = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const header = [];
  if (includeEmail) header.push('Email');
  header.push('First Name');
  if (statusHeader) header.push(statusHeader);
  header.push('Error message', 'Opened');
  ws.addRow(header);
  for (const r of rows) {
    const line = [];
    if (includeEmail) line.push(r.email || '');
    line.push(r.firstName || 'X');
    if (statusHeader) line.push(r.status || '');
    line.push(r.reason || '', r.opened || '');
    ws.addRow(line);
  }
  return wb.xlsx.writeBuffer();
}

async function main() {
  await cleanup();

  console.log('\nderiveState — precedence, with no database involved\n');

  await test('an activated member is ACTIVATED whatever else happened', () => {
    const user = { id: 1, passwordSetAt: new Date() };
    // Everything below screams failure, and none of it matters: they got in.
    const token = { expiresAt: new Date(Date.now() - DAY), usedAt: null };
    const invite = { status: 'BOUNCED' };
    assert.strictEqual(tracking.deriveState(user, token, invite), 'ACTIVATED');
  });

  await test('BOUNCED outranks an expired link', () => {
    // A bad address needs the address fixed. Reporting "link expired" would send
    // the admin to resend to the same dead address, forever.
    const user = { id: 1, passwordSetAt: null };
    const token = { expiresAt: new Date(Date.now() - DAY), usedAt: null };
    assert.strictEqual(tracking.deriveState(user, token, { status: 'BOUNCED' }), 'BOUNCED');
  });

  await test('a FAILED send reads as SEND_FAILED, not as invited', () => {
    const user = { id: 1, passwordSetAt: null };
    const token = { expiresAt: new Date(Date.now() + DAY), usedAt: null };
    assert.strictEqual(tracking.deriveState(user, token, { status: 'FAILED' }), 'SEND_FAILED');
  });

  await test('no token at all is NEVER_INVITED', () => {
    assert.strictEqual(tracking.deriveState({ id: 1, passwordSetAt: null }, null, null), 'NEVER_INVITED');
  });

  await test('an invite row without a token is still NEVER_INVITED', () => {
    // The link is the thing being tracked. A SENT row with no token means the
    // token was cleared; there is nothing for the member to open.
    assert.strictEqual(
      tracking.deriveState({ id: 1, passwordSetAt: null }, null, { status: 'SENT' }),
      'NEVER_INVITED'
    );
  });

  await test('a past expiresAt is EXPIRED', () => {
    const token = { expiresAt: new Date(Date.now() - 1000), usedAt: null };
    assert.strictEqual(tracking.deriveState({ id: 1, passwordSetAt: null }, token, { status: 'SENT' }), 'EXPIRED');
  });

  await test('a live unused token is INVITED', () => {
    const token = { expiresAt: new Date(Date.now() + DAY), usedAt: null };
    assert.strictEqual(tracking.deriveState({ id: 1, passwordSetAt: null }, token, { status: 'SENT' }), 'INVITED');
  });

  await test('expiry is judged against the passed clock, not the real one', () => {
    // The page derives every row against one timestamp so a long list cannot
    // report two members differently for being read a second apart.
    const token = { expiresAt: new Date(2000), usedAt: null };
    assert.strictEqual(tracking.deriveState({ id: 1, passwordSetAt: null }, token, null, 1000), 'INVITED');
    assert.strictEqual(tracking.deriveState({ id: 1, passwordSetAt: null }, token, null, 3000), 'EXPIRED');
  });

  console.log('\nrecording what the transport said\n');

  let sent;
  let failedSend;
  let bounced;
  let expired;
  let activated;
  let never;

  await test('a successful send is recorded as SENT with a sentAt', async () => {
    sent = await makeMember('Sent');
    await tracking.recordSendOutcome(sent.id, { ok: true });
    const row = await prisma.activationInvite.findFirst({ where: { userId: sent.id } });
    assert.strictEqual(row.status, 'SENT');
    assert(row.sentAt, 'sentAt was not set');
    assert.strictEqual(row.channel, 'SITE');
  });

  await test('a failed send is recorded as FAILED with a reason and no sentAt', async () => {
    failedSend = await makeMember('Failed');
    await tracking.recordSendOutcome(failedSend.id, { ok: false, reason: 'Mailbox unavailable' });
    const row = await prisma.activationInvite.findFirst({ where: { userId: failedSend.id } });
    assert.strictEqual(row.status, 'FAILED');
    assert.strictEqual(row.sentAt, null);
    assert(/Mailbox unavailable/.test(row.failureReason), 'the reason was not kept');
  });

  await test('a broken recording never throws — it must not retry a sent email', async () => {
    // Called with an id that cannot exist: the FK rejects it. The handler awaits
    // this after the email has already gone out, so a throw here would fail the
    // job, and the retry would send the member a second link.
    const result = await tracking.recordSendOutcome(-1, { ok: true });
    assert.strictEqual(result, null, 'it should return null rather than throw');
  });

  console.log('\nloadStates — what the page actually shows\n');

  await test('each member lands in the right state', async () => {
    bounced = await makeMember('Bounced');
    expired = await makeMember('Expired');
    activated = await makeMember('Joined', { activated: true });
    never = await makeMember('Never');

    await tracking.recordSendOutcome(bounced.id, { ok: true });
    await prisma.activationInvite.create({
      data: { userId: bounced.id, channel: 'MERGO', status: 'BOUNCED', bouncedAt: new Date(), failureReason: 'Address not found' },
    });
    await prisma.passwordResetToken.create({
      data: { userId: bounced.id, tokenHash: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + DAY) },
    });
    await prisma.passwordResetToken.create({
      data: { userId: expired.id, tokenHash: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() - DAY) },
    });
    await prisma.passwordResetToken.create({
      data: { userId: sent.id, tokenHash: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + DAY) },
    });

    const { rows } = await tracking.loadStates({ search: TAG, pageSize: 200 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.strictEqual(byId.get(bounced.id).state, 'BOUNCED', 'bounced member');
    assert.strictEqual(byId.get(expired.id).state, 'EXPIRED', 'expired member');
    assert.strictEqual(byId.get(activated.id).state, 'ACTIVATED', 'activated member');
    assert.strictEqual(byId.get(never.id).state, 'NEVER_INVITED', 'never-invited member');
    assert.strictEqual(byId.get(sent.id).state, 'INVITED', 'invited member');
    assert.strictEqual(byId.get(failedSend.id).state, 'SEND_FAILED', 'failed-send member');
  });

  await test('the latest attempt wins, not the first', async () => {
    // bounced has a SENT row and then a BOUNCED row. Reading the oldest would
    // report the address as working.
    const { rows } = await tracking.loadStates({ search: TAG, pageSize: 200 });
    const row = rows.find((r) => r.id === bounced.id);
    assert.strictEqual(row.state, 'BOUNCED');
    assert.strictEqual(row.attempts, 2, 'both attempts should be counted');
    assert(/Address not found/.test(row.failureReason || ''), 'the latest reason should show');
  });

  await test('counts are over everything matching, not over the visible page', async () => {
    const full = await tracking.loadStates({ search: TAG, pageSize: 200 });
    const paged = await tracking.loadStates({ search: TAG, pageSize: 2, page: 1 });
    assert.strictEqual(paged.rows.length, 2, 'the page should be limited');
    assert.deepStrictEqual(paged.counts, full.counts,
      'the tallies changed when the page size changed');
  });

  await test('filtering by state returns only that state', async () => {
    const { rows } = await tracking.loadStates({ search: TAG, state: 'BOUNCED', pageSize: 200 });
    assert(rows.length >= 1, 'expected at least the bounced member');
    assert(rows.every((r) => r.state === 'BOUNCED'), 'the filter let another state through');
  });

  await test('an activated member is never offered a resend', async () => {
    const { rows } = await tracking.loadStates({ search: TAG, pageSize: 200 });
    const row = rows.find((r) => r.id === activated.id);
    assert.strictEqual(row.resendable, false);
  });

  console.log('\nresending\n');

  await test('resending refuses a member who has already activated', async () => {
    const result = await tracking.resendFor(activated.id);
    assert.strictEqual(result.queued, false);
    assert.strictEqual(result.reason, 'ALREADY_ACTIVATED');
  });

  await test('resending an un-activated member queues one job', async () => {
    const before = await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } });
    const result = await tracking.resendFor(expired.id);
    const after = await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } });
    assert.strictEqual(result.queued, true);
    assert.strictEqual(after - before, 1, 'expected exactly one new job');
    // Cleaned up so the queue is not left with work for a member about to vanish.
    const job = await prisma.job.findFirst({ where: { type: 'SEND_ACTIVATION_EMAIL' }, orderBy: { id: 'desc' } });
    await prisma.job.delete({ where: { id: job.id } });
  });

  await test('a bulk resend refuses INVITED — it would kill live links', async () => {
    const result = await tracking.resendForState('INVITED');
    assert.strictEqual(result.reason, 'NOT_RESENDABLE');
    assert.strictEqual(result.queued, 0);
  });

  await test('a bulk resend refuses ACTIVATED', async () => {
    const result = await tracking.resendForState('ACTIVATED');
    assert.strictEqual(result.reason, 'NOT_RESENDABLE');
  });

  await test('a site resend will not break the link in a queued Mergo email', async () => {
    // eslint-disable-next-line global-require
    const passwordReset = require('../src/services/passwordReset.service');
    const member = await makeMember('MergoPending');
    const issued = await passwordReset.issueResetLink(member.id, { ttlMs: passwordReset.ACTIVATION_TTL_MS });
    const attempt = await prisma.activationInvite.create({
      data: {
        userId: member.id, channel: 'MERGO', status: 'PENDING', providerStatus: 'QUEUED',
        attemptId: `ACT-TEST-${member.id}`, tokenHash: issued.tokenHash, email: member.email,
      },
    });
    const before = await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } });

    assert.strictEqual((await tracking.resendFor(member.id)).reason, 'MERGO_LINK_PENDING');
    assert.strictEqual((await passwordReset.queueActivation(member.id)).reason, 'MERGO_LINK_PENDING');
    assert.strictEqual(await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } }), before, 'nothing was queued');

    // Once that email bounces, a site send is exactly the right fix.
    await prisma.activationInvite.update({ where: { id: attempt.id }, data: { providerStatus: 'BOUNCED', status: 'BOUNCED' } });
    assert.strictEqual((await tracking.resendFor(member.id)).queued, true, 'a bounced Mergo email can be replaced');
    const job = await prisma.job.findFirst({ where: { type: 'SEND_ACTIVATION_EMAIL' }, orderBy: { id: 'desc' } });
    await prisma.job.delete({ where: { id: job.id } });
  });

  await test('Send activation links counts and emails members only, and respects the per-press cap', async () => {
    // eslint-disable-next-line global-require
    const passwordReset = require('../src/services/passwordReset.service');
    const before = await passwordReset.pendingActivationCount();
    const admin = await prisma.user.create({
      data: {
        firstName: 'Act', lastName: 'NoPassAdmin', email: `noadmin.${TAG}@example.test`,
        password: 'x', passwordSetAt: null, status: 'APPROVED', role: 'ADMIN',
      },
      select: { id: true },
    });
    await makeMember('CapCheck');
    assert.strictEqual(await passwordReset.pendingActivationCount(), before + 1, 'the member counts; the admin does not');

    // limit 0: nothing is queued, so this touches no real member in the dev
    // database, yet the result still shows who would have been sent to.
    const jobsBefore = await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } });
    const result = await passwordReset.sendActivationsForPending({ limit: 0 });
    assert.strictEqual(result.queued, 0);
    assert(result.remaining >= 1, 'the waiting member is reported as remaining for the next press');
    assert.strictEqual(await prisma.job.count({ where: { type: 'SEND_ACTIVATION_EMAIL' } }), jobsBefore, 'nothing was queued');
    await prisma.user.delete({ where: { id: admin.id } });
  });

  console.log('\nreading Mergo results back in\n');

  await test('a dry run writes nothing at all', async () => {
    const before = await prisma.activationInvite.count({ where: { userId: never.id } });
    const buf = await mergoSheet([{ email: never.email, status: 'Bounced', reason: 'Address not found' }]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    const after = await prisma.activationInvite.count({ where: { userId: never.id } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(res.bounced, 1);
    assert.strictEqual(after, before, 'the dry run wrote a row');
  });

  await test('applying records a BOUNCED outcome against the right member', async () => {
    const buf = await mergoSheet([{ email: never.email, status: 'Bounced (550 5.1.1)', reason: 'Address not found' }]);
    const res = await tracking.importMergoStatuses(buf, {});
    assert.strictEqual(res.matched, 1);
    const row = await prisma.activationInvite.findFirst({
      where: { userId: never.id }, orderBy: { id: 'desc' },
    });
    assert.strictEqual(row.status, 'BOUNCED');
    assert.strictEqual(row.channel, 'MERGO');
    assert(row.bouncedAt, 'bouncedAt was not set');
    // And the page now shows them as bounced rather than not-invited.
    const { rows } = await tracking.loadStates({ search: TAG, pageSize: 200 });
    assert.strictEqual(rows.find((r) => r.id === never.id).state, 'BOUNCED');
  });

  await test("Mergo's wording is matched loosely, not exactly", async () => {
    // Real sheets carry "Bounced (550 ...)", "Email sent", "Opened on ...".
    const buf = await mergoSheet([
      { email: sent.email, status: 'Email delivered' },
      { email: expired.email, status: 'opened' },
    ]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.delivered, 2, 'both should read as delivered');
  });

  await test('an address that is not a member is reported, not silently skipped', async () => {
    const buf = await mergoSheet([{ email: `ghost.${TAG}@nowhere.test`, status: 'Bounced' }]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.matched, 0);
    assert(res.errors.some((e) => /no member has the address/i.test(e)),
      'the unmatched address was not reported: ' + JSON.stringify(res.errors));
  });

  await test('the same address twice is reported and only counted once', async () => {
    const buf = await mergoSheet([
      { email: sent.email, status: 'Bounced' },
      { email: sent.email, status: 'Delivered' },
    ]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.read, 1, 'the duplicate should not be read twice');
    assert(res.errors.some((e) => /appears more than once/i.test(e)), 'the duplicate was not reported');
  });

  await test('errors name the spreadsheet row number', async () => {
    // Row 1 is the header, so a bad address on the first data row is row 2.
    const buf = await mergoSheet([{ email: `ghost.${TAG}@nowhere.test`, status: 'Bounced' }]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert(res.errors.some((e) => /^Row 2:/.test(e)),
      'the error did not name row 2: ' + JSON.stringify(res.errors));
  });

  await test('a sheet with no status column is refused with an explanation', async () => {
    const buf = await mergoSheet([{ email: sent.email }], { statusHeader: null });
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.ok, false);
    assert(/no status column/i.test(res.error), 'unhelpful error: ' + res.error);
  });

  await test('a sheet with no Email column is refused', async () => {
    const buf = await mergoSheet([{ status: 'Bounced' }], { includeEmail: false });
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.ok, false);
    assert(/Email/i.test(res.error));
  });

  await test('a renamed tab still works — people rename sheets', async () => {
    const buf = await mergoSheet([{ email: sent.email, status: 'Delivered' }], { sheetName: 'Sheet1 copy' });
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.matched, 1);
  });

  await test('an unreadable status is reported rather than guessed at', async () => {
    const buf = await mergoSheet([{ email: sent.email, status: 'Schrodinger' }]);
    const res = await tracking.importMergoStatuses(buf, { dryRun: true });
    assert.strictEqual(res.ok, false, 'nothing readable, so nothing to apply');
    assert(res.errors.some((e) => /not a status this can read/i.test(e)));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(async () => {
    const n = await cleanup();
    console.log(`cleaned up ${n} throwaway member(s)`);
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
