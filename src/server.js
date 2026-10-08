const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { applyMigrationsDirect } = require('./jobs/applyMigrationsDirect');
const { seedAdminIfRequested } = require('./jobs/seedAdmin');
const { runEgressProbeIfRequested } = require('./jobs/egressProbe');
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
// Migrations run through a different binary than queries do: the schema
// engine, which the CLI downloads at install time for whatever platform it
// detects. That detection is the same one that gets this host wrong, so the
// query-engine override in config/prisma.js does not help here — a wrong
// schema engine fails with "Could not parse schema engine response", because
// what the CLI reads as JSON is actually a dynamic-linker error.
//
// If a musl build is present, point at it explicitly. If it is not, nothing
// here can conjure one; the message below explains what to set so the install
// fetches it.
function schemaEngineOverride() {
  if (process.platform !== "linux") return null;
  if (process.env.PRISMA_SCHEMA_ENGINE_BINARY) return process.env.PRISMA_SCHEMA_ENGINE_BINARY;

  let isMusl = false;
  try { isMusl = !process.report.getReport().header.glibcVersionRuntime; } catch (e) { isMusl = false; }

  let dir;
  try { dir = path.dirname(require.resolve("@prisma/engines/package.json")); } catch (e) { return null; }

  const wanted = isMusl
    ? ["schema-engine-linux-musl-openssl-3.0.x"]
    : ["schema-engine-debian-openssl-3.0.x", "schema-engine-rhel-openssl-3.0.x"];

  for (const name of wanted) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }

  let present = [];
  try { present = fs.readdirSync(dir).filter((n) => n.startsWith("schema-engine")); } catch (e) { /* ignore */ }
  console.error(
    `No usable schema engine for this host (${isMusl ? "musl" : "glibc"}).\n`
    + `  looked for : ${wanted.join(", ")}\n`
    + `  present    : ${present.length ? present.join(", ") : "(none)"}\n`
    + "  fix        : set PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x in this\n"
    + "               environment and redeploy, so the install downloads the matching\n"
    + "               engine. binaryTargets in schema.prisma covers the query engine\n"
    + "               only; the migration engine is fetched by the CLI separately."
  );
  return null;
}

async function runMigrationsIfRequested() {
  if (!config.database.migrateOnBoot) return;

  console.log("Running database migrations (RUN_MIGRATIONS_ON_BOOT=true)...");
  const schemaEngine = schemaEngineOverride();

  // No engine this host can run. Rather than fail — which on a platform with no
  // shell leaves the database empty and no way to fill it — apply the same
  // migration files over a plain MySQL connection. The SQL is identical and the
  // tracking table is written the same way, so a later `migrate deploy` on a
  // host where the engine does work sees them as applied and does nothing.
  if (!schemaEngine && process.platform === 'linux') {
    console.log('  schema engine unusable — applying migrations directly over mysql2 instead');
    const result = await applyMigrationsDirect(config.database.url);
    console.log(`  ${result.applied} applied, ${result.total} total. Migrations up to date.`);
    return;
  }

  if (schemaEngine) console.log(`  using schema engine ${path.basename(schemaEngine)}`);
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: config.database.url,
          ...(schemaEngine ? { PRISMA_SCHEMA_ENGINE_BINARY: schemaEngine } : {}),
        },
      },
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

// --- staying up -------------------------------------------------------------

let httpServer = null;
let shuttingDown = false;

