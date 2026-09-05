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
const organizationRoutes = require('./organization.routes');
const { success } = require('../../utils/apiResponse');
const captchaService = require('../../services/captcha.service');
const challengeService = require('../../services/challenge.service');

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

// Hands out the built-in challenge image and remembers only its hash on the
// session. Also the refresh button's endpoint — asking again abandons the
// previous one, so nobody can collect answers to submit later.
//
// Returns nothing when Turnstile is configured, because then Turnstile is the
// check and the page should not be drawing a second one.
router.get('/captcha', (req, res) => {
  if (captchaService.isTurnstileConfigured()) return success(res, { svg: null });
  return success(res, challengeService.issue(req.session));
});

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/events', eventRoutes);
router.use('/registrations', registrationRoutes);
router.use('/certificates', certificateRoutes);
router.use('/payments', paymentRoutes);
router.use('/webhooks', webhookRoutes);
router.use('/articles', articleRoutes);
router.use('/organizations', organizationRoutes);

module.exports = router;
