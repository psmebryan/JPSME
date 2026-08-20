const fs = require('fs').promises;
const path = require('path');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PUBLIC_UPLOADS_ROOT = path.join(PROJECT_ROOT, 'public', 'uploads');

const DEFAULT_MEMBER_APPROVED_SUBJECT = 'Welcome to JPSME, {{firstName}}!';
const DEFAULT_MEMBER_APPROVED_BODY =
  'Hi {{firstName}},\n\nYour JPSME membership has been approved. Welcome to {{chapterName}} Chapter!\n\nYou can now log in and access your member profile.\n\n- JPSME National';

const DEFAULT_EVENT_SUBJECT = "You're registered for {{eventTitle}}!";
const DEFAULT_EVENT_BODY =
  'Hi {{firstName}},\n\nYou are registered for {{eventTitle}} on {{eventDate}}.\n\nLocation: {{eventLocation}}\n{{zoomLink}}\n\nSee you there!\n\n- JPSME National';

async function safeUnlink(absPath) {
  if (!absPath) return;
  try {
    await fs.unlink(absPath);
  } catch (err) {
    // File may already be gone — deletion is best-effort.
  }
}

function attachmentToAbsolutePath(publicPath) {
  const relative = publicPath.replace(/^\//, '').replace(/^uploads\//, '');
  return path.join(PUBLIC_UPLOADS_ROOT, relative);
}

// --- Member-approved template (single global row) ---

async function getMemberApprovedTemplate() {
  let template = await prisma.emailTemplate.findFirst({ where: { purpose: 'MEMBER_APPROVED' } });
  if (!template) {
    template = await prisma.emailTemplate.create({
      data: { purpose: 'MEMBER_APPROVED', subject: DEFAULT_MEMBER_APPROVED_SUBJECT, bodyHtml: DEFAULT_MEMBER_APPROVED_BODY },
    });
  }
  return template;
}

async function upsertMemberApprovedTemplate({ subject, bodyHtml }) {
  const template = await getMemberApprovedTemplate();
  return prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      subject: subject !== undefined ? subject : template.subject,
      bodyHtml: bodyHtml !== undefined ? bodyHtml : template.bodyHtml,
    },
  });
}

async function setMemberApprovedAttachment(publicPath) {
  const template = await getMemberApprovedTemplate();
  if (template.attachmentImage) await safeUnlink(attachmentToAbsolutePath(template.attachmentImage));
  return prisma.emailTemplate.update({ where: { id: template.id }, data: { attachmentImage: publicPath } });
}

// --- Event registration template (one row per event) ---

async function getEventTemplate(eventId) {
  let template = await prisma.emailTemplate.findUnique({ where: { eventId: Number(eventId) } });
  if (!template) {
    const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
    if (!event) throw new AppError('Event not found', 404);
    template = await prisma.emailTemplate.create({
      data: { purpose: 'EVENT_REGISTRATION', eventId: Number(eventId), subject: DEFAULT_EVENT_SUBJECT, bodyHtml: DEFAULT_EVENT_BODY },
    });
  }
  return template;
}

async function upsertEventTemplate(eventId, { subject, bodyHtml }) {
  const template = await getEventTemplate(eventId);
  return prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      subject: subject !== undefined ? subject : template.subject,
      bodyHtml: bodyHtml !== undefined ? bodyHtml : template.bodyHtml,
    },
  });
}

async function setEventTemplateAttachment(eventId, publicPath) {
  const template = await getEventTemplate(eventId);
  if (template.attachmentImage) await safeUnlink(attachmentToAbsolutePath(template.attachmentImage));
  return prisma.emailTemplate.update({ where: { id: template.id }, data: { attachmentImage: publicPath } });
}

// Called from event.service.js's deleteEvent so removing an event doesn't
// orphan its email template's uploaded attachment (the EmailTemplate row
// itself cascades automatically via onDelete: Cascade).
async function deleteEventTemplateAssets(eventId) {
  const template = await prisma.emailTemplate.findUnique({ where: { eventId: Number(eventId) } });
  if (template && template.attachmentImage) {
    await safeUnlink(attachmentToAbsolutePath(template.attachmentImage));
  }
}

module.exports = {
  getMemberApprovedTemplate,
  upsertMemberApprovedTemplate,
  setMemberApprovedAttachment,
  getEventTemplate,
  upsertEventTemplate,
  setEventTemplateAttachment,
  deleteEventTemplateAssets,
};
