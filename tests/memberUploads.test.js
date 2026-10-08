// Tests for member image uploads: raster only, typed by content.
//
// A member's profile picture is served from this site's own domain, so an SVG
// (a document that can carry script) must not get through, whatever the
// browser claimed it was or what the file was called. No database needed.

const assert = require('assert');
const express = require('express');
const { uploadProfileImage } = require('../src/middleware/upload.middleware');
const verifyImageSignature = require('../src/middleware/verifyImageSignature');

const { verifyRasterImageSignature } = verifyImageSignature;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function run(middleware, file) {
  return new Promise((resolve) => {
    const req = { file };
    middleware(req, {}, (err) => resolve({ err, req }));
  });
}

(async () => {
  // Content decides, and the stored extension follows the content.
  let r = await run(verifyRasterImageSignature, { buffer: PNG, originalname: 'me.svg' });
  assert(!r.err, 'a real PNG is accepted');
  assert.strictEqual(r.req.file.detectedExtension, '.png', 'stored as .png even when named .svg');

  r = await run(verifyRasterImageSignature, { buffer: JPEG, originalname: 'me.jpeg' });
  assert.strictEqual(r.req.file.detectedExtension, '.jpg');

  r = await run(verifyRasterImageSignature, { buffer: SVG, originalname: 'me.png' });
  assert(r.err && r.err.statusCode === 400, 'SVG content is refused for members, even named .png');

  r = await run(verifyRasterImageSignature, { buffer: Buffer.from('hello'), originalname: 'x.png' });
  assert(r.err && r.err.statusCode === 400, 'non-images are refused');

  // Administrators' uploads still allow SVG.
  r = await run(verifyImageSignature, { buffer: SVG, originalname: 'logo.svg' });
  assert(!r.err, 'admin uploads still accept SVG');
  assert.strictEqual(r.req.file.detectedExtension, '.svg');

  // The multer filter for profile pictures refuses a declared SVG up front.
  const app = express();
  app.post('/up', uploadProfileImage.single('profileImage'), (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (bytes, type, name) => {
      const form = new FormData();
      form.append('profileImage', new Blob([bytes], { type }), name);
      return fetch(`${base}/up`, { method: 'POST', body: form });
    };
    let res = await send(SVG, 'image/svg+xml', 'me.svg');
    assert.strictEqual(res.status, 400, 'declared SVG refused by the upload filter');
    res = await send(PNG, 'image/png', 'me.png');
    assert.strictEqual(res.status, 200, 'declared PNG passes the filter');
  } finally {
    server.close();
  }

  console.log('Member upload tests passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
