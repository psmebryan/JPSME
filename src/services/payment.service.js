const { Prisma } = require('@prisma/client');
const config = require('../config');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const settingsService = require('./settings.service');
const paymongoService = require('./paymongo.service');
const auditService = require('./audit.service');
const registrationService = require('./registration.service');
const userService = require('./user.service');
const mailService = require('./mail.service');
const sheetsSyncService = require('./sheetsSync.service');
const invitationService = require('./invitation.service');

// Grosses up baseCentavos so that after PayMongo deducts its own percentage
// cut from the TOTAL charged, JPSME still nets baseCentavos — i.e. the payer
// absorbs the gateway's fee instead of JPSME. Simply adding baseCentavos *
// percent would under-charge, since PayMongo's cut is taken from the
// grossed-up total, not from the base fee alone: if T is the total and p the
// fee rate, T - T*p = baseCentavos, so T = baseCentavos / (1 - p).
// This is an upfront estimate to decide what to charge — PayMongo's actual
// deducted fee (captured separately as gatewayFeeCentavos once the payment
// settles, see applyPaymentPaid) can differ by a centavo or two due to their
// own internal rounding, so the real net occasionally lands a centavo off
// baseCentavos either way. No safety buffer here by design — charge exactly
// what the formula says, nothing padded on top.
async function calculateGatewaySurcharge(baseCentavos) {
  if (baseCentavos <= 0) return 0;
  const percent = await settingsService.getGatewaySurchargePercent();
  const rate = percent / 100;
  const total = baseCentavos / (1 - rate);
  return Math.round(total - baseCentavos);
}

const ACTIVE_STATUSES = ['PENDING', 'PROCESSING'];
const PAID_EVENT_TYPES = new Set(['checkout_session.payment.paid', 'payment.paid']);
const FAILED_EVENT_TYPES = new Set(['checkout_session.payment.failed', 'payment.failed']);
const REFUND_EVENT_TYPES = new Set(['refund.succeeded', 'refund.failed']);

// Never select `password` (or other sensitive columns) onto a payment's nested
// user — these responses go straight to the API.
const SAFE_USER_SELECT = {
  id: true,
  firstName: true,
  middleInitial: true,
  lastName: true,
  email: true,
  phone: true,
  school: true,
  organizationId: true,
  role: true,
  status: true,
  organization: true,
};

function appUrl() {
  return config.appUrl;
}

// --- Reads ---

// A paid membership is good for one year from the moment it is confirmed.
const MEMBERSHIP_VALIDITY_DAYS = 365;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Renewing extends from whichever is later — the existing expiry, or today.
// Paying early therefore never forfeits the remainder of the current year,
// while renewing after a lapse starts a fresh year rather than back-dating one
// that has already run out.
function nextMembershipExpiry(currentExpiry, from = new Date()) {
  const base = currentExpiry && new Date(currentExpiry) > from ? new Date(currentExpiry) : from;
  return addDays(base, MEMBERSHIP_VALIDITY_DAYS);
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
    expiresAt = addDays(latestMembershipPayment.paidAt, MEMBERSHIP_VALIDITY_DAYS);
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

async function getLatestMembershipPayment(userId) {
  return prisma.payment.findFirst({
    where: { userId: Number(userId), purpose: 'MEMBERSHIP_REGISTRATION' },
    orderBy: { createdAt: 'desc' },
  });
}

async function getLatestEventPayment(userId, eventId) {
  return prisma.payment.findFirst({
    where: { userId: Number(userId), purpose: 'EVENT_REGISTRATION', eventId: Number(eventId) },
    orderBy: { createdAt: 'desc' },
  });
}

// Batched, for admin user-list views — one query instead of N.
async function getLatestMembershipStatusForUsers(userIds) {
  const ids = [...new Set(userIds.map(Number))];
  if (!ids.length) return new Map();

  const payments = await prisma.payment.findMany({
    where: { userId: { in: ids }, purpose: 'MEMBERSHIP_REGISTRATION' },
    orderBy: { createdAt: 'desc' },
  });

  const map = new Map();
  for (const payment of payments) {
    if (!map.has(payment.userId)) map.set(payment.userId, payment); // first hit per user = most recent (already sorted desc)
  }
  return map;
}

// IDOR guard for GET /api/payments/:id — throws instead of leaking existence.
// Only the payment's own owner or a MAIN_ADMIN may view it — CHAPTER_ADMIN has
// no access to payment data at all, regardless of chapter.
async function getPaymentForViewer(paymentId, viewer) {
  const payment = await prisma.payment.findUnique({
    where: { id: Number(paymentId) },
    include: { user: { select: SAFE_USER_SELECT }, refund: true },
  });
  if (!payment) throw new AppError('Payment not found', 404);

  const isOwner = payment.userId === viewer.id;
  const isMainAdmin = viewer.role === 'ADMIN';

  if (!isOwner && !isMainAdmin) {
    auditService.log({
      action: 'UNAUTHORIZED_PAYMENT_ACCESS',
      actorId: viewer.id,
      targetUserId: payment.userId,
      paymentId: payment.id,
    });
    throw new AppError('Payment not found', 404); // 404, not 403 — don't confirm the ID exists
  }

  return payment;
}

// --- Admin listing/summary (MAIN_ADMIN only — enforced at the route layer) ---

// `purpose` unset means "all purposes" — event-fee payments show up alongside
// membership payments by default now that both exist; pass an explicit
// purpose to filter down to one.
function buildAdminPaymentWhere({ status, organizationId, organizationIds, dateFrom, dateTo, purpose, eventId }) {
  const where = {};
  if (purpose) where.purpose = purpose;
  if (eventId) where.eventId = Number(eventId);
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo);
  }
  // Subtree-aware: filtering by a cluster includes payments from members of
  // the chapters and student units beneath it, not just its direct members.
  if (Array.isArray(organizationIds)) {
    where.user = { organizationId: { in: organizationIds } };
  } else if (organizationId) {
    where.user = { organizationId: Number(organizationId) };
  }
  return where;
}

