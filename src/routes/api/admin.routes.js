const { Router } = require('express');
const { param, body, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const adminApi = require('../../controllers/api/admin.api');
const certificateApi = require('../../controllers/api/certificate.api');
const adminPaymentApi = require('../../controllers/api/adminPayment.api');
const memberTypeApi = require('../../controllers/api/memberType.api');
const studentOrgApi = require('../../controllers/api/studentOrg.api');
const eventFeeApi = require('../../controllers/api/eventFee.api');
const adminEmailApi = require('../../controllers/api/adminEmail.api');
const adminBroadcastApi = require('../../controllers/api/adminBroadcast.api');
const invitationApi = require('../../controllers/api/invitation.api');
const dataTransferApi = require('../../controllers/api/dataTransfer.api');
const activationsApi = require('../../controllers/api/activations.api');
const jobApi = require('../../controllers/api/job.api');
const merchApi = require('../../controllers/api/merch.api');
const merchOrdersApi = require('../../controllers/api/merchOrders.api');
const merchReturnsApi = require('../../controllers/api/merchReturns.api');
const merchFinanceApi = require('../../controllers/api/merchFinance.api');
const merchLaunchApi = require('../../controllers/api/merchLaunch.api');
const { apiAdmin, apiAdminOrChapterAdmin, presidentTargetGuard, merchCan } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadLogo, uploadEventImage, uploadSponsorLogo, uploadCertificateBackground, uploadEmailAttachment, uploadDataWorkbook, uploadMerchPhotos } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');

const certificateTemplateValidators = [
  body('title').optional({ checkFalsy: true }).trim().isLength({ max: 200 }).withMessage('Title is too long'),
  body('bodyText').optional({ checkFalsy: true }).trim().isLength({ max: 2000 }).withMessage('Body text is too long'),
  body('textColor').optional({ checkFalsy: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Text color must be a hex value like #1a1a2e'),
  body('layoutMode').optional({ checkFalsy: true }).isIn(['text', 'name']).withMessage('Choose a design type'),
  body('nameColor').optional({ checkFalsy: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Name color must be a hex value like #2b508c'),
  body('nameSize').optional({ checkFalsy: true }).isFloat({ min: 6, max: 150 }).withMessage('Name size must be between 6 and 150'),
  body('nameBaseline').optional({ checkFalsy: true }).isFloat({ min: 3, max: 97 }).withMessage('Name position must be between 3% and 97%'),
  body('nameMaxWidth').optional({ checkFalsy: true }).isFloat({ min: 20, max: 100 }).withMessage('Name width must be between 20% and 100%'),
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

const mergoCampaignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many activation campaign changes this hour.' },
});
const mergoSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many Mergo status syncs. Please try again shortly.' },
});

const router = Router();

function checkRouteInput(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Invalid request data.', errors: result.array() });
  }
  return next();
}

// A President never changes the main admin or a President account, on any
// route below (see presidentTargetGuard). Does nothing for anyone else.
router.use(presidentTargetGuard);

// Allow ADMIN and CHAPTER_ADMIN (scoped) for chapter member endpoints
router.get('/organization-members', apiAdminOrChapterAdmin, adminApi.listOrganizationMembers);
router.post('/users/bulk-delete', apiAdminOrChapterAdmin, verifyCsrfToken, adminApi.bulkDeleteUsers);
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
// Organization tree: read one level at a time, and create directly under a node.
router.get('/organization-tree', apiAdmin, adminApi.getOrganizationTreeLevel);
router.post('/organizations/child', apiAdmin, verifyCsrfToken, adminApi.createChildOrganization);
router.post('/organizations/:id/active', apiAdmin, verifyCsrfToken, adminApi.setOrganizationActiveApi);
router.delete('/organizations/:id', apiAdmin, verifyCsrfToken, adminApi.deleteOrganizationApi);

router.get('/organization-admins', apiAdmin, adminApi.listOrganizationAdmins);
router.post('/organization-admins/assign', apiAdmin, verifyCsrfToken, adminApi.assignOrganizationAdmin);
router.post('/organization-admins/remove', apiAdmin, verifyCsrfToken, adminApi.removeOrganizationAdmin);

// Remaining routes require full ADMIN
router.use(apiAdmin);

