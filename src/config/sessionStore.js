const MySQLStore = require('express-mysql-session')(require('express-session'));

// Reuses the same DATABASE_URL as Prisma so there's no separate connection
// config to keep in sync. Auto-creates its own `sessions` table on first run
// (an operational table, not a Prisma-tracked domain model).
function buildSessionStore() {
  const url = new URL(process.env.DATABASE_URL);

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
