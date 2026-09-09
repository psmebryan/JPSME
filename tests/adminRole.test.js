// Tests for granting and removing the ADMIN role via userService.updateUser.
//
// This is the only path in the running application that can hand out ADMIN, so
// the guards around it are the whole of the protection:
//
//   - a chapter admin must not be able to mint one, however they craft the request
//   - nobody may remove their own admin role, which locks them out instantly
//   - the last admin may not be demoted, which locks EVERYONE out permanently —
//     the role can only be restored by an admin, and there would be none
//   - every change is written to the audit log, because granting ADMIN hands
//     over every member's personal details and the whole payment history
//
// Runs against the dev database like the other suites; fixtures are removed in
// a finally block so a failure mid-run still cleans up.

require('dotenv').config();
const prisma = require('../src/config/prisma');
const userService = require('../src/services/user.service');

const TAG = '__ROLETEST__';
let passed = 0;
let failed = 0;
const created = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${err.message}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

async function expectRejection(fn, fragment) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error(`expected a rejection mentioning ${JSON.stringify(fragment)}, got none`);
  if (!threw.message.toLowerCase().includes(fragment.toLowerCase())) {
    throw new Error(`rejected, but for the wrong reason: ${threw.message}`);
  }
  return threw;
}

let seq = 0;
async function makeUser(role = 'USER') {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      firstName: 'ROLE',
      lastName: `TEST${seq}`,
      email: `${TAG.toLowerCase()}${Date.now()}${seq}@example.invalid`,
      password: 'not-a-real-hash',
      role,
      status: 'APPROVED',
    },
  });
  created.push(user.id);
  return user;
}

const read = (id) => prisma.user.findUnique({ where: { id } });

async function auditFor(userId) {
  return prisma.auditLog.findMany({
    where: { targetUserId: userId, action: 'USER_ROLE_CHANGED' },
    orderBy: { id: 'desc' },
  });
}

async function cleanup() {
  if (!created.length) return;
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: created } } });
  await prisma.user.deleteMany({ where: { id: { in: created } } });
}

async function main() {
  // A standing admin, so the "last admin" guard is not tripped by fixtures.
  const standingAdmin = await makeUser('ADMIN');

  await test('a full admin can promote a member to ADMIN', async () => {
    const member = await makeUser('USER');
    await userService.updateUser(member.id, { role: 'ADMIN' }, { allowAdminRole: true, actorId: standingAdmin.id });
    assertEqual((await read(member.id)).role, 'ADMIN', 'role granted');
  });

  await test('a chapter admin cannot, however the request is crafted', async () => {
    // The controller strips `role` for scoped admins, but the service must not
    // depend on that: it is the last line of defence if a future caller forgets.
    const member = await makeUser('USER');
    await expectRejection(
      () => userService.updateUser(member.id, { role: 'ADMIN' }, { actorId: standingAdmin.id }),
      'chapter member management'
    );
    assertEqual((await read(member.id)).role, 'USER', 'unchanged');
  });

  await test('the lesser roles need no special permission', async () => {
    const member = await makeUser('USER');
    await userService.updateUser(member.id, { role: 'CHAPTER_ADMIN' }, { actorId: standingAdmin.id });
    assertEqual((await read(member.id)).role, 'CHAPTER_ADMIN', 'chapter admin assignable');
    await userService.updateUser(member.id, { role: 'USER' }, { actorId: standingAdmin.id });
    assertEqual((await read(member.id)).role, 'USER', 'and reversible');
  });

  await test('nobody can remove their own admin role', async () => {
    // Instant self-lockout, and not recoverable without another admin.
    const self = await makeUser('ADMIN');
    await expectRejection(
      () => userService.updateUser(self.id, { role: 'USER' }, { allowAdminRole: true, actorId: self.id }),
      'your own administrator role'
    );
    assertEqual((await read(self.id)).role, 'ADMIN', 'still an admin');
  });

  await test('an admin can be demoted by a different admin', async () => {
    const other = await makeUser('ADMIN');
    await userService.updateUser(other.id, { role: 'USER' }, { allowAdminRole: true, actorId: standingAdmin.id });
    assertEqual((await read(other.id)).role, 'USER', 'demoted');
  });

  await test('the last remaining admin cannot be demoted', async () => {
    // Permanent lockout: no admin remains to grant the role back, and the app
    // offers no other way to do it.
    const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
    const spares = await prisma.user.findMany({
      where: { role: 'ADMIN', id: { notIn: [standingAdmin.id] } },
      select: { id: true },
    });
    if (admins - spares.length !== 1) throw new Error('fixture assumption broken');

    // Temporarily park the real admins so only ours remains.
    await prisma.user.updateMany({ where: { id: { in: spares.map((a) => a.id) } }, data: { role: 'USER' } });
    try {
      await expectRejection(
        () => userService.updateUser(standingAdmin.id, { role: 'USER' }, { allowAdminRole: true, actorId: 0 }),
        'only administrator'
      );
      assertEqual((await read(standingAdmin.id)).role, 'ADMIN', 'still an admin');
    } finally {
      await prisma.user.updateMany({ where: { id: { in: spares.map((a) => a.id) } }, data: { role: 'ADMIN' } });
    }
  });

  await test('every role change is written to the audit log', async () => {
    const member = await makeUser('USER');
    await userService.updateUser(member.id, { role: 'ADMIN' }, { allowAdminRole: true, actorId: standingAdmin.id });

    const rows = await auditFor(member.id);
    assertEqual(rows.length, 1, 'one entry');
    const meta = JSON.parse(rows[0].metadata);
    assertEqual(meta.from, 'USER', 'records what it was');
    assertEqual(meta.to, 'ADMIN', 'and what it became');
    assertEqual(rows[0].actorId, standingAdmin.id, 'and who did it');
  });

  await test('an unchanged role writes no audit noise', async () => {
    // Saving the member edit form without touching the role must not fill the
    // audit log with entries that record nothing.
    const member = await makeUser('CHAPTER_ADMIN');
    await userService.updateUser(member.id, { role: 'CHAPTER_ADMIN', phone: '0917' }, { allowAdminRole: true, actorId: standingAdmin.id });
    assertEqual((await auditFor(member.id)).length, 0, 'no entry for a no-op');
    assertEqual((await read(member.id)).phone, '0917', 'while the real edit still saved');
  });

  await test('editing a member without sending a role leaves it alone', async () => {
    const member = await makeUser('CHAPTER_ADMIN');
    await userService.updateUser(member.id, { phone: '0918' }, { allowAdminRole: true, actorId: standingAdmin.id });
    assertEqual((await read(member.id)).role, 'CHAPTER_ADMIN', 'role untouched');
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
