// Secrets in addresses never reach the log (src/utils/redactUrl.js): a
// password-reset link or Brevo's webhook token is blanked, the rest kept.
// No database needed.

const assert = require('assert');
const { redactUrl } = require('../src/utils/redactUrl');

const cases = [
  ['/reset-password?uid=12&token=abcdef0123456789', '/reset-password?uid=12&token=[redacted]'],
  ['/api/auth/reset-token?uid=12&token=abc', '/api/auth/reset-token?uid=12&token=[redacted]'],
  ['/api/webhooks/brevo?token=s3cret', '/api/webhooks/brevo?token=[redacted]'],
  ['/x?TOKEN=a&code=123456&page=2', '/x?TOKEN=[redacted]&code=[redacted]&page=2'],
  ['/x?%74oken=a', '/x?%74oken=[redacted]'],
  ['/admin/users/all?search=ann&page=3', '/admin/users/all?search=ann&page=3'],
  ['/store', '/store'],
  ['/x?token', '/x?token'],
];

let failed = 0;
cases.forEach(([input, want]) => {
  try { assert.strictEqual(redactUrl(input), want); } catch (e) { failed += 1; console.error(`FAIL ${input}\n  got  ${redactUrl(input)}\n  want ${want}`); }
});
console.log(`${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
