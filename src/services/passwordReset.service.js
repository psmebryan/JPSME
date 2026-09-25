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

// An ACTIVATION link is the same credential with a very different life. A reset
// is answered within minutes by somebody who just failed to sign in; an
// activation lands unannounced in the inbox of somebody who was not expecting
// it and may not read mail until the weekend. An hour would expire almost all
// of them, and every expiry is a person who has to ask an admin to send another.
//
// Two weeks is the balance: long enough that the link is still good when they
// get round to it, short enough that a leaked mailbox from last term does not
// still open an account.
const ACTIVATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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
// `ttlMs` lets an activation link outlive a reset link. It is passed in rather
// than derived from the account here so this function stays a pure minter — the
// caller already knows which kind of mail it is about to send.
async function issueResetLink(userId, { ttlMs = TOKEN_TTL_MS } = {}) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
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
  return { url, ttlMs };
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

  // Which kind of link this is, so the page can render itself correctly.
  //
  // Derived from the account rather than carried in the URL: a flag in the link
  // would be something the holder could flip, and "is this an activation"
  // decides whether the form asks for an organization and whether submitting it
  // approves the account. That is not a decision to take from the query string.
  const user = await prisma.user.findUnique({
    where: { id },
    select: { passwordSetAt: true, organizationId: true, firstName: true },
  });
  if (!user) return { ok: false, reason: 'INVALID', message: REASONS.INVALID };

  return {
    ok: true,
    userId: id,
    isActivation: user.passwordSetAt === null,
    // Pre-fills the picker when an import happened to name one. The member can
    // still change it — an admin filling this column in is guessing, and the
    // person reading the page is not.
    organizationId: user.organizationId || null,
    firstName: user.firstName,
  };
}

// Sets the new password and burns the link, in one transaction: a password
// changed without the token being consumed would leave a working link behind.
async function completeReset({ userId, token, password, organizationId = null, ipAddress = null }) {
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'WEAK', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const check = await inspectToken(userId, token);
  if (!check.ok) return check;

  // --- activation only -------------------------------------------------------
  //
  // An imported account has no organization until the member picks one, and a
  // member with no organization is invisible to their own chapter. Enforced
  // here rather than only in the form: the form is a convenience, this is the
  // rule.
  const chosenOrg = organizationId ? Number(organizationId) : (check.organizationId || null);
  if (check.isActivation) {
    if (!chosenOrg || !Number.isInteger(chosenOrg)) {
      return { ok: false, reason: 'NO_ORGANIZATION', message: 'Please choose your school or organization.' };
    }
    const org = await prisma.organization.findUnique({
      where: { id: chosenOrg },
      select: { id: true, isActive: true },
    });
    if (!org || !org.isActive) {
      return { ok: false, reason: 'NO_ORGANIZATION', message: 'That organization was not found. Please choose again.' };
    }
  }

  const hashed = await bcrypt.hash(String(password), 10);
  const now = new Date();

  // The conditional update is the concurrency story: two submissions of the
  // same link race on `usedAt: null`, and exactly one wins. Without it, a
  // double-click could apply two different passwords and leave the account on
  // whichever landed second.
  //
  // For an activation this transaction carries four changes that must land
  // together or not at all — password, verification, organization, approval. A
  // half-applied activation is the worst outcome available here: an account that
  // is approved but has no password, or verified but has no chapter, is one a
  // member cannot use and an admin cannot diagnose.
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { userId: check.userId, usedAt: null },
      data: { usedAt: now },
    });
    if (claim.count !== 1) return false;

    const data = { password: hashed, passwordSetAt: now };
    if (check.isActivation) {
      // Using the link IS the proof the address reaches them, so there is no
      // separate six-digit code for an imported member — see the import plan.
      data.emailVerifiedAt = now;
      data.organizationId = chosenOrg;
      data.status = 'APPROVED';
    }
    await tx.user.update({ where: { id: check.userId }, data });
    return true;
  });

  if (!claimed) return { ok: false, reason: 'USED', message: REASONS.USED };

  await auditService.log({
    // Told apart on purpose: a member resetting a password they had is routine,
    // and an account coming to life for the first time is the moment an
    // imported row becomes a person who can sign in.
    action: check.isActivation ? 'ACCOUNT_ACTIVATED' : 'PASSWORD_RESET_COMPLETED',
    targetUserId: check.userId,
    metadata: check.isActivation ? { organizationId: chosenOrg } : null,
    ipAddress,
  });

  // Anyone already signed in as this account is signed out. A reset exists
  // because the password may be in somebody else's hands, and one that leaves
  // that person's session alive has not actually locked them out.
  const revoked = await revokeSessionsFor(check.userId);

  // Only for a reset. A "your password was changed" warning is useful to
  // somebody who did not change it; sending one to a member who has just
  // finished creating their account reads as an alarm about the thing they are
  // in the middle of doing.
  if (!check.isActivation) {
    await jobService.enqueue('SEND_PASSWORD_CHANGED_EMAIL', { userId: check.userId, byAdmin: false });
  }

  return {
    ok: true,
    userId: check.userId,
    sessionsRevoked: revoked,
    activated: Boolean(check.isActivation),
  };
}

