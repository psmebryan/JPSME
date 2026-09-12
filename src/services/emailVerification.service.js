const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
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
//   - it lives three minutes, not 24 hours
//   - five wrong guesses destroy it
//   - it is bound to one account, so guessing must be aimed, not sprayed
//   - the route on top of this is rate limited as well
//
// Three minutes rather than thirty. A code is typed within a minute of
// arriving or not at all — the long window was never being used for anything
// except leaving a working credential sitting in an inbox. Short enough to
// matter, long enough to switch to a mail app, wait for delivery and switch
// back, which is the whole journey it has to survive. The page now shows the
// time left, so nobody has to guess whether what they are holding still works.
const CODE_TTL_MS = 3 * 60 * 1000;
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

  // Returns whether the email actually went out. The send is best-effort and
  // swallows its own failure — correct, since the code is already stored and
  // the person can ask for another — but a caller that reports "a new code was
  // sent" has to be able to tell, or it says so when nothing left the building.
  //
  // The lifetime is passed rather than repeated in the template: the email says
  // how long the code lasts, and the two saying different numbers is exactly
  // the kind of thing nobody notices until somebody trusts the wrong one.
  return sendVerificationEmail(user, code, CODE_TTL_MS);
}

// How much life a code needs left to be worth reusing. Below this floor a
// fresh one is issued instead, because a code that dies while somebody is
// still walking to their inbox is worse than a second email.
//
// Necessarily well under CODE_TTL_MS: a floor at or above the lifetime means
// no code is ever reusable, and every sign-in mails another one.
const REUSE_FLOOR_MS = 45 * 1000;

// Issues a code only when there isn't a usable one already.
//
// The caller is the login form, which now sends the code itself rather than
// leaving the person to work out that they have to go and ask for one. That
// makes it easy to send two: somebody who registers and then immediately tries
// to log in would get a second email a minute after the first, with the code
// in the first one already dead, because a new code replaces the old one. So
// an outstanding code is reused, and sentAt reports when it actually went out
// rather than pretending it went out now.
async function ensureVerificationCode(user) {
  const existing = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });

  if (existing
    && existing.attempts < MAX_ATTEMPTS
    && existing.expiresAt.getTime() - Date.now() > REUSE_FLOOR_MS) {
    return {
      sent: false,
      reason: 'still-valid',
      // Derived rather than stored: the row records when the code dies, and it
      // was born exactly one TTL before that.
      sentAt: existing.expiresAt.getTime() - CODE_TTL_MS,
      expiresAt: existing.expiresAt.getTime(),
    };
  }

  const delivered = await issueVerificationCode(user);
  return {
    sent: delivered,
    reason: delivered ? 'sent' : 'send-failed',
    sentAt: Date.now(),
    expiresAt: await expiryFor(user.id),
  };
}

// Read back rather than recomputed as Date.now() + CODE_TTL_MS. The send in
// between is an HTTP call to the mail provider and can take seconds, and the
// page counts down to this number — a countdown that disagrees with the
// database is a countdown that reaches zero while the code still works, or
// worse, the other way round.
async function expiryFor(userId) {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { userId },
    select: { expiresAt: true },
  });
  return row ? row.expiresAt.getTime() : Date.now() + CODE_TTL_MS;
}

// Called at the one moment a correct password meets an unverified address.
//
// Sending here is safe in a way that sending from a public form is not: bcrypt
// has already agreed, so this cannot be used to ask whether an address is
// registered, and it cannot be aimed at an inbox the sender does not own.
// That is what lets the code arrive with no captcha in front of it and no
// button to find — by the time the person reaches the verification page the
// mail is already on its way.
async function prepareVerification(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user || user.emailVerifiedAt) return null;

  const outcome = await ensureVerificationCode(user);
  if (outcome.reason === 'send-failed') {
    logger.error('login: unverified address, but the email provider did not accept the code', {
      email: normalized, userId: user.id,
    });
  } else {
    logger.info(`login: unverified address, code ${outcome.reason}`, { email: normalized, userId: user.id });
  }
  return { userId: user.id, email: user.email, ...outcome };
}

// The resend behind the "Send it again" button, for somebody the server
// already knows is mid-verification.
//
// Unlike resendVerification below, this takes no address from the request —
// the account comes from the session, put there by a login that got the
// password right. There is nothing to enumerate and no stranger to mail, so it
// needs no captcha and no retyped address: the two things that made asking for
// a second code harder than getting the first.
async function resendForPending(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user || user.emailVerifiedAt) {
    return { sent: false, reason: 'nothing-to-send', sentAt: Date.now(), expiresAt: null };
  }

  // Always a new code, never the outstanding one: they pressed the button
  // because what they have does not work.
  const delivered = await issueVerificationCode(user);
  if (!delivered) {
    logger.error('resend-pending: code generated but the email provider did not accept it', { userId: user.id });
  }
  return {
    sent: delivered,
    reason: delivered ? 'sent' : 'send-failed',
    sentAt: Date.now(),
    expiresAt: await expiryFor(user.id),
  };
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
//
// That silence is right for the response and wrong for the server log. Two of
// the three outcomes here send nothing, and from outside all three look
// identical, so "the resend button does not work" and "the resend button
// correctly did nothing" are the same observation. Whoever is running the site
// has no way to tell them apart, and the natural conclusion is that email is
// broken — which is exactly the wrong place to start looking.
//
// So the outcome is logged. It leaks nothing: it goes to the server log, not
// the response, and the person reading it can already query the users table.
async function resendVerification(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });

  if (!user) {
    // Worth distinguishing from "already verified" because the usual cause is
    // an address that does not match what was stored — note that the route
    // runs normalizeEmail() first, which strips dots from a Gmail address. An
    // account created outside the registration form (seeded, imported, or
    // inserted by hand) can therefore hold an address this will never find.
    logger.info('resend-verification: no account for that address, nothing sent', { email: normalized });
    return;
  }

  if (user.emailVerifiedAt) {
    logger.info('resend-verification: already verified, nothing sent', { email: normalized, userId: user.id });
    return;
  }

  const delivered = await issueVerificationCode(user);
  if (delivered) {
    logger.info('resend-verification: new code sent', { email: normalized, userId: user.id });
  } else {
    // The distinction that matters most, and the one the first version of this
    // logging got wrong: it said "new code sent" whether or not the provider
    // took it, because the send reports its own failure and returns quietly.
    // The provider's own reason is on the line above this one.
    logger.error('resend-verification: code generated but the email provider did not accept it', {
      email: normalized, userId: user.id,
    });
  }
}

module.exports = {
  issueVerificationCode,
  ensureVerificationCode,
  prepareVerification,
  resendForPending,
  verifyEmailCode,
  resendVerification,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
};
