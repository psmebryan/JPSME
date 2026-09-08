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

async function start() {
  try {
    await prisma.$connect();
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
    if (config.isProduction) {
      let host = "(unparseable)";
      try { host = new URL(config.database.url).host; } catch (e) { /* leave the placeholder */ }
      console.error(
        `Failed to reach the database at ${host}.\n`
        + "  If that says localhost, DATABASE_URL points at this server rather than the\n"
        + "  database server — on managed hosting those are two different machines.\n"
        + "  Otherwise the database is refusing this app: check the host's remote access\n"
        + "  rules (the app's IP may need allowing) and that the port is reachable."
      );
    } else {
      console.error('Failed to connect to the database. Is XAMPP MySQL running and DATABASE_URL correct?');
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
