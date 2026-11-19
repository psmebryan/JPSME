// Tests for the merchandise store, phase 5: the soft launch. Store modes
// (closed, soft launch for listed testers, open), the testers list, "Report a
// problem" and its admin page, the stock count (paid items still on the shelf
// taken out), the printable sheet and the go-live checklist.
//
// Runs in-process against the local database. Every row it makes is tagged
// and removed at the end, and the Store settings it changes are put back.

require('dotenv').config();

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const settingsService = require('../src/services/settings.service');
const merch = require('../src/services/merch.service');
const launch = require('../src/services/merchLaunch.service');

const TAG = `__ml${Date.now()}`;
const PASSWORD = 'merch-launch-password-1';
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

let base;
let ipSeq = 0;
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `192.0.2.${200 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: PASSWORD, context }) });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  return async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* page */ }
    return { status: r.status, json, text };
  };
}
const makeUser = async (label, extra = {}) => prisma.user.create({ data: { firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4), role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(), ...extra } });

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const keys = ['merchStoreOpen', 'merchSoftLaunch', 'presidentModules'];
  const saved = {};
  for (const k of keys) saved[k] = await settingsService.getSetting(k, null); // eslint-disable-line no-await-in-loop
  await settingsService.setSetting('presidentModules', JSON.stringify(['dashboard', 'merchandise']));
  await launch.setMode('CLOSED');

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const pres = await makeUser('Pres', { role: 'PRESIDENT' });
  const log = await makeUser('Log', { role: 'FINANCE_LOGISTICS' });
  const fin = await makeUser('Fin', { role: 'FINANCE_LOGISTICS' });
  const ann = await makeUser('Ann');
  const ben = await makeUser('Ben');
  const users = [admin, pres, log, fin, ann, ben];
  await prisma.adminGrant.create({ data: { userId: log.id, modules: JSON.stringify(['merchLogistics']) } });
  await prisma.adminGrant.create({ data: { userId: fin.id, modules: JSON.stringify(['merchFinance']) } });

  const product = await merch.createProduct({ name: `${TAG} Pin`, isActive: true });
  const pin = await merch.addVariant(product.id, { label: 'Gold', memberPrice: '100', price: '150' }, admin.id);
  await merch.recordStock(pin.id, { action: 'receive', quantity: '10' }, admin.id);
  // A paid order of 2, not yet handed over: the ledger has 8, the shelf 10.
  const pay = await prisma.payment.create({ data: { userId: ann.id, purpose: 'MERCHANDISE', amount: 20000, status: 'PAID', paidAt: new Date(), gatewayPaymentId: `pay_${TAG}`, gatewayCheckoutId: `cs_${TAG}` } });
  const order = await prisma.merchOrder.create({
    data: {
      orderNumber: `ORD-2026-8${String(Date.now()).slice(-6)}`, userId: ann.id, buyerName: 'Ann', buyerEmail: ann.email, status: 'PAID',
      subtotalCentavos: 20000, totalCentavos: 20000, paymentId: pay.id, paidAt: new Date(), fulfilment: 'PICKUP',
      items: { create: [{ variantId: pin.id, productName: `${TAG} Pin`, variantLabel: 'Gold', sku: pin.sku, priceType: 'MEMBER', unitPriceCentavos: 10000, quantity: 2 }] },
    },
  });
  await prisma.merchStockMovement.create({ data: { variantId: pin.id, type: 'SOLD', quantity: -2, orderId: order.id, reason: 'Sold (test)' } });

  try {
    const Ad = await signIn(admin.email, 'admin');
    const Pr = await signIn(pres.email, 'admin');
    const Lo = await signIn(log.email, 'admin');
    const Fi = await signIn(fin.email, 'admin');
    const A = await signIn(ann.email);
    const B = await signIn(ben.email);

    await test('soft launch: only the listed testers see the Store and can report problems', async () => {
      assert.strictEqual((await A('GET', '/store')).status, 404, 'closed');
      assert.strictEqual((await Lo('PUT', '/api/admin/merch/store-mode', { mode: 'SOFT' })).status, 403, 'not Logistics');
      assert.strictEqual((await Ad('PUT', '/api/admin/merch/store-mode', { mode: 'NOPE' })).status, 422);
      assert.strictEqual((await Pr('PUT', '/api/admin/merch/store-mode', { mode: 'SOFT' })).status, 200, 'a President with Merchandise may');
      assert.strictEqual(await launch.getMode(), 'SOFT');
      assert.strictEqual((await Ad('POST', '/api/admin/merch/testers', { email: admin.email })).status, 422, 'a main admin account cannot buy');
      assert.strictEqual((await Ad('POST', '/api/admin/merch/testers', { email: 'nobody@example.invalid' })).status, 404);
      const add = await Ad('POST', '/api/admin/merch/testers', { email: ann.email.toUpperCase() });
      assert.strictEqual(add.status, 201, add.text.slice(0, 200));
      const store = await A('GET', '/store');
      assert.strictEqual(store.status, 200);
      assert(store.text.includes('Soft launch: only the National Board') && store.text.includes('id="store-feedback"'));
      assert.strictEqual((await B('GET', '/store')).status, 404, 'not a tester');
      assert.strictEqual((await B('POST', '/api/store/feedback', { message: 'Let me in please' })).status, 404);
      assert((await A('GET', `/store/orders/${order.orderNumber}`)).text.includes(`data-order="${order.orderNumber}"`));
      const page = await Ad('GET', '/admin/merch/launch');
      assert(page.text.includes('data-mode="SOFT"') && page.text.includes(`data-tester="${ann.id}"`) && page.text.includes('1 paid order'));
      assert(!(await Lo('GET', '/admin/merch/launch')).text.includes('data-add-tester'), 'Logistics reads only');
    });

    let reportId;
    await test('reported problems: sent by a tester, fixed by staff', async () => {
      assert.strictEqual((await A('POST', '/api/store/feedback', { message: 'ok' })).status, 422, 'too short');
      const r = await A('POST', '/api/store/feedback', { message: 'The size chart is missing on the polo.', page: '/store/products/1', orderNumber: order.orderNumber });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      reportId = r.json.data.id;
      assert.strictEqual((await A('POST', '/api/store/feedback', { message: 'Another thing went wrong here' })).status, 429, 'one a minute');
      const list = await Lo('GET', '/admin/merch/feedback?status=open');
      assert(list.text.includes('The size chart is missing') && list.text.includes(order.orderNumber));
      assert((await Ad('GET', '/admin/merch/dashboard')).text.includes('reported problem'));
      const done = await Lo('PUT', `/api/admin/merch/feedback/${reportId}`, { done: true, note: 'Added the chart' });
      assert.strictEqual(done.status, 200);
      const row = await prisma.merchFeedback.findUnique({ where: { id: reportId } });
      assert.deepStrictEqual([row.status, row.note, row.resolvedById], ['DONE', 'Added the chart', log.id]);
      assert((await Ad('GET', '/admin/merch/feedback?status=done')).text.includes('Added the chart'));
      await Ad('PUT', `/api/admin/merch/feedback/${reportId}`, { done: false });
      assert.strictEqual((await prisma.merchFeedback.findUnique({ where: { id: reportId } })).status, 'OPEN');
    });

    await test('the stock count takes out paid items still on the shelf', async () => {
      const page = await Lo('GET', '/admin/merch/count');
      assert.strictEqual(page.status, 200);
      assert(page.text.includes(`data-row="${pin.id}" data-expected="10"`), 'expected on shelf = 8 on hand + 2 paid');
      assert(page.text.includes('Opening stock count') || page.text.includes('Stock count'));
      assert.strictEqual((await Fi('POST', '/api/admin/merch/count', { counts: [{ variantId: pin.id, counted: 10 }] })).status, 403, 'Finance does not count');
      let r = await Lo('POST', '/api/admin/merch/count', { counts: [{ variantId: pin.id, counted: '10' }], reason: 'Opening stock count' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.deepStrictEqual([r.json.data.matched, r.json.data.corrected], [1, 0]);
      assert.strictEqual((await merch.onHandFor([pin.id])).get(pin.id), 8);
      r = await Lo('POST', '/api/admin/merch/count', { counts: [{ variantId: pin.id, counted: 9 }] });
      assert.strictEqual(r.json.data.corrected, 1);
      assert.strictEqual((await merch.onHandFor([pin.id])).get(pin.id), 7, 'one missing');
      r = await Lo('POST', '/api/admin/merch/count', { counts: [{ variantId: pin.id, counted: 1 }, { variantId: 999999999, counted: 3 }] });
      assert.strictEqual(r.json.data.failed.length, 2, 'fewer than the paid items, and an unknown variant');
      assert(/At least 2/.test(r.json.data.failed[0].message));
      assert.strictEqual((await Lo('POST', '/api/admin/merch/count', { counts: [] })).status, 422);
      const sheet = await Fi('GET', '/admin/merch/count/print');
      assert(sheet.text.includes('data-count-sheet') && sheet.text.includes(pin.sku) && !sheet.text.includes('Ledger on hand'), 'blind sheet');
      const fiPage = (await Fi('GET', '/admin/merch/count')).text;
      assert(!fiPage.includes('Save counts') && !fiPage.includes('aria-label="Counted,'), 'Finance views only');
      assert((await Lo('GET', '/admin/merch/count')).text.includes('Save counts'));
    });

    await test('the go-live checklist, and opening the Store', async () => {
      const ready = await launch.readiness();
      ['products', 'prices', 'count', 'delivery', 'payments', 'paymongo', 'board', 'feedback'].forEach((k) => assert(ready.items.some((i) => i.key === k), k));
      assert.strictEqual(ready.items.find((i) => i.key === 'board').ok, true, 'a tester has a paid order');
      assert.strictEqual(ready.items.find((i) => i.key === 'feedback').ok, false, 'a report is open');
      assert(['live', 'test', 'missing', 'unknown'].includes(launch.paymongoMode()));
      const page = (await Ad('GET', '/admin/merch/launch')).text;
      assert(page.includes('data-check-item="count"') && page.includes('Go-live checklist'));
      assert(!/sk_(live|test)_[A-Za-z0-9]/.test(page), 'the key itself is never shown');
      assert.strictEqual((await Ad('PUT', '/api/admin/merch/store-mode', { mode: 'OPEN' })).status, 200);
      assert.strictEqual((await B('GET', '/store')).status, 200, 'open to every member');
      assert.strictEqual((await A('POST', '/api/store/feedback', { message: 'Still something odd here' })).status, 404, 'no reports once open');
      // The old switch on the Products page still works, and closing ends the soft launch.
      await Ad('PUT', '/api/admin/merch/store-mode', { mode: 'SOFT' });
      assert.strictEqual((await Ad('PUT', '/api/admin/merch/store-open', { open: false })).status, 200);
      assert.strictEqual(await launch.getMode(), 'CLOSED');
      assert.strictEqual((await A('GET', '/store')).status, 404, 'testers out again');
      assert.strictEqual((await Ad('DELETE', `/api/admin/merch/testers/${ann.id}`)).status, 200);
      assert.strictEqual((await Ad('DELETE', `/api/admin/merch/testers/${ann.id}`)).status, 404);
    });
  } finally {
    server.close();
    for (const k of keys) {
      if (saved[k] === null) await prisma.siteSetting.deleteMany({ where: { key: k } }).catch(() => {}); // eslint-disable-line no-await-in-loop
      else await settingsService.setSetting(k, saved[k]); // eslint-disable-line no-await-in-loop
    }
    const ids = users.map((u) => u.id);
    await prisma.merchFeedback.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: product.id } } }).catch((e) => console.error(e.message));
    await prisma.merchOrder.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.merchProduct.delete({ where: { id: product.id } }).catch((e) => console.error(e.message));
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '192.0.2.2' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
