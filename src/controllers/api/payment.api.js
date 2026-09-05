const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const paymentService = require('../../services/payment.service');

// The param('id').isInt() validators on these routes were declared but never
// read, which makes them decorative: express-validator only records problems,
// something has to act on them. The effect was visible from outside —
// /api/payments/abc became Number('abc') = NaN, reached Prisma, and came back
// as a 500, while /api/payments/events/abc/status answered 200 as though the
// question had been understood. Neither leaked anything, but an endpoint that
// answers a malformed request with 'OK' is lying, and a 500 is an unhandled
// fault on a route someone can hit at will.
function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// Body is intentionally ignored — amount comes from SiteSetting, user comes
// from the session, never from the client.
const createMembershipCheckout = asyncHandler(async (req, res) => {
  const { paymentId, checkoutUrl } = await paymentService.createMembershipCheckout(req.session.user.id);
  return success(res, { paymentId, checkoutUrl }, 'Checkout created');
});

const getMembershipStatus = asyncHandler(async (req, res) => {
  const payment = await paymentService.getLatestMembershipPayment(req.session.user.id);
  return success(res, { payment });
});

// eventId comes from the URL, not the body — same "never trust the client"
// rule as everywhere else in this file.
const getEventPaymentStatus = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const payment = await paymentService.getLatestEventPayment(req.session.user.id, req.params.eventId);
  return success(res, { payment });
});

const getPayment = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return undefined;
  const payment = await paymentService.getPaymentForViewer(req.params.id, {
    id: req.session.user.id,
    role: req.session.user.role,
  });
  return success(res, { payment });
});

module.exports = { createMembershipCheckout, getMembershipStatus, getEventPaymentStatus, getPayment };
