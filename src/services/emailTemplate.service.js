const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');

const DEFAULT_MEMBER_APPROVED_SUBJECT = 'Welcome to JPSME, {{firstName}}!';
const DEFAULT_MEMBER_APPROVED_BODY =
  'Hi {{firstName}},\n\nYour JPSME membership has been approved. Welcome to {{chapterName}} Chapter!\n\nYou can now log in and access your member profile.\n\n- JPSME National';

// Deliberately says nothing about membership. This one goes to somebody whose
// account an admin has accepted, which is true whether or not they have ever
// paid a peso — telling a non-member they are "now a member of JPSME" is the
// exact confusion this template exists to end.
const DEFAULT_ACCOUNT_APPROVED_SUBJECT = 'Your JPSME account is ready, {{firstName}}';
const DEFAULT_ACCOUNT_APPROVED_BODY = [
  'Hi {{firstName}},',
  '',
  'Your JPSME account has been approved. You can now log in, update your profile and register for events.',
  '',
  'To become a full JPSME member — and receive your Certificate of Membership — complete your membership payment from your profile page.',
  '',
  '- JPSME National',
].join('\n');

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

// --- Account-approved template (single global row) ---
//
// No attachment upload, unlike the membership email above. That one carries a
// membership card or certificate image; this one is telling somebody their
// login works, and there is nothing to attach to that.

async function getAccountApprovedTemplate() {
  let template = await prisma.emailTemplate.findFirst({ where: { purpose: 'ACCOUNT_APPROVED' } });
  if (!template) {
    template = await prisma.emailTemplate.create({
      data: { purpose: 'ACCOUNT_APPROVED', subject: DEFAULT_ACCOUNT_APPROVED_SUBJECT, bodyHtml: DEFAULT_ACCOUNT_APPROVED_BODY },
    });
  }
  return template;
}

async function upsertAccountApprovedTemplate({ subject, bodyHtml }) {
  const template = await getAccountApprovedTemplate();
  return prisma.emailTemplate.update({
    where: { id: template.id },
    data: {
      subject: subject !== undefined ? subject : template.subject,
      bodyHtml: bodyHtml !== undefined ? bodyHtml : template.bodyHtml,
    },
  });
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
  getAccountApprovedTemplate,
  upsertAccountApprovedTemplate,
  upsertMemberApprovedTemplate,
  setMemberApprovedAttachment,
  getEventTemplate,
  upsertEventTemplate,
  setEventTemplateAttachment,
  getEventInvitationTemplate,
  upsertEventInvitationTemplate,
  deleteEventTemplateAssets,
};
