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
          "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() "
          + "AND table_name NOT IN ('_prisma_migrations', 'sessions')"
        );
        const strays = Number(others[0].n);

        // Starting over is only safe when there is effectively nothing there.
        // With real tables present, re-running would hit CREATE TABLE on one
        // that exists and stop halfway — worse than refusing outright.
        if (strays > 0) {
          throw new Error(
            "_prisma_migrations records " + done.size + " applied migrations, but the User table is "
            + "missing while " + strays + " other tables exist. This is a state the fallback cannot "
            + "safely repair — restore a complete backup, or empty the database entirely and redeploy."
          );
        }

        log.log(
          "  _prisma_migrations claims " + done.size + " applied migrations but no tables exist — "
          + "that record came from an import, not from this database. Clearing it and applying from scratch."
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

module.exports = { applyMigrationsDirect, listMigrations };
