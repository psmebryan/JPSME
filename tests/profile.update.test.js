// Tests for authService.updateProfile, focused on the name fields.
//
// firstName and lastName are NOT NULL in the schema and every other field this
// function writes is nullable, so they need the opposite rule: absent or blank
// means "leave alone", never "clear". Getting that wrong does not throw — it
// wipes a member's name — so it is worth asserting rather than assuming.
//
// Runs against the real dev database like the other suites here; fixtures are
// tagged and removed in a finally block so a failure mid-run still cleans up.

require('dotenv').config();
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');

const TAG = '__PROFILETEST__';
let passed = 0;
let failed = 0;
let userId = null;

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

async function makeUser() {
  const user = await prisma.user.create({
    data: {
      firstName: 'ORIGINALFIRST',
      lastName: 'ORIGINALLAST',
      middleInitial: 'X',
      email: `${TAG.toLowerCase()}${Date.now()}@example.invalid`,
      password: 'not-a-real-hash',
      school: 'Original School',
    },
  });
  userId = user.id;
  return user;
}

async function read() {
  return prisma.user.findUnique({ where: { id: userId } });
}

async function cleanup() {
  if (!userId) return;
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function main() {
  await makeUser();

  await test('a name that is sent is saved, uppercased like registration', async () => {
    await authService.updateProfile(userId, { firstName: 'Bryan', lastName: 'Lagutan' });
    const u = await read();
    assertEqual(u.firstName, 'BRYAN', 'firstName is normalised');
    assertEqual(u.lastName, 'LAGUTAN', 'lastName is normalised');
  });

  await test('an update that omits the names leaves them intact', async () => {
    // The exact shape of a caller that only means to change a phone number.
    await authService.updateProfile(userId, { phone: '09171234567' });
    const u = await read();
    assertEqual(u.firstName, 'BRYAN', 'firstName survived');
    assertEqual(u.lastName, 'LAGUTAN', 'lastName survived');
    assertEqual(u.phone, '09171234567', 'the field that was sent did change');
  });

  await test('blank names do not wipe the stored ones', async () => {
    // The validators reject a blank name before this point, but the service is
    // reachable from elsewhere and must not depend on that.
    await authService.updateProfile(userId, { firstName: '', lastName: '   ' });
    const u = await read();
    assertEqual(u.firstName, 'BRYAN', 'firstName untouched by an empty string');
    assertEqual(u.lastName, 'LAGUTAN', 'lastName untouched by whitespace');
  });

  await test('the nullable fields still clear when sent empty', async () => {
    // The counterpart to the rule above: everything that IS nullable must keep
    // its old clear-on-blank behaviour, or "remove my phone number" silently
    // stops working.
    await authService.updateProfile(userId, { phone: '', middleInitial: '' });
    const u = await read();
    assertEqual(u.phone, null, 'phone cleared');
    assertEqual(u.middleInitial, null, 'middleInitial cleared');
    assertEqual(u.firstName, 'BRYAN', 'and the name is still not collateral damage');
  });

  await test('school is left alone entirely, even if a caller sends one', async () => {
    // The profile form dropped this field — a member's student unit is their
    // school. The column still holds what registration and imports put there,
    // and the admin editor still writes it, so a profile save must neither
    // clear it nor overwrite it. Sending a value here is the strong case: if
    // the field ever reappears in this code path, this fails.
    assertEqual((await read()).school, 'Original School', 'still what the fixture set');

    await authService.updateProfile(userId, { phone: '09990000000', school: 'Some Other School' });
    const u = await read();
    assertEqual(u.school, 'Original School', 'unchanged by a profile update that sent one');
    assertEqual(u.phone, '09990000000', 'while the fields it does own still save');
  });

  await test('organization can be set and cleared', async () => {
    const org = await prisma.organization.findFirst({ where: { type: 'STUDENT_UNIT' } });
    if (!org) throw new Error('no STUDENT_UNIT in this database to test with');

    await authService.updateProfile(userId, { organizationId: String(org.id) });
    assertEqual((await read()).organizationId, org.id, 'set from the string a form submits');

    await authService.updateProfile(userId, { organizationId: '' });
    assertEqual((await read()).organizationId, null, 'cleared when the picker is left empty');
  });

  await test('a non-numeric organization is rejected, not coerced', async () => {
    let threw = null;
    try {
      await authService.updateProfile(userId, { organizationId: 'not-a-number' });
    } catch (err) {
      threw = err;
    }
    if (!threw) throw new Error('expected an error');
    assertEqual(threw.statusCode || threw.status, 400, 'rejected as a bad request');
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
