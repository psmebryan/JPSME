// Tests for keeping the job queue alive (src/jobs/jobRunner.js and
// jobService.requeueStuckJobs).
//
//   1. A job left PROCESSING by a restart is put back in the queue, or marked
//      FAILED once it has used up its attempts; a job still genuinely running
//      is left alone.
//   2. The worker loop survives a failure while recording a job's outcome — it
//      used to exit, and no queued email went out again until a redeploy.
//
// Part 1 runs against the dev database (throwaway rows); part 2 stubs the job
// service, so it needs no database.

const assert = require('assert');

require('dotenv').config();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

const TYPE = '__JOBRECOVERY_TEST__';

async function partOne() {
  const prisma = require('../src/config/prisma');
  const jobService = require('../src/services/job.service');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);

  async function makeJob({ status, attempts = 0, maxAttempts = 3, updatedAt = null }) {
    const job = await prisma.job.create({ data: { type: TYPE, payload: '{}', status, attempts, maxAttempts } });
    if (updatedAt) {
      await prisma.$executeRawUnsafe('UPDATE `jobs` SET `updatedAt` = ? WHERE `id` = ?', updatedAt, job.id);
    }
    return job;
  }

  try {
    await prisma.job.deleteMany({ where: { type: TYPE } });
    const stuck = await makeJob({ status: 'PROCESSING', updatedAt: old });
    const lastTry = await makeJob({ status: 'PROCESSING', attempts: 2, maxAttempts: 3, updatedAt: old });
    const running = await makeJob({ status: 'PROCESSING' }); // just claimed

    await test('a job interrupted by a restart goes back in the queue', async () => {
      await jobService.requeueStuckJobs();
      const row = await prisma.job.findUnique({ where: { id: stuck.id } });
      assert.strictEqual(row.status, 'PENDING');
      assert.strictEqual(row.attempts, 1, 'the interruption counts as an attempt');
    });

    await test('one that has used up its attempts is marked FAILED instead of looping', async () => {
      const row = await prisma.job.findUnique({ where: { id: lastTry.id } });
      assert.strictEqual(row.status, 'FAILED');
    });

    await test('a job still genuinely running is left alone', async () => {
      const row = await prisma.job.findUnique({ where: { id: running.id } });
      assert.strictEqual(row.status, 'PROCESSING');
    });
  } finally {
    await prisma.job.deleteMany({ where: { type: TYPE } });
    await prisma.$disconnect();
  }
}

async function partTwo() {
  // Stub the job service and handlers the runner loads.
  const jobServicePath = require.resolve('../src/services/job.service');
  const handlersPath = require.resolve('../src/jobs/handlers');
  const runnerPath = require.resolve('../src/jobs/jobRunner');
  delete require.cache[runnerPath];
  delete require.cache[jobServicePath];

  const queue = [{ id: 1, type: 'OK', payload: '{}', attempts: 0, maxAttempts: 3 }, { id: 2, type: 'OK', payload: '{}', attempts: 0, maxAttempts: 3 }];
  const completed = [];
  require.cache[jobServicePath] = {
    id: jobServicePath, filename: jobServicePath, loaded: true,
    exports: {
      async requeueStuckJobs() { return { requeued: 0, failed: 0 }; },
      async claimNextJob() { return queue.shift() || null; },
      async completeJob(id) {
        if (id === 1) throw new Error('database went away while saving the result');
        completed.push(id);
      },
      async failJob() { throw new Error('database still away'); },
    },
  };
  require.cache[handlersPath] = {
    id: handlersPath, filename: handlersPath, loaded: true,
    exports: { async OK() { return 'done'; } },
  };
  const { pollLoop } = require('../src/jobs/jobRunner');

  await test('the worker keeps going after failing to record a job, and runs the next one', async () => {
    let loops = 0;
    await pollLoop(() => { loops += 1; return loops > 3; });
    assert.deepStrictEqual(completed, [2], 'job 2 still ran after job 1 could not be recorded');
  });
}

(async () => {
  await partOne().catch((err) => { console.log(`  FAIL  database part: ${err.message}`); failed += 1; });
  await partTwo().catch((err) => { console.log(`  FAIL  worker part: ${err.message}`); failed += 1; });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
