const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const paymentService = require('../../services/payment.service');

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
  const payment = await paymentService.getLatestEventPayment(req.session.user.id, req.params.eventId);
  return success(res, { payment });
});

const getPayment = asyncHandler(async (req, res) => {
  const payment = await paymentService.getPaymentForViewer(req.params.id, {
    id: req.session.user.id,
    role: req.session.user.role,
  });
  return success(res, { payment });
});

module.exports = { createMembershipCheckout, getMembershipStatus, getEventPaymentStatus, getPayment };
