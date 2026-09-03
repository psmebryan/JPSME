const path = require('path');
const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const certificateService = require('../../services/certificate.service');
const jobService = require('../../services/job.service');
const storageService = require('../../services/storage.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

function sendPdfBuffer(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}

// Replaces res.download(absPath, filename) — that API only ever works with a
// real local filesystem path, which storageService deliberately doesn't
// hand out to callers (an S3-backed driver has no such path). Streaming
// through storageService.readStream instead keeps this endpoint driver-
// agnostic; the promise wrapper lets asyncHandler forward a stream error
// (e.g. the underlying file is missing) the same way it forwards any other
// rejected promise, mirroring what res.download's error callback used to do.
function streamDownload(res, key, filename, contentType = 'application/pdf') {
  return new Promise((resolve, reject) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = storageService.readStream(key);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

// --- Membership template (main admin only) ---

const getMembershipTemplate = asyncHandler(async (req, res) => {
  const template = await certificateService.getMembershipTemplate();
  return success(res, { template });
});

const updateMembershipTemplate = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const template = await certificateService.upsertMembershipTemplate(req.body);
  return success(res, { template }, 'Membership certificate template updated');
});

const uploadMembershipBackground = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No background image uploaded', 400);
  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'certificates/backgrounds',
    prefix: 'certbg',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const template = await certificateService.setMembershipTemplateBackground(publicPath);
  return success(res, { template }, 'Background image updated');
});

const previewMembershipTemplate = asyncHandler(async (req, res) => {
  const template = await certificateService.getMembershipTemplate();
  const buffer = await certificateService.renderPreviewCertificate(template);
  sendPdfBuffer(res, buffer, 'membership-certificate-preview.pdf');
});

// --- Event template (main admin only) ---

const getEventTemplate = asyncHandler(async (req, res) => {
  const template = await certificateService.getEventTemplate(req.params.eventId);
  return success(res, { template });
});

const updateEventTemplate = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const template = await certificateService.upsertEventTemplate(req.params.eventId, req.body);
  return success(res, { template }, 'Event certificate template updated');
});

const uploadEventBackground = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No background image uploaded', 400);
  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'certificates/backgrounds',
    prefix: 'certbg',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const template = await certificateService.setEventTemplateBackground(req.params.eventId, publicPath);
  return success(res, { template }, 'Background image updated');
});

const previewEventTemplate = asyncHandler(async (req, res) => {
  const template = await certificateService.getEventTemplate(req.params.eventId);
  const buffer = await certificateService.renderPreviewCertificate(template);
  sendPdfBuffer(res, buffer, 'event-certificate-preview.pdf');
});

// --- Event certificate generation/listing/export (main admin only) ---

const listEventRegistrantCertificates = asyncHandler(async (req, res) => {
  const filter = ['generated', 'not_generated'].includes(req.query.filter) ? req.query.filter : 'all';
  const registrants = await certificateService.listEventCertificateStatus(req.params.eventId, filter);
  return success(res, { registrants });
});

// Enqueues instead of generating inline — PDF rendering is CPU-bound, and an
// event with a large "generate all pending" batch could otherwise hold the
// admin's request open for a long time. The caller (admin.js) polls
// GET /api/admin/jobs/:jobId for the result instead of waiting on this
// response.
const bulkGenerateEventCertificates = asyncHandler(async (req, res) => {
  const { userIds, force } = req.body;
  const job = await jobService.enqueue('GENERATE_EVENT_CERTIFICATES', {
    eventId: Number(req.params.eventId),
    userIds,
    force: Boolean(force),
    adminUserId: req.session.user.id,
  });
  return success(res, { jobId: job.id }, 'Certificate generation started', 202);
});

const exportEventCertificatesExcel = asyncHandler(async (req, res) => {
  const buffer = await certificateService.exportEventCertificatesExcel(req.params.eventId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="event-${req.params.eventId}-certificates.xlsx"`);
  res.send(buffer);
});

const downloadEventCertificateAsAdmin = asyncHandler(async (req, res) => {
  // Main admin can always fetch the file regardless of release status.
  const { key, filename } = await certificateService.getEventCertificateDownload(req.params.eventId, req.params.userId);
  await streamDownload(res, key, filename);
});

const setEventCertificateReleased = asyncHandler(async (req, res) => {
  const record = await certificateService.setEventCertificateReleased(
    req.params.eventId,
    req.params.userId,
    Boolean(req.body.released),
    req.session.user.id
  );
  return success(res, { certificate: record }, record.released ? 'Certificate released for download' : 'Certificate download revoked');
});

// --- Self-service downloads (any authenticated user) ---

const downloadMembershipCertificate = asyncHandler(async (req, res) => {
  const buffer = await certificateService.renderMembershipCertificateForUser(req.session.user.id);
  sendPdfBuffer(res, buffer, 'jpsme-membership-certificate.pdf');
});

const downloadMyEventCertificate = asyncHandler(async (req, res) => {
  const { key, filename } = await certificateService.getEventCertificateDownload(
    req.params.eventId,
    req.session.user.id,
    { requireReleased: true }
  );
  await streamDownload(res, key, filename);
});

module.exports = {
  getMembershipTemplate,
  updateMembershipTemplate,
  uploadMembershipBackground,
  previewMembershipTemplate,
  getEventTemplate,
  updateEventTemplate,
  uploadEventBackground,
  previewEventTemplate,
  listEventRegistrantCertificates,
  bulkGenerateEventCertificates,
  exportEventCertificatesExcel,
  downloadEventCertificateAsAdmin,
  setEventCertificateReleased,
  downloadMembershipCertificate,
  downloadMyEventCertificate,
};
