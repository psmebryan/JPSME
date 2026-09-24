// Losing a password, and getting back in.
//
// THE RULE THAT SHAPES EVERYTHING HERE: the request endpoint must not reveal
// whether an address has an account. "No account with that email" is a free
// membership check for anyone with a list of addresses, and this site's members
// are students whose addresses are guessable from their names. So every request
// gets the same answer, in the same time, whether or not anybody was mailed.
//
// That is why requestReset returns nothing useful and never throws for an
// unknown address. It is not vagueness — it is the feature.
//
// The link carries 32 random bytes. A six-digit code is safe for verification
// because it is short-lived AND attempt-limited AND already tied to a known
// account; a reset link is issued to anyone who can type an address, so it has
// to be unguessable on its own.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const config = require('../config');
const auditService = require('./audit.service');
const jobService = require('./job.service');

// Long enough to survive a slow mail relay and somebody reading it on a phone
// later; short enough that a link left in an inbox is not a standing key.
const TOKEN_TTL_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

// Matches the registration rule. Reset is not the place to introduce a
// stricter one — somebody locked out is the worst audience for a new rule they
// have to discover by failing.
const MIN_PASSWORD_LENGTH = 8;

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// The user id is mixed in for the same reason it is in the verification code:
// a leaked digest cannot be matched against a precomputed table without also
// knowing which account it belongs to.
function hashToken(userId, token) {
  return crypto.createHash('sha256').update(`${userId}:${String(token).trim()}`).digest('hex');
}

function appUrl() {
  return String(config.appUrl || '').replace(/\/+$/, '');
}

// --- asking for a link ------------------------------------------------------

// Always resolves, always the same shape, whether or not an account exists.
//
// The work is queued rather than done inline, which matters for more than
// throughput: sending mail inline makes the response measurably slower when an
// account exists than when it does not, and that timing difference is the same
// account check the uniform message exists to prevent.
async function requestReset(email, { ipAddress = null } = {}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return;

  const user = await prisma.user.findUnique({
    where: { email: address },
    select: { id: true, email: true, firstName: true },
  });
  if (!user) return;

  await jobService.enqueue('SEND_PASSWORD_RESET_EMAIL', { userId: user.id });

  await auditService.log({
    action: 'PASSWORD_RESET_REQUESTED',
    targetUserId: user.id,
    metadata: { email: user.email },
    ipAddress,
  });
}

// Mints the token and returns the link. Called by the job handler, not by the
// request path — so the plaintext token exists only inside the process that is
// about to put it in an email, and never sits in a queue row on disk.
async function issueResetLink(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const tokenHash = hashToken(userId, token);

  // upsert, not create: one live reset per account. A second request replaces
  // the first, which is what stops an older intercepted mail from still
  // working after the real owner asks again.
  await prisma.passwordResetToken.upsert({
    where: { userId: Number(userId) },
    create: { userId: Number(userId), tokenHash, expiresAt },
    update: { tokenHash, expiresAt, usedAt: null, createdAt: new Date() },
  });

  // The id travels in the URL beside the token because the hash is salted with
  // it — without knowing the account there is nothing to hash against. It is
  // not a secret and grants nothing on its own.
  const url = `${appUrl()}/reset-password?uid=${userId}&token=${token}`;
  return { url, ttlMs: TOKEN_TTL_MS };
}

// --- using a link -----------------------------------------------------------

// Why a reason code rather than a boolean: an expired link and a link that was
// already used are different problems with different next steps, and telling
// somebody "invalid" when the truth is "you already did this" is what sends
// them round the loop three more times.
//
// None of these reveal anything an attacker does not already have. They hold
// the link; what they learn is about the link.
const REASONS = {
  INVALID: 'This reset link is not valid. Please request a new one.',
  EXPIRED: 'This reset link has expired. Please request a new one.',
  USED: 'This reset link has already been used. Request a new one if you still need to change your password.',
};

async function inspectToken(userId, token) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || !token) return { ok: false, reason: 'INVALID', message: REASONS.INVALID };

  const row = await prisma.passwordResetToken.findUnique({ where: { userId: id } });
  if (!row) return { ok: false, reason: 'INVALID', message: REASONS.INVALID };

  // Constant-time, because a fast hash is not a reason to leak how much of a
  // token matched.
  const presented = Buffer.from(hashToken(id, token), 'utf8');
  const stored = Buffer.from(row.tokenHash, 'utf8');
  if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
    return { ok: false, reason: 'INVALID', message: REASONS.INVALID };
  }

  // Order matters: "already used" is checked before expiry, because a used link
  // that has since expired should still say used — that is the more useful
  // truth and the one that stops them retrying.
  if (row.usedAt) return { ok: false, reason: 'USED', message: REASONS.USED };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED', message: REASONS.EXPIRED };

  return { ok: true, userId: id };
}

// Sets the new password and burns the link, in one transaction: a password
// changed without the token being consumed would leave a working link behind.
async function completeReset({ userId, token, password, ipAddress = null }) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'WEAK', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const check = await inspectToken(userId, token);
  if (!check.ok) return check;

  const hashed = await bcrypt.hash(String(password), 10);

  // The conditional update is the concurrency story: two submissions of the
  // same link race on `usedAt: null`, and exactly one wins. Without it, a
  // double-click could apply two different passwords and leave the account on
  // whichever landed second.
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { userId: check.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await tx.user.update({ where: { id: check.userId }, data: { password: hashed } });
    return true;
  });

  if (!claimed) return { ok: false, reason: 'USED', message: REASONS.USED };

  await auditService.log({
    action: 'PASSWORD_RESET_COMPLETED',
    targetUserId: check.userId,
    ipAddress,
  });

  // Anyone already signed in as this account is signed out. A reset exists
  // because the password may be in somebody else's hands, and one that leaves
  // that person's session alive has not actually locked them out.
  const revoked = await revokeSessionsFor(check.userId);

  await jobService.enqueue('SEND_PASSWORD_CHANGED_EMAIL', { userId: check.userId, byAdmin: false });

  return { ok: true, userId: check.userId, sessionsRevoked: revoked };
}

// --- signing out everywhere -------------------------------------------------

// express-mysql-session keeps the serialised session in a text column, so there
// is no indexed way to ask "whose sessions are these". Read and parse instead:
// this table holds one row per signed-in browser for one student organisation,
// not a web-scale session store, and correctness is worth more here than a
// clever LIKE that could match the wrong row.
//
// Never throws. A password that was successfully changed must not report
// failure because the session sweep had a bad day — the important half already
// committed.
async function revokeSessionsFor(userId) {
  try {
    const rows = await prisma.$queryRawUnsafe('SELECT session_id, data FROM sessions');
    const doomed = [];
    rows.forEach((row) => {
      try {
        const parsed = JSON.parse(row.data);
        const id = parsed && parsed.user && parsed.user.id;
        if (Number(id) === Number(userId)) doomed.push(row.session_id);
      } catch (err) { /* a row we cannot parse is not a row we should delete */ }
    });
    if (!doomed.length) return 0;

    const placeholders = doomed.map(() => '?').join(',');
    await prisma.$executeRawUnsafe(`DELETE FROM sessions WHERE session_id IN (${placeholders})`, ...doomed);
    return doomed.length;
  } catch (err) {
    return 0;
  }
}

module.exports = {
  requestReset,
  issueResetLink,
  inspectToken,
  completeReset,
  revokeSessionsFor,
  hashToken,
  TOKEN_TTL_MS,
  MIN_PASSWORD_LENGTH,
};