router.get('/users', adminApi.listUsers);
router.get(
  '/members',
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Invalid page'),
  query('organizationId').optional({ checkFalsy: true }).isInt().withMessage('Invalid organizationId filter'),
  query('status').optional({ checkFalsy: true }).isIn(['PENDING', 'APPROVED', 'REJECTED']).withMessage('Invalid status filter'),
  query('membership').optional({ checkFalsy: true }).isIn(['MEMBER', 'NON_MEMBER', 'LAPSED', 'NEVER']).withMessage('Invalid membership filter'),
  // A member type id from the Master List, or NONE for members without one.
  query('memberType').optional({ checkFalsy: true }).matches(/^(NONE|[1-9]\d*)$/).withMessage('Invalid member type filter'),
  query('paymentStatus').optional({ checkFalsy: true }).isIn(['UNPAID', 'PAID', 'PENDING', 'PROCESSING', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']).withMessage('Invalid payment filter'),
  adminApi.listMembers
);
router.post('/users/:id/approve', verifyCsrfToken, param('id').isInt(), adminApi.approveUser);
router.post('/users/:id/reject', verifyCsrfToken, param('id').isInt(), adminApi.rejectUser);

// A member's credentials. MAIN_ADMIN only — note these sit BELOW the
// apiAdmin gate that /users/:id/approve is under, not with the
// apiAdminOrChapterAdmin routes higher up: setting a password means being able
// to sign in as that member, and changing their address means every future
// reset link goes somewhere else. Neither is chapter-level member management.
router.post(
  '/users/:id/password',
  verifyCsrfToken,
  [
    param('id').isInt(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  adminApi.setUserPassword
);
// Activation invitations. MAIN_ADMIN, inherited from router.use(apiAdmin) above.
//
// A send is its own action rather than part of the import that created the
// accounts, so a sheet can be checked after it is applied and before anybody is
// emailed about it.
router.get('/members/activation-status', adminApi.activationStatus);
router.post('/members/send-activations', verifyCsrfToken, adminApi.sendActivations);
router.post('/users/:id/resend-activation', verifyCsrfToken, param('id').isInt(), adminApi.resendActivation);

// The Activations page: who was invited, what bounced, whose link expired, and
// who got in. See src/services/activationTracking.service.js for why the states
// are derived rather than stored.
router.get('/activations', activationsApi.list);
router.get('/activations/:userId/history', param('userId').isInt({ min: 1 }), checkRouteInput, activationsApi.attemptHistory);
router.post('/activations/:id/resend', verifyCsrfToken, param('id').isInt(), activationsApi.resendOne);
router.post('/activations/resend-state', verifyCsrfToken, activationsApi.resendState);
router.get('/activations/mergo/usage', activationsApi.mergoUsage);
router.get('/activations/email-check', activationsApi.emailCheck);
router.post('/activations/email-check/cleanup', verifyCsrfToken, mergoCampaignLimiter, activationsApi.emailCleanup);
router.post(
  '/activations/mergo/prepare',
  verifyCsrfToken,
  mergoCampaignLimiter,
  body('userIds').isArray({ min: 1, max: 500 }).withMessage('Select between 1 and 500 members.'),
  body('userIds.*').isInt({ min: 1 }).withMessage('Invalid member id.'),
  checkRouteInput,
  activationsApi.prepareMergo
);
router.post('/activations/mergo/sync', verifyCsrfToken, mergoSyncLimiter, activationsApi.syncMergo);
router.put(
  '/activations/mergo/cap',
  verifyCsrfToken,
  mergoCampaignLimiter,
  body('cap').isInt({ min: 1, max: 10000 }).withMessage('Invalid activation cap.'),
  checkRouteInput,
  activationsApi.setMergoCap
);
router.post('/activations/attempts/:attemptId/retry', verifyCsrfToken, mergoCampaignLimiter, activationsApi.retryMergo);
// Reuses the member import's upload middleware — same file type, same size cap.
router.post('/activations/import-delivery', verifyCsrfToken, uploadDataWorkbook.single('workbook'), activationsApi.importDelivery);

router.put(
  '/users/:id/email',
  verifyCsrfToken,
  [
    param('id').isInt(),
    body('email').trim().isEmail().withMessage('A valid email is required').toLowerCase(),
    body('requireVerification').optional().isBoolean(),
  ],
  adminApi.changeUserEmail
);

router.get('/settings/logo', adminApi.getLogo);
router.post('/settings/logo', verifyCsrfToken, uploadLogo.single('logo'), verifyImageSignature, adminApi.uploadLogo);
// The other three site images, same gate and same signature check as the logo.
router.post('/settings/favicon', verifyCsrfToken, uploadLogo.single('image'), verifyImageSignature, adminApi.uploadFavicon);
router.post('/settings/hero-image', verifyCsrfToken, uploadEventImage.single('image'), verifyImageSignature, adminApi.uploadHeroImage);
router.post('/settings/og-image', verifyCsrfToken, uploadLogo.single('image'), verifyImageSignature, adminApi.uploadOgImage);
router.put(
  '/settings/gateway-surcharge-percent',
  verifyCsrfToken,
  body('percent').isFloat({ min: 0, max: 100 }).withMessage('Enter a valid percentage'),
  adminApi.updateGatewaySurchargePercent
);
// What the National President may open. Under /settings, which is in no
// module, so only the main admin ever reaches it (config/adminModules).
router.put(
  '/settings/president-access',
  verifyCsrfToken,
  body('modules').isArray({ max: 50 }).withMessage('modules must be a list'),
  adminApi.updatePresidentAccess
);
// One Finance & Logistics account's ticks. Under /settings too: main admin only.
router.put(
  '/settings/finance-logistics/:userId',
  verifyCsrfToken,
  param('userId').isInt({ min: 1 }),
  body('grants').isArray({ max: 20 }).withMessage('grants must be a list'),
  adminApi.updateFinanceLogisticsAccess
);
router.get('/settings/payments-enabled', adminApi.getPaymentsEnabled);
router.put(
  '/settings/payments-enabled',
  verifyCsrfToken,
  body('enabled').isBoolean().withMessage('enabled must be true or false'),
  adminApi.updatePaymentsEnabled
);
router.get('/settings/registration-emails', adminApi.getRegistrationEmailsEnabled);
router.put(
  '/settings/registration-emails',
  verifyCsrfToken,
  body('enabled').isBoolean().withMessage('enabled must be true or false'),
  adminApi.updateRegistrationEmailsEnabled
);
router.get('/settings/membership-payment-required', adminApi.getMembershipPaymentRequired);
router.put(
  '/settings/membership-payment-required',
  verifyCsrfToken,
  body('required').isBoolean().withMessage('required must be true or false'),
  adminApi.updateMembershipPaymentRequired
);
// Data export / import. MAIN_ADMIN only: the workbook carries every member's
// contact details and the whole payment ledger, and the import writes to the
// organization tree and member records.
router.get('/data/export', dataTransferApi.exportWorkbook);
// The blank sheet for adding members. Carries no data of its own, so unlike the
// export it is safe to hand to whoever is collecting the names.
router.get('/data/import-template', dataTransferApi.importTemplate);
router.post('/data/import/preview', verifyCsrfToken, uploadDataWorkbook.single('workbook'), dataTransferApi.previewImport);
router.post('/data/import', verifyCsrfToken, uploadDataWorkbook.single('workbook'), dataTransferApi.runImport);

// Master List: member types. Main admin only, inherited from router.use(apiAdmin)
// above. Validation is in memberType.service (name 1-60 chars, unique, at most 3).
router.get('/member-types', memberTypeApi.list);
router.post('/member-types', verifyCsrfToken, memberTypeApi.create);
router.put('/member-types/:id', verifyCsrfToken, param('id').isInt({ min: 1 }), checkRouteInput, memberTypeApi.update);
router.delete('/member-types/:id', verifyCsrfToken, param('id').isInt({ min: 1 }), checkRouteInput, memberTypeApi.remove);

// Master List: each event's own registration fee options. Main admin only,
// inherited from router.use(apiAdmin) above. Validation is in eventFee.service.
const eventFeeParams = [param('eventId').isInt({ min: 1 }), checkRouteInput];
const eventFeeOptionParams = [param('eventId').isInt({ min: 1 }), param('optionId').isInt({ min: 1 }), checkRouteInput];
router.get('/event-fees/:eventId/options', eventFeeParams, eventFeeApi.list);
router.post('/event-fees/:eventId/options', verifyCsrfToken, eventFeeParams, eventFeeApi.create);
router.put('/event-fees/:eventId/options/:optionId', verifyCsrfToken, eventFeeOptionParams, eventFeeApi.update);
router.delete('/event-fees/:eventId/options/:optionId', verifyCsrfToken, eventFeeOptionParams, eventFeeApi.remove);

// Master List: student organizations and their officers. Main admin only,
// inherited from router.use(apiAdmin) above.
router.get('/student-organizations', studentOrgApi.list);
router.post('/student-organizations', verifyCsrfToken, studentOrgApi.create);
router.put('/student-organizations/:id', verifyCsrfToken, param('id').isInt({ min: 1 }), checkRouteInput, studentOrgApi.update);
router.get('/student-organizations/:id/officers', param('id').isInt({ min: 1 }), checkRouteInput, studentOrgApi.listOfficers);
router.post('/student-organizations/:id/officers', verifyCsrfToken, param('id').isInt({ min: 1 }), checkRouteInput, studentOrgApi.addOfficer);
router.put('/student-organizations/:id/officers/:officerId', verifyCsrfToken, param('id').isInt({ min: 1 }), param('officerId').isInt({ min: 1 }), checkRouteInput, studentOrgApi.updateOfficer);
router.delete('/student-organizations/:id/officers/:officerId', verifyCsrfToken, param('id').isInt({ min: 1 }), param('officerId').isInt({ min: 1 }), checkRouteInput, studentOrgApi.removeOfficer);

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
// Email certificates to the event's registrants (queued, capped per press).
router.post(
  '/certificates/events/:eventId/send',
  verifyCsrfToken,
  certificateWorkLimiter,
  param('eventId').isInt(),
  certificateApi.sendEventCertificates
);
router.get(
  '/certificates/events/:eventId/export',
  certificateWorkLimiter,
  param('eventId').isInt(),
  certificateApi.exportEventCertificatesExcel
);
router.get('/jobs/:jobId', param('jobId').isInt(), jobApi.getJobStatus);
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

router.get('/emails/account-approved', adminEmailApi.getAccountApprovedTemplate);
router.put('/emails/account-approved', verifyCsrfToken, emailTemplateValidators, adminEmailApi.updateAccountApprovedTemplate);

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

router.get('/invitations/export', invitationApi.exportAllInvitationsExcel);
router.get('/invitations/import-contacts', invitationApi.fetchContactsToInvite);
router.get(
  '/invitations',
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Invalid page'),
  query('eventId').optional({ checkFalsy: true }).isInt().withMessage('Invalid eventId filter'),
  query('type').optional({ checkFalsy: true }).isIn(['Member', 'Guest']).withMessage('Invalid type filter'),
  query('source').optional({ checkFalsy: true }).isIn(['ADMIN_SENT', 'SELF_REQUESTED']).withMessage('Invalid source filter'),
  query('status').optional({ checkFalsy: true }).isIn(['PENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED']).withMessage('Invalid status filter'),
  invitationApi.listInvitationsReport
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

// Merchandise (phase 1): products, photos, variants and the stock ledger.
// Inherits router.use(apiAdmin) above: the main admin, a President given the
// Merchandise module, or a Finance & Logistics account with a task group.
// merchCan then checks the one capability each action needs
// (adminAccess.merchCapsFor). Validation is in merch.service.
const merchId = [param('id').isInt({ min: 1 }), checkRouteInput];
const merchVariant = [param('variantId').isInt({ min: 1 }), checkRouteInput];
router.get('/merch/products', merchCan('catalog.view'), merchApi.listProducts);
router.post('/merch/products', verifyCsrfToken, merchCan('catalog.edit'), merchApi.createProduct);
router.get('/merch/products/:id', merchCan('catalog.view'), merchId, merchApi.getProduct);
router.put('/merch/products/:id', verifyCsrfToken, merchCan('catalog.edit'), merchId, merchApi.updateProduct);
router.delete('/merch/products/:id', verifyCsrfToken, merchCan('catalog.edit'), merchId, merchApi.deleteProduct);
router.post('/merch/products/:id/photos', verifyCsrfToken, merchCan('catalog.edit'), merchId,
  uploadMerchPhotos.fields([{ name: 'photos', maxCount: 6 }]), verifyImageSignature.verifyImageSignatures, merchApi.addPhotos);
router.delete('/merch/products/:id/photos/:imageId', verifyCsrfToken, merchCan('catalog.edit'), param('id').isInt({ min: 1 }), param('imageId').isInt({ min: 1 }), checkRouteInput, merchApi.removePhoto);
router.post('/merch/products/:id/variants', verifyCsrfToken, merchCan('catalog.edit'), merchId, merchApi.addVariant);
router.put('/merch/products/:id/variants/:variantId', verifyCsrfToken, merchCan('catalog.edit'), param('id').isInt({ min: 1 }), merchVariant, merchApi.updateVariant);
router.delete('/merch/products/:id/variants/:variantId', verifyCsrfToken, merchCan('catalog.edit'), param('id').isInt({ min: 1 }), merchVariant, merchApi.deleteVariant);
router.get('/merch/variants/:variantId/movements', merchCan('stock.view'), merchVariant, merchApi.movements);
router.get('/merch/variants/:variantId/price-history', merchCan('catalog.view'), merchVariant, merchApi.priceHistory);
router.post('/merch/variants/:variantId/stock', verifyCsrfToken, merchCan('stock.edit'), merchVariant, merchApi.recordStock);
// Open or close the Store to members (off until launch).
router.put('/merch/store-open', verifyCsrfToken, merchCan('catalog.edit'), body('open').isBoolean(), checkRouteInput, merchApi.setStoreOpen);
// Orders and fulfilment (phase 3a).
const orderNumberParam = [param('orderNumber').matches(/^ORD-\d{4}-\d{6,}$/), checkRouteInput];
router.post('/merch/orders/bulk', verifyCsrfToken, merchCan('orders.fulfil'), merchOrdersApi.bulk);
router.post('/merch/orders/:orderNumber/steps/:action', verifyCsrfToken, merchCan('orders.fulfil'), orderNumberParam, param('action').isIn(['pack', 'ship', 'deliver', 'ready', 'pickedUp', 'unclaimed', 'reopen', 'holdAddress', 'resume']), checkRouteInput, merchOrdersApi.step);
router.post('/merch/handover/lookup', verifyCsrfToken, merchCan('orders.fulfil'), merchOrdersApi.handoverLookup);
router.post('/merch/handover', verifyCsrfToken, merchCan('orders.fulfil'), merchOrdersApi.handover);
router.put('/merch/zones/:id', verifyCsrfToken, merchCan('settings.edit'), param('id').isInt({ min: 1 }), checkRouteInput, merchOrdersApi.updateZone);
router.put('/merch/zone-regions', verifyCsrfToken, merchCan('settings.edit'), merchOrdersApi.setRegionZone);
router.post('/merch/pickup-points', verifyCsrfToken, merchCan('settings.edit'), merchOrdersApi.addPickupPoint);
router.put('/merch/pickup-points/:id', verifyCsrfToken, merchCan('settings.edit'), param('id').isInt({ min: 1 }), checkRouteInput, merchOrdersApi.updatePickupPoint);
router.post('/merch/psgc/import', verifyCsrfToken, merchCan('settings.edit'), uploadDataWorkbook.single('workbook'), merchOrdersApi.importPsgc);
// Refunds and exchanges (phase 3b).
router.post('/merch/orders/:orderNumber/returns', verifyCsrfToken, merchCan('returns.goods', 'refund.approve'), orderNumberParam, merchReturnsApi.raise);
router.post('/merch/returns/:returnNumber/:action', verifyCsrfToken, merchCan('returns.goods', 'refund.approve', 'refund.second'), param('returnNumber').matches(/^RET-\d{4}-\d{6,}$/), param('action').isIn(['check', 'approve', 'reject', 'accept', 'receive', 'send']), checkRouteInput, merchReturnsApi.step);
router.put('/merch/return-settings', verifyCsrfToken, merchCan('policy.edit'), merchReturnsApi.saveSettings);
// The daily reconciliation (phase 4): check a day against PayMongo, or explain its gaps.
const dayParam = [param('day').matches(/^\d{4}-\d{2}-\d{2}$/), checkRouteInput];
router.post('/merch/reconciliation/:day/check', verifyCsrfToken, merchCan('reconcile.edit'), dayParam, merchFinanceApi.checkDay);
router.put('/merch/reconciliation/:day/note', verifyCsrfToken, merchCan('reconcile.edit'), dayParam, merchFinanceApi.explainDay);
// The soft launch (phase 5): Store mode, testers, the stock count, reported problems.
router.put('/merch/store-mode', verifyCsrfToken, merchCan('catalog.edit'), merchLaunchApi.setMode);
router.post('/merch/testers', verifyCsrfToken, merchCan('catalog.edit'), merchLaunchApi.addTester);
router.delete('/merch/testers/:userId', verifyCsrfToken, merchCan('catalog.edit'), param('userId').isInt({ min: 1 }), checkRouteInput, merchLaunchApi.removeTester);
router.post('/merch/count', verifyCsrfToken, merchCan('stock.edit'), merchLaunchApi.saveCount);
router.put('/merch/feedback/:id', verifyCsrfToken, merchCan('orders.view'), param('id').isInt({ min: 1 }), checkRouteInput, merchLaunchApi.setFeedback);

module.exports = router;
