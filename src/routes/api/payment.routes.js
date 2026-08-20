const { Router } = require('express');
const { param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const paymentApi = require('../../controllers/api/payment.api');
const { apiAuth } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');

const router = Router();

// Creating a checkout hits an external gateway and creates DB rows — cap how
// often one user can attempt it.
const createCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment attempts. Please try again later.' },
});

router.post('/membership/create', apiAuth, verifyCsrfToken, createCheckoutLimiter, paymentApi.createMembershipCheckout);
router.get('/membership/status', apiAuth, paymentApi.getMembershipStatus);
router.get('/events/:eventId/status', apiAuth, param('eventId').isInt(), paymentApi.getEventPaymentStatus);
router.get('/:id', apiAuth, param('id').isInt(), paymentApi.getPayment);

module.exports = router;
