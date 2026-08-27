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

async function completeJob(id) {
  await prisma.job.update({ where: { id }, data: { status: 'COMPLETED' } });
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

module.exports = { enqueue, claimNextJob, completeJob, failJob };
