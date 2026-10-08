const prisma = require('../config/prisma');

// The "local" JOB_DRIVER (config.jobs.driver) — a durable, DB-backed queue.
// Only one process (the worker, src/worker.js) is expected to run today, but
// claimNextJob() still claims atomically (an UPDATE guarded by the row's
// current status, not a plain read-then-write) so running two workers later
// for throughput never double-processes the same job.

function backoffMinutes(attempts) {
  // 1, 2, 4, 8... minutes — bounded so a persistently-failing job (e.g. the
  // email provider is down) doesn't hammer it, but also doesn't wait hours.
  return Math.min(2 ** attempts, 30);
}

async function enqueue(type, payload, { maxAttempts = 3 } = {}) {
  return prisma.job.create({
    data: { type, payload: JSON.stringify(payload), maxAttempts },
  });
}

// Claims one due job for processing, or null if none are available. Never
// throws on a lost race (two workers claiming the same row) — updateMany's
// count is just 0 and the caller moves on to the next candidate.
async function claimNextJob() {
  const candidate = await prisma.job.findFirst({
    where: { status: 'PENDING', availableAt: { lte: new Date() } },
    orderBy: { id: 'asc' },
  });
  if (!candidate) return null;

  const claim = await prisma.job.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: { status: 'PROCESSING' },
  });
  if (claim.count === 0) return null; // another worker claimed it first

  return { ...candidate, status: 'PROCESSING' };
}

async function completeJob(id, result) {
  await prisma.job.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      result: result !== undefined ? JSON.stringify(result) : undefined,
    },
  });
}

// Polling endpoints (e.g. bulk certificate generation) read a job's status
// through this rather than the raw Prisma model, so `result` comes back
// already parsed instead of every caller re-doing JSON.parse.
async function getJob(id) {
  const job = await prisma.job.findUnique({ where: { id: Number(id) } });
  if (!job) return null;
  return { ...job, result: job.result ? JSON.parse(job.result) : null };
}

async function failJob(id, error, attempts, maxAttempts) {
  const nextAttempts = attempts + 1;
  const exhausted = nextAttempts >= maxAttempts;
  await prisma.job.update({
    where: { id },
    data: {
      status: exhausted ? 'FAILED' : 'PENDING',
      attempts: nextAttempts,
      lastError: String(error && error.message ? error.message : error).slice(0, 2000),
      availableAt: exhausted ? undefined : new Date(Date.now() + backoffMinutes(nextAttempts) * 60000),
    },
  });
}

// Puts back jobs that were claimed and then never finished.
//
// A job is marked PROCESSING when a worker claims it. If the process stops
// before the job completes — a redeploy, a crash, the host restarting it — the
// row stays PROCESSING forever: nothing ever claims it again, so its email is
// never sent. The send buttons also count PROCESSING as "already queued" and
// skip that person every time after.
//
// Anything still PROCESSING well past any real job's running time is returned
// to PENDING. The interruption counts as an attempt, so a job that kills the
// process every time it runs still ends up FAILED instead of looping forever.
const STUCK_AFTER_MS = 30 * 60 * 1000;

async function requeueStuckJobs({ olderThanMs = STUCK_AFTER_MS, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const stuck = await prisma.job.findMany({
    where: { status: 'PROCESSING', updatedAt: { lt: cutoff } },
    select: { id: true, attempts: true, maxAttempts: true },
  });
  let requeued = 0;
  let failed = 0;
  for (const job of stuck) {
    const nextAttempts = job.attempts + 1;
    const exhausted = nextAttempts >= job.maxAttempts;
    // Conditional on still being PROCESSING, so a job that finished a moment
    // ago is not reset.
    // eslint-disable-next-line no-await-in-loop
    const res = await prisma.job.updateMany({
      where: { id: job.id, status: 'PROCESSING', updatedAt: { lt: cutoff } },
      data: exhausted
        ? { status: 'FAILED', attempts: nextAttempts, lastError: 'Interrupted while processing (server restarted) too many times.' }
        : { status: 'PENDING', attempts: nextAttempts, availableAt: now, lastError: 'Interrupted while processing (server restarted); retried.' },
    });
    if (res.count) {
      if (exhausted) failed += 1; else requeued += 1;
    }
  }
  return { requeued, failed };
}

module.exports = { enqueue, claimNextJob, completeJob, failJob, getJob, requeueStuckJobs, STUCK_AFTER_MS };
