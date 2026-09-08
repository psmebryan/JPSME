const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// Applies pending migrations over a plain MySQL connection, without Prisma's
// schema engine.
//
// That engine is a separate native binary the CLI downloads for whatever
// platform it detects, and on some images the detection is wrong and no correct
// build can be obtained — the failure surfaces as "Could not parse schema
// engine response", which is the CLI trying to read a dynamic-linker error as
// JSON. Nothing in the schema or the environment fixes it from inside the app.
//
// The migrations themselves are just SQL, and mysql2 is already a dependency
// and already known to work here, since the session store uses it. So this
// reads the same files `migrate deploy` would, in the same order, and records
// them in _prisma_migrations the same way — so a later `migrate deploy` run,
// on a host where the engine does work, sees them as applied and does nothing.
//
// Deliberately not a replacement for the real thing: no rollback, no drift
// detection, no shadow database. It exists so a platform that cannot run the
// engine can still get its tables.

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'prisma', 'schema.prisma');

// Matches what Prisma creates, so the real CLI can read and extend it later.
const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
  \`id\` VARCHAR(36) NOT NULL,
  \`checksum\` VARCHAR(64) NOT NULL,
  \`finished_at\` DATETIME(3) NULL,
  \`migration_name\` VARCHAR(255) NOT NULL,
  \`logs\` TEXT NULL,
  \`rolled_back_at\` DATETIME(3) NULL,
  \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`applied_steps_count\` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql')))
    // Prisma names directories with a timestamp prefix, so lexical order is
    // chronological order — the order they must be applied in.
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      return {
        name,
        sql,
        // Same algorithm Prisma uses, so the recorded checksum matches what the
        // CLI would compute and it does not report the migration as modified.
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

// The table names Prisma will actually query: @@map where a model declares one,
// otherwise the model name exactly as written.
function expectedTableNames() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  return models.map(([, name, body]) => {
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    return mapped ? mapped[1] : name;
  });
}

// Repairs table names that differ from the schema only by capitalisation.
//
// mysqldump lowercases table names when exporting from a case-insensitive
// server (Windows, lower_case_table_names=1). Restore that dump onto Linux,
// where names are case-sensitive, and every table is present but five of them
// are called user, event, eventregistration, sitesetting and
// emailverificationtoken, while Prisma asks for User, Event and the rest. Every
// query then fails with "table does not exist" against a database that plainly
// contains it.
//
// Only renames where the exact name is absent and one differing solely by case
// is present, so it cannot touch a correctly-migrated database.
async function repairTableNameCase(connection, log) {
  // Only meaningful where names are case-sensitive. On XAMPP and anywhere else
  // running lower_case_table_names=1 the server folds every name to lowercase,
  // so `user` and `User` are one table — and RENAME TABLE `user` TO `User`
  // becomes a rename onto itself, which fails with "table already exists".
  const [[vars]] = await connection.query("SHOW VARIABLES LIKE 'lower_case_table_names'");
  if (!vars || vars.Value !== '0') return 0;

  const [rows] = await connection.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  const present = rows.map((r) => r.t);
  const renames = [];

  expectedTableNames().forEach((wanted) => {
    if (present.includes(wanted)) return;
    const actual = present.find((p) => p.toLowerCase() === wanted.toLowerCase());
    if (actual && actual !== wanted) renames.push({ from: actual, to: wanted });
  });

  if (!renames.length) return 0;

  log.log(`  ${renames.length} table(s) differ from the schema only by capitalisation — renaming:`);
  renames.forEach((r) => log.log(`    ${r.from} -> ${r.to}`));

  // One statement, so it either all applies or none of it does. InnoDB updates
  // the foreign keys to match automatically.
  const clauses = renames.map((r) => `\`${r.from}\` TO \`${r.to}\``).join(', ');
  await connection.query(`RENAME TABLE ${clauses}`);
  return renames.length;
}

async function applyMigrationsDirect(databaseUrl, log = console) {
  const url = new URL(databaseUrl);
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    // Each migration file holds several statements; running the file as one
    // unit is safer than splitting on semicolons, which would break on any
    // semicolon inside a string or comment.
    multipleStatements: true,
  });

  try {
    await connection.query(CREATE_TRACKING_TABLE);

    // Before judging what is missing: a table present under a different
    // capitalisation is present, and renaming it is repair rather than
    // re-creation.
    await repairTableNameCase(connection, log);

    const [rows] = await connection.query(
      'SELECT migration_name FROM `_prisma_migrations` WHERE finished_at IS NOT NULL'
    );
    let done = new Set(rows.map((r) => r.migration_name));

    // The tracking table can lie. A partial import — or a dump carrying
    // _prisma_migrations without the tables it describes — leaves a database
    // claiming 38 applied migrations while containing none of them. Trusting
    // that record means skipping every migration and then failing on the first
    // query instead, which is how this went wrong in practice.
    //
    // So the claim is checked against reality: User is created by the very first
    // migration, and its absence proves the record cannot be true.
    if (done.size > 0) {
      const [userTable] = await connection.query(
        "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'User'"
      );
      if (Number(userTable[0].n) === 0) {
        const [others] = await connection.query(
          'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() '
          + "AND table_name NOT IN ('_prisma_migrations', 'sessions')"
        );
        const strays = Number(others[0].n);

        // Starting over is only safe when there is effectively nothing there.
        // With real tables present, re-running would hit CREATE TABLE on one
        // that exists and stop halfway — worse than refusing outright.
        if (strays > 0) {
          throw new Error(
            `_prisma_migrations records ${done.size} applied migrations, but the User table is `
            + `missing while ${strays} other tables exist. This is a state the fallback cannot `
            + 'safely repair — restore a complete backup, or empty the database entirely and redeploy.'
          );
        }

        log.log(
          `  _prisma_migrations claims ${done.size} applied migrations but no tables exist — `
          + 'that record came from an import, not from this database. Clearing it and applying from scratch.'
        );
        await connection.query('DELETE FROM `_prisma_migrations`');
        done = new Set();
      }
    }

    const all = listMigrations();
    const pending = all.filter((m) => !done.has(m.name));

    if (!pending.length) {
      log.log(`  ${all.length} migrations, all already applied`);
      return { applied: 0, total: all.length };
    }

    log.log(`  ${all.length} migrations, ${pending.length} pending`);

    for (const migration of pending) {
      // Sequential and awaited: migrations depend on the ones before them, and
      // a later file will fail outright if an earlier one has not run.
      // eslint-disable-next-line no-await-in-loop
      await connection.query(migration.sql);
      // eslint-disable-next-line no-await-in-loop
      await connection.query(
        'INSERT INTO `_prisma_migrations` (id, checksum, migration_name, started_at, finished_at, applied_steps_count) '
        + 'VALUES (?, ?, ?, NOW(3), NOW(3), 1)',
        [crypto.randomUUID(), migration.checksum, migration.name]
      );
      log.log(`    applied ${migration.name}`);
    }

    return { applied: pending.length, total: all.length };
  } finally {
    await connection.end();
  }
}

module.exports = {
  applyMigrationsDirect,
  listMigrations,
  expectedTableNames,
  repairTableNameCase,
};
