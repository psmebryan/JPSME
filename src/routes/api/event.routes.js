const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const eventApi = require('../../controllers/api/event.api');
const registrationApi = require('../../controllers/api/registration.api');
const invitationApi = require('../../controllers/api/invitation.api');
const ticketApi = require('../../controllers/api/ticket.api');
const checkinApi = require('../../controllers/api/checkin.api');
const roomApi = require('../../controllers/api/room.api');
const seatingApi = require('../../controllers/api/seating.api');
const { requireHuman } = require('../../services/captcha.service');
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
  // `chapter` is the form's Organization field; the name is the column's, kept
  // so old links and any saved integration keep working.
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

// Replacing somebody's ticket is a main-admin action, kept apart from the
// member-facing routes above it.
router.post('/:id/registrations/:registrationId/qr/regenerate', apiAdmin, verifyCsrfToken, ticketApi.regenerateTicket);

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
// Removing an admission sits with the other door actions rather than behind the
// main-admin gate below: the person who needs it is the operator who just
// scanned the wrong ticket, and a correction only a main admin can make is one
// that will not happen while a queue is waiting. The service logs it twice over
// — a CHECK_OUT row and an audit entry — precisely because it is available
// widely. Same limiter as the scans, so a stuck client cannot loop on it.
router.post(
  '/:id/checkin/undo',
  apiAuth, verifyCsrfToken, checkinLimiter,
  [
    body('registrationId').isInt({ min: 1 }).withMessage('A registration is required'),
    body('scannerIdentifier').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
  ],
  checkinApi.undoCheckIn
);
// The registration desk reads before it acts: this answers "who is this" and
// admits nobody, so a seat can be chosen first.
router.post('/:id/checkin/lookup', apiAuth, verifyCsrfToken, checkinLimiter, scanValidators, checkinApi.lookup);
router.get('/:id/checkin/search', apiAuth, checkinApi.searchRegistrations);
router.get('/:id/checkin/stats', apiAuth, checkinApi.stats);
router.get('/:id/checkin/report.xlsx', apiAuth, checkinApi.exportReport);

// --- rooms and room attendance ---------------------------------------------
//
// Reading the room list is what the live occupancy view polls, so it is open to
// anyone who can work a door. Changing the configuration is an admin action.
// Scanning sits behind the same gate as the main entrance — checkin.service's
// assertCanCheckIn, applied inside the service so no route can forget it.
router.get('/:id/rooms', apiAuth, roomApi.listRooms);
router.post(
  '/:id/rooms',
  apiAdmin, verifyCsrfToken,
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }).withMessage('A room name is required'),
    // Nullable rather than optional-falsy: an empty capacity means uncapped,
    // which is a real choice and not a missing value.
    body('capacity').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1, max: 100000 })
      .withMessage('Capacity must be a whole number above zero'),
    body('location').optional({ checkFalsy: true }).trim().isLength({ max: 191 }),
    body('displayOrder').optional({ checkFalsy: true }).isInt({ min: 0, max: 9999 }),
  ],
  roomApi.createRoom
);
router.put(
  '/:id/rooms/:roomId',
  apiAdmin, verifyCsrfToken,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('capacity').optional({ nullable: true }).custom((v) => v === '' || v === null || Number.isInteger(Number(v)))
      .withMessage('Capacity must be a whole number, or empty for no limit'),
    body('location').optional({ nullable: true }).trim().isLength({ max: 191 }),
    body('isOpen').optional().isBoolean(),
    body('displayOrder').optional().isInt({ min: 0, max: 9999 }),
  ],
  roomApi.updateRoom
);
router.delete('/:id/rooms/:roomId', apiAdmin, verifyCsrfToken, roomApi.deleteRoom);

// The room door. Same limiter as the main entrance and for the same reason: a
// hall of a thousand people empties into a corridor at once, and a limit tuned
// like the rest of the API would throttle a real queue.
router.post(
  '/:id/rooms/:roomId/scan',
  apiAuth, verifyCsrfToken, checkinLimiter, scanValidators,
  roomApi.scan
);
router.get('/:id/rooms/:roomId/inside', apiAuth, roomApi.listInside);
router.post(
  '/:id/rooms/:roomId/override',
  apiAuth, verifyCsrfToken, checkinLimiter,
  [
    body('registrationId').isInt({ min: 1 }).withMessage('A registration is required'),
    body('state').isIn(['INSIDE', 'OUTSIDE']).withMessage('State must be INSIDE or OUTSIDE'),
  ],
  roomApi.overrideState
);

// --- assigned seating -------------------------------------------------------
//
// Two maps over the same seats. The admin one carries names; the attendee one
// does not, and is scoped to the caller's own registration — which is resolved
// server-side, so a request cannot name somebody else's.
router.get('/:id/seating/map', apiAdmin, seatingApi.adminMap);
// Who has left their seat, and for how long. Behind the same gate as the admin
// map, because it names people and reports their movements.
router.get('/:id/seating/stepped-out', apiAdmin, seatingApi.steppedOut);
router.get('/:id/seating/my-map', apiAuth, seatingApi.attendeeMap);
router.get('/:id/seating/seats/:seatId/history', apiAdmin, seatingApi.seatHistory);
// Open to anyone running a door, not main-admin only: the registration desk is
// staffed by whoever is scanning, and it needs the free seats and one person's
// seat to do its job. Neither carries anybody else's name.
router.get('/:id/seating/available', apiAuth, seatingApi.availableSeats);
router.get('/:id/seating/registrations/:registrationId/seat', apiAuth, seatingApi.registrationSeat);

