const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const registrationService = require('../../services/registration.service');
const paymentService = require('../../services/payment.service');
const eventService = require('../../services/event.service');
const authService = require('../../services/auth.service');
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

  if (event.feeCentavos > 0) {
    const { checkoutUrl } = await paymentService.createEventCheckout(user.id, event.id);
    return success(res, { checkoutUrl }, 'Redirecting to payment', 201);
  }

  const registration = await registrationService.registerForEvent(user, req.params.id);
  return success(res, { registration }, 'You are registered for this event', 201);
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
