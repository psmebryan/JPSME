const config = require('../config');
const logger = require('../utils/logger');
const { pollLoop } = require('./jobRunner');

// Runs the job queue inside the web server.
//
// Queued work is not optional decoration: the confirmation email carrying a
// member's e-ticket is a job, so is the replacement email after an admin
// reissues a ticket, and so is bulk certificate generation. If nothing is
// draining the queue, registration still succeeds and simply nobody is ever
// emailed — a failure with no error anywhere, which is the worst kind.
//
// A separate `npm run worker` process is still the better arrangement, because
// a slow job then cannot add latency to a request. But plenty of hosting will
// only keep one process alive — cPanel/Passenger setups, which is what GoDaddy
// provides, typically manage exactly one — and on those a second process is not
// something you can rely on. Defaulting this on means deploying to such a host
// works rather than silently half-working.
//
// Safe to run alongside the standalone worker: claiming is atomic, so a job is
// executed once regardless of how many runners are watching. Set
// WORKER_MODE=external to leave the queue entirely to a separate process.

let stopping = false;
let running = false;

function shouldRunInProcess() {
  return config.jobs.workerMode !== 'external';
}

function startInProcessWorker() {
  if (running) return;
  if (!shouldRunInProcess()) {
    logger.info('In-process job worker disabled (WORKER_MODE=external) — run `npm run worker` separately');
    return;
  }

  running = true;
  stopping = false;
  logger.info('In-process job worker started');

  // Deliberately not awaited: this loop runs for the life of the process, and
  // awaiting it here would never return to finish booting the server.
  pollLoop(() => stopping).catch((err) => {
    running = false;
    logger.error('in-process job worker stopped unexpectedly', { err: err.message });
  });
}

function stopInProcessWorker() {
  stopping = true;
  running = false;
}

module.exports = { startInProcessWorker, stopInProcessWorker, shouldRunInProcess };