// --- inviting somebody to activate ------------------------------------------

// Queues an activation email for one account.
//
// Refuses on an account that has already been activated rather than quietly
// doing nothing: the caller is either an admin clicking "resend" or a bulk
// send, and both want to know they aimed at somebody who no longer needs it.
// Returns false instead of throwing, because a bulk send hitting one already
// activated member should skip them and carry on, not abort the batch.
async function queueActivation(userId) {
  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, passwordSetAt: true },
  });
  if (!user || user.passwordSetAt !== null) return false;

  await jobService.enqueue('SEND_ACTIVATION_EMAIL', { userId: user.id });
  return true;
}

// How recently an invitation counts as "already sent", so pressing the button
// twice does not mail everybody twice. Long enough to cover a bulk send
// draining, short enough that a genuine "they say it never arrived" retry ten
// minutes later still works.
const RECENTLY_INVITED_MS = 10 * 60 * 1000;

// Everybody an import created who has not activated yet.
//
// Counted for the admin screen so "60 members are waiting to be invited" is
// visible without running the send — the number is the whole reason somebody
// presses the button.
async function pendingActivationCount() {
  return prisma.user.count({ where: { passwordSetAt: null } });
}

// Sends activation links to everyone still waiting for one.
//
// Separate from the import on purpose. Importing 500 rows must not fire 500
// emails from one button press: the queue drains one every couple of seconds,
// so that is twenty minutes of sending with no way to stop it, and a mistake in
// the sheet would already be in 500 inboxes before anybody noticed.
//
// Resumable and safe to press twice. Three things are skipped rather than
// re-sent, because "I clicked it again because I was not sure" is the normal
// way this gets used:
//
//   anyone who has since activated — the handler re-checks at send time too,
//   since a bulk send takes a while to drain;
//   anyone with an invitation still sitting in the queue;
//   anyone invited in the last few minutes.
async function sendActivationsForPending({ actorId = null } = {}) {
  const waiting = await prisma.user.findMany({
    where: { passwordSetAt: null },
    select: { id: true, email: true },
    orderBy: { id: 'asc' },
  });
  if (!waiting.length) return { queued: 0, skipped: 0, total: 0 };

  const ids = waiting.map((u) => u.id);

  // Still queued from a previous press. payload is text, so this is matched in
  // JS rather than with a LIKE that would also match id 1 inside id 12.
  const queuedJobs = await prisma.job.findMany({
    where: { type: 'SEND_ACTIVATION_EMAIL', status: { in: ['PENDING', 'PROCESSING'] } },
    select: { payload: true },
  });
  const alreadyQueued = new Set();
  queuedJobs.forEach((j) => {
    try { alreadyQueued.add(Number(JSON.parse(j.payload).userId)); } catch (err) { /* unreadable payload */ }
  });

  const recent = await prisma.passwordResetToken.findMany({
    where: { userId: { in: ids }, usedAt: null, createdAt: { gt: new Date(Date.now() - RECENTLY_INVITED_MS) } },
    select: { userId: true },
  });
  const invitedRecently = new Set(recent.map((t) => t.userId));

  let queued = 0;
  let skipped = 0;
  for (const user of waiting) {
    if (alreadyQueued.has(user.id) || invitedRecently.has(user.id)) { skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await jobService.enqueue('SEND_ACTIVATION_EMAIL', { userId: user.id });
    queued += 1;
  }

  if (queued) {
    await auditService.log({
      action: 'ACTIVATION_INVITES_SENT',
      actorId,
      metadata: { queued, skipped, total: waiting.length },
    });
  }

  return { queued, skipped, total: waiting.length };
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
  queueActivation,
  pendingActivationCount,
  sendActivationsForPending,
  TOKEN_TTL_MS,
  ACTIVATION_TTL_MS,
  MIN_PASSWORD_LENGTH,
};
