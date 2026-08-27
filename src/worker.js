const prisma = require('./config/prisma');
const logger = require('./utils/logger');
const jobService = require('./services/job.service');
const handlers = require('./jobs/handlers');

// Standalone process (`npm run worker`) that polls the Job table and runs
// whatever's due — separate from the web server so a slow or misbehaving job
// (a stuck email API call, a large Sheets sync) can never add latency to a
// request. Runs alongside `npm run dev`/`npm start`, not instead of them.
//
// This process has no HTTP request to inherit a correlation id from, so each
// job gets its own — the jobId/jobType attached to every log line here is
// the worker's equivalent of app.js's per-request requestId, for the exact
// same reason: tracing one specific unit of async work through the logs.
const POLL_INTERVAL_MS = 2000;
let stopping = false;

async function processOneJob(job) {
  const jobLog = logger.child({ jobId: job.id, jobType: job.type });
  const handler = handlers[job.type];
  if (!handler) {
    jobLog.error('no handler registered for job type — marking failed');
    await jobService.failJob(job.id, `No handler for type "${job.type}"`, job.attempts, job.maxAttempts);
    return;
  }

  try {
    await handler(JSON.parse(job.payload));
    await jobService.completeJob(job.id);
    jobLog.info('job completed');
  } catch (err) {
    jobLog.error('job failed', { err });
    await jobService.failJob(job.id, err, job.attempts, job.maxAttempts);
  }
}

async function pollLoop() {
  while (!stopping) {
    let job;
    try {
      job = await jobService.claimNextJob();
    } catch (err) {
      logger.error('worker failed to claim next job', { err });
    }

    if (job) {
      await processOneJob(job);
      continue; // check for another due job immediately, don't wait out the poll interval
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function start() {
  await prisma.$connect();
  logger.info('job worker started', { pollIntervalMs: POLL_INTERVAL_MS });
  await pollLoop();
}

process.on('SIGINT', async () => {
  stopping = true;
  await prisma.$disconnect();
  process.exit(0);
});

start();
