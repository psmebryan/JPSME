// Connects to a database and reports precisely why it failed, if it did.
//
// Prisma reports almost every connection problem as P1001 "can't reach database
// server", which covers a wrong host, a closed port, a refused address, and bad
// credentials alike — four different problems with four different fixes and one
// message. This asks MySQL directly and prints what it actually said.
//
// Usage (the connection string is passed in, never stored):
//
//   node scripts/test-db-connection.js "mysql://user:pass@host:3306/dbname"
//
// or, to check whatever the app is configured to use:
//
//   node scripts/test-db-connection.js

require('dotenv').config();
const net = require('net');
const mysql = require('mysql2/promise');
const { expectedTableNames } = require('../src/jobs/applyMigrationsDirect');

const raw = process.argv[2] || process.env.DATABASE_URL;

if (!raw) {
  console.error('No connection string. Pass one as an argument, or set DATABASE_URL.');
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch (err) {
  console.error('That is not a valid connection URL. Expected mysql://user:password@host:3306/database');
  console.error('If the password contains @ # / or :, those must be percent-encoded (@ becomes %40).');
  process.exit(1);
}

const host = url.hostname;
const port = url.port ? Number(url.port) : 3306;
const user = decodeURIComponent(url.username);
const database = url.pathname.replace(/^\//, '');

// Never printed: the password. Everything else is useful and not secret.
console.log(`  host     ${host}`);
console.log(`  port     ${port}`);
console.log(`  user     ${user}`);
console.log(`  database ${database}`);
console.log('');

function tcpProbe() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
    socket.setTimeout(8000);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, why: 'timed out' }));
    socket.once('error', (e) => done({ ok: false, why: e.code || e.message }));
    socket.connect(port, host);
  });
}

// Each of these means something different and is fixed somewhere different.
function explain(err) {
  const code = err.code || '';
  const message = err.message || '';

  if (code === 'ER_HOST_NOT_PRIVILEGED' || /is not allowed to connect/i.test(message)) {
    return 'The server is reachable and refused this machine specifically.\n'
      + '  MySQL checks WHERE a connection comes from, separately from the password.\n'
      + '  Fix: cPanel > Remote MySQL > add this machine\'s IP, or % while testing.';
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied/i.test(message)) {
    return 'Reached the server, and it rejected the username or password.\n'
      + '  The address is allowed, so remote access is working — this is credentials.\n'
      + '  Fix: check the password, and that the user is attached to the database in\n'
      + '  cPanel > MySQL Databases > Add User To Database, with All Privileges.';
  }
  if (code === 'ER_BAD_DB_ERROR' || /unknown database/i.test(message)) {
    return 'Connected and authenticated, but that database does not exist.\n'
      + '  Fix: check the name — cPanel usually prefixes it, e.g. account_dbname.';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED') {
    return 'Could not reach the server at all — nothing answered on that port.\n'
      + '  Fix: check the hostname, and whether the host exposes MySQL externally.';
  }
  return message;
}

(async () => {
  const tcp = await tcpProbe();
  if (!tcp.ok) {
    console.log(`  FAILED at the network layer: ${tcp.why}`);
    console.log('  Nothing is listening, or a firewall is dropping the connection.');
    process.exit(1);
  }
  console.log('  port is open');

  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user, database,
      password: decodeURIComponent(url.password),
      connectTimeout: 10000,
    });
  } catch (err) {
    console.log('');
    console.log(`  FAILED: ${err.code || 'error'}`);
    console.log('');
    console.log('  ' + explain(err).split('\n').join('\n  '));
    process.exit(1);
  }

  const [rows] = await conn.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
    [database]
  );
  const present = rows.map((r) => r.t);
  console.log('  connected and authenticated');
  console.log(`  tables in ${database}: ${present.length}`);

  // Reporting the count alone hides the failure that actually happened here: a
  // database with every table present, but five of them lowercased by a dump
  // taken from a case-insensitive server. On Linux, where names are
  // case-sensitive, Prisma's first query then fails on a table the database
  // plainly contains — and a count of 25 looks perfectly healthy while it does.
  if (present.length) {
    // Whether capitalisation matters at all is a property of the server, not
    // the data. Where names are folded (XAMPP, lower_case_table_names=1) every
    // table is stored lowercase and `user` IS `User` — reporting those as
    // problems would send someone renaming tables that are perfectly fine.
    const [[lcn]] = await conn.query("SHOW VARIABLES LIKE 'lower_case_table_names'").catch(() => [[null]]);
    const caseSensitive = lcn ? lcn.Value === '0' : true;
    if (lcn) console.log(`  lower_case_table_names: ${lcn.Value}${caseSensitive ? ' (case-sensitive)' : ' (names folded, capitalisation irrelevant)'}`);

    const expected = expectedTableNames();
    const miscased = [];
    const missing = [];
    expected.forEach((wanted) => {
      const exact = present.includes(wanted);
      const insensitive = present.find((x) => x.toLowerCase() === wanted.toLowerCase());
      if (caseSensitive) {
        if (exact) return;
        if (insensitive) miscased.push(`${insensitive} -> ${wanted}`);
        else missing.push(wanted);
      } else if (!insensitive) {
        missing.push(wanted);
      }
    });

    if (miscased.length) {
      console.log('');
      console.log(`  ${miscased.length} table(s) differ from the schema only by capitalisation:`);
      miscased.forEach((m) => console.log(`    ${m}`));
      console.log('  On a case-sensitive server the app cannot read these.');
      console.log('  Deploy once with RUN_MIGRATIONS_ON_BOOT="true" and the boot-time repair renames them.');
    }
    if (missing.length) {
      console.log('');
      console.log(`  ${missing.length} table(s) the schema expects are absent:`);
      missing.forEach((m) => console.log(`    ${m}`));
      console.log('  Migrations have not been applied to this database.');
    }
    if (!miscased.length && !missing.length) {
      console.log(`  every table the schema expects is present, correctly named`);
    }

    // Correctly-named tables say the schema is right; they say nothing about
    // whether there is anything in them. An empty copy of the schema and a
    // live database look identical above, and pointing an app at the wrong one
    // of those is the difference between a migration and an outage.
    if (!missing.length) {
      const interesting = ['User', 'Event', 'EventRegistration', 'organizations', 'payments'];
      const counts = [];
      for (const table of interesting) {
        const actual = present.find((x) => (caseSensitive ? x === table : x.toLowerCase() === table.toLowerCase()));
        if (!actual) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${actual}\``);
          counts.push(`${table}: ${row.n}`);
        } catch (err) { /* a table we cannot count is not worth failing over */ }
      }
      if (counts.length) {
        console.log('');
        console.log(`  rows — ${counts.join('   ')}`);
        if (counts.every((c) => c.endsWith(': 0'))) {
          console.log('  Every one of those is empty: this is the schema without the data.');
          console.log('  Pointing the app here would start it from nothing.');
        }
      }
    }
  }

  await conn.end();
  console.log('');
  console.log('  This connection string works. If the app still cannot connect,');
  console.log('  the app is running somewhere with a different IP than this machine.');
})();
