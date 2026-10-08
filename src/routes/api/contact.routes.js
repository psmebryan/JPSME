const { Router } = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { requireHuman } = require('../../services/captcha.service');
const mailService = require('../../services/mail.service');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const logger = require('../../utils/logger');

const router = Router();

// The public contact form. Public and unauthenticated, and every accepted
// submission is a real email out of the same Brevo allowance that password
// resets depend on, so two limits:
//
//   per address  a person sending a few messages is normal; a script is not
//   site-wide    a ceiling on the whole form per day, so spread-out abuse
//                from many addresses cannot use up the day's mail quota
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many messages from this network. Please try again in an hour, or email us directly.' },
});

const contactDailyCap = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => 'contact-form',
  message: { success: false, message: 'The contact form is busy right now. Please email us directly instead.' },
});

const contactValidators = [
  body('firstName').trim().notEmpty().withMessage('First name is required').isLength({ max: 100 }).withMessage('First name is too long'),
  body('lastName').trim().notEmpty().withMessage('Last name is required').isLength({ max: 100 }).withMessage('Last name is too long'),
  body('email').trim().isEmail().withMessage('Enter a valid email address').isLength({ max: 191 }),
  body('message').trim().isLength({ min: 10 }).withMessage('Please write a little more (at least 10 characters)')
    .isLength({ max: 5000 }).withMessage('Please keep the message under 5,000 characters'),
];

// Order matters: CSRF, then the limits, then the human check, then the
// validators, so a bot's request is refused before anything is parsed and
// a rejected one still counts against the limit.
router.post(
  '/',
  verifyCsrfToken,
  contactLimiter,
  contactDailyCap,
  requireHuman(),
  contactValidators,
  asyncHandler(async (req, res) => {
    const result = validationResult(req);
    if (!result.isEmpty()) return error(res, 'Validation failed', 422, result.array());

    const sent = await mailService.sendContactMessage({
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      message: req.body.message,
    });
    if (!sent) {
      return error(res, 'Your message could not be sent right now. Please try again later, or email us directly.', 502);
    }

    // Logged without the message or the sender's details: the email itself is
    // the record, and the log is not a place for personal data.
    (req.log || logger).info('contact form message sent');
    return success(res, null, 'Thank you. Your message has been sent, and we will reply by email.');
  })
);

module.exports = router;
