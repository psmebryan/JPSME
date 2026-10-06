// Tests for utils/emailIdentity.js: finding an account by the address somebody
// typed, whichever Gmail spelling they used.
//
// The bug this pins: the auth forms ran normalizeEmail(), which strips dots and
// +tags from Gmail addresses, while imported members are stored with them. So
// "juan.dela.cruz@gmail.com" was searched for as "juandelacruz@gmail.com" and
// never found: "Invalid email or password" with the right password, and no
// reset email at all.
//
// No database: Prisma is a small in-memory fake.

const fs = require('fs');
const path = require('path');
const { cleanEmail, canonicalEmail, findUserByEmail } = require('../src/utils/emailIdentity');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}\n      ${err.message}`);
    failed += 1;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function fakePrisma(users) {
  return {
    user: {
      async findUnique({ where }) {
        if (where.email) return users.find((u) => u.email === where.email) || null;
        if (where.id) return users.find((u) => u.id === where.id) || null;
        return null;
      },
      async findMany({ where }) {
        const endings = where.OR.map((c) => c.email.endsWith);
        return users.filter((u) => endings.some((e) => u.email.endsWith(e))).map((u) => ({ id: u.id, email: u.email }));
      },
    },
  };
}

async function main() {
  await test('cleanEmail only trims and lowercases', () => {
    assertEqual(cleanEmail('  Juan.Dela.Cruz+npc@Gmail.com '), 'juan.dela.cruz+npc@gmail.com', 'dots and +tags are kept');
  });

  await test('canonicalEmail folds Gmail spellings onto one inbox, and leaves other providers alone', () => {
    assertEqual(canonicalEmail('Juan.Dela.Cruz+npc@googlemail.com'), 'juandelacruz@gmail.com', 'gmail');
    assertEqual(canonicalEmail('maria.santos+x@psmeinc.org.ph'), 'maria.santos+x@psmeinc.org.ph', 'non-gmail untouched');
  });

  const users = [
    { id: 1, email: 'juan.dela.cruz@gmail.com' }, // imported, stored as typed
    { id: 2, email: 'anareyes@gmail.com' }, // signed up, stored shortened
    { id: 3, email: 'maria.santos@psmeinc.org.ph' },
  ];
  const prisma = fakePrisma(users);

  await test('an imported member is found by the address exactly as they type it', async () => {
    assertEqual((await findUserByEmail(prisma, 'Juan.Dela.Cruz@gmail.com')).id, 1, 'the bug: this used to be not found');
  });

  await test('...and by the dotless spelling the old forms produced', async () => {
    assertEqual((await findUserByEmail(prisma, 'juandelacruz@gmail.com')).id, 1, 'dotless finds the dotted account');
    assertEqual((await findUserByEmail(prisma, 'juan.dela.cruz+jpsme@gmail.com')).id, 1, '+tag finds it too');
  });

  await test('a member who signed up (stored without dots) still logs in with dots', async () => {
    assertEqual((await findUserByEmail(prisma, 'ana.reyes@gmail.com')).id, 2, 'dotted finds the dotless account');
  });

  await test('other providers must match exactly', async () => {
    assertEqual((await findUserByEmail(prisma, 'maria.santos@psmeinc.org.ph')).id, 3, 'exact works');
    assertEqual(await findUserByEmail(prisma, 'mariasantos@psmeinc.org.ph'), null, 'dots matter outside Gmail');
  });

  await test('two accounts on one Gmail inbox are not guessed between', async () => {
    const twins = fakePrisma([{ id: 7, email: 'j.doe@gmail.com' }, { id: 8, email: 'jdoe+x@gmail.com' }]);
    assertEqual(await findUserByEmail(twins, 'jd.oe@gmail.com'), null, 'ambiguous is not found, never the wrong account');
    assertEqual((await findUserByEmail(twins, 'j.doe@gmail.com')).id, 7, 'an exact match still wins');
  });

  await test('the auth forms no longer strip dots from Gmail addresses', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    for (const p of ['src/routes/api/auth.routes.js', 'src/routes/api/admin.routes.js']) {
      if (/\.normalizeEmail\(/.test(read(p))) throw new Error(`${p} still calls normalizeEmail()`);
    }
  });

  await test('login, sign-up, verification and reset all use the tolerant lookup', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    for (const p of ['src/services/auth.service.js', 'src/services/emailVerification.service.js',
      'src/services/passwordReset.service.js', 'src/services/user.service.js']) {
      const src = read(p);
      if (!/findUserByEmail\(/.test(src)) throw new Error(`${p} does not use findUserByEmail`);
      if (/user\.findUnique\(\{\s*where:\s*\{\s*email/.test(src)) throw new Error(`${p} still looks a user up by exact email`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
