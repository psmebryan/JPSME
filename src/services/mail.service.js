const path = require('path');
const config = require('../config');
const { transporter, MAIL_FROM } = require('../config/mailer');
const emailTemplateService = require('./emailTemplate.service');
const ticketService = require('./ticket.service');
const storageService = require('./storage.service');
const { substituteTokens, formatDate, fullName } = require('../utils/templateTokens');
const logger = require('../utils/logger');

// Every send in this file is best-effort: a provider failure must never undo
// the thing that triggered it, or a Brevo outage would start failing
// registrations and approvals that already committed.
//
// What that must NOT mean is invisible. These failures were reported with a
// bare console.error, which does not reach the structured log anyone actually
// reads — so a resend that never left the building looked identical to one
// that did, and the provider's own explanation (an unauthorised IP, a rejected
// sender, an exhausted quota) was sitting in a stream nobody was watching.
//
// Reported through the logger instead, and the outcome returned, so a caller
// that wants to say what happened can.
function reportSendFailure(kind, to, err) {
  logger.error(`mail: ${kind} failed to send`, { to, reason: err && err.message });
  return false;
}

function getAppUrl() {
  return config.appUrl;
}

// Attachments travel as bytes rather than as a path. nodemailer accepts either
// { filename, path } or { filename, content }, and only the second works when
// the file lives in the database rather than on disk.
//
// Returns null rather than throwing if the file has gone: an approval email
// arriving without its artwork is better than an approval email not arriving.
async function attachmentFor(publicPath) {
  try {
    const content = await storageService.read(String(publicPath).replace(/^\/+/, ''));
    return { filename: path.basename(publicPath), content };
  } catch (err) {
    logger.warn('mail: attachment could not be read, sending without it', { publicPath, reason: err.message });
    return null;
  }
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
async function sendVerificationEmail(user, code, ttlMs) {
  const url = `${getAppUrl()}/verify-email`;
  // Taken from the caller, which owns the lifetime, rather than written into
  // the copy here where it would quietly go stale the moment that changes.
  // Defaulted so a caller that does not pass one still says something true.
  const minutes = Math.max(1, Math.round((Number(ttlMs) || 3 * 60 * 1000) / 60000));
  const lifetime = `The code expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be entered five times.`;

  try {
    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: `${code} is your JPSME verification code`,
      text: `Hi ${user.firstName},\n\n`
        + `Your JPSME verification code is: ${code}\n\n`
        + `Enter it on the verification page to confirm your email address.\n`
        + `${lifetime}\n\n`
        + `If you did not create a JPSME account, you can ignore this email.`,
      html: `
        <p>Hi ${user.firstName},</p>
        <p>Thanks for registering with JPSME. Your verification code is:</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:8px;font-family:monospace;margin:24px 0;">${code}</p>
        <p>Enter it on the <a href="${url}">verification page</a> to confirm your email address.</p>
        <p style="color:#666;font-size:13px;">${lifetime}<br>
        If you did not create a JPSME account, you can ignore this email.</p>
      `,
    });
    return true;
  } catch (err) {
    return reportSendFailure('verification code', user.email, err);
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
      const attachment = await attachmentFor(template.attachmentImage);
      if (attachment) attachments.push(attachment);
    }

    await transporter.sendMail({
      from: MAIL_FROM,
      to: user.email,
      subject: substituteTokens(template.subject, fields),
      html: textToHtml(substituteTokens(template.bodyHtml, fields)),
      attachments,
    });
  } catch (err) {
    reportSendFailure('member approved', user.email, err);
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
    reportSendFailure('account approved', user.email, err);
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
      const attachment = await attachmentFor(attachmentSource);
      if (attachment) attachments.push(attachment);
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
    reportSendFailure('event registration', user.email, err);
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
