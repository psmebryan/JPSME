const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { sendVerificationEmail, sendMemberApprovedEmail, sendAccountApprovedEmail } = require('./mail.service');
const membershipService = require('./membership.service');

// A typed six-digit code rather than a clicked link.
//
// A link has to carry this deployment's own URL, which makes every email only
// as good as that URL being correct and reachable — get it wrong and the mail
// is already sent, already in someone's inbox, and permanently useless. A code
// carries nothing but itself: it works from any device, survives a domain
// change, and can be read out over the phone.
//
// What it costs is entropy. Six digits is a million possibilities, not 2^256,
// so unlike the old token this credential has to be actively defended:
//   - it lives 30 minutes, not 24 hours
//   - five wrong guesses destroy it
//   - it is bound to one account, so guessing must be aimed, not sprayed
//   - the route on top of this is rate limited as well
const CODE_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// randomInt, not Math.random: this is a credential, and it is short enough that
// a predictable generator would be genuinely searchable.
function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// The user id is part of the hash so that two people issued the same six digits
// do not produce the same stored value, and so a leaked hash cannot be matched
// against a precomputed table of all million codes without also knowing the
// account it belongs to.
function hashCode(userId, code) {
  return crypto.createHash('sha256').update(`${userId}:${String(code).trim()}`).digest('hex');
}

// Replaces any previous code for this user, and resets the attempt counter —
// otherwise a fresh code would inherit the old one's exhausted guesses.
async function issueVerificationCode(user) {
  const code = generateCode();
  const data = {
    codeHash: hashCode(user.id, code),
    attempts: 0,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  };

  await prisma.emailVerificationToken.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });

  await sendVerificationEmail(user, code);
}

// One deliberately vague message for every failure below.
//
// Distinguishing "no such account", "already verified", "wrong code" and "no
// code outstanding" would turn this endpoint into a way to ask whether an
// address is registered, and into a way to tell a wrong guess from a wrong
// email while guessing. The person who genuinely has the code in front of them
// is not helped by the distinction; everyone else is.
function rejected() {
  return new AppError('That code is incorrect or has expired. Request a new one below.', 400);
}

// Verifying takes the email as well as the code. That is what keeps a six-digit
// secret workable: a guess has to be aimed at one named account, so the search
// space is a million per account rather than a million across all of them.
async function verifyEmailCode(email, code) {
  const cleaned = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) throw rejected();

  const user = await prisma.user.findUnique({
    where: { email: String(email || '').trim().toLowerCase() },
    include: { emailVerificationToken: true },
  });

  // Already verified is reported the same way as unknown — see rejected().
  if (!user || user.emailVerifiedAt || !user.emailVerificationToken) throw rejected();

  const record = user.emailVerificationToken;

  if (record.expiresAt < new Date()) {
    await prisma.emailVerificationToken.delete({ where: { userId: user.id } }).catch(() => {});
    throw rejected();
  }

  // Counted before the comparison, not after. A guess that crashes the process
  // between comparing and recording would otherwise be free, and free guesses
  // are the whole attack against a six-digit secret.
  const attempts = record.attempts + 1;
  await prisma.emailVerificationToken.update({ where: { userId: user.id }, data: { attempts } });

  const expected = Buffer.from(record.codeHash, 'hex');
  const supplied = Buffer.from(hashCode(user.id, cleaned), 'hex');
  const matches = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);

  if (!matches) {
    // Out of guesses: destroy the code rather than leave it alive at its limit.
    // A new one has to be requested, which is rate limited and which emails the
    // real owner — so a sustained search is both slow and noisy.
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.emailVerificationToken.delete({ where: { userId: user.id } }).catch(() => {});
    }
    throw rejected();
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } }),
    prisma.emailVerificationToken.delete({ where: { userId: user.id } }),
  ]);

  // Catching up an account that was approved before its address was verified.
  //
  // setStatus now refuses to approve an unverified account at all, so nothing
  // new lands in this state — but accounts approved before that rule existed
  // still do, and they were never told. They are told here, at the first moment
  // the message is both true and going to an address we know is theirs.
  //
  // Which message depends on what they actually are. Someone who has paid gets
  // the membership email; someone approved but unpaid gets the account one.
  // Sending the membership email to a non-member is the exact mistake this
  // whole split exists to stop, and it would be no less wrong here.
  //
  // Best-effort and after the transaction, like every other send in this app —
  // a mail failure must never undo a verification the person completed
  // correctly, which would leave them unable to verify at all.
  if (user.status === 'APPROVED') {
    try {
      // Re-read for the organization the templates substitute; `user` above was
      // loaded with the verification token, not the organization.
      const approved = await prisma.user.findUnique({
        where: { id: user.id },
        include: { organization: true },
      });
      if (approved) {
        const membership = await membershipService.getMembershipStatus(approved.id);
        if (membership.tier === membershipService.MEMBERSHIP_TIERS.MEMBER) {
          sendMemberApprovedEmail(approved);
        } else {
          sendAccountApprovedEmail(approved);
        }
      }
    } catch (err) {
      console.error('verifyEmailCode: failed to send the held approval email to', user.email, ':', err.message);
    }
  }

  return user;
}

// Always resolves without revealing whether the email exists, to avoid account
// enumeration — the caller cannot tell a sent code from a silent no-op.
async function resendVerification(email) {
  const user = await prisma.user.findUnique({
    where: { email: String(email || '').trim().toLowerCase() },
  });
  if (user && !user.emailVerifiedAt) {
    await issueVerificationCode(user);
  }
}

module.exports = {
  issueVerificationCode,
  verifyEmailCode,
  resendVerification,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
};
