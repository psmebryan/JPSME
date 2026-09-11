const multer = require('multer');
const AppError = require('../utils/AppError');

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
// pdfkit's doc.image() only supports PNG/JPEG, so certificate backgrounds
// (which get composited into a PDF) can't accept WEBP/SVG like other uploads.
const CERTIFICATE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

// memoryStorage, not diskStorage — the file lands in req.file.buffer instead
// of being written straight to disk by multer itself. Every controller then
// calls storageService.saveUpload(req.file.buffer, ...) explicitly, so
// storageService is the only thing that ever decides where a file actually
// lives; multer's only job is receiving and validating the upload.
// Multer signals a refused upload by calling next(err) with its own error type,
// and nothing here recognised it — so it reached the global handler, failed the
// `err instanceof AppError` test, and came back as a 500 reading "Something
// went wrong. Please try again."
//
// That is the worst possible answer for the two things that actually happen:
// the file is too big, or it is not an image. Both are the uploader's to fix
// and neither is a server fault, but the person saw an identical unexplained
// error either way and had no idea the size limit existed.
//
// So every multer error is translated here, where the limit is actually known,
// into an AppError the handler already renders properly.
function describeSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

function makeUpload(allowedMimeTypes, message, maxFileSize) {
  const instance = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
      // An AppError rather than a bare Error, so the type message survives to
      // the client instead of being swallowed as an unexpected failure.
      if (!allowedMimeTypes.has(file.mimetype)) {
        return cb(new AppError(message, 400));
      }
      cb(null, true);
    },
    limits: { fileSize: maxFileSize },
  });

  // Only `.single` is wrapped because only `.single` is used. Adding .array or
  // .fields later means wrapping those too rather than discovering at runtime
  // that their errors went back to being 500s.
  return {
    single(field) {
      const handler = instance.single(field);
      return (req, res, next) => handler(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return next(new AppError(
              `That file is too large. The limit is ${describeSize(maxFileSize)} — `
              + 'try exporting it at a smaller size, or saving it as JPEG or WEBP instead of PNG.',
              400
            ));
          }
          return next(new AppError(`That upload could not be read (${err.code}).`, 400));
        }

        // The fileFilter rejection above, already an AppError; anything else is
        // genuinely unexpected and keeps its 500.
        return next(err);
      });
    },
  };
}

// 5 MB, not 2. A logo is artwork: the JPSME seal exported at 2160px square is
// several megabytes as a PNG, and 2 MB rejected an entirely ordinary file with
// what used to be an unexplained error. Profile photos come straight off a
// phone camera and are no smaller.
const uploadLogo = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 5 * 1024 * 1024);
const uploadProfileImage = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 5 * 1024 * 1024);
const uploadEventImage = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 3 * 1024 * 1024);
const uploadSponsorLogo = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 5 * 1024 * 1024);
const uploadArticleImage = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 3 * 1024 * 1024);
const uploadCertificateBackground = makeUpload(CERTIFICATE_MIME_TYPES, 'Only PNG or JPEG images are allowed for certificate backgrounds', 3 * 1024 * 1024);
const uploadEmailAttachment = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 3 * 1024 * 1024);

// Data import workbook. Browsers are inconsistent about the MIME type they
// attach to an .xlsx — some send the modern spreadsheetml type, others fall
// back to a generic binary one — so all the plausible values are accepted and
// the real check is ExcelJS refusing to parse anything that is not a workbook.
const SPREADSHEET_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);
const uploadDataWorkbook = makeUpload(SPREADSHEET_MIME_TYPES, 'Upload an .xlsx workbook', 10 * 1024 * 1024);

module.exports = {
  uploadLogo,
  uploadProfileImage,
  uploadEventImage,
  uploadSponsorLogo,
  uploadCertificateBackground,
  uploadEmailAttachment,
  uploadArticleImage,
  uploadDataWorkbook,
};
