// Tests for the public contact form (POST /api/contact).
//
// No real mail and no database: the transport is a stub that records what it
// was given, and the human check is stubbed to pass (it has its own tests).
// The route is mounted on a bare Express app with an in-memory session, so the
// real CSRF check and rate limits are what is being exercised.

const assert = require('assert');
const express = require('express');
const session = require('express-session');

const sent = [];
let failNext = false;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub('../src/config/mailer', {
  MAIL_FROM: 'JPSME <icto@jpsmeinc.org.ph>',
  transporter: {
    async sendMail(mail) {
      if (failNext) { failNext = false; throw new Error('provider down'); }
      sent.push(mail);
      return { messageId: 'stub' };
    },
  },
});
stub('../src/services/captcha.service', { requireHuman: () => (req, res, next) => next() });

process.env.CONTACT_EMAIL_TO = 'contact-test@example.invalid';
const contactRoutes = require('../src/routes/api/contact.routes');

const app = express();
app.use(express.json());
app.use(session({ secret: 'test-secret-test-secret-test-secret', resave: false, saveUninitialized: true }));
app.use((req, res, next) => { req.session.csrfToken = req.session.csrfToken || 'a'.repeat(64); next(); });
app.get('/token', (req, res) => res.json({ token: req.session.csrfToken }));
app.use('/api/contact', contactRoutes);

const valid = {
  firstName: 'Juan', lastName: 'Dela Cruz', email: 'juan@example.invalid',
  message: 'Hello <b>there</b>, I would like to ask about membership.',
};

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = await fetch(`${base}/token`);
    const cookie = t.headers.get('set-cookie').split(';')[0];
    const { token } = await t.json();
    const post = (bodyObj, withToken = true) => fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, withToken ? { 'X-CSRF-Token': token } : {}),
      body: JSON.stringify(bodyObj),
    });

    // Without the CSRF token: refused, nothing sent.
    let res = await post(valid, false);
    assert.strictEqual(res.status, 403, 'missing CSRF token is refused');
    assert.strictEqual(sent.length, 0);

    // A valid message goes to the configured address, with the visitor in
    // Reply-To and their text escaped in the HTML part.
    res = await post(valid);
    assert.strictEqual(res.status, 200, 'valid message accepted');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'contact-test@example.invalid');
    assert.strictEqual(sent[0].replyTo, 'juan@example.invalid');
    assert.strictEqual(sent[0].from, 'JPSME <icto@jpsmeinc.org.ph>', 'sent from the site address, not the visitor');
    assert(sent[0].html.includes('&lt;b&gt;there&lt;/b&gt;'), 'message HTML is escaped');
    assert(!sent[0].html.includes('<b>there</b>'));

    // Bad input is a 422 and sends nothing.
    res = await post({ ...valid, email: 'not-an-email' });
    assert.strictEqual(res.status, 422, 'invalid email is rejected');
    res = await post({ ...valid, message: 'short' });
    assert.strictEqual(res.status, 422, 'too-short message is rejected');
    assert.strictEqual(sent.length, 1);

    // A provider failure is reported, not thanked.
    failNext = true;
    res = await post(valid);
    assert.strictEqual(res.status, 502, 'provider failure is reported to the visitor');

    // Five per hour per address, rejected attempts included (the CSRF refusal
    // above never reached the limiter; the four after it did).
    res = await post(valid);
    assert.strictEqual(res.status, 200, 'the fifth attempt is still allowed');
    res = await post(valid);
    assert.strictEqual(res.status, 429, 'the sixth is rate limited');
    assert.strictEqual(sent.length, 2, 'and sends nothing');

    console.log('Contact form tests passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
