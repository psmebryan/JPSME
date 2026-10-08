const fs = require('fs/promises');
const nodemailer = require('nodemailer');
const config = require('./index');

// Every caller in this app (mail.service.js, broadcastEmail.service.js) calls
// transporter.sendMail({ from, to, subject, text, html, attachments }) using
// nodemailer's conventions (attachments as [{ filename, path }] pointing at a
// local file). This file's job is only to decide WHICH transport implements
// that same interface — callers never change regardless of which branch below
// is active.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_REQUEST_TIMEOUT_MS = 15000;

// Parses nodemailer's "Name <email>" address convention (used by MAIL_FROM
// below) into the { name, email } shape Brevo's API expects.
function parseAddress(address) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(address || '');
  if (match) {
    const [, name, email] = match;
    return name ? { name, email } : { email };
  }
  return { email: address };
}

// Brevo's API takes attachments as base64 content (or a public URL), not a
// local filesystem path. This is the one real translation step; everything
// else is a 1:1 field rename.
//
// It has to accept BOTH of nodemailer's conventions, and for a long time it
// only accepted one. This read `fs.readFile(a.path)` unconditionally — but
// every attachment this app actually builds carries bytes, not a path:
// mail.service.js's attachmentFor reads from storage (which may be the
// database, where there is no path to give), and ticket.service.js renders the
// e-ticket PDF in memory. So `a.path` was always undefined, fs.readFile threw
// a TypeError, and because every send in mail.service.js is deliberately
// best-effort, that throw was swallowed and logged as a generic send failure.
//
// The effect: on Brevo, every email carrying an attachment silently failed —
// including the event registration confirmation with the QR e-ticket attached.
// Mail with no attachment was unaffected, which is why this could sit unnoticed.
async function buildBrevoAttachments(attachments) {
  if (!attachments || !attachments.length) return undefined;
  const built = await Promise.all(
    attachments.map(async (a) => {
      // Bytes first: it is what this app produces, and it needs no filesystem.
      const bytes = a.content !== undefined && a.content !== null
        ? Buffer.from(a.content)
        : await fs.readFile(a.path);
      return { name: a.filename, content: bytes.toString('base64') };
    })
  );
  return built;
}

function buildBrevoTransport() {
  const apiKey = config.email.brevoApiKey;

  return {
    sendMail: async ({ from, to, replyTo, subject, text, html, attachments, tags }) => {
      const payload = {
        sender: parseAddress(from),
        to: [parseAddress(to)],
        subject,
        htmlContent: html,
        textContent: text,
      };
      // nodemailer's replyTo, so a reply goes to whoever wrote in rather than
      // back to the site's own sending address.
      if (replyTo) payload.replyTo = parseAddress(replyTo);
      const brevoAttachments = await buildBrevoAttachments(attachments);
      if (brevoAttachments) payload.attachment = brevoAttachments;
      // Echoed back verbatim on every delivery-event webhook Brevo sends for
      // this message (sent/delivered/bounced/opened/clicked) — the only way
      // this app can correlate a webhook event back to an internal record,
      // since Brevo doesn't sign webhooks with a request body we control.
      if (tags && tags.length) payload.tags = tags;

      let res;
      try {
        res = await fetch(BREVO_API_URL, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          // A hung connection to Brevo must fail cleanly, not hang whatever
          // fire-and-forget caller triggered this send indefinitely.
          signal: AbortSignal.timeout(BREVO_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw new Error('The email provider took too long to respond.');
        }
        // Never include `err` itself verbatim — some runtime network errors
        // can echo back parts of the request. Only ever log/throw a fixed,
        // safe message; the API key never appears in any log, error, or
        // response regardless of what failed.
        throw new Error('Could not reach the email provider.');
      }

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Brevo's own error body ({ code, message }) describes what was
        // wrong with the REQUEST — it never echoes back credentials — but
        // still never log the raw `payload`/headers here, just the safe
        // message field.
        const message = (body && typeof body.message === 'string') ? body.message : 'The email provider rejected the request.';
        console.error('Brevo API error:', res.status, message);
        throw new Error(message);
      }

      return { messageId: body.messageId };
    },
  };
}

// A real SMTP server, which for this deployment is the Google Workspace
// mailbox that sends as studentnatcon@psmeinc.org.ph.
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=studentnatcon@psmeinc.org.ph
//   SMTP_PASS=<16-character Google App Password, not the mailbox password>
//
// Two things about that choice are deliberate.
//
// smtp.gmail.com, not smtp-relay.gmail.com. The relay is the higher-volume
// option, but it authorises senders by IP address, and this app is hosted
// somewhere with no stable outbound IP — the address changes underneath us, so
// any IP allowlist is guaranteed to lock us out eventually. Password auth
// travels with the request instead and does not care what IP it came from.
//
// An App Password, not the account password. Google refuses plain password
// auth on SMTP outright; an App Password is the supported way in, it requires
// 2-Step Verification on the mailbox, and it can be revoked on its own without
// touching the mailbox itself.
//
// Nodemailer takes attachments as { filename, content } (bytes) or
// { filename, path }, and needs no translation for either — unlike the Brevo
// branch above, which had to grow one.
function buildSmtpTransport() {
  return nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    // Port 587 is STARTTLS, which means the connection opens in the clear and
    // is upgraded — so `secure` is false there and true only on 465. Setting
    // secure:true on 587 does not make it safer, it makes it hang.
    secure: config.email.smtp.secure,
    auth: config.email.smtp.user
      ? { user: config.email.smtp.user, pass: config.email.smtp.pass }
      : undefined,
  });
}

// Falls back to logging emails to the console when nothing is configured, so
// registration works out of the box on a fresh local XAMPP setup with no email
// provider set up at all.
function buildTransport() {
  // EMAIL_PROVIDER decides, and it is checked before any credential is looked
  // at. Picking the transport by "which key happens to be set" is how a
  // deployment ends up sending through a provider nobody chose: leaving an old
  // BREVO_API_KEY in .env while adding SMTP credentials would silently keep
  // every email on Brevo, and the only symptom is mail arriving from the wrong
  // place.
  if (config.email.provider === 'smtp') {
    if (!config.email.smtp.host) {
      // Loud, at boot, rather than a send failure per email later. There is no
      // sensible fallback here — quietly using Brevo instead would be exactly
      // the surprise the explicit switch exists to prevent.
      throw new Error('EMAIL_PROVIDER=smtp but SMTP_HOST is not set. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS, or change EMAIL_PROVIDER.');
    }
    return buildSmtpTransport();
  }

  if (config.email.brevoApiKey) {
    return buildBrevoTransport();
  }

  // Provider is 'brevo' with no key. SMTP credentials still win over doing
  // nothing — this is the pre-existing fallback and some environments rely on
  // it — but the provider switch above is the supported way to ask for SMTP.
  if (config.email.smtp.host) {
    return buildSmtpTransport();
  }

  return {
    sendMail: async (options) => {
      console.log('\n--- No email provider configured: email not actually sent ---');
      console.log(`To: ${options.to}\nSubject: ${options.subject}`);
      console.log(options.text || options.html);
      console.log('---------------------------------------------------------\n');
      return { messageId: 'console-dev-transport' };
    },
  };
}

const transporter = buildTransport();
const MAIL_FROM = config.email.from;

module.exports = { transporter, MAIL_FROM };
