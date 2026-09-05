const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const eventApi = require('../../controllers/api/event.api');
const registrationApi = require('../../controllers/api/registration.api');
const invitationApi = require('../../controllers/api/invitation.api');
const ticketApi = require('../../controllers/api/ticket.api');
const checkinApi = require('../../controllers/api/checkin.api');
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

// Each request can itself contain up to 200 invitees (see invitation.api.js),
// so this caps how often an admin can trigger a batch, not how many emails
// go out per batch.
const invitationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many invitation batches sent. Please try again later.' },
});

// Public + unauthenticated, so this is the only thing standing between the
// self-request form and someone scripting mass sends through it — tighter
// than the admin invitationLimiter above, and per-IP rather than per-admin.
const invitationRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
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

const invitationRequestValidators = [
  body('fullName').trim().notEmpty().withMessage('Name is required').isLength({ max: 150 }),
  body('email').trim().notEmpty().withMessage('Email is required').isEmail().withMessage('Enter a valid email address').isLength({ max: 191 }),
  body('school').optional({ checkFalsy: true }).trim().isLength({ max: 150 }),
  body('chapter').optional({ checkFalsy: true }).trim().isLength({ max: 150 }),
  body('company').optional({ checkFalsy: true }).trim().isLength({ max: 150 }),
];

const rsvpValidators = [
  body('status').isIn(['ATTENDING', 'NOT_ATTENDING']).withMessage('Invalid RSVP response'),
];

// Public + unauthenticated, matching invitationRequestLimiter's per-IP tier —
// a guest changing their mind a few times is normal; scripted abuse isn't.
const rsvpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

// Note: specific routes (admin/all) must be declared before the generic '/:id' route.
router.get('/admin/all', apiAdmin, eventApi.listAllEvents);

// Public
router.get('/', eventApi.listPublicEvents);
router.get('/:id', eventApi.getEvent);

// Authenticated user actions (direct/auto-fill registration)
router.post('/:id/register', apiAuth, verifyCsrfToken, registrationLimiter, registrationApi.registerForEvent);
router.post('/:id/cancel', apiAuth, verifyCsrfToken, registrationApi.cancelRegistration);

// A member's own e-ticket. Generous limit on purpose: someone standing in a
// queue with a phone that lost signal will retry, and throttling them at the
// door is exactly the wrong moment to be strict. It is still bounded, since
// each request renders a PDF and a QR bitmap.
const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many ticket requests. Please try again in a few minutes.' },
});

router.get('/:id/ticket.pdf', apiAuth, ticketLimiter, ticketApi.downloadTicketPdf);
router.get('/:id/ticket/qr.png', apiAuth, ticketLimiter, ticketApi.downloadTicketQrPng);

// --- Event check-in ---------------------------------------------------------
//
// Deliberately loose. A single entrance can scan a few hundred people in the
// first ten minutes of a convention, and several stations usually share one
// venue IP, so a limit tuned like the other endpoints here would throttle a
// real door mid-queue — the worst possible failure for this feature. This is
// sized to stop a runaway client loop, not to police legitimate scanning, and
// the endpoint is already behind an admin-or-granted-staff gate. Guessing a
// token is not a threat this needs to defend against: it is 256 bits.
const checkinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many scans from this device. Please wait a moment.' },
});

const scanValidators = [
  // Length-bounded but not format-checked here: deciding what is a valid code
  // is qr.service's job, and a malformed scan must come back as a normal
  // INVALID_QR verdict the door can display, not as a 422 the scanner page has
  // to translate. This only stops something absurd reaching the service.
  body('qrToken').isString().withMessage('A scanned value is required').isLength({ min: 1, max: 512 }),
  body('scannerIdentifier').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
];

router.post('/:id/checkin', apiAuth, verifyCsrfToken, checkinLimiter, scanValidators, checkinApi.scan);
router.post(
  '/:id/checkin/manual',
  apiAuth, verifyCsrfToken, checkinLimiter,
  [
    body('registrationId').isInt({ min: 1 }).withMessage('A registration is required'),
    body('scannerIdentifier').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
  ],
  checkinApi.manualCheckIn
);
router.get('/:id/checkin/search', apiAuth, checkinApi.searchRegistrations);
router.get('/:id/checkin/stats', apiAuth, checkinApi.stats);
router.get('/:id/checkin/report.xlsx', apiAuth, checkinApi.exportReport);

// Granting the ability to scan is a main-admin power, separate from having it.
router.get('/:id/checkin/staff', apiAdmin, checkinApi.listStaff);
router.post(
  '/:id/checkin/staff',
  apiAdmin, verifyCsrfToken,
  [body('userId').isInt({ min: 1 }).withMessage('A user is required')],
  checkinApi.grantStaff
);
router.delete('/:id/checkin/staff/:userId', apiAdmin, verifyCsrfToken, checkinApi.revokeStaff);

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

// Invitations — MAIN_ADMIN only, same tier as broadcast email (a bulk
// email-sending action with real abuse/cost potential, not a routine CRUD op).
router.get('/:id/invitations', apiAdmin, invitationApi.listInvitations);
router.post('/:id/invitations', apiAdmin, verifyCsrfToken, invitationLimiter, invitationApi.createInvitations);
router.post('/:id/invitations/:invitationId/resend', apiAdmin, verifyCsrfToken, invitationLimiter, invitationApi.resendInvitation);
router.get('/:id/invitations/export', apiAdmin, invitationApi.exportInvitationsExcel);

// Public self-service request — anyone viewing the event page (member or not)
// can ask to be invited; still goes through the session-backed CSRF check
// (issueCsrfToken runs for anonymous sessions too), just not apiAuth/apiAdmin.
router.post(
  '/:id/invitation-requests',
  verifyCsrfToken,
  invitationRequestLimiter,
  invitationRequestValidators,
  invitationApi.requestInvitation
);

// Guest RSVP — no account, authorized purely by possessing the unguessable
// token from the invite email (same trust model as the invite-link page itself).
router.post(
  '/:id/invitations/:token/rsvp',
  verifyCsrfToken,
  rsvpLimiter,
  rsvpValidators,
  invitationApi.submitRsvp
);

module.exports = router;
