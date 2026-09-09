const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const authApi = require('../../controllers/api/auth.api');
const { apiAuth } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadProfileImage } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');
const { requireHuman } = require('../../services/captcha.service');

const router = Router();

// Slow down credential-stuffing / brute-force attempts against login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
});

// Limits how often verification emails can be (re)requested for a given IP.
const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Every other sensitive endpoint here has its own limiter beyond the global
// baseline (login, resend-verification) — registration didn't, despite being
// a classic target for mass fake-account creation and email-bombing (each
// one triggers a real verification email send).
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts. Please try again later.' },
});

const registerValidators = [
  body('firstName').trim().notEmpty().withMessage('First name is required').isLength({ max: 100 }),
  body('lastName').trim().notEmpty().withMessage('Last name is required').isLength({ max: 100 }),
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 150 }),
  body('yearLevel').optional({ checkFalsy: true }).isIn(['FIRST', 'SECOND', 'THIRD', 'FOURTH']).withMessage('Select a valid year level'),
  body('organizationId')
    .notEmpty().withMessage('Please select your organization')
    .bail()
    .custom((value) => Number.isInteger(Number(value)) && Number(value) > 0)
    .withMessage('Please select a valid organization'),
  // Where to send them once approved (e.g. an event they clicked "Create an
  // account" from). Real safety (same-site-only) is enforced server-side in
  // auth.service.js's sanitizeRedirectPath — this is just a length cap.
  body('next').optional({ checkFalsy: true }).isLength({ max: 500 }),
];

const loginValidators = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

const resendVerificationValidators = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
];

const profileValidators = [
  // .optional() rather than .optional({ checkFalsy: true }): a field that is
  // simply absent is left alone by the service, but one submitted empty is a
  // real mistake and gets told so, instead of being silently ignored.
  body('firstName').optional().trim().notEmpty().withMessage('First name cannot be blank')
    .isLength({ max: 100 }).withMessage('First name is too long'),
  body('lastName').optional().trim().notEmpty().withMessage('Last name cannot be blank')
    .isLength({ max: 100 }).withMessage('Last name is too long'),
  body('middleInitial').optional({ checkFalsy: true }).trim().isLength({ max: 2 }).withMessage('Middle initial must be at most 2 characters'),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }).withMessage('Phone number is too long'),
  body('yearLevel').optional({ checkFalsy: true }).isIn(['FIRST', 'SECOND', 'THIRD', 'FOURTH']).withMessage('Select a valid year level'),
  body('organizationId').optional({ nullable: true }).custom((value) => {
    if (value === '' || value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('A valid organization is required'),
];

// requireHuman sits before the validators on purpose: a bot's submission
// should be turned away before the server spends anything parsing what it
// claimed to be.
router.post('/register', verifyCsrfToken, registerLimiter, requireHuman(), registerValidators, authApi.register);
router.post('/login', verifyCsrfToken, loginLimiter, loginValidators, authApi.login);
router.post('/logout', verifyCsrfToken, authApi.logout);
router.get('/me', apiAuth, authApi.me);
router.put('/me/profile', apiAuth, verifyCsrfToken, profileValidators, authApi.updateProfile);
router.post(
  '/me/profile/image',
  apiAuth,
  verifyCsrfToken,
  uploadProfileImage.single('profileImage'),
  verifyImageSignature,
  authApi.uploadProfileImage
);
// Protected because it mails an arbitrary address on demand — the cheapest
// way to use this site to send someone else mail they did not ask for.
router.post(
  '/resend-verification',
  verifyCsrfToken,
  resendVerificationLimiter,
  requireHuman(),
  resendVerificationValidators,
  authApi.resendVerification
);

// Tight on purpose, and tighter than anything else here. The code being
// checked is six digits, so this is the one endpoint in the app where
// unlimited requests would actually be worth an attacker's time: a million
// guesses is nothing over a fast connection. The per-code attempt counter in
// emailVerification.service is the real defence — five wrong guesses destroy
// the code — and this caps how quickly someone can burn through codes across
// many accounts to find one that is guessable.
const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.' },
});

router.post(
  '/verify-code',
  verifyCsrfToken,
  verifyCodeLimiter,
  [
    body('email').isEmail().withMessage('Enter the email address you registered with').normalizeEmail(),
    // Digits only, exact length, whitespace stripped first — people paste codes
    // with a stray space from the email far more often than they mistype them.
    body('code').customSanitizer((v) => String(v || '').replace(/\s+/g, ''))
      .matches(/^\d{6}$/).withMessage('Enter the 6-digit code from your email'),
  ],
  authApi.verifyEmailCode
);

module.exports = router;