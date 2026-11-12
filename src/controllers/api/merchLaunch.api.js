const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const launch = require('../../services/merchLaunch.service');

// The soft launch for staff (/api/admin/merch). Behind router.use(apiAdmin)
// and merchCan: the Store mode and the testers need catalog.edit (the main
// admin, a President with Merchandise), the stock count stock.edit
// (Logistics), and marking a reported problem fixed orders.view (any team).

const setMode = asyncHandler(async (req, res) => {
  const mode = await launch.setMode((req.body || {}).mode);
  return success(res, { mode }, `The Store is now: ${launch.MODES[mode]}.`);
});

const addTester = asyncHandler(async (req, res) => {
  const t = await launch.addTester((req.body || {}).email, req.session.user.id);
  return success(res, { tester: t }, `${t.name} can now see the Store during the soft launch.`, 201);
});

const removeTester = asyncHandler(async (req, res) => {
  await launch.removeTester(req.params.userId);
  return success(res, {}, 'Removed from the soft launch.');
});

const saveCount = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const r = await launch.saveCount(body.counts, body.reason, req.session.user.id);
  const msg = `${r.done} counted: ${r.matched} matched, ${r.corrected} corrected${r.failed.length ? `; ${r.failed.length} not saved` : ''}.`;
  return success(res, r, msg);
});

const setFeedback = asyncHandler(async (req, res) => {
  const f = await launch.setFeedbackStatus(req.params.id, req.body || {}, req.session.user.id);
  return success(res, { feedback: f }, f.status === 'DONE' ? 'Marked fixed.' : 'Opened again.');
});

module.exports = { setMode, addTester, removeTester, saveCount, setFeedback };
