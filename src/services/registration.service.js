const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const mailService = require('./mail.service');
const sheetsSyncService = require('./sheetsSync.service');
const invitationService = require('./invitation.service');

// A capacity slot is held by both a confirmed registration and one still
// awaiting fee payment — otherwise a paid event could be oversold during the
// window between "start payment" and "webhook confirms it". `client` defaults
// to the shared `prisma` instance but accepts a transaction handle (`tx`) too,
// so a capacity check can run inside the same transaction as the row it's
// guarding (see upsertPendingPaymentRegistration below).
async function countActiveRegistrations(eventId, client = prisma) {
  return client.eventRegistration.count({
    where: { eventId: Number(eventId), status: { in: ['REGISTERED', 'PENDING_PAYMENT'] } },
  });
}

// Logged-in users already have their profile on file, so registering for a
// free event is a single click: we pull fullName/email/phone/school straight
// from their account instead of asking them to fill a form again. (Paid
// events go through upsertPendingPaymentRegistration + payment.service.js's
// createEventCheckout instead — this function is the free-event path only,
// called when Event.feeCentavos === 0.)
async function registerForEvent(user, eventId, invitation = null) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  if (!event.isPublished) throw new AppError('This event is not open for registration', 400);

  const existing = await prisma.eventRegistration.findUnique({
    where: { userId_eventId: { userId: user.id, eventId: event.id } },
  });

  // If an existing registration exists, allow re-activation when status is CANCELLED
  if (existing) {
    if (existing.status === 'REGISTERED') {
      throw new AppError('You are already registered for this event', 409);
    }
    if (existing.status === 'PENDING_PAYMENT') {
      throw new AppError('You have a pending payment for this event. Please complete or cancel it first.', 409);
    }

    // existing but not currently registered (e.g., CANCELLED) -> try to reactivate
    if (event.capacity) {
      const registrationCount = await countActiveRegistrations(event.id);
      if (registrationCount >= event.capacity) {
        throw new AppError('This event is full', 400);
      }
    }

    const reactivated = await prisma.eventRegistration.update({
      where: { id: existing.id },
      data: {
        status: 'REGISTERED',
        fullName: `${user.firstName} ${user.lastName}`,
        email: user.email,
        phone: user.phone || null,
        school: user.school || null,
        invitationId: invitation ? invitation.id : undefined,
      },
    });
    mailService.sendEventRegistrationEmail(user, event);
    sheetsSyncService.syncEventRegistrations(event.id);
    if (invitation) invitationService.markRegistered(invitation.id);
    return reactivated;
  }

  if (event.capacity) {
    const registrationCount = await countActiveRegistrations(event.id);
    if (registrationCount >= event.capacity) {
      throw new AppError('This event is full', 400);
    }
  }

  const created = await prisma.eventRegistration.create({
    data: {
      userId: user.id,
      eventId: event.id,
      fullName: `${user.firstName} ${user.lastName}`,
      email: user.email,
      phone: user.phone || null,
      school: user.school || null,
      invitationId: invitation ? invitation.id : undefined,
    },
  });
  mailService.sendEventRegistrationEmail(user, event);
  sheetsSyncService.syncEventRegistrations(event.id);
  if (invitation) invitationService.markRegistered(invitation.id);
  return created;
}

