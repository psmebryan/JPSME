const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');

const DEFAULT_MEMBER_APPROVED_SUBJECT = 'Welcome to JPSME, {{firstName}}!';
const DEFAULT_MEMBER_APPROVED_BODY =
  'Hi {{firstName}},\n\nYour JPSME membership has been approved. Welcome to {{chapterName}} Chapter!\n\nYou can now log in and access your member profile.\n\n- JPSME National';

const DEFAULT_EVENT_SUBJECT = "You're registered for {{eventTitle}}!";
const DEFAULT_EVENT_BODY =
  'Hi {{firstName}},\n\nYou are registered for {{eventTitle}} on {{eventDate}}.\n\nLocation: {{eventLocation}}\n{{zoomLink}}\n\nSee you there!\n\n- JPSME National';

const DEFAULT_INVITATION_SUBJECT = "You're invited: {{eventTitle}}";
const DEFAULT_INVITATION_BODY =
  'Hi {{fullName}},\n\nYou\'re invited to {{eventTitle}} on {{eventDate}}.\n\n'
  + 'Just want to attend? Click here — no account needed:\n{{attendUrl}}\n\n'
  + 'Want to register as a JPSME member instead?\n{{inviteUrl}}\n\n- JPSME National';

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
  if (template.attachmentImage) await storageService.remove(template.attachmentImage);
  return prisma.emailTemplate.update({ where: { id: template.id }, data: { attachmentImage: publicPath } });
}

// --- Event templates (one row per event PER PURPOSE — eventId alone is no
// longer unique now that an event can hold both an EVENT_REGISTRATION and an
// EVENT_INVITATION template; the compound eventId_purpose key is) ---

async function getEventTemplateByPurpose(eventId, purpose, defaults) {
  let template = await prisma.emailTemplate.findUnique({
    where: { eventId_purpose: { eventId: Number(eventId), purpose } },
  });
  if (!template) {
    const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
    if (!event) throw new AppError('Event not found', 404);
    template = await prisma.emailTemplate.create({
      data: { purpose, eventId: Number(eventId), subject: defaults.subject, bodyHtml: defaults.bodyHtml },
    });
  }
  return template;
}

async function getEventTemplate(eventId) {
  return getEventTemplateByPurpose(eventId, 'EVENT_REGISTRATION', { subject: DEFAULT_EVENT_SUBJECT, bodyHtml: DEFAULT_EVENT_BODY });
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
  if (template.attachmentImage) await storageService.remove(template.attachmentImage);
  return prisma.emailTemplate.update({ where: { id: template.id }, data: { attachmentImage: publicPath } });
}

// --- Event invitation template (the emailed "you're invited" message, sent
// both when an admin invites someone and when someone self-requests an
// invite — see invitation.service.js). No attachment support (not requested,
// and the invite link itself is the whole point of this email).

async function getEventInvitationTemplate(eventId) {
  return getEventTemplateByPurpose(eventId, 'EVENT_INVITATION', { subject: DEFAULT_INVITATION_SUBJECT, bodyHtml: DEFAULT_INVITATION_BODY });
}

async function upsertEventInvitationTemplate(eventId, { subject, bodyHtml }) {
  const template = await getEventInvitationTemplate(eventId);
  return prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      subject: subject !== undefined ? subject : template.subject,
      bodyHtml: bodyHtml !== undefined ? bodyHtml : template.bodyHtml,
    },
  });
}

// Called from event.service.js's deleteEvent so removing an event doesn't
// orphan any of its templates' uploaded attachments (the EmailTemplate rows
// themselves cascade automatically via onDelete: Cascade). findMany, not
// findUnique — an event can now hold more than one template row.
async function deleteEventTemplateAssets(eventId) {
  const templates = await prisma.emailTemplate.findMany({ where: { eventId: Number(eventId) } });
  await Promise.all(templates.filter((t) => t.attachmentImage).map((t) => storageService.remove(t.attachmentImage)));
}

module.exports = {
  getMemberApprovedTemplate,
  upsertMemberApprovedTemplate,
  setMemberApprovedAttachment,
  getEventTemplate,
  upsertEventTemplate,
  setEventTemplateAttachment,
  getEventInvitationTemplate,
  upsertEventInvitationTemplate,
  deleteEventTemplateAssets,
};