async function listPaymentsForAdmin({ status, organizationId, organizationIds, dateFrom, dateTo, purpose, eventId, page = 1, pageSize = 20 }) {
  const where = buildAdminPaymentWhere({ status, organizationId, organizationIds, dateFrom, dateTo, purpose, eventId });

  const [total, payments] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: { user: { select: SAFE_USER_SELECT }, refund: true, event: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { payments, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

async function getPaymentSummary({ purpose, eventId } = {}) {
  const where = buildAdminPaymentWhere({ purpose, eventId });

  const [paidAgg, statusCounts] = await Promise.all([
    prisma.payment.aggregate({ where: { ...where, status: 'PAID' }, _sum: { amount: true }, _count: true }),
    prisma.payment.groupBy({ by: ['status'], where, _count: true }),
  ]);

  const counts = { PENDING: 0, PROCESSING: 0, PAID: 0, FAILED: 0, EXPIRED: 0, CANCELLED: 0, REFUNDED: 0 };
  statusCounts.forEach((row) => { counts[row.status] = row._count; });

  return {
    counts,
    totalRevenueCentavos: paidAgg._sum.amount || 0,
    paidCount: paidAgg._count,
  };
}

// --- Membership checkout creation ---

// Concurrent requests that both reuse the same still-PENDING payment (e.g. a
// user double-clicking "Pay" right after a previous gateway-call failure)
// could otherwise both count 0 prior attempts and collide on the unique
// (paymentId, attemptNumber) constraint. Retry with the next number on that
// specific collision instead of letting it surface as a raw 500.
const MAX_ATTEMPT_NUMBER_RETRIES = 10;

async function createNextPaymentAttempt(paymentId) {
  for (let tries = 0; tries < MAX_ATTEMPT_NUMBER_RETRIES; tries += 1) {
    const attemptNumber = (await prisma.paymentAttempt.count({ where: { paymentId } })) + 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.paymentAttempt.create({ data: { paymentId, attemptNumber, status: 'CREATED' } });
    } catch (err) {
      // Found under Phase 3 concurrency testing (10 simultaneous requests for
      // the same payment): the previous version's bounds check (`tries < 4`
      // against a 5-iteration loop) meant the *last* iteration's P2002 always
      // fell through to `throw err` — re-throwing the raw Prisma error
      // instead of ever reaching the friendly AppError below, which was
      // actually unreachable dead code. Any non-P2002 error still surfaces
      // immediately, unchanged.
      if (err.code !== 'P2002') throw err;
      if (tries < MAX_ATTEMPT_NUMBER_RETRIES - 1) continue;
    }
  }
  throw new AppError('Please try again in a moment.', 409);
}

// Shared by createMembershipCheckout and createEventCheckout — everything
// about talking to PayMongo and managing the Payment/PaymentAttempt rows is
// purpose-agnostic; only the amount/description/URLs/reuse-scope differ.
// Never trust a client-sent amount/userId/eventId — amount always comes from
// SiteSetting or Event.feeCentavos, user always from the authenticated
// session, eventId always from a server-validated Event lookup.
// `withinTransaction(tx, paymentRow)`, if given, runs INSIDE the same
// Serializable transaction as the payment existence-check/create below —
// e.g. createEventCheckout uses it to also create/reuse the PENDING_PAYMENT
// EventRegistration row atomically with the Payment row, so a crash between
// "hold the registration" and "create the payment" can't happen: both writes
// commit together, or neither does. It must never perform external I/O (the
// PayMongo call happens after this transaction commits, further below) —
// holding a DB transaction open across a third-party network call would pin
// row locks for an unbounded time.
async function createCheckout({ userId, purpose, eventId, amount, description, referencePrefix, successUrl, cancelUrl, alreadyPaidMessage, allowRenewal = false, withinTransaction }) {
  if (!(await settingsService.getPaymentsEnabled())) {
    throw new AppError('Payments are temporarily unavailable. Please try again later.', 503);
  }

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);

  // Membership is renewable, so a past PAID payment must not block a new one —
  // the caller (createMembershipCheckout) has already refused the case that
  // actually matters, an membership still inside its validity year. For an
  // event fee there is nothing to renew, so any prior payment still blocks.
  if (!allowRenewal) {
    const alreadyPaid = await prisma.payment.findFirst({
      where: { userId: user.id, purpose, eventId: eventId || null, status: 'PAID' },
    });
    if (alreadyPaid) {
      throw new AppError(alreadyPaidMessage, 409);
    }
  }

  // `amount` is always the fee JPSME actually wants to net — the payer covers
  // PayMongo's cut on top, so what actually gets charged (and stored as
  // Payment.amount, since that's what the gateway will report back and
  // verifyGatewayAmountMatches compares against) is the grossed-up total.
  const surchargeCentavos = await calculateGatewaySurcharge(amount);
  const totalAmount = amount + surchargeCentavos;

  // Serializable isolation closes the "double-click Pay" race: if two concurrent
  // requests both try to create a payment for the same user (+event, for the
  // event-fee case), MySQL forces one to fail with a write-conflict error
  // instead of silently creating two rows. The same isolation level protects
  // withinTransaction's writes (e.g. the registration capacity check/hold).
  let payment;
  try {
    payment = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.payment.findFirst({
          where: { userId: user.id, purpose, eventId: eventId || null, status: { in: ACTIVE_STATUSES } },
          orderBy: { createdAt: 'desc' },
        });

        let paymentRow;
        if (existing) {
          if (existing.status === 'PROCESSING') {
            throw new AppError('Your payment is already being processed. Please wait for confirmation.', 409);
          }
          // PENDING with no successful checkout yet — reuse it for a retry,
          // refreshed to the current fee/surcharge (covers the surcharge
          // rate changing, or a legacy pre-surcharge row, between attempts).
          paymentRow = await tx.payment.update({
            where: { id: existing.id },
            data: { amount: totalAmount },
          });
        } else {
          paymentRow = await tx.payment.create({
            data: { userId: user.id, purpose, eventId: eventId || null, amount: totalAmount, currency: 'PHP', status: 'PENDING' },
          });
        }

        // Runs on every call, not just when a new Payment is created — e.g.
        // a retry that reuses an existing PENDING payment must also
        // idempotently re-confirm the registration hold still exists (it's a
        // no-op if it does, per upsertPendingPaymentRegistration).
        if (withinTransaction) {
          await withinTransaction(tx, paymentRow);
        }

        return paymentRow;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.code === 'P2034') {
      throw new AppError('Please try again in a moment.', 409);
    }
    throw err;
  }

  const attempt = await createNextPaymentAttempt(payment.id);
  const attemptNumber = attempt.attemptNumber;

  try {
    const { checkoutId, checkoutUrl } = await paymongoService.createGcashCheckout({
      amountCentavos: amount,
      surchargeCentavos,
      description,
      referenceNumber: `${referencePrefix}-${payment.id}`,
      successUrl,
      cancelUrl,
      metadata: { paymentId: String(payment.id), userId: String(user.id), ...(eventId ? { eventId: String(eventId) } : {}) },
    });

    await prisma.payment.update({ where: { id: payment.id }, data: { gatewayCheckoutId: checkoutId } });
    await prisma.paymentAttempt.updateMany({
      where: { paymentId: payment.id, attemptNumber },
      data: { status: 'AWAITING_PAYMENT', gatewayReference: checkoutId },
    });

    await auditService.log({
      action: 'PAYMENT_CREATED',
      actorId: user.id,
      targetUserId: user.id,
      paymentId: payment.id,
      metadata: { amount: payment.amount, currency: payment.currency, attemptNumber, purpose, eventId: eventId || null },
    });

    if (eventId) sheetsSyncService.syncEventRegistrations(eventId);

    return { paymentId: payment.id, checkoutUrl };
  } catch (err) {
    await prisma.paymentAttempt.updateMany({
      where: { paymentId: payment.id, attemptNumber },
      data: { status: 'FAILED', failureCode: String((err && err.message) || 'unknown').slice(0, 191) },
    });
    throw err;
  }
}

