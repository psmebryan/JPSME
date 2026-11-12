// Tests for the merchandise store, phase 3b: refunds and exchanges.
//
// Cancelling a paid order before packing, refunds after pickup (with the
// Logistics check, the approval, the second approval above the limit, and
// "nobody approves their own request"), exchanges (hold, receive, hand over),
// the return window, withdrawals and PayMongo's refund results.
//
// PayMongo is replaced in-process; no request leaves the machine and no money
// moves. Pickup orders are used, so nothing depends on the PSGC list.

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
const merch = require('../src/services/merch.service');
const store = require('../src/services/merchStore.service');
const orders = require('../src/services/merchOrders.service');

const TAG = `__mr${Date.now()}`;
const PASSWORD = 'merch-returns-password-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

// --- PayMongo stand-in ---
const refunds = [];
const sessions = new Map();
let seq = 0;
paymongo.createGcashCheckout = async ({ referenceNumber }) => {
  if (!sessions.has(referenceNumber)) { seq += 1; sessions.set(referenceNumber, `cs_${TAG}_${seq}`); }
  return { checkoutId: sessions.get(referenceNumber), checkoutUrl: 'https://checkout.example.invalid/x' };
};
paymongo.expireCheckoutSession = async (id) => ({ id });
paymongo.createRefund = async ({ amountCentavos }) => { refunds.push(amountCentavos); return { id: `ref_${TAG}_${refunds.length}` }; };
let evt = 0;
const webhook = (type, data) => { evt += 1; return paymentService.processWebhookEvent({ data: { id: `evt_${TAG}_${evt}`, attributes: { type, data } } }); };
async function pay(orderNumber) {
  const o = await prisma.merchOrder.findUnique({ where: { orderNumber }, include: { payment: true } });
  await webhook('checkout_session.payment.paid', { id: o.payment.gatewayCheckoutId, type: 'checkout_session', attributes: { metadata: { paymentId: String(o.payment.id) }, payments: [{ id: `pay_${TAG}_${o.payment.id}`, attributes: { amount: o.payment.amount, currency: 'PHP', status: 'paid', fee: 500 } }] } });
}
async function refundResult(returnNumber, type = 'refund.succeeded') {
  const r = await prisma.merchReturn.findUnique({ where: { returnNumber } });
  const refund = await prisma.refund.findUnique({ where: { id: r.refundId } });
  await webhook(type, { id: refund.gatewayRefundId });
}

