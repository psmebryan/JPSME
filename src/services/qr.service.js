const crypto = require('crypto');
const QRCode = require('qrcode');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const auditService = require('./audit.service');

// What actually gets encoded into the QR image: a fixed prefix plus the random
// token, e.g. "PSME-EVENT:9f2c...". Deliberately NOT a URL.
//
// A URL would bake this deployment's domain into every printed ticket, and
// APP_URL is still localhost — every ticket produced before the real domain is
// set would be permanently wrong, on paper, in someone's hand. The prefixed
// form survives a domain change, a move to a subdomain, and HTTP -> HTTPS,
// because the server resolves the token rather than the reader following a
// link. It is also ~40 characters shorter, which matters when a gun scanner
// has to "type" the whole string as keystrokes.
//
// The prefix earns its place by making a stray scan identifiable: a scanner
// pointed at a shipping label or someone's bank QR produces something without
// it, which the check-in screen can reject as "not a PSME ticket" rather than
// as a token that merely happens not to exist.
const QR_PAYLOAD_PREFIX = 'PSME-EVENT:';

// 32 bytes = 256 bits of entropy, hex-encoded to 64 characters. Guessing one is
// not a thing an attacker can do. The token is the only credential the door
// checks, so it is sized like a credential rather than like an id.
const QR_TOKEN_BYTES = 32;
const QR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// A collision at 256 bits will not happen. The retry exists because "will not
// happen" is not "cannot", and the alternative on a unique-constraint violation
// is a failed registration — so we re-roll rather than reuse or surface an
// error. It never reuses an existing token, which is the one outcome that would
// put two people behind a single ticket.
const MAX_TOKEN_ATTEMPTS = 5;

function generateQrToken() {
  return crypto.randomBytes(QR_TOKEN_BYTES).toString('hex');
}

function buildQrPayload(token) {
  return QR_PAYLOAD_PREFIX + token;
}

// Turns whatever the scanner actually sent into a bare token, or null if it
// could not have come from one of our QR codes.
//
// Handles the ways a real gun scanner mangles input: surrounding whitespace and
// the trailing CR/LF it appends as its "Enter"; a prefix the scanner may have
// been configured to strip on its own, so a bare token is accepted too; and
// case, since some scanners transmit in caps. Anything that is not 64 hex
// characters after that is rejected here, rather than being handed to the
// database as a lookup.
function normalizeScannedValue(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;

  const prefix = value.slice(0, QR_PAYLOAD_PREFIX.length).toUpperCase();
  if (prefix === QR_PAYLOAD_PREFIX.toUpperCase()) {
    value = value.slice(QR_PAYLOAD_PREFIX.length).trim();
  }

  value = value.toLowerCase();
  return QR_TOKEN_PATTERN.test(value) ? value : null;
}

// "REG-2026-000123" — derived from the registration's own id rather than from a
// per-year counter. A counter needs a read-then-write that two concurrent
// registrations can both win, and the retry loop that repairs it buys nothing:
// the id is already unique and already assigned. The number is therefore a
// per-year label, not a per-year sequence; it is a reference to read aloud and
// search by, not a count of anything.
//
// It is a human reference, never a credential. It is printed on the ticket
// beside the QR, but the door checks qrToken alone — knowing someone's
// registration number gets you nothing.
function buildRegistrationNumber(registration) {
  const created = registration.createdAt instanceof Date
    ? registration.createdAt
    : new Date(registration.createdAt);
  return 'REG-' + created.getFullYear() + '-' + String(registration.id).padStart(6, '0');
}

function isUniqueViolationOn(err, field) {
  return err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === 'P2002'
    && Array.isArray(err.meta && err.meta.target)
    && err.meta.target.some((t) => String(t).includes(field));
}

// Mints the QR identity for a registration that has just become valid.
//
// `client` is the shared prisma instance for a standalone call, or a `tx` handle
// when called from inside the transaction that flips the registration to
// REGISTERED — which is how phase 3 will use it, so a row can never commit as
// valid-but-unticketed.
//
// Idempotent by default: a registration that already has a token keeps it. A
// retried webhook or a double-submitted free registration must not silently
// invalidate a ticket the member may already have saved to their phone.
//
// `reissue: true` is the one case that overrides that — reviving a CANCELLED
// registration. The member's previous ticket must not come back to life along
// with the registration, so a fresh token is minted and the old value is gone.
// Anyone holding a printout or screenshot from before the cancellation is
// holding a dead code, permanently.
async function assignRegistrationIdentity(client, registrationId, options) {
  const reissue = Boolean(options && options.reissue);
  const registration = await client.eventRegistration.findUnique({ where: { id: Number(registrationId) } });
  if (!registration) throw new AppError('Registration not found', 404);
  if (registration.qrToken && !reissue) return registration;

  const registrationNumber = registration.registrationNumber || buildRegistrationNumber(registration);

  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await client.eventRegistration.update({
        where: { id: registration.id },
        data: { registrationNumber, qrToken: generateQrToken(), qrGeneratedAt: new Date() },
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'qrToken') && attempt < MAX_TOKEN_ATTEMPTS) continue;
      throw err;
    }
  }
  throw new AppError('Could not allocate a unique QR token', 500);
}

