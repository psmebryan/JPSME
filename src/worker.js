const prisma = require('./config/prisma');
const logger = require('./utils/logger');
const { pollLoop } = require('./jobs/jobRunner');

// Standalone process (`npm run worker`) that drains the job queue — separate
// from the web server so a slow or misbehaving job (a stuck email API call, a
// large certificate batch) can never add latency to a request. This is the
// better arrangement wherever a second long-lived process can be relied on.
//
// Where it cannot — cPanel/Passenger hosting generally keeps one process alive
// — the web server runs the same loop in-process instead (see
// jobs/inProcessWorker.js). Running both is harmless: claiming is atomic, so a
// job executes once no matter how many runners are watching.
let stopping = false;

async function start() {
  await prisma.$connect();
  logger.info('job worker started');
  await pollLoop(() => stopping);
}

process.on('SIGINT', async () => {
  stopping = true;
  await prisma.$disconnect();
  process.exit(0);
});
start();
