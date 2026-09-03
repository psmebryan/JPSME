const AppError = require('../utils/AppError');

// multer's fileFilter only checks the client-declared Content-Type, which is
// trivially spoofed (e.g. renaming a script to photo.png). This re-checks the
// actual bytes against known image signatures before the file is ever handed
// to storageService, so a mismatched file never reaches disk (or S3, later)
// or gets served from /uploads.
function matchesKnownImageSignature(buffer) {
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true; // PNG
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true; // JPEG
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return true; // WEBP
  }
  const head = buffer.slice(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return true; // SVG (text-based, no fixed binary magic number)
  }
  return false;
}

// Use as the middleware immediately after multer's `.single(field)`. Reads
// req.file.buffer (multer's memoryStorage keeps the whole upload in memory
// already — see upload.middleware.js) rather than a disk path, since nothing
// has been written anywhere yet at this point.
function verifyImageSignature(req, res, next) {
  if (!req.file) return next();

  if (!matchesKnownImageSignature(req.file.buffer)) {
    return next(new AppError('The uploaded file is not a valid image', 400));
  }

  next();
}

module.exports = verifyImageSignature;
