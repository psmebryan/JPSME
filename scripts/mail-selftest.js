#!/usr/bin/env node
/**
 * Proves the configured email transport actually works, before any member
 * depends on it.
 *
 *   node scripts/mail-selftest.js                     # report config, verify the connection
 *   node scripts/mail-selftest.js you@example.com     # ...and send one real test email
 *
 * Two separate things get checked, because they fail for different reasons:
 *
 *   verify()  opens the connection and authenticates, and nothing more. This is
 *             what catches a wrong App Password, 2-Step Verification not being
 *             on, the wrong port, or a firewall — the whole class of problems
 *             that otherwise shows up as mail silently not arriving.
 *
 *   send      actually delivers, WITH an attachment. The attachment is the
 *             point: attachments are built as bytes in this app (the e-ticket
 *             PDF is rendered in memory), and a transport that mishandles that
 *             breaks exactly one thing — the event confirmation carrying the QR
 *             ticket — while every other email keeps arriving normally. That is
 *             a bug that hides, so the self-test always attaches something.
 */
require('dotenv').config();
const config = require('../src/config');
const { transporter, MAIL_FROM } = require('../src/config/mailer');

// Never print a credential, only whether there is one and how long it is. A
// self-test gets pasted into chat threads and issue reports.
function shown(value) {
  if (!value) return '(not set)';
  return `set, ${String(value).length} characters`;
}

async function main() {
  const to = process.argv[2];
  const provider = config.email.provider;

  console.log('');
  console.log('  EMAIL_PROVIDER   ', provider);
  console.log('  sends as         ', MAIL_FROM);

  if (provider === 'smtp') {
    console.log('  SMTP_HOST        ', config.email.smtp.host || '(not set)');
    console.log('  SMTP_PORT        ', config.email.smtp.port, config.email.smtp.secure ? '(TLS from the first byte)' : '(STARTTLS)');
    console.log('  SMTP_USER        ', config.email.smtp.user || '(not set)');
    console.log('  SMTP_PASS        ', shown(config.email.smtp.pass));
  } else {
    console.log('  BREVO_API_KEY    ', shown(config.email.brevoApiKey));
  }
  console.log('');

  // Two misconfigurations are worth naming BEFORE opening a connection, because
  // both surface as the same "535 Authentication failed" that reads like a wrong
  // password and sends you off re-creating a credential that was fine.
  if (provider === 'smtp') {
    const warn = [];

    // Google shows an App Password as four groups of four — "abcd efgh ijkl
    // mnop" — and pasting it verbatim gives 19 characters instead of 16. The
    // spaces are purely for reading; they are not part of the secret.
    const pass = config.email.smtp.pass || '';
    if (/\s/.test(pass)) {
      warn.push('SMTP_PASS contains spaces. If this is a Google App Password, remove them — it is 16 characters with no spaces.');
    } else if (/^smtp\.gmail\.com$/i.test(config.email.smtp.host || '') && pass && pass.length !== 16) {
      warn.push(`SMTP_PASS is ${pass.length} characters. A Google App Password is exactly 16.`);
    }

    // The migration off another provider leaves its host behind in .env, and a
    // credential for one provider is always refused by another's server. This
    // compares the host against the sender's own domain only to decide whether
    // to mention it — it never blocks, because plenty of valid setups relay
    // through a host unrelated to the From address.
    const host = (config.email.smtp.host || '').toLowerCase();
    const knownRelays = { 'smtp.gmail.com': 'Google Workspace', 'smtp-relay.gmail.com': 'Google Workspace', 'smtp-relay.brevo.com': 'Brevo', 'smtp.sendgrid.net': 'SendGrid', 'email-smtp': 'Amazon SES' };
    const matched = Object.keys(knownRelays).find((h) => host.includes(h));
    if (matched && !/gmail/.test(matched)) {
      warn.push(`SMTP_HOST is ${config.email.smtp.host}, which is ${knownRelays[matched]} — not Google. A Google App Password will always be refused there. For the Workspace mailbox use smtp.gmail.com.`);
    }

    if (warn.length) {
      console.log(warn.length === 1
        ? '  Before connecting, something looks wrong:'
        : `  Before connecting, ${warn.length} things look wrong:`);
      for (const w of warn) console.log('    - ' + w);
      console.log('');
    }
  }

  // Only real SMTP transports have verify(); the Brevo shim and the
  // console-logging fallback do not, and their absence is not a failure.
  if (typeof transporter.verify === 'function') {
    process.stdout.write('  connecting and authenticating... ');
    try {
      await transporter.verify();
      console.log('OK');
    } catch (err) {
      console.log('FAILED');
      console.log('');
      console.log('  ' + (err && err.message ? err.message : String(err)));
      console.log('');
      // The three ways this fails in practice, named rather than left to a
      // search. Google's own wording for the first two is not obvious.
      if (/invalid login|username and password not accepted|BadCredentials|535/i.test(err && err.message || '')) {
        // Which server refused it matters more than the refusal itself: a
        // credential is only ever valid at the provider that issued it, so the
        // host is the first thing to check, not the password.
        console.log(`  The server that refused it was ${config.email.smtp.host}.`);
        console.log('  A credential is only valid at the provider that issued it — if that host is not');
        console.log('  the one the password came from, no password will ever work there.');
        console.log('');
        console.log('  For a Google Workspace mailbox:');
        console.log('    - SMTP_HOST must be smtp.gmail.com.');
        console.log('    - SMTP_PASS must be a 16-character App Password with no spaces, not the mailbox password.');
        console.log('    - App Passwords only exist once 2-Step Verification is on for that account.');
        console.log('    - SMTP_USER must be the full address, including the domain.');
      } else if (/timed out|ETIMEDOUT|ECONNREFUSED/i.test(err && err.message || '')) {
        console.log('  That is a connection failure, not a credential problem — the port never opened.');
        console.log('    - Port 587 with SMTP_SECURE unset is the combination that works from most hosts.');
        console.log('    - Port 465 needs SMTP_SECURE=true; 587 with SMTP_SECURE=true usually hangs.');
        console.log('    - Some networks block outbound 587 entirely. Worth testing from the live host too.');
      }
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('  this transport has no connection to verify (Brevo API, or nothing configured)');
  }

  if (!to) {
    console.log('');
    console.log('  Pass an address to send a real test email:');
    console.log('    node scripts/mail-selftest.js you@example.com');
    console.log('');
    return;
  }

  process.stdout.write(`  sending a test email to ${to}... `);
  try {
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to,
      subject: 'JPSME email self-test',
      text: 'If this arrived with a small text file attached, the transport works for every email this site sends.',
      html: '<p>If this arrived <strong>with a small text file attached</strong>, the transport works for every email this site sends.</p>',
      attachments: [{
        // Bytes, not a path — deliberately the same shape the e-ticket uses.
        filename: 'jpsme-selftest.txt',
        content: Buffer.from('This attachment was built in memory, exactly like the event e-ticket PDF.\n'),
      }],
    });
    console.log('OK');
    console.log('  message id:', info && info.messageId);
    console.log('');
    console.log('  Check that it arrived AND that the attachment is on it. A message that');
    console.log('  arrives without its attachment is the failure this test exists to catch.');
    console.log('');
  } catch (err) {
    console.log('FAILED');
    console.log('');
    console.log('  ' + (err && err.message ? err.message : String(err)));
    console.log('');
    process.exitCode = 1;
  }
}

main();