async function createMembershipCheckout(userId) {
  const amount = await settingsService.getMembershipFeeCentavos();
  if (amount <= 0) {
    throw new AppError('Membership fee is not configured yet. Please contact an administrator.', 503);
  }

  // Renewal is allowed once the year has run out, or early while still active
  // is not — paying twice inside one validity period is almost always a
  // double-click or a misunderstanding, not an intent to buy two years.
  const membership = await getMembershipStatus(userId);
  if (membership.state === 'ACTIVE') {
    const until = new Date(membership.expiresAt).toLocaleDateString();
    throw new AppError(`Your membership is already active until ${until}.`, 409);
  }

  return createCheckout({
    userId,
    purpose: 'MEMBERSHIP_REGISTRATION',
    eventId: null,
    amount,
    description: 'JPSME Membership Registration Fee',
    referencePrefix: 'membership',
    successUrl: `${appUrl()}/membership-payment/return`,
    cancelUrl: `${appUrl()}/membership-payment/return`,
    alreadyPaidMessage: 'You have already paid your membership fee.',
    allowRenewal: true,
  });
}

// Holds/reuses the registrant's capacity slot (PENDING_PAYMENT) before
// creating the checkout, so a user who starts paying can't lose their spot to
// someone else registering in the meantime.
async function createEventCheckout(userId, eventId, invitation = null) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  if (!event.isPublished) throw new AppError('This event is not open for registration', 400);
  if (event.feeCentavos <= 0) throw new AppError('This event does not require a registration fee', 400);

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);

  return createCheckout({
    userId,
    purpose: 'EVENT_REGISTRATION',
    eventId: event.id,
    amount: event.feeCentavos,
    description: `Event Registration — ${event.title}`,
    referencePrefix: `event-${event.id}`,
    successUrl: `${appUrl()}/events/${event.id}/payment-return`,
    cancelUrl: `${appUrl()}/events/${event.id}/payment-return`,
    alreadyPaidMessage: 'You have already paid to register for this event.',
    // Runs inside createCheckout's own transaction — see the comment there.
    // The invitation link is set on the PENDING_PAYMENT hold now, but
    // EventInvitation.registeredAt itself isn't set until applyPaymentPaid
    // actually confirms the payment — see there.
    withinTransaction: (tx) => registrationService.upsertPendingPaymentRegistration(tx, user, event, invitation),
  });
}

