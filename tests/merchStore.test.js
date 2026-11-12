// Tests for the merchandise store, phase 2: Store pages, cart, checkout through
// PayMongo, the 30-minute stock hold, payment confirmation, expiry, late
// payments and refunds.
//
// PayMongo is replaced in-process (createGcashCheckout, expireCheckoutSession,
// getCheckoutSession, createRefund), so no request leaves the machine and no
// money moves. Payments are switched on for the run and put back afterwards.
// PayMongo's notices are fed straight to processWebhookEvent (the signature
// check in front of it is tested elsewhere).

require('dotenv').config();
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.BREVO_API_KEY = '';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const settingsService = require('../src/services/settings.service');
const paymongo = require('../src/services/paymongo.service');
const paymentService = require('../src/services/payment.service');
const store = require('../src/services/merchStore.service');
const merch = require('../src/services/merch.service');

const TAG = `__ms${Date.now()}`;
const PASSWORD = 'merch-store-password-1';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}\n      ${err.message}`);
    failed += 1;
  }
}

// --- PayMongo stand-in ---------------------------------------------------------------
const calls = { checkout: [], expire: [], refund: [] };
const sessions = new Map(); // referenceNumber -> checkoutId (PayMongo returns the same session for the same key)
const paidAtGateway = new Set(); // checkoutIds PayMongo would report as paid
let expireFails = false;
let seq = 0;
paymongo.createGcashCheckout = async ({ referenceNumber, amountCentavos, surchargeCentavos }) => {
  if (!sessions.has(referenceNumber)) { seq += 1; sessions.set(referenceNumber, `cs_${TAG}_${seq}`); }
  calls.checkout.push({ referenceNumber, amountCentavos, surchargeCentavos });
  const checkoutId = sessions.get(referenceNumber);
  return { checkoutId, checkoutUrl: `https://checkout.example.invalid/${checkoutId}` };
};
paymongo.expireCheckoutSession = async (id) => {
  calls.expire.push(id);
  if (expireFails) throw new Error('already paid');
  return { id, attributes: { status: 'expired' } };
};
paymongo.getCheckoutSession = async (id) => {
  const pay = await prisma.payment.findFirst({ where: { gatewayCheckoutId: id } });
  return {
    id,
    attributes: {
      status: paidAtGateway.has(id) ? 'active' : 'expired',
      payments: paidAtGateway.has(id) ? [{ id: `pay_${id}`, attributes: { status: 'paid', amount: pay.amount, currency: 'PHP', fee: 1000 } }] : [],
    },
  };
};
paymongo.createRefund = async ({ gatewayPaymentId, amountCentavos }) => {
  calls.refund.push({ gatewayPaymentId, amountCentavos });
  return { id: `ref_${TAG}_${calls.refund.length}`, attributes: { status: 'pending' } };
};

let evt = 0;
let pick = () => ({});
async function payAtGateway(order) {
  const fresh = await prisma.merchOrder.findUnique({ where: { id: order.id }, include: { payment: true } });
  const p = fresh.payment;
  evt += 1;
  paidAtGateway.add(p.gatewayCheckoutId);
  return paymentService.processWebhookEvent({
    data: {
      id: `evt_${TAG}_${evt}`,
      attributes: {
        type: 'checkout_session.payment.paid',
        data: {
          id: p.gatewayCheckoutId, type: 'checkout_session',
          attributes: { metadata: { paymentId: String(p.id) }, payments: [{ id: `pay_${TAG}_${p.id}`, attributes: { amount: p.amount, currency: 'PHP', status: 'paid', fee: 1000 } }] },
        },
      },
    },
  });
}

// --- HTTP helpers ----------------------------------------------------------------------
let base;
let ipSeq = 0;
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `198.51.100.${10 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password: PASSWORD, context }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  return async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method, redirect: 'manual',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text };
  };
}

async function makeUser(label, extra = {}) {
  return prisma.user.create({
    data: {
      firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`,
      password: await bcrypt.hash(PASSWORD, 4), role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
      ...extra,
    },
  });
}

