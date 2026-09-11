const { error } = require('../utils/apiResponse');
const membershipService = require('../services/membership.service');

// The gate on everything that belongs to paying members only — the membership
// certificate today, and whatever else is put behind membership later.
//
// Separate from apiAuth and apiAdmin because it asks a different question.
// Those two ask who you are; this one asks whether your membership fee is paid
// and still inside its year. An approved account is not a member — approval
// says an admin accepted the account and the address behind it, nothing more.
//
// Unlike the role checks it has to hit the database, since membership is
// derived from payment state on every read rather than stored on the session.
// A session that was minted while somebody was a member therefore stops
// opening this door the moment their year runs out, which is the point.
//
// Attaches the resolved membership so the handler behind it does not repeat
// the lookup.
async function requireActiveMembership(req, res, next) {
  if (!req.session.user) return error(res, 'Authentication required', 401);

  try {
    const membership = await membershipService.getMembershipStatus(req.session.user.id);
    if (membership.tier !== membershipService.MEMBERSHIP_TIERS.MEMBER) {
      // Names which of the two it is. "Not a member" would send somebody whose
      // year has simply lapsed looking for a fault that is not there.
      return error(
        res,
        membership.state === 'EXPIRED'
          ? 'Your membership has expired. Renew it to get this back.'
          : 'This is for members. It unlocks once your membership payment is confirmed.',
        403
      );
    }
    req.membership = membership;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireActiveMembership };
