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

// How much of a file goes in one row.
//
// The number that matters is MySQL's max_allowed_packet, which caps both the
// largest statement the server will accept and the largest row it will send
// back. It defaults to 1 MB — that is what XAMPP's MariaDB ships with — and on
// the live host it is a server setting we do not get to change.
//
// Writing a whole file in one statement therefore worked up to about a
// megabyte and then stopped, and not with an error anyone could act on:
// MariaDB closes the connection rather than refusing, so a 1.2 MB logo came
// back as a bare 500. 256 KB leaves a four-fold margin against the smallest
// default, which is the point — this should not need retuning per host.
const CHUNK_SIZE = 256 * 1024;

function chunksOf(buffer) {
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
    pieces.push(buffer.subarray(offset, Math.min(offset + CHUNK_SIZE, buffer.length)));
  }
  // A zero-byte file still needs one row, or it would read back as missing
  // rather than as empty.
  if (!pieces.length) pieces.push(Buffer.alloc(0));
  return pieces;
}

// Replaces whatever was at this key, the way writing a file does. Generated
// filenames make a collision essentially impossible, so that is about matching
// the contract rather than a case that happens.
//
// In a transaction because a file is now several rows: a half-written file
// that other requests could read would be worse than no file at all. The
// delete goes first and cascades to the old chunks, so a shorter file
// replacing a longer one cannot leave the tail of the old one behind.
async function save(buffer, key) {
  const normalized = assertManagedKey(key);
  const pieces = chunksOf(buffer);

  await prisma.$transaction(async (tx) => {
    await tx.storedFile.deleteMany({ where: { key: normalized } });
    await tx.storedFile.create({
      data: {
        key: normalized,
        size: buffer.length,
        mimeType: mimeTypeFor(normalized),
      },
    });

    // One statement per chunk, deliberately — createMany would put the whole
    // file back in a single statement and reintroduce exactly the limit this
    // is here to get under.
    for (let seq = 0; seq < pieces.length; seq += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tx.storedFileChunk.create({ data: { key: normalized, seq, data: pieces[seq] } });
    }
  }, {
    // A 5 MB upload is twenty round trips. The default 5s is enough locally
    // and is not worth betting an upload on over a slower connection.
    timeout: 60000,
    maxWait: 15000,
  });
}

async function read(key) {
  const normalized = assertManagedKey(key);
  const row = await prisma.storedFile.findUnique({
    where: { key: normalized },
    include: { chunks: { orderBy: { seq: 'asc' } } },
  });

  if (!row) {
    // Shaped like the filesystem error callers already handle, so a missing
    // file behaves the same whichever driver is behind it.
    const err = new Error(`No stored file for key: ${normalized}`);
    err.code = 'ENOENT';
    throw err;
  }

  // Anything written before chunking existed still lives in the column. Only
  // ever a handful of files, and only ever small ones — nothing bigger than a
  // packet could be written back then.
  if (!row.chunks.length) {
    if (row.data) return Buffer.from(row.data);
    const err = new Error(`Stored file has no contents: ${normalized}`);
    err.code = 'ENOENT';
    throw err;
  }

  return Buffer.concat(row.chunks.map((chunk) => Buffer.from(chunk.data)));
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
  // file and must be one here too. The chunks go with it, by cascade.
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