const available = async (variantId) => (await store.availableFor([variantId])).get(variantId);
const onHand = async (variantId) => (await merch.onHandFor([variantId])).get(variantId);
const orderBy = (number) => prisma.merchOrder.findUnique({ where: { orderNumber: number }, include: { items: true, payment: true } });

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const saved = {
    payments: await settingsService.getPaymentsEnabled(),
    open: await settingsService.getSetting('merchStoreOpen', null),
  };
  await settingsService.setPaymentsEnabled(true);
  await settingsService.setSetting('merchStoreOpen', 'false');

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const ann = await makeUser('Ann', { membershipExpiresAt: new Date(Date.now() + 200 * 864e5) }); // member
  const ben = await makeUser('Ben'); // non-member
  const cy = await makeUser('Cy');
  const dee = await makeUser('Dee');
  const users = [admin, ann, ben, cy, dee];

  const product = await merch.createProduct({ name: `${TAG} Polo`, isActive: true });
  const L = await merch.addVariant(product.id, { label: 'Navy / L', memberPrice: '300', price: '450', cost: '200', limitPerBuyer: '2' }, admin.id);
  const M = await merch.addVariant(product.id, { label: 'Navy / M', memberPrice: '300', price: '450' }, admin.id);
  const TBD = await merch.addVariant(product.id, { label: 'Navy / S' }, admin.id);
  await merch.recordStock(L.id, { action: 'receive', quantity: '3' }, admin.id);
  // Checkout needs delivery or pickup (phase 3a): these tests use a pickup point.
  const point = await prisma.merchPickupPoint.create({ data: { name: `${TAG} Office`, address: 'Quezon City' } });
  pick = () => ({ fulfilment: 'PICKUP', pickupPointId: point.id });
  await merch.recordStock(M.id, { action: 'receive', quantity: '5' }, admin.id);

  try {
    const Ad = await signIn(admin.email, 'admin');
    const A = await signIn(ann.email);
    const B = await signIn(ben.email);
    const C = await signIn(cy.email);
    const D = await signIn(dee.email);

    await test('the Store is hidden until opened; the main admin can preview it', async () => {
      assert.strictEqual((await A('GET', '/store')).status, 404);
      assert.strictEqual((await A('POST', '/api/store/cart', { variantId: L.id })).status, 404);
      const preview = await Ad('GET', '/store');
      assert.strictEqual(preview.status, 200);
      assert(preview.text.includes('data-preview-banner') && preview.text.includes(`${TAG} Polo`));
      assert.strictEqual((await Ad('PUT', '/api/admin/merch/store-open', { open: true })).status, 200);
      assert.strictEqual((await A('GET', '/store')).status, 200);
      assert((await A('GET', '/')).text.includes('href="/store"'), 'menu shows Store');
    });

    await test('members pay the member price, others the non-member price; TBD is not for sale', async () => {
      assert((await A('GET', '/store')).text.includes('₱300.00'));
      assert((await B('GET', '/store')).text.includes('₱450.00'));
      let r = await A('POST', '/api/store/cart', { variantId: L.id, quantity: 1, price: 1 });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.deepStrictEqual([r.json.data.cart.items[0].unitPrice, r.json.data.cart.items[0].priceType], [30000, 'MEMBER'], 'a price in the request is ignored');
      r = await B('POST', '/api/store/cart', { variantId: M.id, quantity: 1 });
      assert.strictEqual(r.json.data.cart.items[0].unitPrice, 45000);
      assert.strictEqual((await A('POST', '/api/store/cart', { variantId: TBD.id })).status, 422, 'not priced yet');
      assert.strictEqual((await Ad('POST', '/api/store/cart', { variantId: M.id })).status, 403, 'the main admin cannot buy');
    });

    await test('limit per buyer and stock are enforced when adding', async () => {
      assert.strictEqual((await A('POST', '/api/store/cart', { variantId: L.id, quantity: 2 })).status, 422, '1 + 2 > limit 2');
      assert.strictEqual((await B('POST', '/api/store/cart', { variantId: M.id, quantity: 9 })).status, 409, 'only 5 left');
      const r = await A('PUT', `/api/store/cart/${L.id}`, { quantity: 2 });
      assert.strictEqual(r.json.data.cart.items[0].quantity, 2);
    });

    let annOrder;
    await test('checkout holds the stock for 30 minutes and opens PayMongo for the order total', async () => {
      const r = await A('POST', '/api/store/checkout', pick());
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      assert(/^ORD-\d{4}-\d{6}$/.test(r.json.data.orderNumber));
      assert(r.json.data.checkoutUrl.startsWith('https://checkout.example.invalid/'));
      annOrder = await orderBy(r.json.data.orderNumber);
      assert.deepStrictEqual([annOrder.status, annOrder.subtotalCentavos, annOrder.memberPricing], ['AWAITING_PAYMENT', 60000, true]);
      assert(Math.abs(new Date(annOrder.holdExpiresAt) - Date.now() - 30 * 60000) < 60000, 'hold of 30 minutes');
      assert.strictEqual(annOrder.payment.amount, annOrder.totalCentavos, 'PayMongo charges the order total');
      assert.strictEqual(calls.checkout.at(-1).amountCentavos, 60000);
      assert.deepStrictEqual([await onHand(L.id), await available(L.id)], [3, 1], 'on hand unchanged, 2 held');
      assert.strictEqual((await A('GET', '/api/store/cart')).json.data.cart.items.length, 0, 'cart emptied');
    });

    await test('one unpaid order at a time', async () => {
      await A('POST', '/api/store/cart', { variantId: M.id, quantity: 1 });
      const r = await A('POST', '/api/store/checkout', pick());
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.data.orderNumber, annOrder.orderNumber);
      await A('DELETE', `/api/store/cart/${M.id}`);
    });

    await test('PayMongo\'s paid notice turns the hold into a sale, once', async () => {
      await payAtGateway(annOrder);
      let o = await orderBy(annOrder.orderNumber);
      assert.strictEqual(o.status, 'PAID');
      assert.deepStrictEqual([await onHand(L.id), await available(L.id)], [1, 1]);
      await payAtGateway(annOrder); // a second notice for the same payment
      o = await orderBy(annOrder.orderNumber);
      assert.strictEqual(o.status, 'PAID');
      assert.strictEqual(await onHand(L.id), 1, 'not sold twice');
      const page = await A('GET', `/store/orders/${annOrder.orderNumber}`);
      assert(page.text.includes('Paid on') && page.text.includes('Navy / L'));
      assert((await A('GET', '/store/orders')).text.includes(annOrder.orderNumber));
      assert.strictEqual((await B('GET', `/store/orders/${annOrder.orderNumber}`)).status, 404, 'not someone else\'s order');
    });

    let benOrder;
    await test('a hold that runs out: the PayMongo link is expired first, then the stock goes back', async () => {
      await B('POST', '/api/store/cart', { variantId: L.id, quantity: 1 });
      const r = await B('POST', '/api/store/checkout', pick());
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      benOrder = await orderBy(r.json.data.orderNumber);
      assert.strictEqual(await available(L.id), 0);
      assert.strictEqual(benOrder.subtotalCentavos, 45000 + 45000, 'M from earlier + L, non-member prices');
      await prisma.merchOrder.update({ where: { id: benOrder.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const before = calls.expire.length;
      const outcome = await store.sweepExpiredHolds();
      assert.strictEqual(outcome.cancelled, 1);
      assert.strictEqual(calls.expire.length, before + 1, 'link expired at PayMongo');
      const o = await orderBy(benOrder.orderNumber);
      assert.deepStrictEqual([o.status, o.cancelReason, o.payment.status], ['CANCELLED', 'Payment time ran out', 'EXPIRED']);
      assert.strictEqual(await available(L.id), 1, 'stock back on sale');
    });

    await test('a late payment still goes through when the stock is there', async () => {
      await payAtGateway(benOrder);
      const o = await orderBy(benOrder.orderNumber);
      assert.deepStrictEqual([o.status, o.cancelReason], ['PAID', null]);
      assert.strictEqual(await available(L.id), 0);
    });

    let cyOrder;
    await test('a late payment after the stock sold out is cancelled and refunded automatically', async () => {
      await merch.recordStock(L.id, { action: 'receive', quantity: '1' }, admin.id);
      await C('POST', '/api/store/cart', { variantId: L.id, quantity: 1 });
      cyOrder = await orderBy((await C('POST', '/api/store/checkout', pick())).json.data.orderNumber);
      await prisma.merchOrder.update({ where: { id: cyOrder.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      await store.sweepExpiredHolds();
      await D('POST', '/api/store/cart', { variantId: L.id, quantity: 1 });
      const dee1 = await orderBy((await D('POST', '/api/store/checkout', pick())).json.data.orderNumber);
      await payAtGateway(dee1); // Dee buys the last one
      const refundsBefore = calls.refund.length;
      await payAtGateway(cyOrder); // Cy's money arrives late
      const o = await orderBy(cyOrder.orderNumber);
      assert.deepStrictEqual([o.status, o.cancelReason], ['CANCELLED', 'Sold out at payment']);
      assert.strictEqual(calls.refund.length, refundsBefore + 1, 'refund sent to PayMongo');
      assert.strictEqual(calls.refund.at(-1).amountCentavos, o.payment.amount, 'the full amount');
      const refund = await prisma.refund.findUnique({ where: { paymentId: o.paymentId } });
      assert.deepStrictEqual([refund.requestedBy, refund.status], [null, 'REQUESTED'], 'requested by the system');
      assert.strictEqual(await onHand(L.id), 0, 'nothing oversold');
      assert((await C('GET', `/store/orders/${cyOrder.orderNumber}`)).text.includes('being refunded'));
    });

    await test('when PayMongo refuses to expire a link that was paid, the order is confirmed, not cancelled', async () => {
      await A('POST', '/api/store/cart', { variantId: M.id, quantity: 1 });
      const o1 = await orderBy((await A('POST', '/api/store/checkout', pick())).json.data.orderNumber);
      paidAtGateway.add(o1.payment.gatewayCheckoutId);
      expireFails = true;
      await prisma.merchOrder.update({ where: { id: o1.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      const outcome = await store.sweepExpiredHolds();
      expireFails = false;
      assert.strictEqual(outcome.paidInstead, 1);
      assert.strictEqual((await orderBy(o1.orderNumber)).status, 'PAID');
    });

    await test('a buyer can cancel an unpaid order; the stock comes back', async () => {
      const before = await available(M.id);
      await B('POST', '/api/store/cart', { variantId: M.id, quantity: 2 });
      const o = await orderBy((await B('POST', '/api/store/checkout', pick())).json.data.orderNumber);
      assert.strictEqual(await available(M.id), before - 2);
      const r = await B('POST', `/api/store/orders/${o.orderNumber}/cancel`);
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.deepStrictEqual([(await orderBy(o.orderNumber)).status, await available(M.id)], ['CANCELLED', before]);
      assert.strictEqual((await B('POST', `/api/store/orders/${o.orderNumber}/pay`)).status, 409, 'cannot pay a cancelled order');
    });

    await test('a refund confirmed by PayMongo marks the paid order Refunded', async () => {
      const o = await orderBy(annOrder.orderNumber);
      const refund = await paymentService.requestRefund({ paymentId: o.paymentId, adminUserId: admin.id, reason: 'requested_by_customer' });
      evt += 1;
      await paymentService.processWebhookEvent({ data: { id: `evt_${TAG}_${evt}`, attributes: { type: 'refund.succeeded', data: { id: refund.gatewayRefundId } } } });
      assert.strictEqual((await orderBy(annOrder.orderNumber)).status, 'REFUNDED');
    });

    await test('two buyers racing for the last item: exactly one gets it', async () => {
      await merch.recordStock(M.id, { action: 'count', counted: String((await onHand(M.id))), reason: 'check' }, admin.id);
      const left = await available(M.id);
      const need = left; // each tries to take everything that is left
      await C('POST', '/api/store/cart', { variantId: M.id, quantity: Math.min(need, 100) });
      await D('POST', '/api/store/cart', { variantId: M.id, quantity: Math.min(need, 100) });
      const [r1, r2] = await Promise.all([C('POST', '/api/store/checkout', pick()), D('POST', '/api/store/checkout', pick())]);
      const ok = [r1, r2].filter((r) => r.status === 201);
      assert.strictEqual(ok.length, 1, `${r1.status} / ${r2.status}`);
      assert.strictEqual(await available(M.id), 0, 'never below zero');
    });

    await test('with online payment switched off, checkout is closed', async () => {
      await settingsService.setPaymentsEnabled(false);
      await prisma.merchCartItem.deleteMany({ where: { userId: ann.id } });
      await merch.recordStock(L.id, { action: 'receive', quantity: '1' }, admin.id);
      await A('POST', '/api/store/cart', { variantId: L.id, quantity: 1 }).catch(() => {});
      const r = await A('POST', '/api/store/checkout', pick());
      assert.strictEqual(r.status, 503);
      await settingsService.setPaymentsEnabled(true);
    });
  } finally {
    server.close();
    await settingsService.setPaymentsEnabled(saved.payments);
    if (saved.open === null) await prisma.siteSetting.deleteMany({ where: { key: 'merchStoreOpen' } }).catch(() => {});
    else await settingsService.setSetting('merchStoreOpen', saved.open);
    const ids = users.map((u) => u.id);
    const orders = await prisma.merchOrder.findMany({ where: { userId: { in: ids } }, select: { id: true, paymentId: true } });
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: product.id } } }).catch((e) => console.error(e.message));
    await prisma.merchOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } }).catch((e) => console.error(e.message));
    await prisma.merchCartItem.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.merchProduct.delete({ where: { id: product.id } }).catch((e) => console.error(e.message));
    await prisma.merchPickupPoint.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const payIds = (await prisma.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    await prisma.refund.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
    await prisma.paymentWebhook.deleteMany({ where: { webhookId: { startsWith: `evt_${TAG}` } } }).catch(() => {});
    await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }, { paymentId: { in: payIds } }] } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { in: payIds } } }).catch((e) => console.error(e.message));
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.1' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
