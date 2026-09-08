// Tests for repairTableNameCase in src/jobs/applyMigrationsDirect.js.
//
// This is the code that unblocked a live deployment: the hosted database held
// every table, but five of them had arrived lowercased from a Windows-origin
// dump onto a case-sensitive Linux server, so Prisma's very first query failed
// on a table the database plainly contained.
//
// Written against a fake connection rather than a real database, because the
// bug only exists where lower_case_table_names = 0 and the local XAMPP server
// runs 1 — the failing condition is literally not reproducible here. The fake
// records what SQL was issued, which is the whole behaviour worth asserting.

const { repairTableNameCase, expectedTableNames } = require('../src/jobs/applyMigrationsDirect');

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
    throw new Error(
      `${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

// A stand-in for a mysql2 connection that answers the two SELECTs this function
// asks and remembers every statement, so a test can assert on what was run —
// including, importantly, that nothing was run.
function fakeConnection({ caseSensitive = true, tables = [] } = {}) {
  const issued = [];
  return {
    issued,
    async query(sql) {
      issued.push(sql);
      if (sql.includes('lower_case_table_names')) {
        return [[{ Variable_name: 'lower_case_table_names', Value: caseSensitive ? '0' : '1' }]];
      }
      if (sql.includes('information_schema.tables')) {
        return [tables.map((t) => ({ t }))];
      }
      return [[]];
    },
  };
}

const silent = { log() {} };

// The exact shape the live database was in: every table present, the five
// CamelCase ones lowercased by mysqldump.
const CAMEL_CASE_TABLES = ['User', 'EmailVerificationToken', 'Event', 'EventRegistration', 'SiteSetting'];

function importedTableList() {
  return expectedTableNames().map((t) => (CAMEL_CASE_TABLES.includes(t) ? t.toLowerCase() : t));
}

function backtick(name) {
  return String.fromCharCode(96) + name + String.fromCharCode(96);
}

async function main() {
  await test('the schema lists every table Prisma will query, un-lowercased', () => {
    const names = expectedTableNames();
    assert(names.includes('User'), 'User is a model with no @@map, so it keeps its capitals');
    assert(names.includes('event_check_ins'), '@@map names are read from the mapping, not the model');
    assert(!names.includes('EventCheckIn'), 'a mapped model must not appear under its model name');
    CAMEL_CASE_TABLES.forEach((t) => assert(names.includes(t), `${t} must be expected exactly as written`));
  });

  await test('a Windows dump on a case-sensitive server renames exactly the five', async () => {
    const conn = fakeConnection({ tables: importedTableList() });
    const count = await repairTableNameCase(conn, silent);
    assertEqual(count, 5, 'five tables need repair');

    const rename = conn.issued.find((s) => s.startsWith('RENAME TABLE'));
    assert(rename, 'a RENAME TABLE statement was issued');
    CAMEL_CASE_TABLES.forEach((t) => {
      const clause = `${backtick(t.toLowerCase())} TO ${backtick(t)}`;
      assert(rename.includes(clause), `renames ${t.toLowerCase()} to ${t}`);
    });
  });

  await test('all five renames go in one statement, so it is all-or-nothing', async () => {
    const conn = fakeConnection({ tables: importedTableList() });
    await repairTableNameCase(conn, silent);
    const renames = conn.issued.filter((s) => s.startsWith('RENAME TABLE'));
    assertEqual(renames.length, 1, 'exactly one RENAME TABLE, not five');
    assertEqual(renames[0].split(' TO ').length - 1, 5, 'that one statement carries all five clauses');
  });

  await test('a correctly-migrated database is left alone', async () => {
    const conn = fakeConnection({ tables: expectedTableNames() });
    const count = await repairTableNameCase(conn, silent);
    assertEqual(count, 0, 'nothing to repair');
    assert(!conn.issued.some((s) => s.startsWith('RENAME TABLE')), 'no RENAME TABLE was issued');
  });

  await test('a case-insensitive server is left alone even when names look wrong', async () => {
    // XAMPP stores every table lowercased, so this list is what a perfectly
    // healthy local database reports. Renaming here would try to rename a table
    // onto itself and fail with "table already exists" — which would have taken
    // down local development the moment this shipped.
    const conn = fakeConnection({ caseSensitive: false, tables: importedTableList() });
    const count = await repairTableNameCase(conn, silent);
    assertEqual(count, 0, 'no repair attempted');
    assertEqual(conn.issued.length, 1, 'it stops after reading the variable, without even listing tables');
  });

  await test('a genuinely missing table is left for the migration to create', async () => {
    // Absent is not the same as miscased. Creating it is the migration's job;
    // this function only ever renames something that is already there.
    const conn = fakeConnection({ tables: expectedTableNames().filter((t) => t !== 'SiteSetting') });
    const count = await repairTableNameCase(conn, silent);
    assertEqual(count, 0, 'nothing renamed');
    assert(!conn.issued.some((s) => s.startsWith('RENAME TABLE')), 'no RENAME TABLE was issued');
  });

  await test('an unrelated table with no schema counterpart is never touched', async () => {
    // sessions belongs to express-mysql-session, and a host may hold backups or
    // leftovers besides. Only names the schema actually asks for are candidates.
    const conn = fakeConnection({ tables: [...importedTableList(), 'sessions', 'User_backup_2026'] });
    await repairTableNameCase(conn, silent);
    const rename = conn.issued.find((s) => s.startsWith('RENAME TABLE'));
    assert(!rename.includes('sessions'), 'sessions is not in the rename');
    assert(!rename.includes('User_backup_2026'), 'an unrelated backup table is not in the rename');
  });

  await test('an empty database is a no-op, not an error', async () => {
    // The ordinary first deploy: the fallback runs before any table exists.
    const conn = fakeConnection({ tables: [] });
    const count = await repairTableNameCase(conn, silent);
    assertEqual(count, 0, 'nothing to rename on an empty database');
  });

  await test('what it did is reported, not done silently', async () => {
    const lines = [];
    const conn = fakeConnection({ tables: importedTableList() });
    await repairTableNameCase(conn, { log: (m) => lines.push(m) });
    assert(lines.some((l) => l.includes('capitalisation')), 'says why it is renaming');
    CAMEL_CASE_TABLES.forEach((t) => {
      assert(lines.some((l) => l.includes(`${t.toLowerCase()} -> ${t}`)), `names the ${t} rename in the log`);
    });
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
