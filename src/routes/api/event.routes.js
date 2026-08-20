const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const eventApi = require('../../controllers/api/event.api');
const registrationApi = require('../../controllers/api/registration.api');
const { apiAuth, apiAdmin } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadEventImage } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');

const router = Router();

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many registration attempts. Please try again later.' },
});

const eventValidators = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('description').optional({ checkFalsy: true }).trim(),
  body('location').optional({ checkFalsy: true }).trim().isLength({ max: 200 }),
  body('modality').optional().isIn(['FACE_TO_FACE', 'ONLINE']).withMessage('Modality must be FACE_TO_FACE or ONLINE'),
  body('zoomLink').optional({ checkFalsy: true }).trim().isURL().withMessage('Zoom link must be a valid URL').isLength({ max: 500 }),
  body('featured').optional().isBoolean().withMessage('Featured must be true or false'),
  body('startDate').isISO8601().withMessage('A valid start date is required'),
  body('endDate').optional({ checkFalsy: true }).isISO8601(),
  body('capacity').optional({ checkFalsy: true }).isInt({ min: 1 }),
  body('isPublished').optional().isBoolean().withMessage('Published status must be true or false'),
  // checkFalsy here only skips a true empty-string/blank field (JS: only ""
  // is falsy among strings) — the form value "0" is NOT falsy as a string,
  // so it's still validated and correctly means "explicitly free", matching
  // the capacity field's existing convention just above.
  body('feePhp').optional({ checkFalsy: true }).isFloat({ min: 0, max: 1000000 }).withMessage('Enter a valid registration fee'),
];

// Note: specific routes (admin/all) must be declared before the generic '/:id' route.
router.get('/admin/all', apiAdmin, eventApi.listAllEvents);

// Public
router.get('/', eventApi.listPublicEvents);
router.get('/:id', eventApi.getEvent);

// Authenticated user actions (direct/auto-fill registration)
router.post('/:id/register', apiAuth, verifyCsrfToken, registrationLimiter, registrationApi.registerForEvent);
router.post('/:id/cancel', apiAuth, verifyCsrfToken, registrationApi.cancelRegistration);

// Admin management
router.post(
  '/',
  apiAdmin,
  verifyCsrfToken,
  uploadEventImage.single('image'),
  verifyImageSignature,
  eventValidators,
  eventApi.createEvent
);
router.put(
  '/:id',
  apiAdmin,
  verifyCsrfToken,
  uploadEventImage.single('image'),
  verifyImageSignature,
  eventValidators,
  eventApi.updateEvent
);
router.delete('/:id', apiAdmin, verifyCsrfToken, eventApi.deleteEvent);
router.get('/:id/registrations', apiAdmin, registrationApi.eventRegistrations);

module.exports = router;
