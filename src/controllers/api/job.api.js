const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const jobService = require('../../services/job.service');

// Generic job-status polling endpoint — not tied to any one job type, so
// every "enqueue it, then poll for the result" flow (bulk certificate
// generation today, any future one) reuses this instead of growing a
// bespoke status endpoint per job type.
const getJobStatus = asyncHandler(async (req, res) => {
  const job = await jobService.getJob(req.params.jobId);
  if (!job) return error(res, 'Job not found', 404);
  return success(res, { status: job.status, result: job.result, lastError: job.lastError });
});

module.exports = { getJobStatus };
