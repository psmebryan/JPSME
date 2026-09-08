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
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
    [database]
  );
  console.log('  connected and authenticated');
  console.log(`  tables in ${database}: ${rows[0].n}`);
  await conn.end();
  console.log('');
  console.log('  This connection string works. If the app still cannot connect,');
  console.log('  the app is running somewhere with a different IP than this machine.');
})();
