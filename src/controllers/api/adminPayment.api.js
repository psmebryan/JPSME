const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const paymentService = require('../../services/payment.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// This whole router is MAIN_ADMIN only (see admin.routes.js) — CHAPTER_ADMIN
// never reaches these handlers.
const listPayments = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const { status, organizationId, dateFrom, dateTo, purpose, eventId, page } = req.query;
  const result = await paymentService.listPaymentsForAdmin({
    status: status || undefined,
    organizationId: organizationId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    purpose: purpose || undefined,
    eventId: eventId || undefined,
    page: Math.max(1, Number(page) || 1),
  });
  return success(res, result);
});

const getPaymentSummary = asyncHandler(async (req, res) => {
  const { purpose, eventId } = req.query;
  const summary = await paymentService.getPaymentSummary({ purpose: purpose || undefined, eventId: eventId || undefined });
  return success(res, summary);
});

const getPayment = asyncHandler(async (req, res) => {
  const payment = await paymentService.getPaymentForViewer(req.params.id, {
    id: req.session.user.id,
    role: req.session.user.role,
  });
  return success(res, { payment });
});

const refundPayment = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;

  const refund = await paymentService.requestRefund({
    paymentId: req.params.id,
    adminUserId: req.session.user.id,
    reason: req.body.reason,
    notes: req.body.notes,
  });
  return success(res, { refund }, 'Refund requested');
});

const reconcilePayment = asyncHandler(async (req, res) => {
  const result = await paymentService.reconcilePayment(req.params.id);
  return success(res, result, 'Reconciliation complete');
});

module.exports = { listPayments, getPaymentSummary, getPayment, refundPayment, reconcilePayment };
