const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const finance = require('../../services/merchFinance.service');

// The daily reconciliation (/api/admin/merch/reconciliation). Behind
// router.use(apiAdmin) and merchCan('reconcile.edit'): Finance or the main
// admin. Checking only reads PayMongo and saves the day's result; it never
// changes a payment or an order.

const checkDay = asyncHandler(async (req, res) => {
  const day = await finance.reconcileDay(req.params.day, req.session.user.id);
  const msg = day.status === 'MATCHED'
    ? `${day.day}: all ${day.siteCount} paid order(s) match PayMongo.`
    : `${day.day}: ${day.gaps.length} gap(s) found. See the list.`;
  return success(res, { day }, msg);
});

const explainDay = asyncHandler(async (req, res) => {
  const day = await finance.explainDay(req.params.day, (req.body || {}).note, req.session.user.id);
  return success(res, { day }, `${day.day}: explanation saved.`);
});

module.exports = { checkDay, explainDay };
