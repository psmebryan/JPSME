const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./auth.routes');
const adminRoutes = require('./admin.routes');
const eventRoutes = require('./event.routes');
const registrationRoutes = require('./registration.routes');
const certificateRoutes = require('./certificate.routes');
const paymentRoutes = require('./payment.routes');
const webhookRoutes = require('./webhook.routes');
const articleRoutes = require('./article.routes');
const { success } = require('../../utils/apiResponse');

const router = Router();

// General abuse backstop for the whole API surface. Individual routes (login,
// certificate generation, event registration) layer stricter limiters on top
// of this where the endpoint is more expensive or more attractive to abuse.
const baselineApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
router.use(baselineApiLimiter);

// Lets client-side JS fetch the current CSRF token without a full page reload.
router.get('/csrf-token', (req, res) => success(res, { csrfToken: req.session.csrfToken }));

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/events', eventRoutes);
router.use('/registrations', registrationRoutes);
router.use('/certificates', certificateRoutes);
router.use('/payments', paymentRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/articles', articleRoutes);

module.exports = router;
