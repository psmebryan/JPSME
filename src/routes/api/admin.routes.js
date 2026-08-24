const { Router } = require('express');
const { param, body, query } = require('express-validator');
const rateLimit = require('express-rate-limit');
const adminApi = require('../../controllers/api/admin.api');
const certificateApi = require('../../controllers/api/certificate.api');
const adminPaymentApi = require('../../controllers/api/adminPayment.api');
const adminEmailApi = require('../../controllers/api/adminEmail.api');
const adminBroadcastApi = require('../../controllers/api/adminBroadcast.api');
const { apiAdmin, apiAdminOrChapterAdmin } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadLogo, uploadSponsorLogo, uploadCertificateBackground, uploadEmailAttachment } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');

const certificateTemplateValidators = [
  body('title').optional({ checkFalsy: true }).trim().isLength({ max: 200 }).withMessage('Title is too long'),
  body('bodyText').optional({ checkFalsy: true }).trim().isLength({ max: 2000 }).withMessage('Body text is too long'),
  body('textColor').optional({ checkFalsy: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Text color must be a hex value like #1a1a2e'),
];

const emailTemplateValidators = [
  body('subject').optional({ checkFalsy: true }).trim().isLength({ max: 200 }).withMessage('Subject is too long'),
  body('bodyHtml').optional({ checkFalsy: true }).trim().isLength({ max: 5000 }).withMessage('Body is too long'),
];

// PDF preview/bulk-generate and Excel export are CPU/memory-heavy, so they get a
// tighter cap than ordinary admin CRUD even though this whole router is already
// main-ADMIN only.
const certificateWorkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many certificate operations. Please try again later.' },
});

// Requesting a refund calls out to PayMongo — cap it beyond the fact that this
// whole action is already MAIN_ADMIN-only.
const refundLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many refund requests. Please try again later.' },
});

// A broadcast can email hundreds of real people — cap accidental/repeated
// triggers beyond the fact this is already main-ADMIN-only.
const broadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many broadcasts sent this hour. Please try again later.' },
});

const router = Router();

// Allow ADMIN and CHAPTER_ADMIN (scoped) for chapter member endpoints
router.get('/chapter-members', apiAdminOrChapterAdmin, adminApi.listChapterMembers);
router.put('/users/:id', apiAdminOrChapterAdmin, verifyCsrfToken, adminApi.updateUser);
router.delete('/users/:id', apiAdminOrChapterAdmin, verifyCsrfToken, adminApi.deleteUser);

const paymentListValidators = [
  query('status').optional({ checkFalsy: true }).isIn(['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']).withMessage('Invalid status filter'),
  query('dateFrom').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid dateFrom'),
  query('dateTo').optional({ checkFalsy: true }).isISO8601().withMessage('Invalid dateTo'),
  query('purpose').optional({ checkFalsy: true }).isIn(['MEMBERSHIP_REGISTRATION', 'EVENT_REGISTRATION']).withMessage('Invalid purpose filter'),
  query('eventId').optional({ checkFalsy: true }).isInt().withMessage('Invalid eventId filter'),
];

// Chapter admin assignment endpoints (ADMIN only)
router.get('/chapter-admins', apiAdmin, adminApi.listChapterAdmins);
router.post('/chapter-admins/assign', apiAdmin, adminApi.assignChapterAdmin);
router.post('/chapter-admins/remove', apiAdmin, adminApi.removeChapterAdmin);

// Remaining routes require full ADMIN
router.use(apiAdmin);

router.get('/users', adminApi.listUsers);
router.post('/users/:id/approve', verifyCsrfToken, param('id').isInt(), adminApi.approveUser);
router.post('/users/:id/reject', verifyCsrfToken, param('id').isInt(), adminApi.rejectUser);

router.get('/settings/logo', adminApi.getLogo);
router.post('/settings/logo', verifyCsrfToken, uploadLogo.single('logo'), verifyImageSignature, adminApi.uploadLogo);
router.put(
  '/settings/membership-fee',
  verifyCsrfToken,
  body('feePhp').isFloat({ min: 0, max: 1000000 }).withMessage('Enter a valid fee amount'),
  adminApi.updateMembershipFee
);
router.get('/settings/payments-enabled', adminApi.getPaymentsEnabled);
router.put(
  '/settings/payments-enabled',
  verifyCsrfToken,
  body('enabled').isBoolean().withMessage('enabled must be true or false'),
  adminApi.updatePaymentsEnabled
);
router.get('/sponsors', adminApi.listSponsors);
router.post('/sponsors', verifyCsrfToken, uploadSponsorLogo.single('logo'), verifyImageSignature, adminApi.createSponsor);
router.delete('/sponsors/:id', verifyCsrfToken, param('id').isInt(), adminApi.deleteSponsor);

