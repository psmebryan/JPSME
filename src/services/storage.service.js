const crypto = require('crypto');
const config = require('../config');
const localDriver = require('./storage/localStorage.driver');
const dbDriver = require('./storage/dbStorage.driver');

// The only module in the app that should ever read/write an uploaded or
// generated file. Every controller/service that used to reach for fs/path
// directly goes through here instead, so swapping the backing store (local
// disk today, S3 later) is a change to the driver this delegates to, not a
// repo-wide search-and-replace.
//
//   JPSME code -> storageService -> dbStorage.driver.js    (today)
//   JPSME code -> storageService -> localStorage.driver.js  (opt-in)
//   JPSME code -> storageService -> s3Storage.driver.js     (later)
//
// The database is the default because this host wipes the filesystem on every
// deploy: "local" there means an uploaded logo works until the next publish
// and then 404s everywhere. See dbStorage.driver.js.
const driver = config.storage.driver === 'local' ? localDriver : dbDriver;

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

// Was an escape hatch returning a real filesystem path, for email attachments:
// nodemailer takes them as { filename, path }. That only ever worked for a
// driver backed by files, and the database driver has no path to give — so the
// caller reads the bytes instead and passes { filename, content }, which both
// transports accept and which no driver has to special-case.

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
};