router.put(
  '/:id/seating',
  apiAdmin, verifyCsrfToken,
  [body('enabled').isBoolean().withMessage('Enabled must be true or false')],
  seatingApi.setEnabled
);
router.post(
  '/:id/seating/sections',
  apiAdmin, verifyCsrfToken,
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }).withMessage('A section name is required'),
    body('roomId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('displayOrder').optional({ checkFalsy: true }).isInt({ min: 0, max: 9999 }),
  ],
  seatingApi.createSection
);
router.put(
  '/:id/seating/sections/:sectionId',
  apiAdmin, verifyCsrfToken,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('roomId').optional({ nullable: true }).custom((v) => v === '' || v === null || Number.isInteger(Number(v)))
      .withMessage('Pick a room, or none'),
    body('displayOrder').optional().isInt({ min: 0, max: 9999 }),
  ],
  seatingApi.updateSection
);
router.delete('/:id/seating/sections/:sectionId', apiAdmin, verifyCsrfToken, seatingApi.deleteSection);
router.post(
  '/:id/seating/sections/:sectionId/generate',
  apiAdmin, verifyCsrfToken,
  [
    // Bounded here as well as in the service. The service refuses an absurd
    // grid; this stops the request being parsed at all.
    body('rows').isInt({ min: 1, max: 200 }).withMessage('Rows must be between 1 and 200'),
    body('seatsPerRow').isInt({ min: 1, max: 200 }).withMessage('Seats per row must be between 1 and 200'),
    body('startNumber').optional({ checkFalsy: true }).isInt({ min: 0, max: 9999 }),
    body('rowLabelStyle').optional({ checkFalsy: true }).isIn(['LETTERS', 'NUMBERS']),
    body('rowLabelStart').optional({ checkFalsy: true }).isInt({ min: 0, max: 999 }),
    body('type').optional({ checkFalsy: true }).isIn(['REGULAR', 'VIP', 'ACCESSIBLE', 'TABLE']),
  ],
  seatingApi.generateSeats
);
router.post(
  '/:id/seating/seats/:seatId/block',
  apiAdmin, verifyCsrfToken,
  [body('blocked').isBoolean().withMessage('Blocked must be true or false')],
  seatingApi.setBlocked
);
router.delete('/:id/seating/seats/:seatId', apiAdmin, verifyCsrfToken, seatingApi.deleteSeat);

// The desk: putting a named person in a named seat, and taking them out again.
router.post(
  '/:id/seating/seats/:seatId/assign',
  apiAdmin, verifyCsrfToken,
  [body('registrationId').isInt({ min: 1 }).withMessage('A registration is required')],
  seatingApi.assignSeat
);
router.post('/:id/seating/seats/:seatId/release', apiAdmin, verifyCsrfToken, seatingApi.adminRelease);

// The attendee choosing for themselves. No registration in the body — see
// ownRegistration in seating.api.
router.post('/:id/seating/seats/:seatId/hold', apiAuth, verifyCsrfToken, seatingApi.holdSeat);
router.post('/:id/seating/seats/:seatId/confirm', apiAuth, verifyCsrfToken, seatingApi.confirmSeat);
router.post('/:id/seating/seats/:seatId/give-up', apiAuth, verifyCsrfToken, seatingApi.releaseOwnSeat);

router.get('/:id/sessions', apiAuth, roomApi.listSessions);
router.post(
  '/:id/sessions',
  apiAdmin, verifyCsrfToken,
  [
    body('name').isString().trim().isLength({ min: 1, max: 120 }).withMessage('A session name is required'),
    body('roomId').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1 }),
    body('startTime').optional({ checkFalsy: true }).isISO8601().withMessage('Enter a valid start time'),
    body('endTime').optional({ checkFalsy: true }).isISO8601().withMessage('Enter a valid end time'),
  ],
  roomApi.createSession
);
router.delete('/:id/sessions/:sessionId', apiAdmin, verifyCsrfToken, roomApi.deleteSession);

// One person's movements. Mounted under registrations rather than rooms because
// it spans every room they entered.
router.get('/:id/registrations/:registrationId/attendance', apiAuth, roomApi.attendanceHistory);

// Granting the ability to scan is a main-admin power, separate from having it.
router.get('/:id/checkin/staff', apiAdmin, checkinApi.listStaff);
router.post(
  '/:id/checkin/staff',
  apiAdmin, verifyCsrfToken,
  [body('userId').isInt({ min: 1 }).withMessage('A user is required')],
  checkinApi.grantStaff
);
router.delete('/:id/checkin/staff/:userId', apiAdmin, verifyCsrfToken, checkinApi.revokeStaff);

// Integration keys: the same door, opened by another SYSTEM rather than by a
// person. Main admin only, for the same reason granting staff is — a key
// admits people with no JPSME account behind it.
//
// These are the admin-facing management routes and are session-authenticated
// like everything else here. The routes the other system actually calls live
// at /api/integration and are authenticated by the key itself.
router.get('/:id/integration-keys', apiAdmin, checkinApi.listIntegrationKeys);
router.post(
  '/:id/integration-keys',
  apiAdmin, verifyCsrfToken,
  [body('label').trim().isLength({ min: 1, max: 120 }).withMessage('A label is required')],
  checkinApi.createIntegrationKey
);
router.delete('/:id/integration-keys/:keyId', apiAdmin, verifyCsrfToken, checkinApi.revokeIntegrationKey);

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
  // The most exposed form in the app: no account needed, and it mails whatever
  // address is typed into it.
  requireHuman(),
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
