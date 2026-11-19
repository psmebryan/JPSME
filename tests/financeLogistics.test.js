// Tests for the merchandise store, phase 4: the Finance & Logistics role,
// what each team may open and do, the field permissions (cost, addresses),
// the dashboard, the sales reports, the Transaction Report's Merchandise tab,
// the daily reconciliation against PayMongo and the month-end pack.
//
// Runs in-process against the local database with PayMongo stood in (no
// network). Every row it makes is tagged and removed at the end; the days it
// reconciles are in 2025, before the store existed, and their rows are
// removed too. Mail goes nowhere (run with the suite's SMTP settings).

require('dotenv').config();

const assert = require('assert');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const settingsService = require('../src/services/settings.service');
const paymongo = require('../src/services/paymongo.service');
const merch = require('../src/services/merch.service');
const access = require('../src/services/adminAccess.service');
const finance = require('../src/services/merchFinance.service');

const TAG = `__fl${Date.now()}`;
const PASSWORD = 'finance-logistics-password-1';
const DAY = '2025-03-14'; // a Friday long before the store, so no real sales share it
const DAY2 = '2025-03-15';
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

// --- PayMongo stand-in: what each checkout session says ---
const gateway = new Map(); // checkoutId -> { paid, amount, id, fee } | 'down'
paymongo.getCheckoutSession = async (id) => {
  const g = gateway.get(id);
  if (g === 'down') throw new Error('PayMongo unreachable');
  if (!g || !g.paid) return { id, attributes: { status: 'expired', payments: [] } };
  return { id, attributes: { status: 'active', payments: [{ id: g.id, attributes: { status: 'paid', amount: g.amount, fee: g.fee || 0, currency: 'PHP' } }] } };
};

