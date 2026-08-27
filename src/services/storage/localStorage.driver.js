const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// The "local" STORAGE_DRIVER (config.storage.driver) — GoDaddy's ordinary
// filesystem, exactly what every upload/certificate path already used
// before this abstraction existed. A future S3Storage driver implements
// this exact same five-function shape (save/readStream/read/delete/exists)
// plus getUrl/removeFolder, so storage.service.js's callers never change.
//
// Every key this driver ever receives is one of the two shapes the app
// already produces and stores in the database — no new key format, so
// introducing this abstraction needs no data migration:
//   - "uploads/..."  -> a public, web-servable asset (logo, profile photo,
//     event/sponsor/article image, certificate background, email
//     attachment). Stored on User/Event/etc. as "/uploads/..." (leading
//     slash) — that's the literal URL express.static serves it at.
//   - "storage/..."  -> a private, generated file (currently only event
//     certificate PDFs). Stored on EventCertificate.filePath as exactly
//     this relative-from-project-root path, never web-accessible directly.
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

function normalizeKey(key) {
  return String(key).replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolvePath(key) {
  const normalized = normalizeKey(key);
  let absolute;
  if (normalized.startsWith('uploads/')) {
    absolute = path.join(PROJECT_ROOT, 'public', normalized);
  } else if (normalized.startsWith('storage/')) {
    absolute = path.join(PROJECT_ROOT, normalized);
  } else {
    throw new Error(`Unrecognized storage key (must start with "uploads/" or "storage/"): ${key}`);
  }
  // Defense in depth against path traversal — keys are always built
  // internally (generated filenames, or values already sitting in the DB),
  // never taken raw from user input, but this is cheap insurance against a
  // future caller that forgets that.
  const root = normalized.startsWith('uploads/') ? path.join(PROJECT_ROOT, 'public') : PROJECT_ROOT;
  if (!absolute.startsWith(root)) throw new Error(`Invalid storage key: ${key}`);
  return absolute;
}

async function save(buffer, key) {
  const absPath = resolvePath(key);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, buffer);
}

function readStream(key) {
  return fs.createReadStream(resolvePath(key));
}

async function read(key) {
  return fsp.readFile(resolvePath(key));
}

async function del(key) {
  try {
    await fsp.unlink(resolvePath(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Recursive delete of everything under a key treated as a directory (e.g.
// "storage/certificates/events/12") — an S3 driver would implement this as
// list-by-prefix + batch delete instead, since S3 has no real directories.
async function removeFolder(key) {
  try {
    await fsp.rm(resolvePath(key), { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function exists(key) {
  try {
    await fsp.access(resolvePath(key));
    return true;
  } catch {
    return false;
  }
}

function getUrl(key) {
  const normalized = normalizeKey(key);
  if (!normalized.startsWith('uploads/')) return null; // certificates etc. are never web-accessible directly
  return `/${normalized}`;
}

module.exports = { save, readStream, read, delete: del, removeFolder, exists, getUrl, resolvePath };
