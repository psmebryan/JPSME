const asyncHandler = require('../../utils/asyncHandler');
const { error } = require('../../utils/apiResponse');
const paymongoService = require('../../services/paymongo.service');
const paymentService = require('../../services/payment.service');
const auditService = require('../../services/audit.service');

// PayMongo POSTs here on payment/refund state changes. Never trust this request
// without a valid signature — it's the ONLY thing allowed to mark a payment PAID.
const handlePaymongoWebhook = asyncHandler(async (req, res) => {
  const signatureHeader = req.get('Paymongo-Signature');

  if (!paymongoService.verifyWebhookSignature(req.rawBody, signatureHeader)) {
    await auditService.log({ action: 'WEBHOOK_REJECTED', metadata: { reason: 'invalid signature' }, ipAddress: req.ip });
    return error(res, 'Invalid signature', 400);
  }

  const result = await paymentService.processWebhookEvent(req.body, req.ip);
  // PayMongo only cares about the HTTP status, not the body shape — 200 means
  // "received and won't be retried."
  return res.status(200).json({ received: true, result });
});

module.exports = { handlePaymongoWebhook };