// --- HTTP ---
let base;
let ipSeq = 0;
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `198.51.100.${90 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: PASSWORD, context }) });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  return async (method, p, body) => {
    const isForm = body instanceof FormData;
    const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* page */ }
    return { status: r.status, json, text };
  };
}
const makeUser = async (label, extra = {}) => prisma.user.create({ data: { firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4), role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(), ...extra } });
const form = (fields, photo) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, typeof v === 'string' ? v : JSON.stringify(v)));
  if (photo) fd.append('photo', new Blob([photo.bytes], { type: 'image/png' }), 'p.png');
  return fd;
};

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const saved = {
    payments: await settingsService.getPaymentsEnabled(), open: await settingsService.getSetting('merchStoreOpen', null),
    access: await settingsService.getSetting('presidentModules', null),
    limit: await settingsService.getSetting('merchRefundApprovalLimit', null), window: await settingsService.getSetting('merchReturnWindowDays', null),
  };
  await settingsService.setPaymentsEnabled(true);
  await settingsService.setSetting('merchStoreOpen', 'true');
  await settingsService.setSetting('presidentModules', JSON.stringify(['dashboard', 'merchandise']));
  await settingsService.setSetting('merchRefundApprovalLimit', '');
  await settingsService.setSetting('merchReturnWindowDays', '7');

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const pres = await makeUser('Pres', { role: 'PRESIDENT' });
  // Phase 4: Finance & Logistics does the check and the first approval.
  const fin = await makeUser('Fin', { role: 'FINANCE_LOGISTICS' });
  await prisma.adminGrant.create({ data: { userId: fin.id, modules: JSON.stringify(['merchFinance', 'merchLogistics']) } });
  const ann = await makeUser('Ann', { membershipExpiresAt: new Date(Date.now() + 100 * 864e5) });
  const ben = await makeUser('Ben');
  const users = [admin, pres, fin, ann, ben];
  const point = await prisma.merchPickupPoint.create({ data: { name: `${TAG} Office`, address: 'QC' } });
  const product = await merch.createProduct({ name: `${TAG} Polo`, isActive: true });
  const L = await merch.addVariant(product.id, { label: 'Navy / L', memberPrice: '50', price: '80' }, admin.id);
  const M = await merch.addVariant(product.id, { label: 'Navy / M', memberPrice: '50', price: '80' }, admin.id);
  const XL = await merch.addVariant(product.id, { label: 'Navy / XL', memberPrice: '60', price: '90' }, admin.id);
  for (const v of [L, M, XL]) await merch.recordStock(v.id, { action: 'receive', quantity: '30' }, admin.id); // eslint-disable-line no-await-in-loop
  const available = async (id) => (await store.availableFor([id])).get(id);

  try {
    const Ad = await signIn(admin.email, 'admin');
    const Pr = await signIn(pres.email, 'admin');
    const Fi = await signIn(fin.email, 'admin');
    const A = await signIn(ann.email);
    const B = await signIn(ben.email);
    const buy = async (U, variantId, qty) => {
      await U('POST', '/api/store/cart', { variantId, quantity: qty });
      const r = await U('POST', '/api/store/checkout', { fulfilment: 'PICKUP', pickupPointId: point.id });
      if (r.status !== 201) throw new Error(`checkout ${r.status} ${r.text.slice(0, 120)}`);
      await pay(r.json.data.orderNumber);
      return r.json.data.orderNumber;
    };
    const pickUp = async (n) => { for (const s of ['pack', 'ready', 'pickedUp']) await orders.applyStep(n, s, {}, admin.id); }; // eslint-disable-line no-await-in-loop
    const ask = (U, n, fields, photo) => U('POST', `/api/store/orders/${n}/returns`, form(fields, photo));
    const act = (U, rn, action, body = {}) => U('POST', `/api/admin/merch/returns/${rn}/${action}`, body);

    await test('cancel a paid order before packing: packing is blocked, the full refund puts the stock back', async () => {
      const before = await available(L.id);
      const n = await buy(A, L.id, 2);
      assert.strictEqual(await available(L.id), before - 2);
      const r = await ask(A, n, { kind: 'CANCEL', reason: 'CANCELLED_BEFORE_PACKING' });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      const rn = r.json.data.request.returnNumber;
      assert.strictEqual(r.json.data.request.status, 'CHECKED', 'nothing for Logistics to check');
      assert.strictEqual((await Ad('POST', `/api/admin/merch/orders/${n}/steps/pack`)).status, 409, 'not packed while cancelling');
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { payment: true } });
      const ok = await act(Ad, rn, 'approve', {});
      assert.strictEqual(ok.status, 200, ok.text.slice(0, 200));
      assert.strictEqual(ok.json.data.request.status, 'REFUND_SENT');
      assert.strictEqual(refunds.at(-1), o.payment.amount, 'everything that was paid');
      assert.strictEqual(await available(L.id), before, 'back on the shelf');
      assert.strictEqual((await prisma.merchOrder.findUnique({ where: { orderNumber: n } })).status, 'CANCELLED');
      await refundResult(rn);
      assert.strictEqual((await prisma.merchReturn.findUnique({ where: { returnNumber: rn } })).status, 'COMPLETED');
      assert.strictEqual((await prisma.payment.findUnique({ where: { id: o.paymentId } })).status, 'REFUNDED');
      assert.strictEqual((await prisma.merchOrder.findUnique({ where: { orderNumber: n } })).status, 'CANCELLED');
    });

    await test('once packed, an order cannot be cancelled; a refund waits until it is received', async () => {
      const n = await buy(B, L.id, 1);
      await orders.applyStep(n, 'pack', {}, admin.id);
      assert.strictEqual((await ask(B, n, { kind: 'CANCEL', reason: 'CANCELLED_BEFORE_PACKING' })).status, 409);
      assert.strictEqual((await ask(B, n, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [] })).status, 409, 'not received yet');
    });

    let annOrder;
    await test('refund after pickup: rules, Logistics check, a partial refund, one refund per order', async () => {
      annOrder = await buy(A, L.id, 2);
      await pickUp(annOrder);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: annOrder }, include: { items: true, payment: true } });
      const item = o.items[0];
      assert.strictEqual((await ask(A, annOrder, { kind: 'REFUND', reason: 'DAMAGED', items: [{ orderItemId: item.id, quantity: 1 }] })).status, 422, 'damage needs a photo');
      assert.strictEqual((await ask(A, annOrder, { kind: 'REFUND', reason: 'OTHER', items: [{ orderItemId: item.id, quantity: 1 }] })).status, 422, 'other needs details');
      assert.strictEqual((await ask(A, annOrder, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 3 }] })).status, 422, 'more than bought');
      assert.strictEqual((await ask(B, annOrder, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 1 }] })).status, 404, 'not Ben\'s order');
      const svg = await ask(A, annOrder, { kind: 'REFUND', reason: 'DAMAGED', items: [{ orderItemId: item.id, quantity: 1 }] }, { bytes: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
      assert.strictEqual(svg.status, 400, 'an svg is not a photo');
      const r = await ask(A, annOrder, { kind: 'REFUND', reason: 'DAMAGED', details: 'Torn seam', items: [{ orderItemId: item.id, quantity: 1 }] }, { bytes: PNG });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      const req = r.json.data.request;
      assert(req.photoUrl, 'photo kept');
      assert.strictEqual(req.suggestedCentavos, 5000, 'one item at the member price');
      assert.strictEqual((await ask(A, annOrder, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 1 }] })).status, 409, 'one open request per order');
      assert.strictEqual((await act(Ad, req.returnNumber, 'approve', { amount: '50' })).status, 409, 'Logistics first');
      const before = await available(L.id);
      const c = await act(Ad, req.returnNumber, 'check', { items: [{ id: req.items[0].id, receivedQty: 1, resaleableQty: 0 }], note: 'Seam torn, not resaleable' });
      assert.strictEqual(c.status, 200, c.text.slice(0, 200));
      assert.strictEqual(await available(L.id), before, 'damaged: not back on the shelf');
      assert.strictEqual((await act(Ad, req.returnNumber, 'approve', { amount: '999' })).status, 422, 'not more than was paid');
      const ap = await act(Ad, req.returnNumber, 'approve', { amount: '50' });
      assert.strictEqual(ap.json.data.request.status, 'REFUND_SENT');
      assert.strictEqual(refunds.at(-1), 5000);
      await refundResult(req.returnNumber);
      const after = await prisma.merchOrder.findUnique({ where: { orderNumber: annOrder }, include: { payment: true } });
      assert.deepStrictEqual([after.status, after.payment.status], ['PICKED_UP', 'PAID'], 'a part refund leaves the order and payment as they were');
      const again = await ask(A, annOrder, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 1 }] });
      assert.strictEqual(again.status, 409, 'PayMongo allows one refund per payment');
    });

    await test('the return window, which staff raising a request are not bound by', async () => {
      const n = await buy(B, M.id, 1);
      await pickUp(n);
      await prisma.merchOrder.update({ where: { orderNumber: n }, data: { pickedUpAt: new Date(Date.now() - 9 * 864e5) } });
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { items: true } });
      const r = await ask(B, n, { kind: 'REFUND', reason: 'WRONG_SIZE', items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
      assert.strictEqual(r.status, 409);
      assert(/within 7 days/.test(r.json.message), r.json.message);
      const staff = await Ad('POST', `/api/admin/merch/orders/${n}/returns`, { kind: 'REFUND', reason: 'DAMAGED', details: 'Found at the desk', allItems: true });
      assert.strictEqual(staff.status, 201, staff.text.slice(0, 200));
      const rn = staff.json.data.request.returnNumber;
      const checkBody = { items: [{ id: staff.json.data.request.items[0].id, receivedQty: 1, resaleableQty: 1 }] };
      assert.strictEqual((await act(Pr, rn, 'check', checkBody)).status, 403, 'the President does not do the Logistics check');
      assert.strictEqual((await act(Fi, rn, 'check', checkBody)).status, 200, 'Logistics does');
      assert.strictEqual((await act(Ad, rn, 'approve', {})).status, 403, 'nobody approves their own request');
      assert.strictEqual((await act(Pr, rn, 'approve', {})).status, 403, 'the President gives only the second approval');
      assert.strictEqual((await act(Fi, rn, 'approve', {})).status, 200, 'Finance can');
    });

    await test('above the approval limit a second, different person approves', async () => {
      await settingsService.setSetting('merchRefundApprovalLimit', '10000'); // PHP 100
      const n = await buy(A, M.id, 3); // 3 x PHP 50 = 150
      await pickUp(n);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { items: true } });
      const rn = (await ask(A, n, { kind: 'REFUND', reason: 'CHANGE_OF_MIND', items: [{ orderItemId: o.items[0].id, quantity: 3 }] })).json.data.request.returnNumber;
      const req = await prisma.merchReturn.findUnique({ where: { returnNumber: rn }, include: { items: true } });
      await act(Ad, rn, 'check', { items: [{ id: req.items[0].id, receivedQty: 3, resaleableQty: 3 }] });
      const first = await act(Ad, rn, 'approve', { amount: '150' });
      assert.strictEqual(first.json.data.request.status, 'NEEDS_SECOND');
      const sentBefore = refunds.length;
      assert.strictEqual((await act(Ad, rn, 'approve', {})).status, 403, 'not the same person twice');
      assert.strictEqual(refunds.length, sentBefore, 'nothing sent yet');
      const second = await act(Pr, rn, 'approve', {});
      assert.strictEqual(second.json.data.request.status, 'REFUND_SENT');
      assert.strictEqual(refunds.at(-1), 15000);
      const page = await Ad('GET', `/admin/merch/returns/${rn}`);
      assert(page.text.includes('Second approval') && page.text.includes(`Pres ${TAG.toUpperCase()}`));
      await settingsService.setSetting('merchRefundApprovalLimit', '');
    });

    await test('exchange: same price only; accept holds the new size, old item back, new one handed over', async () => {
      const n = await buy(B, L.id, 1);
      await pickUp(n);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { items: true } });
      const item = o.items[0];
      const dear = await ask(B, n, { kind: 'EXCHANGE', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 1, newVariantId: XL.id }] });
      assert.strictEqual(dear.status, 422, 'different price');
      const formData = await B('GET', `/api/store/orders/${n}/returns/form`);
      assert.deepStrictEqual(formData.json.data.items[0].swaps.map((s) => s.label), ['Navy / M'], 'only same-price sizes in stock');
      const r = await ask(B, n, { kind: 'EXCHANGE', reason: 'WRONG_SIZE', items: [{ orderItemId: item.id, quantity: 1, newVariantId: M.id }] });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      const rn = r.json.data.request.returnNumber;
      const mBefore = await available(M.id);
      const lBefore = await available(L.id);
      assert.strictEqual((await act(Ad, rn, 'accept')).json.data.request.status, 'NEW_HELD');
      assert.strictEqual(await available(M.id), mBefore - 1, 'new size held');
      assert.strictEqual((await act(Ad, rn, 'send')).status, 409, 'old item first');
      assert.strictEqual((await act(Ad, rn, 'receive', { items: [{ id: r.json.data.request.items[0].id, resaleableQty: 1 }] })).status, 200);
      assert.strictEqual(await available(L.id), lBefore + 1, 'old size back on the shelf');
      const sent = await act(Ad, rn, 'send');
      assert.strictEqual(sent.json.data.request.status, 'COMPLETED');
      assert.strictEqual(await available(M.id), mBefore - 1, 'the hold became a sale');
      const moves = await prisma.merchStockMovement.findMany({ where: { returnId: sent.json.data.request.id } });
      assert.deepStrictEqual(moves.map((m) => m.type).sort(), ['HELD', 'RELEASED', 'RETURNED', 'SOLD']);
      assert.strictEqual((await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { payment: true } })).payment.status, 'PAID', 'no money moved');
    });

    await test('rejecting a held exchange gives the size back; the buyer is told why', async () => {
      const n = await buy(A, L.id, 1);
      await pickUp(n);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { items: true } });
      const rn = (await ask(A, n, { kind: 'EXCHANGE', reason: 'WRONG_SIZE', items: [{ orderItemId: o.items[0].id, quantity: 1, newVariantId: M.id }] })).json.data.request.returnNumber;
      const mBefore = await available(M.id);
      await act(Ad, rn, 'accept');
      assert.strictEqual((await act(Ad, rn, 'reject', {})).status, 422, 'needs a reason');
      const rej = await act(Ad, rn, 'reject', { reason: 'Item was worn' });
      assert.strictEqual(rej.json.data.request.status, 'REJECTED');
      assert.strictEqual(await available(M.id), mBefore, 'hold released');
      assert((await A('GET', `/store/orders/${n}`)).text.includes('Item was worn'));
    });

    await test('a buyer can withdraw until it is approved; a PayMongo refund failure is shown', async () => {
      const n = await buy(B, M.id, 2);
      await pickUp(n);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n }, include: { items: true } });
      const rn = (await ask(B, n, { kind: 'REFUND', reason: 'CHANGE_OF_MIND', items: [{ orderItemId: o.items[0].id, quantity: 1 }] })).json.data.request.returnNumber;
      assert.strictEqual((await A('POST', `/api/store/returns/${rn}/withdraw`)).status, 404, 'only the buyer');
      assert.strictEqual((await B('POST', `/api/store/returns/${rn}/withdraw`)).json.data.request.status, 'WITHDRAWN');
      const rn2 = (await ask(B, n, { kind: 'REFUND', reason: 'CHANGE_OF_MIND', items: [{ orderItemId: o.items[0].id, quantity: 1 }] })).json.data.request.returnNumber;
      const req = await prisma.merchReturn.findUnique({ where: { returnNumber: rn2 }, include: { items: true } });
      await act(Ad, rn2, 'check', { items: [{ id: req.items[0].id, receivedQty: 1, resaleableQty: 1 }] });
      await act(Ad, rn2, 'approve', {});
      assert.strictEqual((await B('POST', `/api/store/returns/${rn2}/withdraw`)).status, 409, 'too late once sent');
      await refundResult(rn2, 'refund.failed');
      assert.strictEqual((await prisma.merchReturn.findUnique({ where: { returnNumber: rn2 } })).status, 'REFUND_FAILED');
      assert((await Ad('GET', `/admin/merch/returns/${rn2}`)).text.includes('PayMongo could not complete'));
    });

    await test('pages render; members cannot act on requests', async () => {
      const list = await Ad('GET', '/admin/merch/returns');
      assert.strictEqual(list.status, 200);
      assert((await Ad('GET', '/admin/merch/returns?group=closed')).text.includes('RET-'));
      assert((await A('GET', `/store/orders/${annOrder}`)).text.includes('Returns &amp; refunds'));
      assert.strictEqual((await B('POST', '/api/admin/merch/returns/RET-2026-000001/approve', {})).status, 403);
      assert.strictEqual((await B('PUT', '/api/admin/merch/return-settings', { approvalLimit: '1' })).status, 403);
      const s = await Ad('PUT', '/api/admin/merch/return-settings', { approvalLimit: 'abc' });
      assert.strictEqual(s.status, 422);
      assert((await Ad('GET', '/admin/merch/fulfilment')).text.includes('Approval limit'));
    });
  } finally {
    server.close();
    await settingsService.setPaymentsEnabled(saved.payments);
    for (const [key, val] of [['merchStoreOpen', saved.open], ['presidentModules', saved.access], ['merchRefundApprovalLimit', saved.limit], ['merchReturnWindowDays', saved.window]]) {
      if (val === null) await prisma.siteSetting.deleteMany({ where: { key } }).catch(() => {}); // eslint-disable-line no-await-in-loop
      else await settingsService.setSetting(key, val); // eslint-disable-line no-await-in-loop
    }
    const ids = users.map((u) => u.id);
    const rets = await prisma.merchReturn.findMany({ where: { order: { userId: { in: ids } } }, select: { photoUrl: true } });
    const storage = require('../src/services/storage.service'); // eslint-disable-line global-require
    for (const r of rets) if (r.photoUrl) await storage.remove(r.photoUrl).catch(() => {}); // eslint-disable-line no-await-in-loop
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: product.id } } }).catch((e) => console.error(e.message));
    await prisma.merchReturn.deleteMany({ where: { order: { userId: { in: ids } } } }).catch((e) => console.error(e.message));
    await prisma.merchOrder.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.merchCartItem.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.merchProduct.delete({ where: { id: product.id } }).catch((e) => console.error(e.message));
    const payIds = (await prisma.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    await prisma.refund.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
    await prisma.paymentWebhook.deleteMany({ where: { webhookId: { startsWith: `evt_${TAG}` } } }).catch(() => {});
    await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }, { paymentId: { in: payIds } }] } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { in: payIds } } }).catch((e) => console.error(e.message));
    await prisma.merchPickupPoint.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.9' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
