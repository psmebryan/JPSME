// Tests for what an upload says when it refuses.
//
// Multer signals a refused upload with its own error type. Nothing recognised
// it, so it reached the global handler, failed the `instanceof AppError` test,
// and came back as a 500 reading "Something went wrong. Please try again."
//
// That is the worst possible answer for the only two things that actually
// happen — the file is too big, or it is not an image. Both are the uploader's
// to fix, neither is a server fault, and the person saw the same unexplained
// error either way with no hint that a size limit existed at all.
//
// Mounted on a bare express app rather than driven through the real admin
// route: that route is behind apiAdmin and CSRF, both of which answer long
// before multer sees a byte, so a test going through it would only ever be
// measuring the login gate. The error handler here mirrors the one in app.js —
// the AppError branch is the whole contract this fix depends on.

const express = require('express');
const AppError = require('../src/utils/AppError');
const { uploadLogo, uploadDataWorkbook } = require('../src/middleware/upload.middleware');

let passed = 0;
let failed = 0;
let server;
let base;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function buildApp() {
  const app = express();
  app.post('/logo', uploadLogo.single('logo'), (req, res) => res.status(200).json({ ok: true, size: req.file.size }));
  app.post('/workbook', uploadDataWorkbook.single('file'), (req, res) => res.status(200).json({ ok: true }));

  // The same classification app.js does: an AppError is something the caller
  // can act on, anything else is a 500 nobody can.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const known = err instanceof AppError;
    res.status(known ? err.statusCode : 500).json({
      success: false,
      message: known ? err.message : 'Something went wrong. Please try again.',
    });
  });
  return app;
}

const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function pngOfSize(totalBytes) {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, Math.round(totalBytes) - PNG_HEADER.length), 0x41)]);
}

async function post(route, field, { bytes, filename, type }) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), filename);
  const res = await fetch(`${base}${route}`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, message: body.message || '', body };
}

async function main() {
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await test('an ordinary logo goes straight through', async () => {
    const { status, body } = await post('/logo', 'logo', {
      bytes: pngOfSize(64 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assertEqual(status, 200, 'accepted');
    assertEqual(body.size, 64 * 1024, 'intact');
  });

  await test('artwork that used to be rejected now fits', async () => {
    // The seal exported at 2160px square is several megabytes as a PNG. The old
    // 2 MB cap turned an entirely ordinary logo into an unexplained error.
    const { status } = await post('/logo', 'logo', {
      bytes: pngOfSize(3.5 * 1024 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assertEqual(status, 200, 'a 3.5 MB logo is accepted');
  });

  await test('a file over the limit is the caller\'s problem, not a server fault', async () => {
    // The bug in one assertion: this was a 500, which reads as "the site is
    // broken" rather than "your file is too big".
    const { status } = await post('/logo', 'logo', {
      bytes: pngOfSize(6 * 1024 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assertEqual(status, 400, 'a 400');
  });

  await test('and it says how big the file is, how big is allowed, and what to do', async () => {
    // "Too large" alone leaves somebody guessing how much to shrink it by, and
    // guessing means another upload and another wait. Naming both numbers is
    // the difference between one more attempt and several.
    const { message } = await post('/logo', 'logo', {
      bytes: pngOfSize(6 * 1024 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assert(/about 6\.\d MB/.test(message), `names the size they sent, got: ${message}`);
    assert(/over the 5 MB limit/.test(message), `names the limit, got: ${message}`);
    assert(/JPEG|WEBP|smaller/i.test(message), `suggests a fix, got: ${message}`);
    assert(!/Something went wrong/i.test(message), 'not the generic fallback');
  });

  await test('a much larger file reports its own size, not a fixed one', async () => {
    const { message } = await post('/logo', 'logo', {
      bytes: pngOfSize(12 * 1024 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assert(/about 12\.\d MB/.test(message), `the real size, got: ${message}`);
  });

  await test('a file of the wrong type lists what is allowed', async () => {
    const { status, message } = await post('/logo', 'logo', {
      bytes: Buffer.from('%PDF-1.4'), filename: 'brochure.pdf', type: 'application/pdf',
    });
    assertEqual(status, 400, 'a 400');
    assert(/PNG/i.test(message) && /SVG/i.test(message), `lists the types, got: ${message}`);
    assert(!/Something went wrong/i.test(message), 'not the generic fallback');
  });

  await test('the limit quoted is the one that endpoint actually uses', async () => {
    // Each upload has its own cap. A message that always said "5 MB" would be
    // wrong on most of them, which is why the limit is described where it is
    // defined rather than in the error handler.
    const { message } = await post('/workbook', 'file', {
      bytes: Buffer.alloc(11 * 1024 * 1024, 0x41),
      filename: 'members.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    assert(/10 MB/.test(message), `the workbook's own limit, got: ${message}`);
  });

  await test('a rejected upload never reaches the handler behind it', async () => {
    // The handler would read req.file, which is not there — the reason this has
    // to fail at the middleware rather than be checked later.
    const { status, body } = await post('/logo', 'logo', {
      bytes: pngOfSize(6 * 1024 * 1024), filename: 'seal.png', type: 'image/png',
    });
    assertEqual(status, 400, 'stopped');
    assert(!body.ok, 'the success handler did not run');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(() => {
    if (server) server.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
