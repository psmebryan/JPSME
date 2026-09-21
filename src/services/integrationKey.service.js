// Credentials that let another system scan one event's tickets.
//
// WHY THIS EXISTS AT ALL
//
// The QR payload is opaque on purpose: 32 random bytes that encode nothing
// about the person or the event (see EventRegistration.qrToken). A second
// system pointed at a JPSME ticket therefore reads a meaningless string. It has
// exactly two ways to make sense of one — hold a copy of every live token, or
// ask this server. Handing out a file of live tokens is handing out a file of
// working tickets, so this is the other way.
//
// WHAT A KEY IS
//
//   jpsme_ik_<keyId>_<secret>
//              12 hex   64 hex
//
// Two halves, and the split is the whole design:
//
//   keyId is public. It is stored in the clear and indexed, so authenticating a
//   scan is ONE indexed lookup. If the entire key were hashed, finding the
//   matching row would mean hashing against every key in the table on every
//   scan — the wrong shape for a door with a queue in front of it.
//
//   secret is hashed with SHA-256 and shown once, at creation. Nothing stores
//   it afterwards, so there is nothing to leak later.
//
// SHA-256 AND NOT BCRYPT, deliberately. Slow hashes exist to make LOW-entropy
// human passwords expensive to guess. This secret is 32 bytes straight from the
// CSPRNG — there is no dictionary, no pattern, and nothing to brute force. A
// deliberately slow hash here would buy no security and would slow down every
// person waiting to get in.
//
// The comparison is still constant-time: a fast hash does not excuse leaking
// how much of a secret matched via timing.

const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const auditService = require('./audit.service');

const KEY_PREFIX = 'jpsme_ik_';
const KEY_ID_BYTES = 6;      // 12 hex characters
const SECRET_BYTES = 32;     // 64 hex characters, 256 bits

// Presented keys are matched against this before any database work, so a
// malformed Authorization header costs nothing.
const KEY_PATTERN = new RegExp(`^${KEY_PREFIX}([0-9a-f]{12})_([0-9a-f]{64})$`);

// lastUsedAt answers "is this key still in use?", which does not need
// per-scan resolution. Without this throttle a door scanning six hundred people
// writes six hundred times to one row — and those writes serialise against each
// other on the same row, at exactly the moment the queue is longest.
const LAST_USED_THROTTLE_MS = 60 * 1000;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

// Constant-time compare of two hex digests. Falls back to a plain false on a
// length mismatch, because timingSafeEqual throws rather than returning false
// when the buffers differ in length.
function digestsMatch(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// What is safe to show in a list: everything except the secret, which no longer
// exists anywhere by this point.
function publicView(key) {
  return {
    id: key.id,
    eventId: key.eventId,
    label: key.label,
    keyId: key.keyId,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    active: !key.revokedAt,
    createdBy: key.createdByUser
      ? `${key.createdByUser.firstName} ${key.createdByUser.lastName}`.trim()
      : null,
    revokedBy: key.revokedByUser
      ? `${key.revokedByUser.firstName} ${key.revokedByUser.lastName}`.trim()
      : null,
  };
}

// --- issuing ----------------------------------------------------------------

async function createKey({ eventId, label, adminUserId, ipAddress = null }) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const trimmed = String(label || '').trim();
  if (!trimmed) throw new AppError('A label is required', 422);

  const keyId = crypto.randomBytes(KEY_ID_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');

  const created = await prisma.eventIntegrationKey.create({
    data: {
      eventId: Number(eventId),
      label: trimmed.slice(0, 120),
      keyId,
      secretHash: hashSecret(secret),
      createdBy: adminUserId ? Number(adminUserId) : null,
    },
  });

  await auditService.log({
    action: 'INTEGRATION_KEY_CREATED',
    actorId: adminUserId,
    // The keyId, never the secret. An audit log is not a place to put a live
    // credential — it is read by more people, and kept for longer, than
    // anything that should hold one.
    metadata: { eventId: Number(eventId), keyId, label: created.label },
    ipAddress,
  });

  // The only moment the full key exists in one piece. The caller must show it
  // now, because nothing can reconstruct it afterwards.
  return { key: publicView(created), plaintext: `${KEY_PREFIX}${keyId}_${secret}` };
}

async function listKeys(eventId) {
  const rows = await prisma.eventIntegrationKey.findMany({
    where: { eventId: Number(eventId) },
    include: {
      createdByUser: { select: { firstName: true, lastName: true } },
      revokedByUser: { select: { firstName: true, lastName: true } },
    },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
  });
  return rows.map(publicView);
}

async function revokeKey({ keyRowId, adminUserId, ipAddress = null }) {
  const existing = await prisma.eventIntegrationKey.findUnique({ where: { id: Number(keyRowId) } });
  if (!existing) throw new AppError('Key not found', 404);

  // Conditional update rather than read-then-write: two admins revoking at once
  // should produce one revocation with one timestamp and one name on it, not a
  // race over who gets recorded.
  const claim = await prisma.eventIntegrationKey.updateMany({
    where: { id: Number(keyRowId), revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: adminUserId ? Number(adminUserId) : null },
  });
  if (claim.count !== 1) throw new AppError('This key is already revoked', 409);

  await auditService.log({
    action: 'INTEGRATION_KEY_REVOKED',
    actorId: adminUserId,
    metadata: { eventId: existing.eventId, keyId: existing.keyId, label: existing.label },
    ipAddress,
  });

  return publicView(await prisma.eventIntegrationKey.findUnique({ where: { id: Number(keyRowId) } }));
}

// --- authenticating ---------------------------------------------------------

// Resolves a presented key to the event it opens, or null.
//
// Null for every failure, with no distinction between "no such key", "wrong
// secret" and "revoked". The caller turns all of them into one 401: telling an
// unauthenticated caller WHICH part of its credential was wrong is telling it
// how to get closer.
async function authenticate(presented) {
  const match = KEY_PATTERN.exec(String(presented || '').trim());
  if (!match) return null;

  const [, keyId, secret] = match;
  const row = await prisma.eventIntegrationKey.findUnique({
    where: { keyId },
    include: { event: { select: { id: true, title: true, startDate: true, endDate: true } } },
  });
  if (!row) return null;
  if (!digestsMatch(row.secretHash, hashSecret(secret))) return null;
  if (row.revokedAt) return null;

  return row;
}

// Fire-and-forget: a failure to record that a key was used must never fail the
// scan that used it. Someone is standing at a door.
function touch(row) {
  const last = row.lastUsedAt ? row.lastUsedAt.getTime() : 0;
  if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
  prisma.eventIntegrationKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}

module.exports = {
  createKey,
  listKeys,
  revokeKey,
  authenticate,
  touch,
  publicView,
  // Exported for the tests, which assert the format rather than trusting it.
  KEY_PREFIX,
  KEY_PATTERN,
  hashSecret,
};