// --- Webhook processing ---

async function processWebhookEvent(eventEnvelope, ipAddress) {
  const webhookId = eventEnvelope?.data?.id;
  const eventType = eventEnvelope?.data?.attributes?.type;
  const resource = eventEnvelope?.data?.attributes?.data;

  if (!webhookId || !eventType) {
    throw new AppError('Malformed webhook payload', 400);
  }

  // Idempotency: the (gateway, webhookId) unique constraint makes a replayed or
  // duplicate delivery a guaranteed database-level no-op.
  let webhookRecord;
  try {
    webhookRecord = await prisma.paymentWebhook.create({
      data: { gateway: 'paymongo', webhookId, eventType, payload: JSON.stringify(eventEnvelope) },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      await auditService.log({ action: 'WEBHOOK_DUPLICATE', metadata: { webhookId, eventType }, ipAddress });
      return { duplicate: true };
    }
    throw err;
  }

  await auditService.log({ action: 'WEBHOOK_RECEIVED', metadata: { webhookId, eventType }, ipAddress });

  if (PAID_EVENT_TYPES.has(eventType)) {
    return handlePaymentPaidEvent({ webhookRecord, resource, ipAddress });
  }
  if (FAILED_EVENT_TYPES.has(eventType)) {
    return handlePaymentFailedEvent({ webhookRecord, resource, ipAddress });
  }
  if (REFUND_EVENT_TYPES.has(eventType)) {
    return handleRefundEvent({ webhookRecord, resource, eventType, ipAddress });
  }

  // Any other event type is recorded for audit/debugging but intentionally not
  // acted upon.
  await prisma.paymentWebhook.update({ where: { id: webhookRecord.id }, data: { processed: true, processedAt: new Date() } });
  return { ignored: true, eventType };
}

async function markWebhookProcessed(webhookRecordId, paymentId) {
  await prisma.paymentWebhook.update({
    where: { id: webhookRecordId },
    data: { paymentId: paymentId || null, processed: true, processedAt: new Date() },
  });
}

// Shared by the webhook path and the reconciliation path — throws +
// audit-logs + marks the webhook (when applicable) on a mismatch, exactly as
// before, just no longer hand-copied in two places.
async function verifyGatewayAmountMatches(localPayment, gatewayAmount, gatewayCurrency, { webhookId, webhookRecordId, ipAddress } = {}) {
  if (gatewayAmount !== undefined && gatewayAmount !== localPayment.amount) {
    await auditService.log({
      action: 'SUSPICIOUS_PAYMENT_MISMATCH',
      paymentId: localPayment.id,
      targetUserId: localPayment.userId,
      metadata: { expectedAmount: localPayment.amount, gatewayAmount, webhookId },
      ipAddress,
    });
    if (webhookRecordId) await markWebhookProcessed(webhookRecordId, localPayment.id);
    throw new AppError('Payment amount mismatch', 400);
  }
  if (gatewayCurrency !== undefined && gatewayCurrency !== localPayment.currency) {
    await auditService.log({
      action: 'SUSPICIOUS_PAYMENT_MISMATCH',
      paymentId: localPayment.id,
      targetUserId: localPayment.userId,
      metadata: { expectedCurrency: localPayment.currency, gatewayCurrency, webhookId },
      ipAddress,
    });
    if (webhookRecordId) await markWebhookProcessed(webhookRecordId, localPayment.id);
    throw new AppError('Payment currency mismatch', 400);
  }
}

// Shared "mark paid" transition, used by both the webhook handler and the
// admin-triggered reconciliation path — one place performs this state
// transition, so the two paths can never drift apart. For an EVENT_REGISTRATION
// payment, this is also the single choke point that flips the matching
// EventRegistration from PENDING_PAYMENT to REGISTERED — that cross-table
// invariant isn't DB-enforced, so a missing/wrong-state registration here is
// logged loudly (console.error + audit metadata) rather than silently ignored.
async function applyPaymentPaid(localPayment, { gatewayPaymentId, gatewayFeeCentavos, webhookRecordId, source, ipAddress } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: localPayment.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        gatewayPaymentId: gatewayPaymentId || localPayment.gatewayPaymentId,
        // PayMongo's own reported cut — recorded for accounting (Total paid /
        // Fee deducted / Net received on the admin report), not estimated in
        // advance. Left at 0 if the gateway didn't report one.
        ...(gatewayFeeCentavos !== undefined ? { gatewayFeeCentavos } : {}),
      },
    });

    const latestAttempt = await tx.paymentAttempt.findFirst({
      where: { paymentId: localPayment.id },
      orderBy: { attemptNumber: 'desc' },
    });
    if (latestAttempt) {
      await tx.paymentAttempt.update({ where: { id: latestAttempt.id }, data: { status: 'SUCCEEDED' } });
    }

    if (webhookRecordId) {
      await tx.paymentWebhook.update({
        where: { id: webhookRecordId },
        data: { paymentId: localPayment.id, processed: true, processedAt: new Date() },
      });
    }

    let registrationFlipped = false;
    let flippedInvitationId = null;
    let registrationAnomaly = null;
    if (localPayment.purpose === 'EVENT_REGISTRATION' && localPayment.eventId) {
      const registration = await tx.eventRegistration.findUnique({
        where: { userId_eventId: { userId: localPayment.userId, eventId: localPayment.eventId } },
      });
      if (registration && registration.status === 'PENDING_PAYMENT') {
        await tx.eventRegistration.update({ where: { id: registration.id }, data: { status: 'REGISTERED' } });
        registrationFlipped = true;
        flippedInvitationId = registration.invitationId;
      } else {
        registrationAnomaly = registration ? `status was ${registration.status}, not PENDING_PAYMENT` : 'no matching registration found';
        console.error('applyPaymentPaid: event registration anomaly for payment', localPayment.id, '-', registrationAnomaly);
      }
    }

    await tx.auditLog.create({
      data: {
        action: 'PAYMENT_SUCCEEDED',
        targetUserId: localPayment.userId,
        paymentId: localPayment.id,
        metadata: JSON.stringify({ amount: localPayment.amount, currency: localPayment.currency, source, registrationAnomaly }),
        ipAddress,
      },
    });

    return { registrationFlipped, flippedInvitationId };
  });

  if (result.registrationFlipped && result.flippedInvitationId) {
    invitationService.markRegistered(result.flippedInvitationId);
  }

  if (result.registrationFlipped) {
    // Fire-and-forget, same as every other email send in this app — must
    // never block or roll back the payment confirmation itself.
    try {
      const [user, event] = await Promise.all([
        prisma.user.findUnique({ where: { id: localPayment.userId } }),
        prisma.event.findUnique({ where: { id: localPayment.eventId } }),
      ]);
      if (user && event) mailService.sendEventRegistrationEmail(user, event);
    } catch (err) {
      console.error('applyPaymentPaid: failed to send event registration email for payment', localPayment.id, err.message);
    }
  }

  // Auto-approve membership on confirmed payment (reverses the earlier
  // "admin manually reviews payment status before approving" design, per
  // explicit request). Reuses userService.setStatus exactly as the manual
  // admin-approve button does — same status transition, same approval email
  // — rather than re-implementing it here. Deliberately does NOT touch an
  // already-REJECTED account: a late-arriving payment confirmation must
  // never silently override an admin's explicit rejection decision. Runs
  // after the payment transaction commits, same as the event-registration
  // email above — a failure here must never roll back the payment itself.
  if (localPayment.purpose === 'MEMBERSHIP_REGISTRATION') {
    try {
      const user = await prisma.user.findUnique({ where: { id: localPayment.userId } });

      // Start (or extend) the one-year validity. Done before the approval
      // below so that even if setStatus fails, the member still gets the year
      // they paid for — the two are independent facts.
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { membershipExpiresAt: nextMembershipExpiry(user.membershipExpiresAt) },
        });
      }

      if (user && user.status === 'PENDING') {
        await userService.setStatus(localPayment.userId, 'APPROVED', {
          reason: 'MEMBERSHIP_PAYMENT_CONFIRMED',
          paymentId: localPayment.id,
        });
      }
    } catch (err) {
      console.error('applyPaymentPaid: failed to auto-approve membership for payment', localPayment.id, err.message);
      // Previously this console.error was the ONLY record of the failure —
      // invisible outside server logs, so a stuck PENDING-despite-PAID
      // account could go unnoticed indefinitely (found exactly this happening
      // to a real user). Logged here too so it surfaces on the admin audit
      // log and actually gets someone's attention.
      await auditService.log({
        action: 'AUTO_APPROVAL_FAILED',
        targetUserId: localPayment.userId,
        paymentId: localPayment.id,
        metadata: { error: err.message },
      }).catch(() => {});
    }
  }

  // setStatus above already triggers its own Membership sync on a genuine
  // status change — this call is what keeps the Payment Status column
  // current even when the user was already APPROVED (e.g. a stray re-payment).
  if (localPayment.purpose === 'MEMBERSHIP_REGISTRATION') {
    sheetsSyncService.syncMembership();
  } else if (localPayment.purpose === 'EVENT_REGISTRATION' && localPayment.eventId) {
    sheetsSyncService.syncEventRegistrations(localPayment.eventId);
  }

  return { paymentId: localPayment.id, ...result };
}

