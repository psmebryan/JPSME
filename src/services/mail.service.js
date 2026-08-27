const path = require('path');
const config = require('../config');
const { transporter, MAIL_FROM } = require('../config/mailer');
const emailTemplateService = require('./emailTemplate.service');
const storageService = require('./storage.service');
const { substituteTokens, formatDate, fullName } = require('../utils/templateTokens');

function getAppUrl() {
  return config.appUrl;
}

// nodemailer's attachments contract (both the Brevo shim and the real SMTP
// transport in config/mailer.js) needs a real local path — one of the few
// remaining spots that can't go through storageService's normal
// read/readStream, see its getAbsolutePath doc comment.
function attachmentToAbsolutePath(publicPath) {
  return storageService.getAbsolutePath(publicPath);
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

// Unlike every other function in this file, this one does NOT catch its own
// errors — the caller (invitation.service.js) needs to know whether the send
// actually succeeded so it can persist SENT vs FAILED onto the
// EventInvitation row; swallowing the error here would silently leave every
// failed send looking identical to a successful one.
async function sendEventInvitationEmail(invitation, event) {
  const inviteUrl = `${getAppUrl()}/events/${event.id}/invite/${invitation.token}`;
  const template = await emailTemplateService.getEventInvitationTemplate(event.id);
  const fields = {
    fullName: invitation.fullName,
    eventTitle: event.title,
    eventDate: formatDate(event.startDate),
    eventLocation: event.location || '',
    chapter: invitation.chapter || '',
    school: invitation.school || '',
    company: invitation.company || '',
    inviteUrl,
    // One-click "I'll be there, no account needed" link — only meaningful
    // for a guest invite (recordRsvp rejects it for a member invitation and
    // that click just falls back to the normal registration page instead).
    attendUrl: `${inviteUrl}/rsvp/attending`,
  };

  return transporter.sendMail({
    from: MAIL_FROM,
    to: invitation.email,
    subject: substituteTokens(template.subject, fields),
    html: textToHtml(substituteTokens(template.bodyHtml, fields)),
    // Brevo echoes this back on every delivery-event webhook for this
    // message — the invitation's own ID, so the webhook handler can match
    // the event to this exact row without guessing from the email address
    // alone (which could theoretically be reused across invitations).
    tags: [`invitation-${invitation.id}`],
  });
}

module.exports = { sendVerificationEmail, sendMemberApprovedEmail, sendEventRegistrationEmail, sendEventInvitationEmail };
