const path = require('path');
const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const emailTemplateService = require('../../services/emailTemplate.service');
const storageService = require('../../services/storage.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// --- Member-approved template (main admin only) ---

const getMemberApprovedTemplate = asyncHandler(async (req, res) => {
  const template = await emailTemplateService.getMemberApprovedTemplate();
  return success(res, { template });
});

const updateMemberApprovedTemplate = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const template = await emailTemplateService.upsertMemberApprovedTemplate(req.body);
  return success(res, { template }, 'Member-approved email updated');
});

const uploadMemberApprovedAttachment = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No image uploaded', 400);
  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'email-attachments',
    prefix: 'emailattach',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const template = await emailTemplateService.setMemberApprovedAttachment(publicPath);
  return success(res, { template }, 'Attachment updated');
});

// --- Event registration template (main admin only) ---

const getEventTemplate = asyncHandler(async (req, res) => {
  const template = await emailTemplateService.getEventTemplate(req.params.eventId);
  return success(res, { template });
});

const updateEventTemplate = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const template = await emailTemplateService.upsertEventTemplate(req.params.eventId, req.body);
  return success(res, { template }, 'Event email updated');
});

const uploadEventAttachment = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No image uploaded', 400);
  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'email-attachments',
    prefix: 'emailattach',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const template = await emailTemplateService.setEventTemplateAttachment(req.params.eventId, publicPath);
  return success(res, { template }, 'Attachment updated');
});

// --- Event invitation template (main admin only) ---

const getEventInvitationTemplate = asyncHandler(async (req, res) => {
  const template = await emailTemplateService.getEventInvitationTemplate(req.params.eventId);
  return success(res, { template });
});

const updateEventInvitationTemplate = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const template = await emailTemplateService.upsertEventInvitationTemplate(req.params.eventId, req.body);
  return success(res, { template }, 'Invitation email updated');
});

module.exports = {
  getMemberApprovedTemplate,
  updateMemberApprovedTemplate,
  uploadMemberApprovedAttachment,
  getEventTemplate,
  updateEventTemplate,
  uploadEventAttachment,
  getEventInvitationTemplate,
  updateEventInvitationTemplate,
};