// Shared "mark failed" transition — mirrors applyPaymentPaid, used by both
// the webhook handler and reconciliation.
async function applyPaymentFailed(localPayment, { webhookRecordId, source, ipAddress } = {}) {
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: localPayment.id }, data: { status: 'FAILED' } });

    const latestAttempt = await tx.paymentAttempt.findFirst({
      where: { paymentId: localPayment.id },
      orderBy: { attemptNumber: 'desc' },
    });
    if (latestAttempt) {
      await tx.paymentAttempt.update({ where: { id: latestAttempt.id }, data: { status: 'FAILED' } });
    }

    if (webhookRecordId) {
      await tx.paymentWebhook.update({
        where: { id: webhookRecordId },
        data: { paymentId: localPayment.id, processed: true, processedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        action: 'PAYMENT_FAILED',
        targetUserId: localPayment.userId,
        paymentId: localPayment.id,
        metadata: JSON.stringify({ source }),
        ipAddress,
      },
    });
  });

  if (localPayment.purpose === 'MEMBERSHIP_REGISTRATION') {
    sheetsSyncService.syncMembership();
  } else if (localPayment.purpose === 'EVENT_REGISTRATION' && localPayment.eventId) {
    sheetsSyncService.syncEventRegistrations(localPayment.eventId);
  }

  return { paymentId: localPayment.id };
}

