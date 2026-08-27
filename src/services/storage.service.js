const crypto = require('crypto');
const localDriver = require('./storage/localStorage.driver');

// The only module in the app that should ever read/write an uploaded or
// generated file. Every controller/service that used to reach for fs/path
// directly goes through here instead, so swapping the backing store (local
// disk today, S3 later) is a change to the driver this delegates to, not a
// repo-wide search-and-replace.
//
//   JPSME code -> storageService -> localStorage.driver.js (today)
//   JPSME code -> storageService -> s3Storage.driver.js     (later)
//
// config.storage.driver is already validated (config/index.js's oneOf()) to
// only allow 'local' — there's deliberately no if/else here yet, since a
// second driver doesn't exist. It plugs in at this one line.
const driver = localDriver;

function generateFilename(prefix, extension) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${extension}`;
}

// Saves a public, web-servable asset (logo, profile photo, event/sponsor/
// article image, certificate background, email attachment) and returns the
// public URL to store on the model — e.g. User.profileImage,
// Event.imageUrl. Identical in shape to what multer's old diskStorage
// config used to hand back, so this is a drop-in replacement for existing
// data, not a new format needing a migration.
async function saveUpload(buffer, { folder, prefix, extension }) {
  const filename = generateFilename(prefix, extension);
  const key = `uploads/${folder}/${filename}`;
  await driver.save(buffer, key);
  return driver.getUrl(key);
}

// Saves a privately-stored generated file (currently only event certificate
// PDFs) — never web-accessible directly, only through an authenticated
// download endpoint (see readStream below). Returns the same relative-path
// identifier EventCertificate.filePath already stores today.
async function saveGenerated(buffer, { folder, prefix, extension }) {
  const filename = generateFilename(prefix, extension);
  const key = `storage/${folder}/${filename}`;
  await driver.save(buffer, key);
  return key;
}

function readStream(key) {
  return driver.readStream(key);
}

async function read(key) {
  return driver.read(key);
}

function isManagedKey(key) {
  if (typeof key !== 'string') return false;
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.startsWith('uploads/') || normalized.startsWith('storage/');
}

// Silently no-ops for anything this storage layer doesn't actually manage
// (an external image URL, an empty/null value) — every caller used to do
// this "is it actually ours to delete" check inline before unlinking;
// centralized here instead of repeated at every call site.
async function remove(key) {
  if (!isManagedKey(key)) return;
  await driver.delete(key);
}

async function removeFolder(key) {
  if (!isManagedKey(key)) return;
  await driver.removeFolder(key);
}

async function exists(key) {
  if (!isManagedKey(key)) return false;
  return driver.exists(key);
}

function getUrl(key) {
  return driver.getUrl(key);
}

// Escape hatch for the one legitimate remaining need for a real filesystem
// path: nodemailer's SMTP transport (the Brevo fallback path) takes
// attachments as { filename, path }, a contract from a third-party library
// this app doesn't control. Nothing else in the app should call this — an
// S3 driver has no local path to return, so this would need to change
// (e.g. download-to-temp-file-first) if that fallback transport is ever
// actually exercised against S3-backed storage.
function getAbsolutePath(key) {
  return driver.resolvePath(key);
}

module.exports = {
  saveUpload,
  saveGenerated,
  readStream,
  read,
  remove,
  removeFolder,
  exists,
  getUrl,
  isManagedKey,
  getAbsolutePath,
};