// Payments — MAIN_ADMIN only. Chapter admins have no access to payment data
// or the refund action (inherited from router.use(apiAdmin) above).
router.get('/payments', paymentListValidators, adminPaymentApi.listPayments);
router.get('/payments/summary', adminPaymentApi.getPaymentSummary);
router.get('/payments/:id', param('id').isInt(), adminPaymentApi.getPayment);
router.post(
  '/payments/:id/refund',
  verifyCsrfToken,
  refundLimiter,
  param('id').isInt(),
  body('reason').optional().isIn(['duplicate', 'fraudulent', 'requested_by_customer', 'others']).withMessage('Invalid refund reason'),
  body('notes').optional({ checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Notes are too long'),
  adminPaymentApi.refundPayment
);
router.post(
  '/payments/:id/reconcile',
  verifyCsrfToken,
  refundLimiter,
  param('id').isInt(),
  adminPaymentApi.reconcilePayment
);

// Certificates — main ADMIN only (inherited from router.use(apiAdmin) above,
// so CHAPTER_ADMIN can neither customize templates nor generate certificates).
router.get('/certificates/membership-template', certificateApi.getMembershipTemplate);
router.put('/certificates/membership-template', verifyCsrfToken, certificateTemplateValidators, certificateApi.updateMembershipTemplate);
router.post(
  '/certificates/membership-template/background',
  verifyCsrfToken,
  uploadCertificateBackground.single('background'),
  verifyImageSignature,
  certificateApi.uploadMembershipBackground
);
router.get('/certificates/membership-template/preview', certificateWorkLimiter, certificateApi.previewMembershipTemplate);

router.get('/certificates/events/:eventId/template', param('eventId').isInt(), certificateApi.getEventTemplate);
router.put(
  '/certificates/events/:eventId/template',
  verifyCsrfToken,
  param('eventId').isInt(),
  certificateTemplateValidators,
  certificateApi.updateEventTemplate
);
router.post(
  '/certificates/events/:eventId/template/background',
  verifyCsrfToken,
  param('eventId').isInt(),
  uploadCertificateBackground.single('background'),
  verifyImageSignature,
  certificateApi.uploadEventBackground
);
router.get(
  '/certificates/events/:eventId/template/preview',
  certificateWorkLimiter,
  param('eventId').isInt(),
  certificateApi.previewEventTemplate
);

router.get('/certificates/events/:eventId/registrants', param('eventId').isInt(), certificateApi.listEventRegistrantCertificates);
router.post(
  '/certificates/events/:eventId/generate',
  verifyCsrfToken,
  certificateWorkLimiter,
  param('eventId').isInt(),
  certificateApi.bulkGenerateEventCertificates
);
router.get(
  '/certificates/events/:eventId/export',
  certificateWorkLimiter,
  param('eventId').isInt(),
  certificateApi.exportEventCertificatesExcel
);
router.get(
  '/certificates/events/:eventId/registrants/:userId/download',
  param('eventId').isInt(),
  param('userId').isInt(),
  certificateApi.downloadEventCertificateAsAdmin
);
router.post(
  '/certificates/events/:eventId/registrants/:userId/release',
  verifyCsrfToken,
  param('eventId').isInt(),
  param('userId').isInt(),
  certificateApi.setEventCertificateReleased
);

// Emails — main ADMIN only (inherited from router.use(apiAdmin) above).
router.get('/emails/member-approved', adminEmailApi.getMemberApprovedTemplate);
router.put('/emails/member-approved', verifyCsrfToken, emailTemplateValidators, adminEmailApi.updateMemberApprovedTemplate);
router.post(
  '/emails/member-approved/attachment',
  verifyCsrfToken,
  uploadEmailAttachment.single('attachment'),
  verifyImageSignature,
  adminEmailApi.uploadMemberApprovedAttachment
);

router.get('/emails/events/:eventId/template', param('eventId').isInt(), adminEmailApi.getEventTemplate);
router.put(
  '/emails/events/:eventId/template',
  verifyCsrfToken,
  param('eventId').isInt(),
  emailTemplateValidators,
  adminEmailApi.updateEventTemplate
);
router.post(
  '/emails/events/:eventId/template/attachment',
  verifyCsrfToken,
  param('eventId').isInt(),
  uploadEmailAttachment.single('attachment'),
  verifyImageSignature,
  adminEmailApi.uploadEventAttachment
);

router.get('/emails/events/:eventId/invitation-template', param('eventId').isInt(), adminEmailApi.getEventInvitationTemplate);
router.put(
  '/emails/events/:eventId/invitation-template',
  verifyCsrfToken,
  param('eventId').isInt(),
  emailTemplateValidators,
  adminEmailApi.updateEventInvitationTemplate
);

// Broadcasts — main ADMIN only (inherited from router.use(apiAdmin) above).
// Specific routes before the generic '/:id' route (same convention as event.routes.js).
router.get('/broadcasts', adminBroadcastApi.listBroadcasts);
router.get('/broadcasts/audience-count', adminBroadcastApi.getAudienceCount);
router.post(
  '/broadcasts',
  verifyCsrfToken,
  broadcastLimiter,
  uploadEmailAttachment.single('attachment'),
  verifyImageSignature,
  adminBroadcastApi.createBroadcast
);
router.get('/broadcasts/:id', param('id').isInt(), adminBroadcastApi.getBroadcast);

module.exports = router;