async function handlePaymentPaidEvent({ webhookRecord, resource, ipAddress }) {
  // checkout_session.payment.paid's nested resource is the Checkout Session
  // itself (its own `payments` array holds the actual Payment); a bare
  // payment.paid event's nested resource IS the Payment. Handle both shapes,
  // and fall back to the metadata.paymentId we set at checkout-creation time
  // if the checkout id can't be matched directly.
  const isCheckoutSession = resource?.type === 'checkout_session';
  const checkoutId = isCheckoutSession ? resource.id : resource?.attributes?.checkout_session_id;
  const gatewayPayment = isCheckoutSession ? resource?.attributes?.payments?.[0] : resource;
  const metadataPaymentId = resource?.attributes?.metadata?.paymentId || gatewayPayment?.attributes?.metadata?.paymentId;

  let localPayment = null;
  if (checkoutId) {
    localPayment = await prisma.payment.findUnique({ where: { gatewayCheckoutId: checkoutId } });
  }
  if (!localPayment && metadataPaymentId) {
    localPayment = await prisma.payment.findUnique({ where: { id: Number(metadataPaymentId) } });
  }

  if (!localPayment) {
    await auditService.log({ action: 'WEBHOOK_REJECTED', metadata: { webhookId: webhookRecord.webhookId, reason: 'no matching local payment' }, ipAddress });
    await markWebhookProcessed(webhookRecord.id, null);
    return { unmatched: true };
  }

  if (localPayment.status === 'PAID') {
    await markWebhookProcessed(webhookRecord.id, localPayment.id);
    return { alreadyPaid: true, paymentId: localPayment.id };
  }

  // A REFUNDED payment is a settled, terminal state exactly like PAID — a
  // late/out-of-order "paid" event (e.g. a delayed retry of an earlier
  // delivery attempt) must never resurrect it back to PAID after the money
  // has already been returned. Unlike PAID above this is genuinely
  // unexpected rather than a normal idempotent re-delivery, so it's recorded
  // as an anomaly rather than silently no-op'd. (FAILED/EXPIRED/CANCELLED are
  // deliberately NOT blocked here — PayMongo's hosted checkout can let a user
  // retry a declined attempt within the same checkout session, so a
  // previously-FAILED local Payment legitimately reaching PAID is expected,
  // not a downgrade-then-upgrade attack.)
  if (localPayment.status === 'REFUNDED') {
    await auditService.log({
      action: 'SUSPICIOUS_PAYMENT_MISMATCH',
      paymentId: localPayment.id,
      targetUserId: localPayment.userId,
      metadata: { reason: 'paid webhook received for an already-refunded payment', webhookId: webhookRecord.webhookId },
      ipAddress,
    });
    await markWebhookProcessed(webhookRecord.id, localPayment.id);
    return { rejectedTransition: true, from: 'REFUNDED', to: 'PAID', paymentId: localPayment.id };
  }

  const gatewayAmount = gatewayPayment?.attributes?.amount ?? gatewayPayment?.amount;
  const gatewayCurrency = gatewayPayment?.attributes?.currency ?? gatewayPayment?.currency ?? 'PHP';
  const gatewayStatus = gatewayPayment?.attributes?.status ?? gatewayPayment?.status;
  const gatewayId = gatewayPayment?.id;
  // Only present once PayMongo has actually settled the payment — this is
  // their real deducted cut, not an estimate.
  const gatewayFeeCentavos = gatewayPayment?.attributes?.fee ?? gatewayPayment?.fee;

  await verifyGatewayAmountMatches(localPayment, gatewayAmount, gatewayCurrency, {
    webhookId: webhookRecord.webhookId,
    webhookRecordId: webhookRecord.id,
    ipAddress,
  });

  if (gatewayStatus && gatewayStatus !== 'paid') {
    await markWebhookProcessed(webhookRecord.id, localPayment.id);
    return { notPaid: true };
  }

  await applyPaymentPaid(localPayment, { gatewayPaymentId: gatewayId, gatewayFeeCentavos, webhookRecordId: webhookRecord.id, source: 'webhook', ipAddress });

  return { confirmed: true, paymentId: localPayment.id };
}

