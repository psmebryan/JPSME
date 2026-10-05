// Tests for which transport sends the mail, and for the bug that made one of
// them drop attachments.
//
// Two separate things are covered here.
//
// 1. EMAIL_PROVIDER picks the transport, and it does so BEFORE looking at any
//    credential. The switch to the Google Workspace mailbox leaves an old
//    BREVO_API_KEY sitting in .env, and if the choice were made by "whichever
//    key is set" then adding SMTP credentials would silently change nothing —
//    every email would keep going out through Brevo, and the only symptom would
//    be mail arriving from the wrong place.
//
// 2. An attachment built from BYTES survives the Brevo translation step. It did
//    not: buildBrevoAttachments read fs.readFile(a.path), but nothing in this
//    app ever sets `path` — attachmentFor in mail.service.js reads from storage
//    (which may be the database) and ticket.service.js renders the e-ticket PDF
//    in memory. So `a.path` was undefined, fs.readFile threw, and because every
//    send in mail.service.js is best-effort, the throw was swallowed. Mail with
//    no attachment was unaffected, so the failure was invisible: the one email
//    it broke was the event confirmation carrying the QR e-ticket.
//
// Nothing here opens a network connection or touches the database. The mailer is
// re-required per case with a different environment, so the module cache has to
// be cleared each time — `transporter` is built once at require time.

const assert = require('assert');

// src/config/index.js calls require('dotenv').config() at the top, so every
// re-require of it re-reads the real .env and puts back any variable this file
// just deleted. That made the isolation below a no-op: cases appeared to pass
// while actually running against the developer's own .env (a local SMTP_HOST of
// smtp-relay.brevo.com was quietly reappearing, so "no SMTP_HOST" never held).
//
// Loaded once here, exactly as the app does, and then neutered — from this point
// on withEnv() is the only thing that decides what the mail configuration is.
const dotenv = require('dotenv');
dotenv.config();
dotenv.config = () => ({ parsed: {} });

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

const MAIL_KEYS = [
  'EMAIL_PROVIDER', 'BREVO_API_KEY', 'BREVO_SENDER',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
];

const MAIL_MODULES = ['../src/config', '../src/config/mailer', '../src/config/preflight'];

function uncache() {
  for (const m of MAIL_MODULES) delete require.cache[require.resolve(m)];
}

// The real .env is already loaded by the time this file runs, so every case
// starts from a known-empty mail configuration rather than from whatever the
// developer happens to have set — otherwise these tests pass or fail depending
// on the machine they run on.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of MAIL_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // config/index.js exposes getters over live process.env, but mailer.js and
  // preflight.js both read at require time, so both have to be re-required.
  uncache();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const k of MAIL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    uncache();
  };
  try {
    const out = fn();
    // An async body has to keep the environment in place until it settles, or
    // the restore below lands while the transport is still being used.
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const SMTP_ENV = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'studentnatcon@psmeinc.org.ph',
  SMTP_PASS: 'abcdefghijklmnop',
  SMTP_FROM: 'JPSME Student NatCon <studentnatcon@psmeinc.org.ph>',
};

// A real nodemailer transport has verify(); the Brevo shim is a bare object with
// only sendMail, and the no-provider fallback likewise. That difference is how
// these cases tell the three apart without sending anything.
function isNodemailer(t) {
  return typeof t.verify === 'function';
}

