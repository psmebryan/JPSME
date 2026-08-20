const path = require('path');
const { transporter, MAIL_FROM } = require('../config/mailer');
const emailTemplateService = require('./emailTemplate.service');
const { substituteTokens, formatDate, fullName } = require('../utils/templateTokens');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PUBLIC_UPLOADS_ROOT = path.join(PROJECT_ROOT, 'public', 'uploads');

function getAppUrl() {
  return process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
}

function attachmentToAbsolutePath(publicPath) {
  const relative = publicPath.replace(/^\//, '').replace(/^uploads\//, '');
  return path.join(PUBLIC_UPLOADS_ROOT, relative);
}

// Templates are authored as plain text with {{token}} placeholders (same
// convention as certificate templates) — line breaks become <br> for the HTML part.
function textToHtml(text) {
  return String(text || '').replace(/\n/g, '<br>');
}

// Best-effort, same as sendMemberApprovedEmail/sendEventRegistrationEmail
// below: a mail-provider failure here must never fail registration itself —
// the user account and verification token are already committed by the time
// this runs, and the "Resend verification email" flow is the existing
// designed escape hatch if the first attempt didn't arrive. Previously this
// had no try/catch, so a provider error (e.g. a misconfigured API key)
// surfaced as a raw registration failure even though the account had already
// been created — found via a real failed send during Brevo setup.
async function sendVerificationEmail(user, rawToken) {
  const verifyUrl = `${getAppUrl()}/verify-email?token=${rawToken}`;

  try {
    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: 'Verify your JPSME account',
      text: `Hi ${user.firstName},\n\nPlease verify your email by visiting:\n${verifyUrl}\n\nThis link expires in 24 hours.`,
      html: `
        <p>Hi ${user.firstName},</p>
        <p>Thanks for registering with JPSME. Please confirm your email address:</p>
        <p><a href="${verifyUrl}">${verifyUrl}</a></p>
        <p>This link expires in 24 hours.</p>
      `,
    });
  } catch (err) {
    console.error('Failed to send verification email to', user.email, ':', err.message);
  }
}

// Fires when an admin approves a pending applicant. Best-effort: a mail
// failure here must never undo or fail the approval action itself.
async function sendMemberApprovedEmail(user) {
  try {
    const template = await emailTemplateService.getMemberApprovedTemplate();
    const fields = {
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: fullName(user),
      email: user.email,
      chapterName: user.chapter ? user.chapter.name : 'JPSME National',
    };

    const attachments = [];
    if (template.attachmentImage) {
      attachments.push({ filename: path.basename(template.attachmentImage), path: attachmentToAbsolutePath(template.attachmentImage) });
    }

    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: substituteTokens(template.subject, fields),
      html: textToHtml(substituteTokens(template.bodyHtml, fields)),
      attachments,
    });
  } catch (err) {
    console.error('Failed to send member-approved email to', user.email, ':', err.message);
  }
}

// Fires when a user successfully registers (or re-registers) for an event.
// Uses that event's own customizable template. Best-effort, same as above.
async function sendEventRegistrationEmail(user, event) {
  try {
    const template = await emailTemplateService.getEventTemplate(event.id);
    const fields = {
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: fullName(user),
      eventTitle: event.title,
      eventDate: formatDate(event.startDate),
      eventLocation: event.location || '',
      zoomLink: (event.modality === 'ONLINE' && event.zoomLink) ? event.zoomLink : '',
    };

    const attachments = [];
    const attachmentSource = template.attachmentImage || event.imageUrl;
    if (attachmentSource) {
      attachments.push({ filename: path.basename(attachmentSource), path: attachmentToAbsolutePath(attachmentSource) });
    }

    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: substituteTokens(template.subject, fields),
      html: textToHtml(substituteTokens(template.bodyHtml, fields)),
      attachments,
    });
  } catch (err) {
    console.error('Failed to send event-registration email to', user.email, ':', err.message);
  }
}

module.exports = { sendVerificationEmail, sendMemberApprovedEmail, sendEventRegistrationEmail };
