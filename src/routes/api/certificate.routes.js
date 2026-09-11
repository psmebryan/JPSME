const { Router } = require('express');
const { param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const certificateApi = require('../../controllers/api/certificate.api');
const { apiAuth } = require('../../middleware/auth.middleware');
const { requireActiveMembership } = require('../../middleware/membership.middleware');

const router = Router();

// PDF rendering is CPU-bound, so certificate downloads get a tighter cap than
// the baseline API limiter to keep one user from hammering the server with them.
const certificateDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many certificate downloads. Please try again later.' },
});

// Members only, and the gate is on the route rather than buried in the
// handler so that "who may have this" is answerable by reading the routing
// table. certificate.service enforces it a second time: this file is where a
// new handler would most easily be added without the check.
//
// The event certificate below is deliberately NOT behind it — attending an
// event is not membership, and a non-member who sat through a seminar earned
// that certificate.
router.get(
  '/membership/download',
  apiAuth,
  requireActiveMembership,
  certificateDownloadLimiter,
  certificateApi.downloadMembershipCertificate
);
router.get(
  '/events/:eventId/download',
  apiAuth,
  certificateDownloadLimiter,
  param('eventId').isInt(),
  certificateApi.downloadMyEventCertificate
);

module.exports = router;
