const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const authApi = require('../../controllers/api/auth.api');
const { apiAuth } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadProfileImage } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');

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

const registerValidators = [
  body('firstName').trim().notEmpty().withMessage('First name is required').isLength({ max: 100 }),
  body('lastName').trim().notEmpty().withMessage('Last name is required').isLength({ max: 100 }),
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 150 }),
  body('chapterId')
    .notEmpty().withMessage('Please select a chapter')
    .bail()
    .custom((value) => Number.isInteger(Number(value)) && Number(value) > 0)
    .withMessage('Please select a valid chapter'),
];

const loginValidators = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

const resendVerificationValidators = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
];

const profileValidators = [
  body('middleInitial').optional({ checkFalsy: true }).trim().isLength({ max: 2 }).withMessage('Middle initial must be at most 2 characters'),
  body('phone').optional({ checkFalsy: true }).trim().isLength({ max: 30 }).withMessage('Phone number is too long'),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 150 }).withMessage('School name is too long'),
  body('chapterId').optional({ nullable: true }).custom((value) => {
    if (value === '' || value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('A valid chapter is required'),
];

router.post('/register', verifyCsrfToken, registerValidators, authApi.register);
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
router.post(
  '/resend-verification',
  verifyCsrfToken,
  resendVerificationLimiter,
  resendVerificationValidators,
  authApi.resendVerification
);

module.exports = router;