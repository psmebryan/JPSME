const { Router } = require('express');
const { param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const certificateApi = require('../../controllers/api/certificate.api');
const { apiAuth } = require('../../middleware/auth.middleware');

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

router.get('/membership/download', apiAuth, certificateDownloadLimiter, certificateApi.downloadMembershipCertificate);
router.get(
  '/events/:eventId/download',
  apiAuth,
  certificateDownloadLimiter,
  param('eventId').isInt(),
  certificateApi.downloadMyEventCertificate
);

module.exports = router;
