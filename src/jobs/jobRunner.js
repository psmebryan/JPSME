const logger = require('../utils/logger');
const jobService = require('../services/job.service');
const handlers = require('./handlers');

// The polling loop itself, shared by the standalone worker process
// (`npm run worker`) and the in-process runner the web server can start.
//
// It lives here rather than inside worker.js because there are now two places
// that need it, and two copies of a loop that claims and executes jobs is two
// places for a retry rule to drift.
//
// Running both at once is safe: jobService.claimNextJob claims with a
// conditional update on status PENDING, so of two runners reaching the same job
// exactly one gets a row count of 1 and the other simply moves on.

const POLL_INTERVAL_MS = 2000;

async function processOneJob(job) {
  // No HTTP request to inherit a correlation id from, so each job gets its own
  // — the worker's equivalent of app.js's per-request requestId, for tracing
  // one unit of async work through the logs.
  const jobLog = logger.child({ jobId: job.id, jobType: job.type });
  const handler = handlers[job.type];
  if (!handler) {
    jobLog.error('no handler registered for job type — marking failed');
    await jobService.failJob(job.id, `No handler for type "${job.type}"`, job.attempts, job.maxAttempts);
    return;
  }

  try {
    const result = await handler(JSON.parse(job.payload));
    await jobService.completeJob(job.id, result);
    jobLog.info('job completed');
  } catch (err) {
    jobLog.error('job failed', { err });
    await jobService.failJob(job.id, err, job.attempts, job.maxAttempts);
  }
}

// `shouldStop` lets the caller end the loop without this module owning any
// process-level state — the standalone worker stops on SIGINT, the in-process
// one stops when the server shuts down.
// How often a running worker also puts back jobs a restart interrupted (see
// jobService.requeueStuckJobs). Cheap: one indexed query.
const STUCK_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function sweepStuckJobs() {
  try {
    const { requeued, failed } = await jobService.requeueStuckJobs();
    if (requeued || failed) logger.warn('requeued jobs interrupted by a restart', { requeued, failed });
  } catch (err) {
    logger.error('could not check for stuck jobs', { err });
  }
}

async function pollLoop(shouldStop) {
  // At start-up first: the jobs a redeploy interrupted are exactly the ones
  // waiting to be picked up again.
  await sweepStuckJobs();
  let lastSweep = Date.now();

  while (!shouldStop()) {
    if (Date.now() - lastSweep > STUCK_SWEEP_INTERVAL_MS) {
      // eslint-disable-next-line no-await-in-loop
      await sweepStuckJobs();
      lastSweep = Date.now();
    }

    let job;
    try {
      job = await jobService.claimNextJob();
    } catch (err) {
      logger.error('worker failed to claim next job', { err });
    }

    if (job) {
      // Guarded: processOneJob catches the handler's own errors, but recording
      // the outcome is a database write too, and a failure there used to
      // escape this loop and stop the worker for good — no queued email went
      // out again until the next restart.
      try {
        // eslint-disable-next-line no-await-in-loop
        await processOneJob(job);
      } catch (err) {
        logger.error('could not record the outcome of a job', { jobId: job.id, err });
      }
      continue; // check for another due job immediately rather than waiting out the interval
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

module.exports = { pollLoop, processOneJob, POLL_INTERVAL_MS, sweepStuckJobs };