// Admin action: replace a registration's token, killing the previous one.
//
// The old token is overwritten, not archived. Afterwards the previous QR is not
// "revoked" in a table somewhere — it simply resolves to nothing, the same
// answer the door gives a code that was never ours. That is the whole point of
// regeneration: a ticket that leaked or printed wrong has to stop working, and
// the only way to be certain is for the value itself to be gone.
//
// Deliberately does NOT clear checkedInAt — reissuing a ticket to someone
// already admitted must not readmit them.
async function regenerateQr({ registrationId, adminUserId, ipAddress = null }) {
  const existing = await prisma.eventRegistration.findUnique({ where: { id: Number(registrationId) } });
  if (!existing) throw new AppError('Registration not found', 404);
  if (existing.status !== 'REGISTERED') {
    throw new AppError('Only a confirmed registration can have its QR regenerated', 400);
  }

  let updated = null;
  for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      updated = await prisma.eventRegistration.update({
        where: { id: existing.id },
        data: {
          registrationNumber: existing.registrationNumber || buildRegistrationNumber(existing),
          qrToken: generateQrToken(),
          qrGeneratedAt: new Date(),
        },
      });
      break;
    } catch (err) {
      if (isUniqueViolationOn(err, 'qrToken') && attempt < MAX_TOKEN_ATTEMPTS) continue;
      throw err;
    }
  }
  if (!updated) throw new AppError('Could not allocate a unique QR token', 500);

  await auditService.log({
    action: existing.qrToken ? 'QR_REGENERATED' : 'QR_GENERATED',
    actorId: adminUserId,
    targetUserId: existing.userId,
    // The old token is never recorded, here or anywhere else. Writing it to the
    // audit log would defeat the regeneration — a readable copy of a killed
    // credential is still a copy.
    metadata: {
      registrationId: existing.id,
      eventId: existing.eventId,
      registrationNumber: updated.registrationNumber,
      hadPreviousToken: Boolean(existing.qrToken),
    },
    ipAddress,
  });

  return updated;
}

// Resolves a scanned value to the registration it belongs to.
//
// The scope is deliberately narrow: does this token exist, and whose is it.
// Whether that registration may actually pass the door — right event, not
// cancelled, paid where payment is required, not already admitted — is
// checkin.service's decision in phase 5, because those answers depend on the
// door being scanned at rather than on the token. Keeping the two apart is what
// stops "the QR is valid" from quietly coming to mean "let them in".
async function validateQrToken(rawScannedValue) {
  const token = normalizeScannedValue(rawScannedValue);
  if (!token) return { token: null, registration: null };

  const registration = await prisma.eventRegistration.findUnique({
    where: { qrToken: token },
    include: {
      event: true,
      user: { select: { id: true, status: true, profileImage: true } },
    },
  });

  return { token, registration: registration || null };
}

// Error correction level H recovers a code with up to ~30% of its area damaged
// — the level to use when a ticket will be folded, printed on a home printer,
// creased in a pocket, or read off a scratched phone screen at a crowded door.
// Margin 4 is the quiet zone the QR spec requires; scanners fail on codes butted
// straight up against surrounding artwork.
const QR_RENDER_OPTIONS = {
  errorCorrectionLevel: 'H',
  margin: 4,
  color: { dark: '#000000', light: '#FFFFFF' },
};

async function renderQrPng(token, options) {
  const width = (options && options.width) || 512;
  return QRCode.toBuffer(buildQrPayload(token), Object.assign({}, QR_RENDER_OPTIONS, { type: 'png', width }));
}

async function renderQrSvg(token, options) {
  const width = (options && options.width) || 512;
  return QRCode.toString(buildQrPayload(token), Object.assign({}, QR_RENDER_OPTIONS, { type: 'svg', width }));
}

// For embedding straight into an EJS page or a PDF without writing a file first.
async function renderQrDataUrl(token, options) {
  const width = (options && options.width) || 512;
  return QRCode.toDataURL(buildQrPayload(token), Object.assign({}, QR_RENDER_OPTIONS, { width }));
}

module.exports = {
  QR_PAYLOAD_PREFIX,
  generateQrToken,
  buildQrPayload,
  normalizeScannedValue,
  buildRegistrationNumber,
  assignRegistrationIdentity,
  regenerateQr,
  validateQrToken,
  renderQrPng,
  renderQrSvg,
  renderQrDataUrl,
};
