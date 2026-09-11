const path = require('path');
const config = require('../config');
const { transporter, MAIL_FROM } = require('../config/mailer');
const emailTemplateService = require('./emailTemplate.service');
const ticketService = require('./ticket.service');
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
// Carries a code to type, not a link to click. A link has to embed this
// deployment's own URL, so an email is only as good as that URL being right at
// the moment it was sent — and by the time anyone notices it was wrong, the
// mail is already in somebody's inbox and permanently useless. A code has no
// such dependency: it works from any device, survives moving domain, and can
// be read out loud to someone who cannot get the mail open.
//
// The code is still shown in the subject line as well, because most mail
// clients preview it there — which spares the reader opening the message at
// all on a phone.
async function sendVerificationEmail(user, code) {
  const url = `${getAppUrl()}/verify-email`;

  try {
    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: `${code} is your JPSME verification code`,
      text: `Hi ${user.firstName},\n\n`
        + `Your JPSME verification code is: ${code}\n\n`
        + `Enter it on the verification page to confirm your email address.\n`
        + `The code expires in 30 minutes and can be entered five times.\n\n`
        + `If you did not create a JPSME account, you can ignore this email.`,
      html: `
        <p>Hi ${user.firstName},</p>
        <p>Thanks for registering with JPSME. Your verification code is:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:8px;font-family:monospace;margin:24px 0;">${code}</p>
        <p>Enter it on the <a href="${url}">verification page</a> to confirm your email address.</p>
        <p style="color:#666;font-size:13px;">The code expires in 30 minutes and can be entered five times.<br>
        If you did not create a JPSME account, you can ignore this email.</p>
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
      // Alias kept alongside the current name so approval templates written
      // before the organization migration keep substituting. Unlike the
      // certificate path this never threw — user.chapter was simply undefined,
      // so every approval email silently said "JPSME National" regardless of
      // the member's actual organization.
      organizationName: user.organization ? user.organization.name : 'JPSME National',
      chapterName: user.organization ? user.organization.name : 'JPSME National',
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

// Sent when an admin approves the account itself. Distinct from the one above,
// which is sent when a membership payment confirms and is the only message
// allowed to say somebody is a member.
//
// No attachment: sendMemberApprovedEmail carries whatever membership artwork
// has been uploaded, and attaching it here would hand a membership card to
// somebody who has not bought one. Best-effort, like every other send here.
async function sendAccountApprovedEmail(user) {
  try {
    const template = await emailTemplateService.getAccountApprovedTemplate();
    const fields = {
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: fullName(user),
      email: user.email,
      organizationName: user.organization ? user.organization.name : 'JPSME National',
      chapterName: user.organization ? user.organization.name : 'JPSME National',
    };

    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: substituteTokens(template.subject, fields),
      html: textToHtml(substituteTokens(template.bodyHtml, fields)),
    });
  } catch (err) {
    console.error('Failed to send account-approved email to', user.email, ':', err.message);
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

    // The e-ticket, when there is one to attach. buildTicketAttachment returns
    // null rather than throwing for every reason a ticket might not exist yet —
    // an unpaid registration, a cancelled one, a row the backfill has not
    // reached — because a missing ticket must never be the reason a member is
    // not told their registration went through. The email still sends, and the
    // ticket remains available on their profile.
    //
    // This is also why the send is downstream of the mint on both paths: the
    // free-event path enqueues this job only after the transaction that mints
    // commits, and the paid path sends only after applyPaymentPaid's
    // transaction commits. A ticket promised in an email that does not exist
    // yet would be worse than one attached a moment later.
    const ticket = await ticketService.buildTicketAttachment(user.id, event.id);
    if (ticket) attachments.push(ticket);

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
    // {{organization}} is the name to use; {{chapter}} is the same value under
    // the column's original name, and {{school}} resolves to whatever a row
    // recorded back when the form still asked for one. Both stay mapped so a
    // template saved before this change keeps rendering rather than printing a
    // literal {{chapter}} into somebody's invitation.
    organization: invitation.chapter || '',
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

module.exports = {
  sendVerificationEmail,
  sendMemberApprovedEmail,
  sendAccountApprovedEmail,
  sendEventRegistrationEmail,
  sendEventInvitationEmail,
};
