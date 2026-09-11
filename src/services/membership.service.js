const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// What it means to be a member, kept deliberately at the bottom of the
// dependency graph: this file requires nothing but prisma.
//
// It was originally part of payment.service, which is where paying for a
// membership belongs. But "is this person a member" is a question other things
// need to ask — the membership certificate, for one — and certificate.service
// cannot import payment.service: payment → registration → event → certificate
// is already an edge, and closing that loop would hand one of them a
// half-built module at require time. Rather than copy the rule into a second
// place and let the two drift, it lives here and both import it. Everything it
// used to export from payment.service still does, so no caller changed.

// A paid membership is good for one year from the moment it is confirmed.
const MEMBERSHIP_VALIDITY_YEARS = 1;

// Calendar arithmetic, not 365 days. The two only agree when no 29 February
// falls in between: paying on 1 March 2027 and adding 365 days lands on
// 29 February 2028, a day short of the anniversary. Members would silently
// lose a day whenever their year spanned a leap day.
//
// setFullYear also handles the one date that has no anniversary — a membership
// bought on 29 February rolls to 1 March, which is the later of the two
// candidate dates and so never shortens what was paid for.
function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// Renewing extends from whichever is later — the existing expiry, or today.
// Paying early therefore never forfeits the remainder of the current year,
// while renewing after a lapse starts a fresh year rather than back-dating one
// that has already run out.
function nextMembershipExpiry(currentExpiry, from = new Date()) {
  const base = currentExpiry && new Date(currentExpiry) > from ? new Date(currentExpiry) : from;
  return addYears(base, MEMBERSHIP_VALIDITY_YEARS);
}

// How the app classifies people, and how the three categories relate:
//
//   MEMBER      — has an account and a membership inside its validity year
//   NON_MEMBER  — has an account but has never paid, or has lapsed
//   GUEST       — has no account at all; exists only as an EventInvitation
//                 row with a null userId, created for one specific event
//
// GUEST is deliberately absent from this function: it is not a state a User
// can be in. Someone with no account has no User row to classify, so guests
// are identified where they actually live — by an invitation without a userId.
//
// MEMBER/NON_MEMBER are derived from payment state on every read rather than
// stored, because a stored copy would silently go stale the moment a
// membership lapsed with nothing running to update it.
//
// Note what is NOT part of this: User.status. Approval and membership are
// different questions — approval says an admin has accepted the account and
// the address behind it, membership says the fee is paid and current. An
// approved account that has never paid is a perfectly ordinary non-member.
const MEMBERSHIP_TIERS = { MEMBER: 'MEMBER', NON_MEMBER: 'NON_MEMBER', GUEST: 'GUEST' };

// Pure, and takes the payment as an argument, so a list view can classify a
// page of members from data it has already batched instead of issuing a query
// per row. `latestMembershipPayment` may be null/undefined.
function classifyMembership(user, latestMembershipPayment) {
  let expiresAt = user && user.membershipExpiresAt;

  // Backfill for anyone who paid before expiry was tracked: derive the date
  // from their payment rather than showing them as never having paid.
  if (!expiresAt && latestMembershipPayment
      && latestMembershipPayment.status === 'PAID' && latestMembershipPayment.paidAt) {
    expiresAt = addYears(latestMembershipPayment.paidAt, MEMBERSHIP_VALIDITY_YEARS);
  }

  if (!expiresAt) {
    return { tier: MEMBERSHIP_TIERS.NON_MEMBER, state: 'NONE', expiresAt: null, daysRemaining: null };
  }

  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const active = msLeft > 0;
  return {
    tier: active ? MEMBERSHIP_TIERS.MEMBER : MEMBERSHIP_TIERS.NON_MEMBER,
    state: active ? 'ACTIVE' : 'EXPIRED',
    expiresAt,
    daysRemaining: Math.ceil(msLeft / 86400000),
  };
}

// Single-user convenience over classifyMembership, for the member's own pages.
// NONE and EXPIRED both classify as NON_MEMBER but stay distinguishable here,
// since only EXPIRED is something to renew.
async function getMembershipStatus(userId) {
  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { membershipExpiresAt: true },
  });
  if (!user) throw new AppError('User not found', 404);

  const latest = user.membershipExpiresAt ? null : await prisma.payment.findFirst({
    where: { userId: Number(userId), purpose: 'MEMBERSHIP_REGISTRATION', status: 'PAID' },
    orderBy: { paidAt: 'desc' },
    select: { status: true, paidAt: true },
  });

  return classifyMembership(user, latest);
}

// The one-line question every member-only benefit asks. Named as a question so
// the call sites read as the rule they are enforcing rather than as a string
// comparison somebody has to decode.
async function isActiveMember(userId) {
  const membership = await getMembershipStatus(userId);
  return membership.tier === MEMBERSHIP_TIERS.MEMBER;
}

module.exports = {
  MEMBERSHIP_VALIDITY_YEARS,
  MEMBERSHIP_TIERS,
  addYears,
  nextMembershipExpiry,
  classifyMembership,
  getMembershipStatus,
  isActiveMember,
};
