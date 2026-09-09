// Tests for src/jobs/seedAdmin.js.
//
// This is the only code in the application that can grant the ADMIN role —
// everything else refuses, on purpose. So the guards around it are the whole
// security story, and each one is asserted here rather than trusted: it does
// nothing without the flag, nothing without both credentials, and nothing with
// a password too short to be worth having.
//
// Runs against the dev database like the other suites; the fixture account is
// removed in a finally block so a failure mid-run still cleans up.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const { seedAdminIfRequested } = require('../src/jobs/seedAdmin');

const EMAIL = '__seedadmintest__@example.invalid';
let passed = 0;
let failed = 0;

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

const silent = { log() {}, error() {} };

// Each case sets exactly the environment it is testing, so no test can pass
// because of a variable another one left behind.
function withEnv(vars, fn) {
  const keys = ['SEED_ADMIN_ON_BOOT', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD',
    'SEED_ADMIN_FIRST_NAME', 'SEED_ADMIN_LAST_NAME', 'SEED_ADMIN_MIDDLE_INITIAL'];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.entries(vars).forEach(([k, v]) => { process.env[k] = v; });
  return Promise.resolve(fn()).finally(() => {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });
}

const read = () => prisma.user.findUnique({ where: { email: EMAIL } });
const cleanup = () => prisma.user.deleteMany({ where: { email: EMAIL } });

async function main() {
  await cleanup();

  await test('does nothing at all without the flag', async () => {
    // The default state of every deployment. If this ever creates an account,
    // every server running this code has an admin nobody asked for.
    await withEnv({ SEED_ADMIN_EMAIL: EMAIL, SEED_ADMIN_PASSWORD: 'a-good-password' }, () => seedAdminIfRequested(prisma, silent));
    assertEqual(await read(), null, 'no account was created');
  });

  await test('refuses when the flag is set but credentials are missing', async () => {
    await withEnv({ SEED_ADMIN_ON_BOOT: 'true' }, () => seedAdminIfRequested(prisma, silent));
    assertEqual(await read(), null, 'no account was created');

    await withEnv({ SEED_ADMIN_ON_BOOT: 'true', SEED_ADMIN_EMAIL: EMAIL }, () => seedAdminIfRequested(prisma, silent));
    assertEqual(await read(), null, 'an email without a password is not enough');
  });

  await test('refuses a password shorter than eight characters', async () => {
    await withEnv({ SEED_ADMIN_ON_BOOT: 'true', SEED_ADMIN_EMAIL: EMAIL, SEED_ADMIN_PASSWORD: 'admin1' },
      () => seedAdminIfRequested(prisma, silent));
    assertEqual(await read(), null, 'no account was created');
  });

  await test('creates the admin when the flag and credentials are all present', async () => {
    await withEnv({
      SEED_ADMIN_ON_BOOT: 'true',
      SEED_ADMIN_EMAIL: EMAIL,
      SEED_ADMIN_PASSWORD: 'a-good-password',
      SEED_ADMIN_FIRST_NAME: 'Bryan Michael',
      SEED_ADMIN_MIDDLE_INITIAL: 'D',
      SEED_ADMIN_LAST_NAME: 'Lagutan',
    }, () => seedAdminIfRequested(prisma, silent));

    const u = await read();
    assert(u, 'the account exists');
    assertEqual(u.role, 'ADMIN', 'role');
    assertEqual(u.status, 'APPROVED', 'approved, so it can log in immediately');
    assert(u.emailVerifiedAt, 'email marked verified, so no provider is needed to get in');
    assertEqual(u.organizationId, null, 'not attached to any organization');
    assertEqual(u.firstName, 'BRYAN MICHAEL', 'name uppercased like every other account');
    assertEqual(u.middleInitial, 'D', 'middle initial');
    assertEqual(u.lastName, 'LAGUTAN', 'surname');
    assert(await bcrypt.compare('a-good-password', u.password), 'the password actually works');
  });

  await test('the flag accepts the quoted forms a hosting panel produces', async () => {
    // GoDaddy's own hint tells you to wrap the value in quotes so it is stored
    // as text, which is how RUN_MIGRATIONS_ON_BOOT arrived as "true" with the
    // quotes included.
    for (const raw of ['"true"', 'TRUE', ' yes ', '1', 'on']) {
      await cleanup();
      // eslint-disable-next-line no-await-in-loop
      await withEnv({ SEED_ADMIN_ON_BOOT: raw, SEED_ADMIN_EMAIL: EMAIL, SEED_ADMIN_PASSWORD: 'a-good-password' },
        () => seedAdminIfRequested(prisma, silent));
      // eslint-disable-next-line no-await-in-loop
      assert(await read(), `${JSON.stringify(raw)} was accepted as true`);
    }
    for (const raw of ['false', '"false"', 'no', '0', 'off']) {
      await cleanup();
      // eslint-disable-next-line no-await-in-loop
      await withEnv({ SEED_ADMIN_ON_BOOT: raw, SEED_ADMIN_EMAIL: EMAIL, SEED_ADMIN_PASSWORD: 'a-good-password' },
        () => seedAdminIfRequested(prisma, silent));
      // eslint-disable-next-line no-await-in-loop
      assertEqual(await read(), null, `${JSON.stringify(raw)} was correctly not treated as true`);
    }
  });

  await test('promotes an existing member without renaming them', async () => {
    // The realistic case: somebody registered normally, and now needs the role.
    // Overwriting their name with the SEED_ADMIN_* values would be wrong — they
    // are only there for an account that does not exist yet.
    await cleanup();
    await prisma.user.create({
      data: {
        firstName: 'EXISTING', lastName: 'MEMBER', email: EMAIL,
        password: await bcrypt.hash('their-old-password', 12), role: 'USER', status: 'PENDING',
      },
    });

    await withEnv({
      SEED_ADMIN_ON_BOOT: 'true',
      SEED_ADMIN_EMAIL: EMAIL,
      SEED_ADMIN_PASSWORD: 'a-new-password',
      SEED_ADMIN_FIRST_NAME: 'Should Not', SEED_ADMIN_LAST_NAME: 'Overwrite',
    }, () => seedAdminIfRequested(prisma, silent));

    const u = await read();
    assertEqual(u.role, 'ADMIN', 'promoted');
    assertEqual(u.status, 'APPROVED', 'and approved');
    assertEqual(u.firstName, 'EXISTING', 'their own first name kept');
    assertEqual(u.lastName, 'MEMBER', 'their own surname kept');
    assert(await bcrypt.compare('a-new-password', u.password), 'password reset to the supplied one');
  });

  await test('an email in a different case is still the same account', async () => {
    // Registration lowercases addresses, so a variable typed with capitals must
    // not create a second, parallel admin the first one shadows.
    const before = await prisma.user.count({ where: { email: EMAIL } });
    await withEnv({ SEED_ADMIN_ON_BOOT: 'true', SEED_ADMIN_EMAIL: EMAIL.toUpperCase(), SEED_ADMIN_PASSWORD: 'a-good-password' },
      () => seedAdminIfRequested(prisma, silent));
    assertEqual(await prisma.user.count({ where: { email: EMAIL } }), before, 'no duplicate created');
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
