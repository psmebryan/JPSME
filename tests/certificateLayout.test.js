// Tests for the "Uploaded design — print the name only" certificate layout.
//
// The defaults are measured from the 16th SNC design (NAME baseline 50.78%
// down an A4 landscape page, 44.3pt, #2b508c, centred). Settings that are
// missing or out of range must fall back to those defaults rather than drawing
// the name off the page. No database: storage is stubbed.

const assert = require('assert');

const storagePath = require.resolve('../src/services/storage.service');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: { async exists() { return false; }, async read() { return null; } },
};
const cert = require('../src/services/certificate.service');

(async () => {
  // Defaults: the measured 16th SNC values.
  const d = cert.sanitizeLayout({ mode: 'name' });
  assert.strictEqual(d.mode, 'name');
  assert.strictEqual(d.nameColor, '#2b508c');
  assert.strictEqual(d.nameSize, 44.3);
  assert.strictEqual(d.nameBaseline, 50.78);
  assert.strictEqual(d.nameFont, 'Helvetica-Bold');
  assert.strictEqual(d.nameUppercase, false);

  // Out-of-range or unknown values fall back instead of breaking the page.
  const bad = cert.sanitizeLayout({ mode: 'weird', nameColor: 'blue', nameSize: 900, nameBaseline: -5, nameFont: 'Comic Sans', nameMaxWidth: 5 });
  assert.strictEqual(bad.mode, 'text', 'unknown mode is the plain certificate');
  assert.strictEqual(bad.nameColor, '#2b508c');
  assert.strictEqual(bad.nameSize, 44.3);
  assert.strictEqual(bad.nameBaseline, 50.78);
  assert.strictEqual(bad.nameFont, 'Helvetica-Bold');
  assert.strictEqual(bad.nameMaxWidth, 69);

  // The form's checkbox sends "on".
  assert.strictEqual(cert.sanitizeLayout({ nameUppercase: 'on' }).nameUppercase, true);

  // Both a typical and a very long name render as a one-page PDF.
  for (const name of ['Juan A. Dela Cruz', 'Maria Christina Josephine B. Villanueva-Santiago de los Reyes']) {
    // eslint-disable-next-line no-await-in-loop
    const pdf = await cert.renderPreviewCertificate(
      { backgroundImage: null, title: 'T', bodyText: 'B', textColor: '#000000', layout: d },
      { fullName: name },
    );
    assert(pdf.slice(0, 5).toString() === '%PDF-', 'a PDF');
    assert((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length === 1, 'exactly one page, even for a long name');
  }

  console.log('Certificate layout tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
