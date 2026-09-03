const multer = require('multer');

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
// pdfkit's doc.image() only supports PNG/JPEG, so certificate backgrounds
// (which get composited into a PDF) can't accept WEBP/SVG like other uploads.
const CERTIFICATE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

// memoryStorage, not diskStorage — the file lands in req.file.buffer instead
// of being written straight to disk by multer itself. Every controller then
// calls storageService.saveUpload(req.file.buffer, ...) explicitly, so
// storageService is the only thing that ever decides where a file actually
// lives; multer's only job is receiving and validating the upload.
function makeUpload(allowedMimeTypes, message, maxFileSize) {
  return multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
      if (!allowedMimeTypes.has(file.mimetype)) {
        return cb(new Error(message));
      }
      cb(null, true);
    },
    limits: { fileSize: maxFileSize },
  });
}

const uploadLogo = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 2 * 1024 * 1024);
const uploadProfileImage = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 2 * 1024 * 1024);
const uploadEventImage = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 3 * 1024 * 1024);
const uploadSponsorLogo = makeUpload(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed', 2 * 1024 * 1024);
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
