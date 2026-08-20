const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const certificateService = require('../../services/certificate.service');

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
  const publicPath = `/uploads/certificates/backgrounds/${req.file.filename}`;
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
  const publicPath = `/uploads/certificates/backgrounds/${req.file.filename}`;
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

const bulkGenerateEventCertificates = asyncHandler(async (req, res) => {
  const { userIds, force } = req.body;
  const result = await certificateService.generateEventCertificatesBulk({
    eventId: req.params.eventId,
    userIds,
    force: Boolean(force),
    adminUserId: req.session.user.id,
  });
  const message = `${result.generated.length} certificate(s) generated, ${result.skipped.length} skipped (already generated)`;
  return success(res, {
    generatedCount: result.generated.length,
    skippedCount: result.skipped.length,
    skipped: result.skipped,
  }, message);
});

const exportEventCertificatesExcel = asyncHandler(async (req, res) => {
  const buffer = await certificateService.exportEventCertificatesExcel(req.params.eventId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="event-${req.params.eventId}-certificates.xlsx"`);
  res.send(buffer);
});

const downloadEventCertificateAsAdmin = asyncHandler(async (req, res) => {
  // Main admin can always fetch the file regardless of release status.
  const { absPath, filename } = await certificateService.getEventCertificateDownload(req.params.eventId, req.params.userId);
  res.download(absPath, filename);
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
  const { absPath, filename } = await certificateService.getEventCertificateDownload(
    req.params.eventId,
    req.session.user.id,
    { requireReleased: true }
  );
  res.download(absPath, filename);
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
