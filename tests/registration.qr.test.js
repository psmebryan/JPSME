// Integration tests for phase 3: does a ticket actually get minted at the two
// points a registration becomes REGISTERED, and only at those points.
//
// The paid path is driven through the real entry point — processWebhookEvent
// with a payment.paid envelope — rather than by calling the internal transition
// directly. The whole security argument for paid events is "only a confirmed
// payment mints a ticket", and testing a private function would leave the actual
// route money takes unexercised.
//
// Runs against the real dev database, same as the other suites here. Fixtures
// are tagged and removed in a finally block.

const prisma = require('../src/config/prisma');
const qrService = require('../src/services/qr.service');
const registrationService = require('../src/services/registration.service');
const paymentService = require('../src/services/payment.service');

const TAG = '__REGQRTEST__';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { contains: TAG.toLowerCase() } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  const guard = userIds.length ? userIds : [0];

  await prisma.paymentWebhook.deleteMany({ where: { webhookId: { contains: TAG } } });
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: guard } } });
  await prisma.paymentAttempt.deleteMany({ where: { payment: { userId: { in: guard } } } });
  await prisma.payment.deleteMany({ where: { userId: { in: guard } } });
  await prisma.eventRegistration.deleteMany({ where: { userId: { in: guard } } });
  await prisma.event.deleteMany({ where: { title: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { id: { in: guard } } });
}

let seq = 0;
async function makeMember() {
  seq += 1;
  return prisma.user.create({
    data: {
      firstName: 'Reg', lastName: `Member${seq}`,
      email: `${TAG.toLowerCase()}m${seq}@example.test`,
      password: 'not-a-real-hash', status: 'APPROVED',
    },
  });
}

async function makeEvent(feeCentavos = 0) {
  return prisma.event.create({
    data: {
      title: `${TAG} ${feeCentavos ? 'Paid' : 'Free'} Event ${(seq += 1)}`,
      startDate: new Date(Date.now() + 86400000),
      feeCentavos,
      isPublished: true,
    },
  });
}

// Mirrors what payment.service.js's createEventCheckout leaves behind: a PENDING
// Payment tied to the event, plus the PENDING_PAYMENT registration holding the
// capacity slot. Built directly so the test does not have to reach PayMongo.
async function makePendingEventPayment(user, event) {
  const registration = await registrationService.createPendingPaymentRegistration(user, event);
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      eventId: event.id,
      purpose: 'EVENT_REGISTRATION',
      amount: event.feeCentavos,
      currency: 'PHP',
      status: 'PENDING',
      gatewayCheckoutId: `cs_${TAG}_${event.id}_${user.id}_${(seq += 1)}`,
    },
  });
  return { registration, payment };
}

// A payment.paid envelope shaped the way handlePaymentPaidEvent reads it: the
// nested resource IS the Payment, and it carries the checkout_session_id that
// matches our local row.
function paidWebhookEnvelope(payment, { webhookId }) {
  return {
    data: {
      id: webhookId,
      attributes: {
        type: 'payment.paid',
        data: {
          id: `pay_${webhookId}`,
          type: 'payment',
          attributes: {
            checkout_session_id: payment.gatewayCheckoutId,
            amount: payment.amount,
            currency: 'PHP',
            status: 'paid',
            fee: 0,
          },
        },
      },
    },
  };
}

