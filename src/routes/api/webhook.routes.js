const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const webhookApi = require('../../controllers/api/webhook.api');

const router = Router();

// PayMongo, not a browser — generous enough for legitimate retry bursts,
// tight enough to blunt abuse of an endpoint that's reachable with no auth.
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

// No apiAuth/CSRF here on purpose — PayMongo can't carry our session cookie or
// CSRF token. Authenticity is verified via the PayMongo-Signature header instead
// (see webhook.api.js / paymongo.service.js).
router.post('/paymongo', webhookLimiter, webhookApi.handlePaymongoWebhook);

module.exports = router;
