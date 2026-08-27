const app = require('./app');
const config = require('./config');
const prisma = require('./config/prisma');
const { startReconciliationSweep, stopReconciliationSweep } = require('./jobs/paymentReconciliationSweep.job');
const { startInvitationReconciliationSweep, stopInvitationReconciliationSweep } = require('./jobs/invitationReconciliationSweep.job');

const PORT = config.port;

async function start() {
  try {
    await prisma.$connect();
    app.listen(PORT, () => {
      console.log(`JPSME server running at http://localhost:${PORT}`);
    });
    startReconciliationSweep();
    startInvitationReconciliationSweep();
  } catch (err) {
    console.error('Failed to connect to the database. Is XAMPP MySQL running and DATABASE_URL correct?');
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  stopReconciliationSweep();
  stopInvitationReconciliationSweep();
  await prisma.$disconnect();
  process.exit(0);
});

start();