async function main() {
  await cleanup();

  // --- free events ----------------------------------------------------------

  await test('registering for a free event mints a ticket in the same breath', async () => {
    const user = await makeMember();
    const event = await makeEvent(0);
    const reg = await registrationService.registerForEvent(user, event.id);

    assertEqual(reg.status, 'REGISTERED', 'registered immediately');
    assert(/^[0-9a-f]{64}$/.test(reg.qrToken), 'a token was minted');
    assert(reg.registrationNumber, 'a registration number was assigned');
    assert(reg.qrGeneratedAt, 'qrGeneratedAt stamped');
  });

  await test('the minted ticket resolves back to that exact registration', async () => {
    const user = await makeMember();
    const event = await makeEvent(0);
    const reg = await registrationService.registerForEvent(user, event.id);

    const { registration } = await qrService.validateQrToken(qrService.buildQrPayload(reg.qrToken));
    assert(registration, 'the token resolves');
    assertEqual(registration.id, reg.id, 'to the right registration');
    assertEqual(registration.event.id, event.id, 'and the right event');
  });

  await test('cancelling leaves the token resolvable so the door can say why, not just "unknown"', async () => {
    const user = await makeMember();
    const event = await makeEvent(0);
    const reg = await registrationService.registerForEvent(user, event.id);
    await registrationService.cancelRegistration(user.id, event.id);

    const { registration } = await qrService.validateQrToken(reg.qrToken);
    assert(registration, 'still resolves');
    assertEqual(registration.status, 'CANCELLED', 'and reports the real reason it must be refused');
  });

  await test('re-registering after a cancellation issues a NEW ticket and kills the old one', async () => {
    const user = await makeMember();
    const event = await makeEvent(0);
    const first = await registrationService.registerForEvent(user, event.id);
    await registrationService.cancelRegistration(user.id, event.id);
    const second = await registrationService.registerForEvent(user, event.id);

    assertEqual(second.status, 'REGISTERED', 'registered again');
    assert(second.qrToken, 'has a ticket');
    assert(second.qrToken !== first.qrToken, 'and it is a different token');

    const old = await qrService.validateQrToken(first.qrToken);
    assertEqual(old.registration, null, 'the pre-cancellation printout is permanently dead');
  });

  await test('re-registering keeps the same registration number', async () => {
    const user = await makeMember();
    const event = await makeEvent(0);
    const first = await registrationService.registerForEvent(user, event.id);
    await registrationService.cancelRegistration(user.id, event.id);
    const second = await registrationService.registerForEvent(user, event.id);
    assertEqual(second.registrationNumber, first.registrationNumber, 'the human reference is stable across the round trip');
  });

  // --- paid events ----------------------------------------------------------

  await test('holding a slot for a paid event mints NO ticket before payment', async () => {
    const user = await makeMember();
    const event = await makeEvent(50000);
    const { registration } = await makePendingEventPayment(user, event);

    assertEqual(registration.status, 'PENDING_PAYMENT', 'slot held');
    assertEqual(registration.qrToken, null, 'but no ticket — an unpaid registrant cannot walk in');
  });

  await test('a confirmed payment mints the ticket and confirms the registration', async () => {
    const user = await makeMember();
    const event = await makeEvent(50000);
    const { registration, payment } = await makePendingEventPayment(user, event);

    const result = await paymentService.processWebhookEvent(
      paidWebhookEnvelope(payment, { webhookId: `evt_${TAG}_paid_${payment.id}` }), '127.0.0.1',
    );
    assert(!result.unmatched, 'the webhook matched the local payment');

    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assertEqual(after.status, 'REGISTERED', 'registration confirmed');
    assert(/^[0-9a-f]{64}$/.test(after.qrToken), 'ticket minted on payment');
    assert(after.registrationNumber, 'registration number assigned');
  });

  await test('a redelivered webhook does not reissue the ticket', async () => {
    const user = await makeMember();
    const event = await makeEvent(50000);
    const { registration, payment } = await makePendingEventPayment(user, event);

    await paymentService.processWebhookEvent(
      paidWebhookEnvelope(payment, { webhookId: `evt_${TAG}_once_${payment.id}` }), '127.0.0.1',
    );
    const afterFirst = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });

    // A genuinely distinct delivery id, so this is not short-circuited by the
    // webhook-replay constraint — it has to be the "already PAID" guard and the
    // idempotent mint doing the work.
    await paymentService.processWebhookEvent(
      paidWebhookEnvelope(payment, { webhookId: `evt_${TAG}_twice_${payment.id}` }), '127.0.0.1',
    );
    const afterSecond = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });

    assertEqual(afterSecond.qrToken, afterFirst.qrToken, 'the member keeps the ticket they already saved');
    assertEqual(afterSecond.qrGeneratedAt.getTime(), afterFirst.qrGeneratedAt.getTime(), 'and its timestamp did not churn');
  });

  await test('a cancelled paid registration that pays again gets a new ticket, not its old one', async () => {
    const user = await makeMember();
    const event = await makeEvent(50000);

    // Pay once, get a ticket, then cancel.
    const first = await makePendingEventPayment(user, event);
    await paymentService.processWebhookEvent(
      paidWebhookEnvelope(first.payment, { webhookId: `evt_${TAG}_r1_${first.payment.id}` }), '127.0.0.1',
    );
    const ticketed = await prisma.eventRegistration.findUnique({ where: { id: first.registration.id } });
    const oldToken = ticketed.qrToken;
    assert(oldToken, 'had a ticket before cancelling');

    await registrationService.cancelRegistration(user.id, event.id);

    // Register and pay again. The slot is re-held, which must drop the old
    // ticket, so the mint on payment issues a fresh one.
    const second = await makePendingEventPayment(user, event);
    const held = await prisma.eventRegistration.findUnique({ where: { id: second.registration.id } });
    assertEqual(held.qrToken, null, 'the old ticket is dropped when the slot is re-held');

    await paymentService.processWebhookEvent(
      paidWebhookEnvelope(second.payment, { webhookId: `evt_${TAG}_r2_${second.payment.id}` }), '127.0.0.1',
    );
    const reticketed = await prisma.eventRegistration.findUnique({ where: { id: second.registration.id } });

    assert(reticketed.qrToken, 'a ticket was issued for the new payment');
    assert(reticketed.qrToken !== oldToken, 'and it is not the pre-cancellation one');
    const dead = await qrService.validateQrToken(oldToken);
    assertEqual(dead.registration, null, 'the pre-cancellation ticket stays dead');
  });

  await test('a failed payment mints nothing', async () => {
    const user = await makeMember();
    const event = await makeEvent(50000);
    const { registration, payment } = await makePendingEventPayment(user, event);

    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
    const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
    assertEqual(after.qrToken, null, 'no ticket without money');
    assertEqual(after.status, 'PENDING_PAYMENT', 'and the registration is not confirmed');
  });

  // --- the invariant the whole design rests on ------------------------------

  await test('no unpaid registration anywhere here holds a ticket, and every confirmed one does', async () => {
    // Deliberately narrower than "only REGISTERED rows have tokens". A
    // CANCELLED registration keeps its token on purpose, so the door can answer
    // "this was cancelled" rather than "unknown code" — the token resolves but
    // never admits, and re-registering replaces it. PENDING_PAYMENT is the case
    // that must be airtight: money has not arrived, so no ticket may exist at
    // all, not even a refusable one.
    const ticketedButUnpaid = await prisma.eventRegistration.count({
      where: {
        qrToken: { not: null },
        status: 'PENDING_PAYMENT',
        user: { email: { contains: TAG.toLowerCase() } },
      },
    });
    assertEqual(ticketedButUnpaid, 0, 'an unpaid registration may never hold a ticket');

    const registeredWithout = await prisma.eventRegistration.count({
      where: {
        qrToken: null,
        status: 'REGISTERED',
        user: { email: { contains: TAG.toLowerCase() } },
      },
    });
    assertEqual(registeredWithout, 0, 'and no confirmed registration may be left without one');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
