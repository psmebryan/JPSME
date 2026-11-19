const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const returns = require('../../services/merchReturns.service');
const redact = require('../../utils/merchRedact');

// Merchandise refunds and exchanges for staff (/api/admin/merch). Behind
// router.use(apiAdmin) and merchCan (which sets req.merchCaps). Who may take
// each step (phase 4):
//
//   check, accept, receive, send   Logistics (returns.goods): the goods side
//   approve, first approval        Finance (refund.approve)
//   approve, second approval       the main admin or the National President
//                                  (refund.second), above the limit
//   reject                         whoever owns the step it is waiting at
//
// The rules about people, "nobody approves their own request" and "the second
// approval comes from someone else", live in merchReturns.service.

const actor = (req) => ({ id: req.session.user.id, role: req.session.user.role, caps: req.merchCaps });

const raise = asyncHandler(async (req, res) => {
  const ret = await returns.createRequest(actor(req), req.params.orderNumber, req.body || {}, { byBuyer: false });
  return success(res, { request: redact.costs(req.merchCaps, ret) }, `${ret.returnNumber} raised for the buyer.`, 201);
});

// The capability a step needs, given where the request is now.
function needs(action, current) {
  if (['check', 'accept', 'receive', 'send'].includes(action)) return ['returns.goods'];
  if (action === 'approve') return current.status === 'NEEDS_SECOND' ? ['refund.second'] : ['refund.approve'];
  // reject
  if (current.kind === 'EXCHANGE' || current.status === 'REQUESTED') return ['returns.goods', 'refund.approve'];
  if (current.status === 'NEEDS_SECOND') return ['refund.second', 'refund.approve'];
  return ['refund.approve'];
}

const STEP = {
  check: (n, b, a) => returns.check(n, b, a.id),
  approve: (n, b, a) => returns.approve(n, b, a),
  reject: (n, b, a) => returns.reject(n, b, a.id),
  accept: (n, b, a) => returns.acceptExchange(n, a.id),
  receive: (n, b, a) => returns.receiveOld(n, b, a.id),
  send: (n, b, a) => returns.sendNew(n, b, a.id),
};
const step = asyncHandler(async (req, res) => {
  const current = await returns.getReturn(req.params.returnNumber);
  const caps = req.merchCaps || new Set();
  if (!needs(req.params.action, current).some((c) => caps.has(c))) {
    return error(res, 'This step belongs to another team. Your access does not include it.', 403);
  }
  const ret = await STEP[req.params.action](req.params.returnNumber, req.body || {}, actor(req));
  return success(res, { request: redact.costs(caps, ret) }, `${ret.returnNumber}: ${ret.statusLabel}.`);
});

const saveSettings = asyncHandler(async (req, res) => {
  const settings = await returns.setSettings(req.body || {});
  return success(res, { settings }, 'Refund settings saved.');
});

module.exports = { raise, step, saveSettings, needs };