// Without this, a failed GCash attempt (declined, cancelled by the user on
// PayMongo's page, etc.) would leave the Payment stuck PENDING forever instead
// of freeing the user up to see a clear "failed, try again" state.
async function handlePaymentFailedEvent({ webhookRecord, resource, ipAddress }) {
  const isCheckoutSession = resource?.type === 'checkout_session';
  const checkoutId = isCheckoutSession ? resource.id : resource?.attributes?.checkout_session_id;
  const gatewayPayment = isCheckoutSession ? resource?.attributes?.payments?.[0] : resource;
  const metadataPaymentId = resource?.attributes?.metadata?.paymentId || gatewayPayment?.attributes?.metadata?.paymentId;

  let localPayment = null;
  if (checkoutId) {
    localPayment = await prisma.payment.findUnique({ where: { gatewayCheckoutId: checkoutId } });
  }
  if (!localPayment && metadataPaymentId) {
    localPayment = await prisma.payment.findUnique({ where: { id: Number(metadataPaymentId) } });
  }

  if (!localPayment) {
    await markWebhookProcessed(webhookRecord.id, null);
    return { unmatched: true };
  }

  // A payment that's already PAID/REFUNDED is a settled, terminal state — a
  // late/out-of-order "failed" event must never downgrade it.
  if (!ACTIVE_STATUSES.includes(localPayment.status)) {
    await markWebhookProcessed(webhookRecord.id, localPayment.id);
    return { noChange: true };
  }

  await applyPaymentFailed(localPayment, { webhookRecordId: webhookRecord.id, source: 'webhook', ipAddress });

  return { failed: true, paymentId: localPayment.id };
}

async function handleRefundEvent({ webhookRecord, resource, eventType, ipAddress }) {
  const gatewayRefundId = resource?.id;
  const status = eventType === 'refund.succeeded' ? 'SUCCEEDED' : 'FAILED';

  const refund = gatewayRefundId ? await prisma.refund.findUnique({ where: { gatewayRefundId } }) : null;
  if (!refund) {
    await markWebhookProcessed(webhookRecord.id, null);
    return { unmatched: true };
  }

  if (refund.status === status) {
    await markWebhookProcessed(webhookRecord.id, refund.paymentId);
    return { noChange: true };
  }

  // Needed (beyond refund.paymentId) to know whether to also free up the
  // event-registration slot below.
  const payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });

  // The only valid FROM-state for REFUNDED is PAID — requestRefund() already
  // requires status === 'PAID' before it will ever create a Refund row, and a
  // PAID payment can never be downgraded away from PAID by any other webhook
  // handler (handlePaymentFailedEvent explicitly excludes it). So this should
  // be unreachable in practice, but it's still checked here directly rather
  // than trusted transitively — a "FAILED/REFUNDED payment gets marked
  // REFUNDED again" webhook must be rejected as anomalous, not silently
  // applied, since Payment and Refund would otherwise end up inconsistent
  // (Refund=SUCCEEDED, Payment≠REFUNDED).
  if (status === 'SUCCEEDED' && payment && payment.status !== 'PAID') {
    await auditService.log({
      action: 'SUSPICIOUS_PAYMENT_MISMATCH',
      paymentId: refund.paymentId,
      targetUserId: payment.userId,
      metadata: { reason: `refund.succeeded webhook for a payment in ${payment.status}, not PAID`, gatewayRefundId, webhookId: webhookRecord.webhookId },
      ipAddress,
    });
    await markWebhookProcessed(webhookRecord.id, refund.paymentId);
    return { rejectedTransition: true, from: payment.status, to: 'REFUNDED', paymentId: refund.paymentId };
  }

  await prisma.$transaction(async (tx) => {
    await tx.refund.update({ where: { id: refund.id }, data: { status } });

    if (status === 'SUCCEEDED') {
      await tx.payment.update({ where: { id: refund.paymentId }, data: { status: 'REFUNDED' } });

      if (payment && payment.purpose === 'EVENT_REGISTRATION' && payment.eventId) {
        const registration = await tx.eventRegistration.findUnique({
          where: { userId_eventId: { userId: payment.userId, eventId: payment.eventId } },
        });
        if (registration && registration.status === 'REGISTERED') {
          await tx.eventRegistration.update({ where: { id: registration.id }, data: { status: 'CANCELLED' } });
        }
      }
    }

    await tx.paymentWebhook.update({
      where: { id: webhookRecord.id },
      data: { paymentId: refund.paymentId, processed: true, processedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        action: status === 'SUCCEEDED' ? 'REFUND_SUCCEEDED' : 'REFUND_FAILED',
        paymentId: refund.paymentId,
        metadata: JSON.stringify({ gatewayRefundId, webhookId: webhookRecord.webhookId }),
        ipAddress,
      },
    });
  });

  return { updated: true, status };
}

