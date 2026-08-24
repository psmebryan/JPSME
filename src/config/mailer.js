const fs = require('fs/promises');
const nodemailer = require('nodemailer');

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
// local filesystem path — nodemailer's convention here is { filename, path }.
// This is the one real translation step; everything else is a 1:1 field
// rename.
async function buildBrevoAttachments(attachments) {
  if (!attachments || !attachments.length) return undefined;
  const built = await Promise.all(
    attachments.map(async (a) => ({
      name: a.filename,
      content: (await fs.readFile(a.path)).toString('base64'),
    }))
  );
  return built;
}

function buildBrevoTransport() {
  const apiKey = process.env.BREVO_API_KEY;

  return {
    sendMail: async ({ from, to, subject, text, html, attachments, tags }) => {
      const payload = {
        sender: parseAddress(from),
        to: [parseAddress(to)],
        subject,
        htmlContent: html,
        textContent: text,
      };
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

// Falls back to logging emails to the console when neither Brevo nor SMTP is
// configured, so registration works out of the box on a fresh local XAMPP
// setup with zero email provider set up yet.
function buildTransport() {
  // Brevo API takes priority when configured — this is the intended path now
  // that a Brevo key exists; SMTP stays available underneath purely as a
  // fallback for environments that haven't set BREVO_API_KEY, not removed.
  if (process.env.BREVO_API_KEY) {
    return buildBrevoTransport();
  }

  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
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
const MAIL_FROM = process.env.SMTP_FROM || process.env.BREVO_SENDER || 'JPSME <no-reply@jpsme.local>';

module.exports = { transporter, MAIL_FROM };
