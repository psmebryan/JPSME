const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
// pdfkit's doc.image() only supports PNG/JPEG, so certificate backgrounds
// (which get composited into a PDF) can't accept WEBP/SVG like other uploads.
const CERTIFICATE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

function makeImageStorage(folderName, prefix) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(__dirname, '..', '..', 'public', 'uploads', folderName));
    },
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).toLowerCase();
      cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    },
  });
}

function makeFileFilter(allowedMimeTypes, message) {
  return (req, file, cb) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return cb(new Error(message));
    }
    cb(null, true);
  };
}

const fileFilter = makeFileFilter(ALLOWED_MIME_TYPES, 'Only PNG, JPEG, WEBP, or SVG images are allowed');
const certificateFileFilter = makeFileFilter(CERTIFICATE_MIME_TYPES, 'Only PNG or JPEG images are allowed for certificate backgrounds');

const uploadLogo = multer({
  storage: makeImageStorage('logo', 'logo'),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

const uploadProfileImage = multer({
  storage: makeImageStorage('profile', 'profile'),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

const uploadEventImage = multer({
  storage: makeImageStorage('events', 'events'),
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB for event images
});

const uploadSponsorLogo = multer({
  storage: makeImageStorage('sponsors', 'sponsors'),
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

const uploadCertificateBackground = multer({
  storage: makeImageStorage('certificates/backgrounds', 'certbg'),
  fileFilter: certificateFileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});

const uploadEmailAttachment = multer({
  storage: makeImageStorage('email-attachments', 'emailattach'),
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
});

module.exports = {
  uploadLogo,
  uploadProfileImage,
  uploadEventImage,
  uploadSponsorLogo,
  uploadCertificateBackground,
  uploadEmailAttachment,
};