// Holds the registrant's capacity slot for a PAID event as PENDING_PAYMENT —
// never REGISTERED. Only payment.service.js's applyPaymentPaid (reached
// exclusively via a verified PayMongo webhook, or an admin-triggered
// reconciliation against PayMongo's own API) is allowed to flip this row to
// REGISTERED; nothing here or in the checkout-creation path ever does that,
// regardless of how far checkout creation itself gets — a registration must
// never become REGISTERED merely because a checkout session was created.
//
// `client` is `prisma` for a standalone call, or a `tx` handle when called
// from inside payment.service.js's createCheckout transaction — in the paid
// path it's always called with `tx`, so the registration hold and the
// Payment row it's paired with are created (or reused) atomically: both
// commit together, or neither does, closing the gap where a crash between
// "create registration" and "create payment" could otherwise leave one
// without the other.
async function upsertPendingPaymentRegistration(client, user, event, invitation = null) {
  const existing = await client.eventRegistration.findUnique({
    where: { userId_eventId: { userId: user.id, eventId: event.id } },
  });

  if (existing) {
    if (existing.status === 'REGISTERED') {
      throw new AppError('You are already registered for this event', 409);
    }
    if (existing.status === 'PENDING_PAYMENT') {
      return existing; // idempotent reuse — retrying "Register & Pay"/"Pay Now" must not duplicate
    }

    // CANCELLED -> try to reactivate as a pending-payment hold
    const count = await countActiveRegistrations(event.id, client);
    if (event.capacity && count >= event.capacity) {
      throw new AppError('This event is full', 400);
    }
    return client.eventRegistration.update({
      where: { id: existing.id },
      data: {
        status: 'PENDING_PAYMENT',
        fullName: `${user.firstName} ${user.lastName}`,
        email: user.email,
        phone: user.phone || null,
        school: user.school || null,
        invitationId: invitation ? invitation.id : undefined,
      },
    });
  }

  const count = await countActiveRegistrations(event.id, client);
  if (event.capacity && count >= event.capacity) {
    throw new AppError('This event is full', 400);
  }

  return client.eventRegistration.create({
    data: {
      userId: user.id,
      eventId: event.id,
      fullName: `${user.firstName} ${user.lastName}`,
      email: user.email,
      phone: user.phone || null,
      school: user.school || null,
      status: 'PENDING_PAYMENT',
      invitationId: invitation ? invitation.id : undefined,
    },
  });
}

// Standalone entry point (non-transactional) — kept for callers that don't
// need the payment-row atomicity above; payment.service.js's
// createEventCheckout uses upsertPendingPaymentRegistration(tx, ...) directly
// instead, so the two writes land in the same transaction.
async function createPendingPaymentRegistration(user, event, invitation = null) {
  return upsertPendingPaymentRegistration(prisma, user, event, invitation);
}

// No status gate here (never has been) — it unconditionally sets CANCELLED
// regardless of current status, so this already works unchanged for
// PENDING_PAYMENT rows too, not just REGISTERED ones. Cancelling a
// PENDING_PAYMENT row just frees the capacity slot — it does not reach out to
// PayMongo (there is nothing to cancel gateway-side until a checkout is
// actually paid; an unpaid checkout session simply expires on its own). Any
// Payment row tied to it is left exactly as-is, same as membership payments
// today — payment history is never deleted to "clean up" a cancellation.
async function cancelRegistration(userId, eventId) {
  const registration = await prisma.eventRegistration.findUnique({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
  });
  if (!registration) throw new AppError('Registration not found', 404);

  const cancelled = await prisma.eventRegistration.update({
    where: { id: registration.id },
    data: { status: 'CANCELLED' },
  });
  sheetsSyncService.syncEventRegistrations(cancelled.eventId);
  return cancelled;
}

async function getUserRegistrations(userId) {
  return prisma.eventRegistration.findMany({
    where: { userId: Number(userId) },
    include: { event: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function getEventRegistrations(eventId) {
  return prisma.eventRegistration.findMany({
    where: { eventId: Number(eventId) },
    orderBy: { createdAt: 'desc' },
  });
}
async function getRegisteredEventIds(userId) {
  const regs = await prisma.eventRegistration.findMany({
    where: { userId: Number(userId), status: 'REGISTERED' },
    select: { eventId: true },
  });
  return regs.map((r) => r.eventId);
}

// Unlike getRegisteredEventIds (REGISTERED only, for the public events list),
// this returns the raw status including PENDING_PAYMENT — the event-details
// page needs to distinguish "not registered" from "payment pending" to show
// the right button ("Register & Pay" vs "Payment Pending — Pay Now").
async function getRegistrationStatus(userId, eventId) {
  const reg = await prisma.eventRegistration.findUnique({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
    select: { status: true },
  });
  return reg ? reg.status : null;
}

module.exports = {
  registerForEvent,
  cancelRegistration,
  getUserRegistrations,
  getEventRegistrations,
  getRegisteredEventIds,
  getRegistrationStatus,
  countActiveRegistrations,
  upsertPendingPaymentRegistration,
  createPendingPaymentRegistration,
};
