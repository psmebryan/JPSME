const crypto = require('crypto');
const asyncHandler = require('../../utils/asyncHandler');
const { error } = require('../../utils/apiResponse');
const paymongoService = require('../../services/paymongo.service');
const paymentService = require('../../services/payment.service');
const auditService = require('../../services/audit.service');
const invitationService = require('../../services/invitation.service');

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

// Brevo doesn't sign webhook requests (no HMAC header, unlike PayMongo), so
// authenticity is verified via a shared secret embedded in the webhook URL
// itself when it's registered in Brevo (?token=...) — a standard workaround
// for providers without native request signing. Compared with
// timingSafeEqual rather than === so a byte-by-byte comparison can't leak
// how much of the token an attacker guessed correctly via response timing.
function isValidBrevoToken(req) {
  const expected = process.env.BREVO_WEBHOOK_SECRET;
  const provided = req.query.token;
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(String(provided));
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Brevo POSTs one event per delivery-lifecycle change for a transactional
// email (delivered/bounced/opened/etc.) — see invitation.service.js's
// applyWebhookEvent for which event types are actually acted on. Never
// throws on an event it doesn't recognize or can't correlate — an
// unrecognized webhook payload must not become a 500 that gets Brevo to keep
// retrying forever.
const handleBrevoWebhook = asyncHandler(async (req, res) => {
  if (!isValidBrevoToken(req)) {
    await auditService.log({ action: 'WEBHOOK_REJECTED', metadata: { reason: 'invalid brevo token' }, ipAddress: req.ip });
    return error(res, 'Invalid token', 401);
  }

  const body = req.body || {};
  const tag = Array.isArray(body.tags) ? body.tags[0] : body.tag;
  const result = await invitationService.applyWebhookEvent({ tag, eventType: body.event, reason: body.reason });
  return res.status(200).json({ received: true, result });
});

module.exports = { handlePaymongoWebhook, handleBrevoWebhook };
