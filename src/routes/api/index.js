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
//
// 900, not 300. The limit counts per address, and one address is not one
// person: a university lab or a chapter on campus wifi arrives as a single IP,
// and this app is at its busiest exactly when a room full of students is
// signing up at once. The registration page alone spends a handful of requests
// a visit — the challenge image, the organization list, one per search
// keystroke — so twenty a minute shared across a room ran out mid-signup, and
// what it broke first was the captcha, which simply stopped loading.
//
// Still a backstop worth having: the endpoints that are actually worth abusing
// (login, registration, resend, verify, certificates) each carry their own
// much tighter limiter on top of this, and those are unchanged.
const baselineApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 900,
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
// Reloaded before writing, because this is the one GET in the app that
// modifies the session, and express-session saves the WHOLE object at the end
// of a request. Any other request in flight against the same session has its
// own older copy, and whichever finishes last wins — so issuing a challenge
// could silently undo a login that had just been saved by a request running
// alongside it. Reloading first means the copy about to be written includes
// whatever landed in the meantime.
//
// reload fails for a session that has never been stored, which is the ordinary
// case for a first-time visitor — nothing exists to clobber then, so that path
// just proceeds.
router.get('/captcha', (req, res) => {
  if (captchaService.isTurnstileConfigured()) return success(res, { svg: null });

  if (typeof req.session.reload !== 'function') {
    return success(res, challengeService.issue(req.session));
  }
  return req.session.reload(() => success(res, challengeService.issue(req.session)));
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
