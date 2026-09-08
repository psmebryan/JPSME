const net = require('net');
const { execFile } = require('child_process');
const app = require('./app');
const config = require('./config');
const prisma = require('./config/prisma');
const { startReconciliationSweep, stopReconciliationSweep } = require('./jobs/paymentReconciliationSweep.job');
const { startWebhookHealthCheck, stopWebhookHealthCheck } = require('./jobs/webhookHealthCheck.job');
const { startInProcessWorker, stopInProcessWorker } = require('./jobs/inProcessWorker');
const preflight = require('./config/preflight');
const logger = require('./utils/logger');
const { startInvitationReconciliationSweep, stopInvitationReconciliationSweep } = require('./jobs/invitationReconciliationSweep.job');

const PORT = config.port;

// Applies any pending migrations before the app serves a request.
//
// `migrate deploy` only ever moves forward: it applies migrations that have
// not run, never generates or edits one, and never resets. Re-running it is a
// no-op. That is what makes it safe to attach to a boot; `migrate dev` would
// not be.
//
// A failure here stops the app rather than letting it serve against a schema
// it does not match — half-migrated is worse than not started, because the
// errors surface as scattered missing columns rather than one clear failure.
async function runMigrationsIfRequested() {
  if (!config.database.migrateOnBoot) return;

  console.log("Running database migrations (RUN_MIGRATIONS_ON_BOOT=true)...");
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: config.database.url } },
      (err, stdout, stderr) => {
        if (stdout) console.log(stdout.trim());
        if (stderr) console.error(stderr.trim());
        if (err) return reject(new Error("migrate deploy failed: " + err.message));
        console.log("Migrations up to date.");
        return resolve();
      }
    );
  });
}

async function start() {
  try {
    await prisma.$connect();
    await runMigrationsIfRequested();
    app.listen(PORT, () => {
      console.log(`JPSME server running at http://localhost:${PORT}`);
    });
    // Before anything else, so a misconfigured deployment says so at the top
    // of the log rather than being discovered through odd behaviour later.
    preflight.report(logger);
    startReconciliationSweep();
    startWebhookHealthCheck();
    startInProcessWorker();
    startInvitationReconciliationSweep();
  } catch (err) {
    // The useful advice differs completely by environment, and giving the
    // wrong one sends someone looking in a place that does not exist. "Is
    // XAMPP running" means nothing on a server; "check the remote access
    // rules" means nothing on a laptop.
    // Only a genuine connection failure deserves connection advice. A schema or
    // configuration error (P1012, say) reaches this same handler, and answering
    // it with "check your firewall and remote access rules" sends someone after
    // a problem they do not have — which is exactly what happened when a missing
    // DATABASE_URL was reported as a refused connection.
    const isConnectionFailure = err.errorCode === 'P1001'
      || err.code === 'P1001'
      || /can't reach database server/i.test(err.message || '');

    if (config.isProduction && isConnectionFailure) {
      // P1001 covers two completely different failures with one message: a
      // socket that never opens (the port is blocked or the host is wrong) and
      // a socket that opens and is then refused (credentials, or the address
      // is not in the database's allow-list). They are fixed in different
      // places, and guessing between them costs a deploy each time. So ask the
      // network directly before printing advice.
      let host = '(unparseable)';
      let port = 3306;
      try {
        const u = new URL(config.database.url);
        host = u.hostname;
        port = u.port ? Number(u.port) : 3306;
      } catch (e) { /* leave the placeholders */ }

      const socketOpens = await new Promise((resolve) => {
        const s2 = new net.Socket();
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; s2.destroy(); resolve(v); } };
        s2.setTimeout(8000);
        s2.once('connect', () => done(true));
        s2.once('timeout', () => done(false));
        s2.once('error', () => done(false));
        s2.connect(port, host);
      });

      if (socketOpens) {
        console.error(
          `Reached ${host}:${port} — the network is fine, the database refused the connection.\n`
          + "  So this is not a firewall or a wrong hostname. It is one of:\n"
          + "    - the username or password is wrong\n"
          + "    - the user is not attached to the database (cPanel > MySQL Databases >\n"
          + "      Add User To Database, with All Privileges)\n"
          + "    - this server's address is not in the database's allow-list\n"
          + "      (cPanel > Remote MySQL)"
        );
      } else {
        console.error(
          `Could not open a connection to ${host}:${port} at all.\n`
          + "  Nothing answered, so the credentials were never even offered. Either the\n"
          + "  hostname is wrong, or this platform blocks outbound connections on that\n"
          + "  port — some hosting only permits outbound HTTP/HTTPS, which would make a\n"
          + "  remote MySQL server unreachable no matter how it is configured.\n"
          + "  If the same connection string works from your own machine, it is the latter."
        );
      }
    } else if (isConnectionFailure) {
      console.error('Failed to connect to the database. Is XAMPP MySQL running and DATABASE_URL correct?');
    } else {
      console.error(`Startup failed (${err.errorCode || err.code || 'no code'}). The database was not the problem.`);
    }
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  stopReconciliationSweep();
  stopWebhookHealthCheck();
  stopInProcessWorker();
  stopInvitationReconciliationSweep();
  await prisma.$disconnect();
  process.exit(0);
});

start();