async function main() {
  console.log('\nWhich transport gets built\n');

  test('EMAIL_PROVIDER=smtp builds a real SMTP transport', () => {
    withEnv(SMTP_ENV, () => {
      const { transporter } = require('../src/config/mailer');
      assert(isNodemailer(transporter), 'expected a nodemailer transport');
    });
  });

  test('EMAIL_PROVIDER=smtp wins even with a Brevo key still in .env', () => {
    withEnv(Object.assign({}, SMTP_ENV, { BREVO_API_KEY: 'xkeysib-leftover' }), () => {
      const { transporter } = require('../src/config/mailer');
      // The whole point: a stale key must not quietly keep mail on Brevo.
      assert(isNodemailer(transporter), 'a leftover BREVO_API_KEY silently kept the Brevo transport');
    });
  });

  test('the default is still Brevo when a key is set and no provider is named', () => {
    withEnv({ BREVO_API_KEY: 'xkeysib-existing' }, () => {
      const { transporter } = require('../src/config/mailer');
      assert(!isNodemailer(transporter), 'an existing Brevo deployment changed transport on upgrade');
    });
  });

  test('EMAIL_PROVIDER=smtp with no SMTP_HOST refuses to start', () => {
    withEnv({ EMAIL_PROVIDER: 'smtp', BREVO_API_KEY: 'xkeysib-existing' }, () => {
      assert.throws(
        () => require('../src/config/mailer'),
        /SMTP_HOST is not set/,
        'it fell back to another transport instead of failing loudly'
      );
    });
  });

  test('an unsupported EMAIL_PROVIDER throws rather than being ignored', () => {
    withEnv({ EMAIL_PROVIDER: 'mergo' }, () => {
      // Mergo is a mail-merge tool driven from a spreadsheet by a person. It has
      // no API this app can hand a password reset to, so naming it here has to
      // fail at boot rather than look configured.
      assert.throws(() => require('../src/config/mailer'), /not supported/i);
    });
  });

  test('with nothing configured, mail is logged instead of sent', () => {
    withEnv({}, () => {
      const { transporter } = require('../src/config/mailer');
      assert(!isNodemailer(transporter) && typeof transporter.sendMail === 'function',
        'expected the console fallback');
    });
  });

  test('the sender address comes from SMTP_FROM when set', () => {
    withEnv(SMTP_ENV, () => {
      const { MAIL_FROM } = require('../src/config/mailer');
      assert.strictEqual(MAIL_FROM, SMTP_ENV.SMTP_FROM);
    });
  });

  test('BREVO_SENDER still supplies the address when SMTP_FROM is absent', () => {
    withEnv(Object.assign({}, SMTP_ENV, {
      SMTP_FROM: undefined,
      BREVO_SENDER: 'JPSME <studentnatcon@psmeinc.org.ph>',
    }), () => {
      const { MAIL_FROM } = require('../src/config/mailer');
      assert.strictEqual(MAIL_FROM, 'JPSME <studentnatcon@psmeinc.org.ph>');
    });
  });

  console.log('\nAttachments built from bytes, not from a path\n');

  // The regression. Driven through the Brevo transport's own sendMail with fetch
  // stubbed, so it proves the bytes reach the payload rather than reaching into
  // a private helper.
  await testAsync('an attachment carrying content reaches Brevo base64-encoded', async () => {
    const realFetch = global.fetch;
    let payload = null;
    global.fetch = async (url, opts) => {
      payload = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ messageId: '<test>' }) };
    };
    try {
      await withEnv({ BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER: 'JPSME <a@b.c>' }, async () => {
        const { transporter } = require('../src/config/mailer');
        await transporter.sendMail({
          from: 'JPSME <a@b.c>',
          to: 'student@example.com',
          subject: 'ticket',
          text: 'your ticket',
          // Exactly the shape ticket.service.js returns for the e-ticket PDF.
          attachments: [{ filename: 'ticket.pdf', content: Buffer.from('%PDF-1.4 pretend'), contentType: 'application/pdf' }],
        });
      });
      assert(payload, 'no request was made');
      assert(Array.isArray(payload.attachment) && payload.attachment.length === 1,
        'the attachment never made it into the payload');
      assert.strictEqual(payload.attachment[0].name, 'ticket.pdf');
      assert.strictEqual(
        Buffer.from(payload.attachment[0].content, 'base64').toString(),
        '%PDF-1.4 pretend',
        'the bytes did not survive the round trip'
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  await testAsync('a send carrying an e-ticket no longer throws on the Brevo path', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messageId: '<test>' }) });
    try {
      await withEnv({ BREVO_API_KEY: 'xkeysib-test' }, async () => {
        const { transporter } = require('../src/config/mailer');
        // Before the fix this threw TypeError from fs.readFile(undefined), which
        // mail.service.js caught and logged as a generic send failure — so the
        // confirmation email simply never arrived.
        await transporter.sendMail({
          from: 'JPSME <a@b.c>', to: 'student@example.com', subject: 's', text: 't',
          attachments: [{ filename: 'e.pdf', content: Buffer.from('x') }],
        });
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  await testAsync('a path-based attachment still works, for callers that use one', async () => {
    const realFetch = global.fetch;
    let payload = null;
    global.fetch = async (url, opts) => {
      payload = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ messageId: '<test>' }) };
    };
    try {
      await withEnv({ BREVO_API_KEY: 'xkeysib-test' }, async () => {
        const { transporter } = require('../src/config/mailer');
        await transporter.sendMail({
          from: 'JPSME <a@b.c>', to: 'student@example.com', subject: 's', text: 't',
          // package.json certainly exists, whatever machine this runs on.
          attachments: [{ filename: 'package.json', path: require.resolve('../package.json') }],
        });
      });
      assert(payload && payload.attachment && payload.attachment.length === 1, 'the path attachment was dropped');
      assert(Buffer.from(payload.attachment[0].content, 'base64').toString().includes('"name"'),
        'the file was not read');
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log('\nWhat preflight says about a half-finished switch\n');

  // preflight skips itself outside production, so every case here has to run as
  // production to get any report at all.
  function checkAs(env) {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      return withEnv(env, () => require('../src/config/preflight').check());
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  }

  // check() returns entries built by its own add() helper; read both a title
  // field and the raw entry so this does not depend on that shape.
  function textOf(entries) {
    return JSON.stringify(entries || []);
  }

  test('SMTP selected with a host but no credentials is a problem, not a warning', () => {
    const { problems } = checkAs({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com' });
    assert(/no credentials/i.test(textOf(problems)),
      'a host with no user or password passed preflight: ' + textOf(problems));
  });

  test('preflight names the App Password, because that is the thing people get wrong', () => {
    const { problems } = checkAs({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com' });
    assert(/App Password/i.test(textOf(problems)), 'the advice did not mention an App Password');
  });

  test('port 587 with SMTP_SECURE=true is warned about', () => {
    const { warnings } = checkAs(Object.assign({}, SMTP_ENV, { SMTP_SECURE: 'true' }));
    assert(/587/.test(textOf(warnings)), 'the combination that hangs was not flagged');
  });

  test('port 465 without SMTP_SECURE is warned about', () => {
    const { warnings } = checkAs(Object.assign({}, SMTP_ENV, { SMTP_PORT: '465' }));
    assert(/465/.test(textOf(warnings)), 'implicit TLS on 465 was not flagged');
  });

  test('a fully configured SMTP mailbox raises no email problem at all', () => {
    const { problems } = checkAs(SMTP_ENV);
    // Matched against titles only, and only against the email-transport titles.
    // A substring search over the whole report matches "Every link this app
    // emails" in the unrelated APP_URL warning, which a local .env always
    // triggers under NODE_ENV=production — so the loose version of this test
    // failed on a configuration that was in fact correct.
    const offending = (problems || []).filter((p) => /SMTP|email transport/i.test(p.title || ''));
    assert.strictEqual(offending.length, 0,
      'a working configuration was reported as broken: ' + JSON.stringify(offending));
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
