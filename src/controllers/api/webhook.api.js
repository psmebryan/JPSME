const crypto = require('crypto');
const config = require('../../config');
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

  // Acknowledge first, process after. Confirming a payment is not a quick
  // write — it flips a registration, sends a confirmation email, auto-approves
  // the membership and syncs a Google Sheet — and PayMongo times out a slow
  // handler and redelivers, so processing before responding invites exactly
  // the duplicate deliveries this has to defend against.
  //
  // Safe to acknowledge early because the work is idempotent regardless: the
  // (gateway, webhookId) unique constraint in processWebhookEvent makes any
  // redelivery a database-level no-op. And if this process dies between the
  // response and the work, the event is not lost — reconcilePayment and the
  // stuck-payment sweep re-derive state from PayMongo's own API.
  //
  // The signature was already verified above, so nothing unauthenticated ever
  // reaches this point.
  res.status(200).json({ received: true });

  try {
    await paymentService.processWebhookEvent(req.body, req.ip);
  } catch (err) {
    // The response is already sent, so this cannot be reported to PayMongo —
    // it has to be visible here instead, or a failure after acknowledgement
    // would vanish silently.
    (req.log || console).error('paymongo webhook processing failed after acknowledgement', {
      err: err.message,
      eventId: req.body?.data?.id,
      eventType: req.body?.data?.attributes?.type,
    });
    await auditService.log({
      action: 'WEBHOOK_REJECTED',
      metadata: {
        reason: 'processing failed after 200 acknowledgement',
        eventId: req.body?.data?.id,
        error: err.message,
      },
      ipAddress: req.ip,
    }).catch(() => {});
  }
});

// Brevo doesn't sign webhook requests (no HMAC header, unlike PayMongo), so
// authenticity is verified via a shared secret embedded in the webhook URL
// itself when it's registered in Brevo (?token=...) — a standard workaround
// for providers without native request signing. Compared with
// timingSafeEqual rather than === so a byte-by-byte comparison can't leak
// how much of the token an attacker guessed correctly via response timing.
function isValidBrevoToken(req) {
  const expected = config.email.brevoWebhookSecret;
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