// Reconciliation for gateway/local state drift (e.g. a lost webhook
// delivery) — called both by the admin's manual "Reconcile" button and by
// the scheduled sweep in src/jobs/paymentReconciliationSweep.job.js.
// Purpose-agnostic: works for membership and event-fee payments alike.
// `triggeredBy` is purely an audit-trail label ('admin' for the manual
// button, 'auto_sweep' for the scheduled job) — it changes nothing about the
// reconciliation logic itself.
async function reconcilePayment(paymentId, { triggeredBy = 'admin' } = {}) {
  const payment = await prisma.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) throw new AppError('Payment not found', 404);

  // Already settled locally — nothing to reconcile, regardless of whether a
  // gatewayCheckoutId happens to be on record (e.g. it can be missing if the
  // original checkout-creation call failed after the Payment row was created
  // but the payment was still later matched and confirmed by webhook via the
  // metadata.paymentId fallback).
  if (payment.status === 'PAID' || payment.status === 'REFUNDED') {
    await auditService.log({ action: 'PAYMENT_RECONCILED', paymentId: payment.id, metadata: { outcome: 'already_settled_locally', localStatus: payment.status, triggeredBy } });
    return { outcome: 'no_change', localStatus: payment.status };
  }

  if (!payment.gatewayCheckoutId) {
    throw new AppError('This payment has no gateway checkout to reconcile against', 400);
  }

  // GET /checkout_sessions/:id — attributes.status is 'active' | 'expired';
  // attributes.payments[] holds any attempted payments, each with its own
  // attributes.status ('paid' on success) — verified against PayMongo's docs
  // while building this, not recalled from memory.
  const session = await paymongoService.getCheckoutSession(payment.gatewayCheckoutId);
  const sessionStatus = session?.attributes?.status;
  const paidGatewayPayment = (session?.attributes?.payments || []).find((p) => p?.attributes?.status === 'paid');

  if (paidGatewayPayment) {
    const gatewayAmount = paidGatewayPayment.attributes?.amount;
    const gatewayCurrency = paidGatewayPayment.attributes?.currency ?? 'PHP';
    await verifyGatewayAmountMatches(payment, gatewayAmount, gatewayCurrency, {});
    await applyPaymentPaid(payment, {
      gatewayPaymentId: paidGatewayPayment.id,
      gatewayFeeCentavos: paidGatewayPayment.attributes?.fee,
      source: 'reconcile',
    });
    await auditService.log({ action: 'PAYMENT_RECONCILED', paymentId: payment.id, metadata: { outcome: 'marked_paid', gatewayPaymentId: paidGatewayPayment.id, triggeredBy } });
    return { outcome: 'marked_paid', paymentId: payment.id };
  }

  if (sessionStatus === 'expired') {
    await applyPaymentFailed(payment, { source: 'reconcile' });
    await auditService.log({ action: 'PAYMENT_RECONCILED', paymentId: payment.id, metadata: { outcome: 'marked_failed', gatewaySessionStatus: sessionStatus, triggeredBy } });
    return { outcome: 'marked_failed', paymentId: payment.id };
  }

  await auditService.log({ action: 'PAYMENT_RECONCILED', paymentId: payment.id, metadata: { outcome: 'still_pending', gatewaySessionStatus: sessionStatus, triggeredBy } });
  return { outcome: 'still_pending', gatewaySessionStatus: sessionStatus };
}

// Candidates for the automated sweep: still PENDING/PROCESSING well past the
// point a webhook should normally have arrived, and actually has a gateway
// checkout to check against (reconcilePayment throws without one — a Payment
// row can lack one if checkout creation itself failed before ever reaching
// PayMongo, which isn't this job's concern).
async function findStuckPayments(olderThanMinutes) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  return prisma.payment.findMany({
    where: { status: { in: ACTIVE_STATUSES }, createdAt: { lte: cutoff }, gatewayCheckoutId: { not: null } },
    orderBy: { createdAt: 'asc' },
  });
}

// --- Refunds (MAIN_ADMIN only — enforced by the route middleware, not here) ---

async function requestRefund({ paymentId, adminUserId, reason, notes }) {
  const payment = await prisma.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) throw new AppError('Payment not found', 404);
  if (payment.status !== 'PAID') throw new AppError('Only a paid payment can be refunded', 400);
  if (!payment.gatewayPaymentId) throw new AppError('This payment has no gateway reference to refund', 400);

  const existingRefund = await prisma.refund.findUnique({ where: { paymentId: payment.id } });
  if (existingRefund) throw new AppError('This payment already has a refund on record', 409);

  let gatewayRefund;
  try {
    gatewayRefund = await paymongoService.createRefund({
      gatewayPaymentId: payment.gatewayPaymentId,
      amountCentavos: payment.amount,
      reason: reason || 'requested_by_customer',
      notes,
    });
  } catch (err) {
    await auditService.log({
      action: 'REFUND_FAILED',
      actorId: adminUserId,
      targetUserId: payment.userId,
      paymentId: payment.id,
      metadata: { reason: 'gateway request failed', message: err.message },
    });
    throw err;
  }

  const refund = await prisma.$transaction(async (tx) => {
    const created = await tx.refund.create({
      data: {
        paymentId: payment.id,
        requestedBy: Number(adminUserId),
        reason: notes || reason || null,
        amount: payment.amount,
        gatewayRefundId: gatewayRefund.id,
        status: 'REQUESTED',
      },
    });
    await tx.auditLog.create({
      data: {
        action: 'REFUND_REQUESTED',
        actorId: Number(adminUserId),
        targetUserId: payment.userId,
        paymentId: payment.id,
        metadata: JSON.stringify({ amount: payment.amount, gatewayRefundId: gatewayRefund.id }),
      },
    });
    return created;
  });

  return refund;
}

module.exports = {
  getMembershipStatus,
  classifyMembership,
  MEMBERSHIP_TIERS,
  nextMembershipExpiry,
  MEMBERSHIP_VALIDITY_DAYS,
  getLatestMembershipPayment,
  getLatestEventPayment,
  getLatestMembershipStatusForUsers,
  getPaymentForViewer,
  listPaymentsForAdmin,
  getPaymentSummary,
  createMembershipCheckout,
  createEventCheckout,
  calculateGatewaySurcharge,
  processWebhookEvent,
  requestRefund,
  reconcilePayment,
  findStuckPayments,
};