// --- HTTP ---
let base;
let ipSeq = 0;
async function signIn(email, context = 'admin') {
  ipSeq += 1;
  const ip = `192.0.2.${150 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: PASSWORD, context }) });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  return async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* page */ }
    return { status: r.status, json, text, buf, location: r.headers.get('location') };
  };
}
const makeUser = async (label, extra = {}) => prisma.user.create({ data: { firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4), role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(), ...extra } });
const at = (day, hh) => new Date(`${day}T${hh}:00:00+08:00`);
const sheetNames = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const headers = (ws) => (ws.getRow(1).values || []).filter(Boolean).map(String);

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const saved = { access: await settingsService.getSetting('presidentModules', null) };
  await settingsService.setSetting('presidentModules', JSON.stringify(['dashboard', 'merchandise']));

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const pres = await makeUser('Pres', { role: 'PRESIDENT' });
  const fin = await makeUser('Fin', { role: 'FINANCE_LOGISTICS' });
  const log = await makeUser('Log', { role: 'FINANCE_LOGISTICS' });
  const none = await makeUser('None', { role: 'FINANCE_LOGISTICS' });
  const buyer = await makeUser('Buyer');
  const users = [admin, pres, fin, log, none, buyer];
  const org = await prisma.organization.findFirst({ where: { type: 'STUDENT_UNIT' }, select: { id: true, name: true } });

  const product = await merch.createProduct({ name: `${TAG} Cap`, isActive: true });
  const cap = await merch.addVariant(product.id, { label: 'Black', memberPrice: '200', price: '250', cost: '120' }, admin.id);
  await merch.recordStock(cap.id, { action: 'receive', quantity: '20', unitCost: '120' }, admin.id);

  // One paid order, made straight in the database: paid on DAY, by delivery.
  let orderSeq = 0;
  async function paidOrder({ day = DAY, hour = '10', qty = 2, status = 'PAID', paidHere = true, amount = null, cost = 12000 } = {}) {
    orderSeq += 1;
    const subtotal = 20000 * qty;
    const total = amount || subtotal + 15000;
    const checkoutId = `cs_${TAG}_${orderSeq}`;
    const payment = await prisma.payment.create({
      data: {
        userId: buyer.id, purpose: 'MERCHANDISE', amount: total, status: paidHere ? 'PAID' : 'PENDING',
        paidAt: paidHere ? at(day, hour) : null, createdAt: at(day, hour), gatewayCheckoutId: checkoutId,
        gatewayPaymentId: paidHere ? `pay_${TAG}_${orderSeq}` : null, gatewayFeeCentavos: paidHere ? 500 : 0,
      },
    });
    const order = await prisma.merchOrder.create({
      data: {
        orderNumber: `ORD-2025-9${String(Date.now()).slice(-5)}${orderSeq}`, userId: buyer.id, buyerName: `Buyer ${TAG}`, buyerEmail: buyer.email,
        organizationId: org ? org.id : null, memberPricing: true, status: paidHere ? status : 'AWAITING_PAYMENT',
        subtotalCentavos: subtotal, deliveryFeeCentavos: 15000, totalCentavos: total, paymentId: payment.id, paidAt: paidHere ? at(day, hour) : null,
        fulfilment: 'DELIVERY', zoneName: 'Metro Manila',
        shipTo: JSON.stringify({ recipientName: 'Juan Secret', phone: '09171234567', lines: ['Juan Secret', '09171234567', '12 Hidden St., Brgy. Secret, Quezon City'] }),
        createdAt: at(day, hour),
        items: { create: [{ variantId: cap.id, productName: `${TAG} Cap`, variantLabel: 'Black', sku: cap.sku, priceType: 'MEMBER', unitPriceCentavos: 20000, unitCostCentavos: cost, quantity: qty }] },
      },
    });
    gateway.set(checkoutId, { paid: paidHere, amount: total, id: `pay_${TAG}_${orderSeq}`, fee: 500 });
    return { order, payment, checkoutId };
  }

  try {
    const Ad = await signIn(admin.email);
    const Pr = await signIn(pres.email);

    await test('only the main admin gives the role and ticks each account', async () => {
      assert.strictEqual((await Pr('PUT', `/api/admin/settings/finance-logistics/${fin.id}`, { grants: ['merchFinance'] })).status, 403);
      assert.strictEqual((await Pr('PUT', `/api/admin/users/${buyer.id}`, { role: 'FINANCE_LOGISTICS' })).status, 403, 'a President cannot give the role');
      const r = await Ad('PUT', `/api/admin/settings/finance-logistics/${fin.id}`, { grants: ['merchFinance', 'payments', 'reports', 'bogus'] });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.deepStrictEqual(r.json.data.grants, ['merchFinance', 'payments', 'reports'], 'unknown ticks are dropped');
      await Ad('PUT', `/api/admin/settings/finance-logistics/${log.id}`, { grants: ['merchLogistics'] });
      assert.strictEqual((await Ad('PUT', `/api/admin/settings/finance-logistics/${buyer.id}`, { grants: ['merchFinance'] })).status, 404, 'only for that role');
      const page = await Ad('GET', '/admin/settings');
      assert(page.text.includes('Finance &amp; Logistics access') && page.text.includes(`data-fl-account="${fin.id}"`));
      assert((await Ad('GET', `/admin/users/${buyer.id}/edit`)).text.includes('value="FINANCE_LOGISTICS"'));
    });

    const Fi = await signIn(fin.email);
    const Lo = await signIn(log.email);
    const No = await signIn(none.email);

    await test('each account opens only what it was given', async () => {
      // No ticks: signed in, but every admin page sends them away.
      const n = await No('GET', '/admin/merch/dashboard');
      assert.strictEqual(n.status, 302);
      assert.strictEqual((await No('GET', '/api/admin/merch/products')).status, 403);
      // Landing: the store dashboard, not the national one.
      const d = await Fi('GET', '/admin/dashboard');
      assert.strictEqual(d.status, 302);
      assert.strictEqual(d.location, '/admin/merch/dashboard');
      for (const p of ['/admin/settings', '/admin/users/all', '/admin/events', '/admin/audit-log']) {
        assert.strictEqual((await Fi('GET', p)).status, 302, `${p} refused`); // eslint-disable-line no-await-in-loop
      }
      assert.strictEqual((await Fi('GET', '/admin/merch/dashboard')).status, 200);
      assert.strictEqual((await Fi('GET', '/admin/merch/reconciliation')).status, 200);
      assert.strictEqual((await Lo('GET', '/admin/merch/reconciliation')).status, 302, 'Logistics does not reconcile');
      assert.strictEqual((await Lo('GET', '/admin/merch/pickup')).status, 200);
      assert.strictEqual((await Fi('GET', '/admin/merch/pickup')).status, 302, 'Finance does not hand over');
      // Payments: view only, and only with the tick.
      assert.strictEqual((await Fi('GET', '/api/admin/payments')).status, 200);
      assert.strictEqual((await Lo('GET', '/api/admin/payments')).status, 403);
      const pay = await prisma.payment.create({ data: { userId: buyer.id, purpose: 'MERCHANDISE', amount: 100, status: 'PAID', paidAt: new Date(), gatewayPaymentId: `pay_${TAG}_x`, gatewayCheckoutId: `cs_${TAG}_x` } });
      assert.strictEqual((await Fi('GET', `/api/admin/payments/${pay.id}`)).status, 200, 'can see one payment');
      assert.strictEqual((await Fi('POST', `/api/admin/payments/${pay.id}/refund`, { reason: 'others' })).status, 403, 'cannot refund there');
      const pp = await Fi('GET', '/admin/payments');
      assert(pp.text.includes('data-can-act="0"') && !pp.text.includes('data-refund='), 'no refund buttons');
      // Reports: with the tick.
      assert.strictEqual((await Fi('GET', '/admin/reports/transactions')).status, 200);
      assert.strictEqual((await Lo('GET', '/admin/reports/transactions')).status, 302);
      // Sidebar: only their own links.
      const side = (await Lo('GET', '/admin/merch/inventory')).text;
      assert(side.includes('href="/admin/merch/pickup"') && !side.includes('href="/admin/merch/reconciliation"') && !side.includes('href="/admin/settings"'));
      assert(side.includes('Finance &amp; Logistics') || side.includes('Finance & Logistics'), 'role label');
    });

    await test('actions follow the team: Logistics stock and steps, Finance neither', async () => {
      const recv = await Lo('POST', `/api/admin/merch/variants/${cap.id}/stock`, { action: 'receive', quantity: '5', unitCost: '1' });
      assert.strictEqual(recv.status, 201, recv.text.slice(0, 200));
      const mv = await prisma.merchStockMovement.findFirst({ where: { variantId: cap.id }, orderBy: { id: 'desc' } });
      assert.strictEqual(mv.unitCostCentavos, null, 'a cost sent by someone who cannot see costs is ignored');
      assert.strictEqual((await Fi('POST', `/api/admin/merch/variants/${cap.id}/stock`, { action: 'receive', quantity: '5' })).status, 403);
      assert.strictEqual((await Lo('PUT', `/api/admin/merch/products/${product.id}`, { name: 'x' })).status, 403, 'products are not Logistics');
      assert.strictEqual((await Lo('PUT', `/api/admin/merch/products/${product.id}/variants/${cap.id}`, { cost: '1' })).status, 403);
      const { order } = await paidOrder({ day: '2025-02-10' });
      assert.strictEqual((await Fi('POST', `/api/admin/merch/orders/${order.orderNumber}/steps/pack`, {})).status, 403);
      assert.strictEqual((await Lo('POST', `/api/admin/merch/orders/${order.orderNumber}/steps/pack`, {})).status, 200);
      assert.strictEqual((await Lo('PUT', '/api/admin/merch/return-settings', { approvalLimit: '1' })).status, 403, 'the limit is the main admin\'s');
      assert.strictEqual((await Pr('PUT', '/api/admin/merch/return-settings', { approvalLimit: '1' })).status, 403);
      assert.strictEqual((await Lo('POST', `/api/admin/merch/reconciliation/${DAY}/check`, {})).status, 403);
      const ful = await Lo('GET', '/admin/merch/fulfilment');
      assert(/<fieldset class="min-w-0 space-y-6"\s*>/.test(ful.text), 'settings editable');
      assert((await Fi('GET', '/admin/merch/fulfilment')).text.includes('<fieldset class="min-w-0 space-y-6" disabled>'), 'read only for Finance');
    });

    await test('costs: only Finance, the main admin, or a President given costs', async () => {
      const lo = await Lo('GET', `/api/admin/merch/products/${product.id}`);
      assert.strictEqual(lo.status, 200);
      assert(!/cost/i.test(JSON.stringify(lo.json.data)), 'no cost in the JSON');
      const fi = await Fi('GET', `/api/admin/merch/products/${product.id}`);
      assert.strictEqual(fi.json.data.product.variants[0].costCentavos, 12000);
      const lp = (await Lo('GET', `/admin/merch/products/${product.id}`)).text;
      assert(!lp.includes('Unit cost (PHP)') && !lp.includes('"costCentavos"'), 'not on the page either');
      const pr = await Pr('GET', `/api/admin/merch/products/${product.id}`);
      assert(!('costCentavos' in pr.json.data.product.variants[0]), 'President without the costs tick');
      await settingsService.setSetting('presidentModules', JSON.stringify(['dashboard', 'merchandise', 'merchCosts']));
      assert.strictEqual((await Pr('GET', `/api/admin/merch/products/${product.id}`)).json.data.product.variants[0].costCentavos, 12000);
      await settingsService.setSetting('presidentModules', JSON.stringify(['dashboard', 'merchandise']));
      const inv = await Lo('GET', '/admin/merch/inventory/export.xlsx');
      const wb = await sheetNames(inv.buf);
      assert(!headers(wb.getWorksheet('On hand')).some((h) => /cost/i.test(h)), 'inventory export without cost columns');
      const invF = await sheetNames((await Fi('GET', '/admin/merch/inventory/export.xlsx')).buf);
      assert(headers(invF.getWorksheet('On hand')).includes('Unit cost'));
      const hist = await Lo('GET', `/api/admin/merch/variants/${cap.id}/price-history`);
      assert(!hist.json.data.history.some((h) => h.field === 'costCentavos'), 'cost changes left out of the history');
    });

    await test('addresses: Logistics while the order travels, never Finance, the export never', async () => {
      const { order } = await paidOrder({ day: '2025-02-11' });
      const url = `/admin/merch/orders/${order.orderNumber}`;
      assert((await Lo('GET', url)).text.includes('12 Hidden St.'), 'Logistics sees it');
      const f = (await Fi('GET', url)).text;
      assert(!f.includes('12 Hidden St.') && !f.includes('09171234567') && f.includes('data-address-hidden'));
      assert(!(await Pr('GET', url)).text.includes('12 Hidden St.'), 'nor the President');
      await prisma.merchOrder.update({ where: { id: order.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
      assert(!(await Lo('GET', url)).text.includes('12 Hidden St.'), 'not after delivery');
      assert((await Ad('GET', url)).text.includes('12 Hidden St.'), 'the main admin still does');
      const xl = await Ad('GET', `/admin/merch/orders/export.xlsx?from=2025-02-11&to=2025-02-11`);
      assert(!xl.buf.toString('latin1').includes('Hidden'), 'not in the orders export');
    });

    await test('the daily reconciliation: matched, gaps, explained', async () => {
      await paidOrder({ day: DAY, hour: '09' });
      const b = await paidOrder({ day: DAY, hour: '23' });
      const c = await paidOrder({ day: DAY, hour: '12', paidHere: false }); // missed webhook
      const r1 = await Fi('POST', `/api/admin/merch/reconciliation/${DAY2}/check`, {});
      assert.strictEqual(r1.status, 200, r1.text.slice(0, 200));
      assert.strictEqual(r1.json.data.day.status, 'MATCHED', 'a day with no sales matches');
      // DAY: one paid order matches; one PayMongo shows a different amount; one unpaid here is paid there.
      gateway.set(b.checkoutId, { ...gateway.get(b.checkoutId), amount: 1 });
      gateway.set(c.checkoutId, { paid: true, amount: c.payment.amount, id: 'pay_other' });
      const r = await Fi('POST', `/api/admin/merch/reconciliation/${DAY}/check`, {});
      const day = r.json.data.day;
      assert.strictEqual(day.status, 'GAPS');
      assert.strictEqual(day.siteCount, 2);
      assert.deepStrictEqual(day.gaps.map((g) => g.code).sort(), ['AMOUNT', 'NOT_HERE']);
      assert.strictEqual(day.feeCentavos, 1000);
      assert.strictEqual((await prisma.payment.findUnique({ where: { id: c.payment.id } })).status, 'PENDING', 'the check changes nothing');
      // PayMongo down for one: a gap, never a match.
      gateway.set(b.checkoutId, 'down');
      const down = await Fi('POST', `/api/admin/merch/reconciliation/${DAY}/check`, {});
      assert(down.json.data.day.gaps.some((g) => g.code === 'NOT_CHECKED'));
      assert.strictEqual((await Fi('PUT', `/api/admin/merch/reconciliation/${DAY}/note`, { note: '' })).status, 422);
      const ex = await Fi('PUT', `/api/admin/merch/reconciliation/${DAY}/note`, { note: 'Checked with PayMongo support' });
      assert.strictEqual(ex.json.data.day.status, 'EXPLAINED');
      assert.strictEqual((await Fi('POST', '/api/admin/merch/reconciliation/2999-01-01/check', {})).status, 422, 'not a future day');
      const page = await Fi('GET', '/admin/merch/reconciliation?month=2025-03');
      assert(page.text.includes('Gaps explained') && page.text.includes('Checked with PayMongo support'));
      assert(page.text.includes(`data-check="${DAY}"`));
      assert(!(await Pr('GET', '/admin/merch/reconciliation?month=2025-03')).text.includes('data-check='), 'the President views only');
    });

    await test('sales report, profit for those who see costs, month-end pack', async () => {
      const rep = await finance.salesReport({ from: DAY, to: DAY });
      assert.strictEqual(rep.summary.orders, 2);
      assert.strictEqual(rep.summary.units, 4);
      assert.strictEqual(rep.summary.itemSalesCentavos, 80000);
      assert.strictEqual(rep.summary.costCentavos, 48000);
      assert.strictEqual(rep.summary.profitCentavos, 32000);
      assert.strictEqual(rep.summary.paymongoFeeCentavos, 1000);
      assert.strictEqual(rep.summary.netCentavos, rep.summary.chargedCentavos - 1000);
      if (org) assert.strictEqual(rep.organizations[0].organization, org.name);
      const fp = (await Fi('GET', `/admin/merch/reports?from=${DAY}&to=${DAY}`)).text;
      assert(fp.includes('Profit on items') && fp.includes('₱320.00'));
      const lp = (await Lo('GET', `/admin/merch/reports?from=${DAY}&to=${DAY}`)).text;
      assert(!lp.includes('Profit on items') && !lp.includes('₱320.00'), 'no profit for Logistics');
      const fx = await sheetNames((await Fi('GET', `/admin/merch/reports/export.xlsx?from=${DAY}&to=${DAY}`)).buf);
      assert(headers(fx.getWorksheet('By product')).includes('Profit'));
      const lx = await sheetNames((await Lo('GET', `/admin/merch/reports/export.xlsx?from=${DAY}&to=${DAY}`)).buf);
      assert(!headers(lx.getWorksheet('By product')).includes('Profit'));
      const me = await Fi('GET', '/admin/merch/month-end.xlsx?month=2025-03');
      assert.strictEqual(me.status, 200);
      const wb = await sheetNames(me.buf);
      ['Summary', 'By product', 'By organization', 'Orders', 'Refunds paid', 'Reconciliation', 'Stock movements', 'Stock at month end'].forEach((n) => assert(wb.getWorksheet(n), `sheet ${n}`));
      assert.strictEqual(wb.getWorksheet('Orders').rowCount >= 3, true);
      assert(!me.buf.toString('latin1').includes('Hidden'), 'no addresses in the pack');
      assert.strictEqual((await Lo('GET', '/admin/merch/month-end.xlsx?month=2025-03')).status, 302, 'not Logistics');
    });

    await test('dashboard and the Transaction Report Merchandise tab', async () => {
      const f = (await Fi('GET', '/admin/merch/dashboard')).text;
      assert(f.includes('Store Dashboard') && f.includes('data-recon') && f.includes('data-tile="profit"'));
      const l = (await Lo('GET', '/admin/merch/dashboard')).text;
      assert(!l.includes('data-recon') && !l.includes('data-tile="profit"') && l.includes('Paid, to pack'));
      const t = await Fi('GET', `/admin/reports/transactions?kind=merch&from=${DAY}&to=${DAY}`);
      assert.strictEqual(t.status, 200);
      assert(t.text.includes('aria-current="page">Merchandise') && t.text.includes(`Buyer ${TAG}`));
      const x = await sheetNames((await Fi('GET', `/admin/reports/transactions/export.xlsx?kind=merch&from=${DAY}&to=${DAY}`)).buf);
      assert(headers(x.getWorksheet('Merchandise')).includes('Items'));
    });

    await test('leaving the role drops the ticks', async () => {
      await Ad('PUT', `/api/admin/users/${none.id}`, { role: 'FINANCE_LOGISTICS' });
      await access.setGrant(none.id, ['reports'], admin.id);
      const r = await Ad('PUT', `/api/admin/users/${none.id}`, { role: 'USER' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.strictEqual(await prisma.adminGrant.count({ where: { userId: none.id } }), 0);
    });
  } finally {
    server.close();
    if (saved.access === null) await prisma.siteSetting.deleteMany({ where: { key: 'presidentModules' } }).catch(() => {});
    else await settingsService.setSetting('presidentModules', saved.access);
    const ids = users.map((u) => u.id);
    await prisma.merchReconciliation.deleteMany({ where: { day: { in: [new Date(`${DAY}T00:00:00Z`), new Date(`${DAY2}T00:00:00Z`)] } } }).catch((e) => console.error(e.message));
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: product.id } } }).catch((e) => console.error(e.message));
    await prisma.merchOrder.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.merchProduct.delete({ where: { id: product.id } }).catch((e) => console.error(e.message));
    const payIds = (await prisma.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }, { paymentId: { in: payIds } }] } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { in: payIds } } }).catch((e) => console.error(e.message));
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '192.0.2.' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
