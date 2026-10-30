const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const registrationService = require('../../services/registration.service');
const paymentService = require('../../services/payment.service');
const eventService = require('../../services/event.service');
const authService = require('../../services/auth.service');
const invitationService = require('../../services/invitation.service');
const eventFeeService = require('../../services/eventFee.service');
const settingsService = require('../../services/settings.service');
const prisma = require('../../config/prisma');
const AppError = require('../../utils/AppError');

// Session only stores a lightweight user snapshot; pull the fresh profile so
// autofill/direct-registration always uses current contact details.
//
// Branches purely on the server-loaded Event's own feeCentavos — the request
// body carries no fields at all (no amount, no status, no userId to spoof).
// A free event takes the exact same instant-registration path as before; a
// paid event hands off to payment.service.js's createEventCheckout, which is
// the only path that ever creates a PENDING_PAYMENT registration, and the
// only thing that can ever confirm it into REGISTERED is a verified webhook
// (or admin reconciliation against PayMongo) — never this controller, and
// never merely because a checkout URL was returned to the client.
const registerForEvent = asyncHandler(async (req, res) => {
  const user = await authService.getById(req.session.user.id);
  // Prevent admins from registering for events through the public flow
  if (user.role === 'ADMIN') {
    throw new AppError('Admins cannot register for events', 403);
  }

  const event = await eventService.getEventById(req.params.id);

  // Present only when this click came from an invitation link — validated
  // against both this event and this exact user before it's trusted to link
  // the resulting registration back to it (see resolveInvitationForUser).
  const invitation = await invitationService.resolveInvitationForUser(req.body.inviteToken, event.id, user);

  // What this person pays: the fee option they picked from this event's own
  // options, checked against the database. Only the choice comes from the
  // request, never an amount. An event with no options charges its single fee.
  // A members-only option is refused to someone without an active membership.
  let fee;
  try {
    fee = await eventFeeService.resolveEventChoice(event, req.body.feeOption, user.id);
  } catch (err) {
    // "Pay now" on a pending payment sends no choice: reuse what was recorded
    // when they first chose.
    const pending = err.statusCode === 422 && !req.body.feeOption
      ? await prisma.eventRegistration.findUnique({ where: { userId_eventId: { userId: user.id, eventId: event.id } } })
      : null;
    if (!pending || pending.status !== 'PENDING_PAYMENT' || pending.feeCentavos === null) throw err;
    fee = { feeCentavos: pending.feeCentavos, feeOptionName: pending.feeOptionName };
  }

  // Online payment only when it is switched on. While it is off (Admin ->
  // Settings), a paid event registers them straight away with the fee
  // recorded, to be collected offline, instead of refusing them.
  if (fee.feeCentavos > 0 && await settingsService.getPaymentsEnabled()) {
    const { checkoutUrl } = await paymentService.createEventCheckout(user.id, event.id, invitation, { amountCentavos: fee.feeCentavos });
    await prisma.eventRegistration.updateMany({
      where: { userId: user.id, eventId: event.id },
      data: { feeCentavos: fee.feeCentavos, feeOptionName: fee.feeOptionName },
    });
    return success(res, { checkoutUrl }, 'Redirecting to payment', 201);
  }

  const registration = await registrationService.registerForEvent(user, req.params.id, invitation, fee);
  const message = fee.feeCentavos > 0
    ? `You are registered. Your registration fee is PHP ${(fee.feeCentavos / 100).toFixed(2)}${fee.feeOptionName ? ` (${fee.feeOptionName})` : ''}, paid to the organizers.`
    : 'You are registered for this event';
  return success(res, { registration, feeCentavos: fee.feeCentavos, feeOptionName: fee.feeOptionName }, message, 201);
});

const cancelRegistration = asyncHandler(async (req, res) => {
  const registration = await registrationService.cancelRegistration(req.session.user.id, req.params.id);
  return success(res, { registration }, 'Registration cancelled');
});

const myRegistrations = asyncHandler(async (req, res) => {
  const registrations = await registrationService.getUserRegistrations(req.session.user.id);
  return success(res, { registrations });
});

const eventRegistrations = asyncHandler(async (req, res) => {
  const registrations = await registrationService.getEventRegistrations(req.params.id);
  return success(res, { registrations });
});

module.exports = { registerForEvent, cancelRegistration, myRegistrations, eventRegistrations };
