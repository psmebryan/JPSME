// ?next= after signing in or registering may only be a path on this site
// (src/utils/safeRedirect.js). No database needed.

const assert = require('assert');
const { safeRedirectPath } = require('../src/utils/safeRedirect');

const allowed = ['/', '/events/12', '/store?x=1#top', '/store/orders/ORD-2026-000001', '/%5Cevil.com'];
const refused = [
  '//evil.com',
  '/\\evil.com', // a backslash reads as a slash: //evil.com
  '/\\/evil.com',
  '/\t/evil.com', // tabs and newlines are dropped by the browser
  '/\n/evil.com',
  '/ /evil.com',
  'https://evil.com',
  'javascript:alert(1)',
  'evil.com',
  '',
  null,
  undefined,
  `/${'a'.repeat(600)}`,
];

let failed = 0;
allowed.forEach((v) => {
  try { assert.strictEqual(safeRedirectPath(v), v); } catch (e) { failed += 1; console.error('FAIL allowed:', JSON.stringify(v)); }
});
refused.forEach((v) => {
  try { assert.strictEqual(safeRedirectPath(v), null); } catch (e) { failed += 1; console.error('FAIL refused:', JSON.stringify(v)); }
});
console.log(`${allowed.length + refused.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
