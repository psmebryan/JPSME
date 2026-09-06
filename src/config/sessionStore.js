const MySQLStore = require('express-mysql-session')(require('express-session'));
const config = require('./index');

// Reuses the same DATABASE_URL as Prisma so there's no separate connection
// config to keep in sync. Auto-creates its own `sessions` table on first run
// (an operational table, not a Prisma-tracked domain model).
//
// SESSION_STORE currently only supports 'mysql' (config.session.store already
// validates this at startup) — a second store would branch here.
function buildSessionStore() {
  // Checked explicitly, because this is the first thing in the whole app to
  // touch DATABASE_URL and it runs at import time — before server.js's
  // try/catch exists to say anything useful. Unset, new URL(undefined) throws
  // "TypeError: Invalid URL, input: 'undefined'", which names neither the
  // variable nor the file, and on a host that restarts the process it simply
  // repeats forever. Worth two lines to turn that into an instruction.
  if (!config.database.url) {
    throw new Error(
      'DATABASE_URL is not set, so the app cannot reach a database.\n'
      + '  Locally: add it to .env (e.g. mysql://root:@localhost:3306/jpsme2_new).\n'
      + '  On a host: set it in the environment variables for the app — a .env file '
      + 'is not deployed, so the value has to be provided there.'
    );
  }

  let url;
  try {
    url = new URL(config.database.url);
  } catch (err) {
    throw new Error(
      'DATABASE_URL is set but is not a valid connection URL. '
      + 'It should look like mysql://user:password@host:3306/database — and if the '
      + 'password contains @ # / or :, those characters must be percent-encoded.'
    );
  }

  return new MySQLStore({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000, // 15 minutes
    expiration: 1000 * 60 * 60 * 8, // matches the 8h cookie maxAge in app.js
  });
}

module.exports = buildSessionStore();
