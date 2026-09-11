const { Readable } = require('stream');
const path = require('path');
const prisma = require('../../config/prisma');

// The "database" STORAGE_DRIVER — uploaded files kept as rows rather than as
// files on disk.
//
// This exists because the host wipes the filesystem on every deploy. A logo
// uploaded through the admin panel worked until the next publish and then 404'd
// on every page of the site, which is exactly where the site logo and every
// sponsor image ended up. Anything a person uploads has to outlive a deploy,
// and on this host the database is the only thing that does.
//
// Implements the same shape as localStorage.driver — save/readStream/read/
// delete/removeFolder/exists/getUrl — so storage.service's callers never knew
// it changed. Keys keep the identical format the filesystem driver used as a
// path ("uploads/logo/logo-1699-abc.png"), so no stored URL needed rewriting.

// Guessed from the extension rather than trusted from the upload: every caller
// already generates the extension itself from the original filename, and the
// value is served back as a Content-Type header, where a wrong or attacker-
// chosen value is how an "image" gets interpreted as something else.
const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

function normalizeKey(key) {
  return String(key).replace(/\\/g, '/').replace(/^\/+/, '');
}

// Same contract the filesystem driver enforced. Keys are always built
// internally, but a key that is neither an upload nor a generated file is a
// caller bug worth failing loudly on rather than storing something unreachable.
function assertManagedKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized.startsWith('uploads/') && !normalized.startsWith('storage/')) {
    throw new Error(`Unrecognized storage key (must start with "uploads/" or "storage/"): ${key}`);
  }
  return normalized;
}

function mimeTypeFor(key) {
  return MIME_BY_EXTENSION[path.extname(normalizeKey(key)).toLowerCase()] || 'application/octet-stream';
}

// Upsert rather than create: re-saving the same key has to replace, the way
// writing a file does. Generated filenames make a collision essentially
// impossible, so this is about matching the contract, not about a case that
// happens.
async function save(buffer, key) {
  const normalized = assertManagedKey(key);
  const data = { data: buffer, size: buffer.length, mimeType: mimeTypeFor(normalized) };
  await prisma.storedFile.upsert({
    where: { key: normalized },
    update: data,
    create: { key: normalized, ...data },
  });
}

async function read(key) {
  const normalized = assertManagedKey(key);
  const row = await prisma.storedFile.findUnique({ where: { key: normalized } });
  if (!row) {
    // Shaped like the filesystem error callers already handle, so a missing
    // file behaves the same whichever driver is behind it.
    const err = new Error(`No stored file for key: ${normalized}`);
    err.code = 'ENOENT';
    throw err;
  }
  return Buffer.from(row.data);
}

// A real stream would need cursor-based chunking, which buys nothing here: the
// row is already fully in memory the moment it is read, and these are images
// and single certificates rather than large media.
function readStream(key) {
  const stream = new Readable({ read() {} });
  read(key)
    .then((buffer) => { stream.push(buffer); stream.push(null); })
    .catch((err) => stream.destroy(err));
  return stream;
}

async function del(key) {
  const normalized = assertManagedKey(key);
  // deleteMany, not delete: deleting something already gone is a no-op for a
  // file and must be one here too.
  await prisma.storedFile.deleteMany({ where: { key: normalized } });
}

// The equivalent of a recursive directory delete — by key prefix, the way an
// S3 driver would have to do it too, since neither store has real directories.
async function removeFolder(key) {
  const normalized = assertManagedKey(key);
  const prefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
  await prisma.storedFile.deleteMany({
    // Both the folder itself and everything beneath it, matching rm -r.
    where: { OR: [{ key: normalized }, { key: { startsWith: prefix } }] },
  });
}

async function exists(key) {
  const normalized = assertManagedKey(key);
  const count = await prisma.storedFile.count({ where: { key: normalized } });
  return count > 0;
}

// Identical to the filesystem driver's: the URL is the key with a leading
// slash. What changes is who answers that URL — express.static served it from
// disk, and now a route reads it from here (see app.js). Private keys
// ("storage/...") return null, so a certificate can never become a public URL
// by accident.
function getUrl(key) {
  const normalized = normalizeKey(key);
  if (!normalized.startsWith('uploads/')) return null;
  return `/${normalized}`;
}

// Deliberately absent, unlike the filesystem driver: there is no path to give.
// The one caller that wanted one (email attachments) now reads the bytes
// instead, which works for either driver.
function resolvePath(key) {
  throw new Error(
    `Storage driver "database" has no filesystem path for ${key}. `
    + 'Read the bytes with storageService.read() instead.'
  );
}

module.exports = { save, readStream, read, delete: del, removeFolder, exists, getUrl, resolvePath };
