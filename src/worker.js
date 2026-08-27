const prisma = require('./config/prisma');
const jobService = require('./services/job.service');
const handlers = require('./jobs/handlers');

// Standalone process (`npm run worker`) that polls the Job table and runs
// whatever's due — separate from the web server so a slow or misbehaving job
// (a stuck email API call, a large Sheets sync) can never add latency to a
// request. Runs alongside `npm run dev`/`npm start`, not instead of them.
const POLL_INTERVAL_MS = 2000;
let stopping = false;

async function processOneJob(job) {
  const handler = handlers[job.type];
  if (!handler) {
    console.error(`Job ${job.id}: no handler registered for type "${job.type}" — marking failed.`);
    await jobService.failJob(job.id, `No handler for type "${job.type}"`, job.attempts, job.maxAttempts);
    return;
  }

  try {
    await handler(JSON.parse(job.payload));
    await jobService.completeJob(job.id);
    console.log(`Job ${job.id} (${job.type}) completed.`);
  } catch (err) {
    console.error(`Job ${job.id} (${job.type}) failed:`, err.message);
    await jobService.failJob(job.id, err, job.attempts, job.maxAttempts);
  }
}

async function pollLoop() {
  while (!stopping) {
    let job;
    try {
      job = await jobService.claimNextJob();
    } catch (err) {
      console.error('Worker: failed to claim next job:', err.message);
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
  console.log('Job worker started, polling every', POLL_INTERVAL_MS, 'ms');
  await pollLoop();
}

process.on('SIGINT', async () => {
  stopping = true;
  await prisma.$disconnect();
  process.exit(0);
});

start();