// Connects to the database, retrying for about half a minute. A deploy or a
// host restart can bring this process up a moment before MySQL is accepting
// connections; exiting on the first refusal turned that moment into a failed
// boot. Gives up with the original error, so the diagnosis below still runs.
async function connectWithRetry(attempts = 5) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$connect();
      return;
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      const waitMs = Math.min(2000 * (2 ** (i - 1)), 10000);
      console.warn(`Database not reachable yet (attempt ${i} of ${attempts}); retrying in ${waitMs / 1000}s`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// Stops cleanly: no new connections, in-flight requests allowed to finish (up
// to 10s), background work stopped, database closed.
//
// The host sends SIGTERM on every redeploy and restart. Only SIGINT (Ctrl+C)
// was handled, so a redeploy cut requests off mid-way and could leave a job
// half-done.
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopReconciliationSweep();
  stopWebhookHealthCheck();
  stopInProcessWorker();
  stopInvitationReconciliationSweep();
  const finish = async () => {
    try { await prisma.$disconnect(); } catch (e) { /* exiting anyway */ }
    process.exit(exitCode);
  };
  // Never wait forever on a connection that will not close.
  setTimeout(finish, 10000).unref();
  if (httpServer) httpServer.close(() => finish());
  else finish();
}

async function start() {
  try {
    // Before the database, so it still reports when the database is the thing
    // that cannot be reached — which is exactly when the answer is wanted.
    await runEgressProbeIfRequested(console);

    await connectWithRetry();
    await runMigrationsIfRequested();
    // After migrations, because on a first deploy the User table does not exist
    // until they have run. Does nothing unless SEED_ADMIN_ON_BOOT is set.
    await seedAdminIfRequested(prisma, console);
    httpServer = app.listen(PORT, () => {
      console.log(`JPSME server running at http://localhost:${PORT}`);
    });
    // Longer than the hosting proxy's own keep-alive. Node's default is 5s;
    // a proxy holds idle connections open longer, and when it reuses one Node
    // has just closed the visitor gets a 502 — the classic "site went down for
    // a second". headersTimeout must be above keepAliveTimeout.
    httpServer.keepAliveTimeout = 65 * 1000;
    httpServer.headersTimeout = 66 * 1000;
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

    // Which advice is right depends on where the DATABASE SERVER is, not on
    // NODE_ENV. This was gated on config.isProduction, and the preview
    // environment runs `npm run dev` on a Linux container — so a genuine
    // outbound-port block on a hosted server was answered with "Is XAMPP MySQL
    // running?", which is the exact wrong-place-to-look this code exists to
    // prevent. A remote host can never be XAMPP, whatever NODE_ENV says.
    let dbHost = '(unparseable)';
    let dbPort = 3306;
    try {
      const parsed = new URL(config.database.url);
      dbHost = parsed.hostname;
      dbPort = parsed.port ? Number(parsed.port) : 3306;
    } catch (e) { /* leave the placeholders */ }
    const dbIsLocal = ['localhost', '127.0.0.1', '::1', ''].includes(dbHost);

    if (isConnectionFailure && !dbIsLocal) {
      // P1001 covers two completely different failures with one message: a
      // socket that never opens (the port is blocked or the host is wrong) and
      // a socket that opens and is then refused (credentials, or the address
      // is not in the database's allow-list). They are fixed in different
      // places, and guessing between them costs a deploy each time. So ask the
      // network directly before printing advice.
      const host = dbHost;
      const port = dbPort;

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
      // Reached only when the database really is meant to be on this machine.
      console.error(`Failed to connect to ${dbHost}:${dbPort}. Is XAMPP MySQL running, and is DATABASE_URL correct?`);
    } else {
      console.error(`Startup failed (${err.errorCode || err.code || 'no code'}). The database was not the problem.`);
    }
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A promise that rejects with nobody listening used to take the whole server
// down (Node 15+ exits on it): one background task failing — a sheet sync, an
// email — and every visitor got an error until the host restarted us. Logged
// instead; the request or task that caused it has already ended.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection (server kept running)', {
    reason: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack ? String(reason.stack).split('\n').slice(0, 6).join('\n') : undefined,
  });
});

// A thrown error nothing caught. The process may be in a broken state, so it
// is logged and the server stops cleanly — finishing in-flight requests — and
// the host starts a fresh one, rather than carrying on half-broken.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception; restarting cleanly', { err: err && err.message, stack: err && err.stack });
  shutdown('uncaughtException', 1);
});

start();
