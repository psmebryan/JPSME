// Tests for the merchandise store, phase 3a: delivery or pickup, addresses,
// delivery zones, and the order steps after payment (pack, ship, deliver,
// ready, pickup handover, address hold), plus the PSGC importer.
//
// Uses its own made-up PSGC rows (codes starting 97-99, which no PSA code
// does), zones and pickup point, so nothing depends on the real PSGC import.
// PayMongo is replaced in-process; no request leaves the machine.

require('dotenv').config();
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.BREVO_API_KEY = '';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const settingsService = require('../src/services/settings.service');
const paymongo = require('../src/services/paymongo.service');
const paymentService = require('../src/services/payment.service');
const merch = require('../src/services/merch.service');
const fulfilment = require('../src/services/merchFulfilment.service');
const orders = require('../src/services/merchOrders.service');

const TAG = `__mf${Date.now()}`;
const PASSWORD = 'merch-fulfil-password-1';
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

// --- PayMongo stand-in ---
const calls = { checkout: [] };
const sessions = new Map();
let seq = 0;
paymongo.createGcashCheckout = async ({ referenceNumber, amountCentavos, surchargeCentavos }) => {
  if (!sessions.has(referenceNumber)) { seq += 1; sessions.set(referenceNumber, `cs_${TAG}_${seq}`); }
  calls.checkout.push({ amountCentavos, surchargeCentavos });
  return { checkoutId: sessions.get(referenceNumber), checkoutUrl: `https://checkout.example.invalid/${seq}` };
};
paymongo.expireCheckoutSession = async (id) => ({ id });
let evt = 0;
async function pay(orderNumber) {
  const o = await prisma.merchOrder.findUnique({ where: { orderNumber }, include: { payment: true } });
  evt += 1;
  await paymentService.processWebhookEvent({ data: { id: `evt_${TAG}_${evt}`, attributes: { type: 'checkout_session.payment.paid', data: { id: o.payment.gatewayCheckoutId, type: 'checkout_session', attributes: { metadata: { paymentId: String(o.payment.id) }, payments: [{ id: `pay_${TAG}_${o.payment.id}`, attributes: { amount: o.payment.amount, currency: 'PHP', status: 'paid', fee: 500 } }] } } } } });
}

// --- HTTP ---
let base;
let ipSeq = 0;
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `198.51.100.${50 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip }, body: JSON.stringify({ email, password: PASSWORD, context }) });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  return async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, redirect: 'manual', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString()); } catch (e) { /* page */ }
    return { status: r.status, json, text: buf.toString(), buf };
  };
}
const makeUser = async (label, extra = {}) => prisma.user.create({ data: { firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4), role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(), ...extra } });

// Made-up places: region R (province P, city C, barangays B1/B2, second city C3
// with B3), region RN (Metro Manila-like: city CN with no province, barangay
// BN), region RX (no zone).
const R = '9900000000'; const P = '9901000000'; const C = '9901001000'; const B1 = '9901001001'; const B2 = '9901001002';
const C3 = '9901002000'; const B3 = '9901002001';
const RN = '9800000000'; const CN = '9800101000'; const BN = '9800101001';
const RX = '9700000000'; const CX = '9700101000'; const BX = '9700101001';
const address = (over = {}) => ({
  recipientName: 'Ann Cruz', mobile: '0917 123 4567', houseNo: 'Unit 4B', street: 'Rizal St.', regionCode: R, provinceCode: P, cityCode: C, barangayCode: B1,
  zip: '1100', landmark: 'Beside the chapel', addressType: 'HOME', ...over,
});

// A PSA-style workbook: blank column A, the header row, then rows in the PSA's
// order (regions, cities straight under Metro Manila, Manila's sub-
// municipalities, a province with an independent city listed after it).
async function psaWorkbook({ sheetName = 'PSGC' } = {}) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet(sheetName);
  s.addRow([null, '10-digit PSGC', 'Name', 'Correspondence Code', 'Geographic Level', 'Old names', 'City Class']);
  s.addRow([null, '1300000000', 'National Capital Region (NCR)', 1, 'Reg']);
  s.addRow([null, '1380600000', 'City of Manila', 1, 'City', null, 'HUC']);
  s.addRow([null, '1380601000', 'Tondo I/II', 1, 'SubMun']);
  s.addRow([null, '1380601001', 'Barangay 1', 1, 'Bgy']);
  s.addRow([null, '0700000000', 'Region VII (Central Visayas)', 1, 'Reg']);
  s.addRow([null, '0702200000', 'Cebu', 1, 'Prov']);
  s.addRow([null, '0702201000', 'Alcantara', 1, 'Mun']);
  for (let i = 1; i <= 1000; i += 1) s.addRow([null, `07022010${String(i).padStart(2, '0').slice(-2)}`.slice(0, 8) + String(i).padStart(3, '0').slice(-2), `Bgy ${i}`, 1, 'Bgy']);
  s.addRow([null, '0730600000', 'City of Cebu', 1, 'City', null, 'HUC']);
  s.addRow([null, '0730600001', 'Adlaon', 1, 'Bgy']);
  for (let r = 1; r <= 9; r += 1) s.addRow([null, `${String(20 + r)}00000000`, `Region ${r}`, 1, 'Reg']);
  s.addRow([null, null, 'Note: some footnote', null, null]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const saved = { payments: await settingsService.getPaymentsEnabled(), open: await settingsService.getSetting('merchStoreOpen', null) };
  await settingsService.setPaymentsEnabled(true);
  await settingsService.setSetting('merchStoreOpen', 'true');

  await prisma.psgcArea.createMany({ data: [
    { code: R, name: `${TAG} Region`, level: 'Reg', regionCode: R },
    { code: P, name: `${TAG} Province`, level: 'Prov', regionCode: R, provinceCode: P },
    { code: C, name: `${TAG} City`, level: 'City', regionCode: R, provinceCode: P, cityCode: C },
    { code: B1, name: 'Poblacion', level: 'Bgy', regionCode: R, provinceCode: P, cityCode: C },
    { code: B2, name: 'San Isidro', level: 'Bgy', regionCode: R, provinceCode: P, cityCode: C },
    { code: C3, name: `${TAG} Town`, level: 'Mun', regionCode: R, provinceCode: P, cityCode: C3 },
    { code: B3, name: 'Bagong Silang', level: 'Bgy', regionCode: R, provinceCode: P, cityCode: C3 },
    { code: RN, name: `${TAG} Metro`, level: 'Reg', regionCode: RN },
    { code: CN, name: `${TAG} Metro City`, level: 'City', regionCode: RN, cityCode: CN },
    { code: BN, name: 'Barangay 1', level: 'Bgy', regionCode: RN, cityCode: CN, subMunicipality: 'District I' },
    { code: RX, name: `${TAG} Far`, level: 'Reg', regionCode: RX },
    { code: CX, name: `${TAG} Far City`, level: 'City', regionCode: RX, cityCode: CX },
    { code: BX, name: 'Far Bgy', level: 'Bgy', regionCode: RX, cityCode: CX },
  ] });
  const zone = await prisma.merchDeliveryZone.create({ data: { name: `${TAG} Zone`, feeCentavos: 15000 } });
  const zoneOff = await prisma.merchDeliveryZone.create({ data: { name: `${TAG} Zone Off`, feeCentavos: null } });
  await prisma.merchZoneRegion.createMany({ data: [{ regionCode: R, zoneId: zone.id }, { regionCode: RN, zoneId: zoneOff.id }] });
  const point = await prisma.merchPickupPoint.create({ data: { name: `${TAG} Office`, address: 'Quezon City', hours: '9-5' } });

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const ann = await makeUser('Ann', { membershipExpiresAt: new Date(Date.now() + 100 * 864e5) });
  const ben = await makeUser('Ben');
  const users = [admin, ann, ben];
  const product = await merch.createProduct({ name: `${TAG} Pin`, isActive: true });
  const pin = await merch.addVariant(product.id, { label: 'Standard', memberPrice: '50', price: '80' }, admin.id);
  await merch.recordStock(pin.id, { action: 'receive', quantity: '50' }, admin.id);

  try {
    const Ad = await signIn(admin.email, 'admin');
    const A = await signIn(ann.email);
    const B = await signIn(ben.email);

    await test('PSGC importer: PSA layout, Metro Manila without province, Manila districts, independent city under its province', async () => {
      const rows = await fulfilment.parsePsgcWorkbook(await psaWorkbook());
      const by = (n) => rows.find((r) => r.name === n);
      assert.strictEqual(by('City of Manila').provinceCode, null, 'Metro Manila city: no province');
      assert.deepStrictEqual([by('Barangay 1').cityCode, by('Barangay 1').subMunicipality], ['1380600000', 'Tondo I/II']);
      assert.strictEqual(by('City of Cebu').provinceCode, '0702200000', 'independent city under Cebu');
      assert.strictEqual(by('Adlaon').cityCode, '0730600000');
      assert(!rows.some((r) => /footnote/.test(r.name)), 'footnotes skipped');
      await assert.rejects(fulfilment.parsePsgcWorkbook(await psaWorkbook({ sheetName: 'Other' })), /PSGC/);
      await assert.rejects(fulfilment.parsePsgcWorkbook(Buffer.from('not excel')), /Excel/);
    });

    await test('dropdown lookups: provinces, "no province" cities, barangays with their district', async () => {
      const r = await A('GET', `/api/store/psgc/provinces?region=${R}`);
      assert.deepStrictEqual(r.json.data.provinces.map((p) => p.code), [P]);
      const m = await A('GET', `/api/store/psgc/provinces?region=${RN}`);
      assert.deepStrictEqual([m.json.data.provinces.length, m.json.data.directCities], [0, true]);
      const cities = (await A('GET', `/api/store/psgc/cities?region=${RN}&province=`)).json.data.cities;
      assert.deepStrictEqual(cities.map((c) => c.code), [CN]);
      const bgys = (await A('GET', `/api/store/psgc/barangays?city=${CN}`)).json.data.barangays;
      assert.deepStrictEqual(bgys.map((b) => b.name), ['Barangay 1 (District I)']);
    });

    await test('every address rule is checked on the server', async () => {
      const bad = async (over, why) => {
        const r = await A('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', confirmAddress: true, address: address(over) });
        assert.strictEqual(r.status, 422, `${why}: ${r.status} ${r.text.slice(0, 120)}`);
        return r.json.message;
      };
      await A('POST', '/api/store/cart', { variantId: pin.id, quantity: 2 });
      assert.strictEqual((await A('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', address: address() })).status, 422, 'must tick confirm');
      assert.strictEqual((await A('POST', '/api/store/checkout', {})).status, 422, 'must choose a way');
      await bad({ recipientName: 'Ann' }, 'first and last name');
      await bad({ mobile: '12345' }, 'mobile');
      await bad({ houseNo: 'N/A' }, 'N/A');
      await bad({ street: '' }, 'street');
      await bad({ landmark: '' }, 'landmark');
      await bad({ zip: '110' }, 'zip');
      await bad({ addressType: 'CASTLE' }, 'type');
      assert(/does not belong/.test(await bad({ barangayCode: B3 }, 'barangay of another town')));
      await bad({ provinceCode: '' }, 'province missing for a region that has them');
      assert(/not available yet/.test(await bad({ regionCode: RN, provinceCode: '', cityCode: CN, barangayCode: BN }, 'zone with no fee')));
      assert(/do not deliver/.test(await bad({ regionCode: RX, provinceCode: '', cityCode: CX, barangayCode: BX }, 'region in no zone')));
      const clean = await fulfilment.validateAddress(address({ mobile: '+63 917 123 4567' }));
      assert.strictEqual(clean.mobile, '+639171234567', 'stored as +63');
    });

    let annDelivery;
    await test('delivery checkout: the zone fee is added and PayMongo charges items + delivery + its fee', async () => {
      const preview = await A('GET', `/api/store/delivery-quote?region=${R}`);
      assert.deepStrictEqual([preview.json.data.quote.available, preview.json.data.totals.deliveryFee], [true, 15000]);
      const r = await A('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', confirmAddress: true, saveAddress: true, address: address() });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      annDelivery = r.json.data.orderNumber;
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: annDelivery }, include: { payment: true } });
      assert.deepStrictEqual([o.fulfilment, o.subtotalCentavos, o.deliveryFeeCentavos, o.zoneName], ['DELIVERY', 10000, 15000, `${TAG} Zone`]);
      assert.strictEqual(o.totalCentavos, 25000 + o.channelFeeCentavos);
      assert.strictEqual(calls.checkout.at(-1).amountCentavos, 25000, 'PayMongo amount = items + delivery');
      assert.strictEqual(o.payment.amount, o.totalCentavos);
      const shipTo = JSON.parse(o.shipTo);
      assert(shipTo.lines.some((l) => /Brgy\. Poblacion/.test(l)) && shipTo.mobile === '+639171234567');
      assert.strictEqual((await fulfilment.listAddresses(ann.id)).length, 1, 'address saved');
      await pay(annDelivery);
    });

    await test('a saved address can be used at checkout and is re-checked', async () => {
      const [saved1] = await fulfilment.listAddresses(ann.id);
      await A('POST', '/api/store/cart', { variantId: pin.id, quantity: 1 });
      const r = await A('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', confirmAddress: true, addressId: saved1.id });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      await pay(r.json.data.orderNumber);
      assert.strictEqual((await B('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', confirmAddress: true, addressId: saved1.id })).status, 404, 'not someone else\'s address');
    });

    await test('staff steps for a delivery: pack, ship with tracking, deliver; wrong steps refused', async () => {
      const step = (a, body) => Ad('POST', `/api/admin/merch/orders/${annDelivery}/steps/${a}`, body);
      assert.strictEqual((await step('ship', { courier: 'LBC', trackingNumber: 'X1' })).status, 409, 'not packed yet');
      assert.strictEqual((await step('ready')).status, 422, 'ready is for pickup orders');
      assert.strictEqual((await step('pack')).status, 200);
      assert.strictEqual((await step('pack')).status, 409, 'already packed');
      assert.strictEqual((await step('ship', { courier: 'LBC' })).status, 422, 'tracking required');
      assert.strictEqual((await step('ship', { courier: 'LBC', trackingNumber: 'LBC123' })).status, 200);
      const page = await A('GET', `/store/orders/${annDelivery}`);
      assert(page.text.includes('LBC123') && page.text.includes('Shipped'));
      assert.strictEqual((await step('deliver')).status, 200);
      const o = await orders.getOrder(annDelivery);
      assert.deepStrictEqual(o.events.map((e) => e.status), ['AWAITING_PAYMENT', 'PAID', 'PACKED', 'SHIPPED', 'DELIVERED']);
      assert(o.events.slice(2).every((e) => e.by === `Admin ${TAG.toUpperCase()}`), 'who did each step');
    });

    await test('address hold: staff pause it, the buyer fixes it within the same zone, it carries on', async () => {
      await A('POST', '/api/store/cart', { variantId: pin.id, quantity: 1 });
      const n = (await A('POST', '/api/store/checkout', { fulfilment: 'DELIVERY', confirmAddress: true, address: address({ landmark: 'somewhere' }) })).json.data.orderNumber;
      await pay(n);
      await Ad('POST', `/api/admin/merch/orders/${n}/steps/pack`);
      assert.strictEqual((await Ad('POST', `/api/admin/merch/orders/${n}/steps/holdAddress`, {})).status, 422, 'needs a note');
      assert.strictEqual((await Ad('POST', `/api/admin/merch/orders/${n}/steps/holdAddress`, { note: 'Landmark too vague' })).status, 200);
      const page = await A('GET', `/store/orders/${n}`);
      assert(page.text.includes('data-fix-form') && page.text.includes('Landmark too vague'));
      const other = await A('POST', `/api/store/orders/${n}/address`, { ...address({ regionCode: RN, provinceCode: '', cityCode: CN, barangayCode: BN }), confirmAddress: true });
      assert.strictEqual(other.status, 422, 'another zone');
      const fixed = await A('POST', `/api/store/orders/${n}/address`, { ...address({ landmark: 'Across the plaza fountain' }), confirmAddress: true });
      assert.strictEqual(fixed.status, 200, fixed.text.slice(0, 200));
      const o = await orders.getOrder(n);
      assert.deepStrictEqual([o.status, o.addressNote], ['PACKED', null], 'back where it was');
      assert(o.shipLines.some((l) => /plaza fountain/.test(l)));
      assert.strictEqual((await B('POST', `/api/store/orders/${n}/address`, { ...address(), confirmAddress: true })).status, 404, 'only the buyer');
    });

    let benPickup;
    await test('pickup: ready, the QR on the buyer\'s page, handover by scanning; a ticket QR is refused', async () => {
      await B('POST', '/api/store/cart', { variantId: pin.id, quantity: 3 });
      const r = await B('POST', '/api/store/checkout', { fulfilment: 'PICKUP', pickupPointId: point.id });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      benPickup = r.json.data.orderNumber;
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: benPickup } });
      assert.deepStrictEqual([o.fulfilment, o.deliveryFeeCentavos, /^[0-9a-f]{32}$/.test(o.qrToken)], ['PICKUP', 0, true]);
      await pay(benPickup);
      assert(!(await B('GET', `/store/orders/${benPickup}`)).text.includes('data-pickup-qr'), 'no QR before it is ready');
      await Ad('POST', `/api/admin/merch/orders/${benPickup}/steps/pack`);
      assert.strictEqual((await Ad('POST', `/api/admin/merch/orders/${benPickup}/steps/ship`, { courier: 'x', trackingNumber: 'y' })).status, 422, 'ship is for delivery');
      await Ad('POST', `/api/admin/merch/orders/${benPickup}/steps/ready`);
      assert((await B('GET', `/store/orders/${benPickup}`)).text.includes('data-pickup-qr'));
      assert.strictEqual((await Ad('POST', '/api/admin/merch/handover/lookup', { code: `JPSME:${'a'.repeat(64)}` })).status, 422, 'an event ticket is not an order');
      assert.strictEqual((await Ad('POST', '/api/admin/merch/handover/lookup', { code: `${orders.QR_PREFIX}${'0'.repeat(32)}` })).status, 404);
      const look = await Ad('POST', '/api/admin/merch/handover/lookup', { code: `${orders.QR_PREFIX}${o.qrToken}` });
      assert.deepStrictEqual([look.status, look.json.data.order.orderNumber], [200, benPickup]);
      const h = await Ad('POST', '/api/admin/merch/handover', { code: `  ${orders.QR_PREFIX}${o.qrToken.toUpperCase()}\r\n` });
      assert.strictEqual(h.status, 200, h.text.slice(0, 200));
      assert.strictEqual(h.json.data.order.status, 'PICKED_UP');
      assert.strictEqual((await Ad('POST', '/api/admin/merch/handover', { code: benPickup })).status, 409, 'already picked up');
      assert.strictEqual((await Ad('POST', '/api/admin/merch/handover/lookup', { code: annDelivery })).status, 409, 'a delivery order cannot be handed over');
    });

    await test('bulk packing moves each order it can and reports the rest; pick list and export', async () => {
      const made = [];
      for (const U of [A, B]) {
        await U('POST', '/api/store/cart', { variantId: pin.id, quantity: 1 }); // eslint-disable-line no-await-in-loop
        const n = (await U('POST', '/api/store/checkout', { fulfilment: 'PICKUP', pickupPointId: point.id })).json.data.orderNumber; // eslint-disable-line no-await-in-loop
        await pay(n); // eslint-disable-line no-await-in-loop
        made.push(n);
      }
      const r = await Ad('POST', '/api/admin/merch/orders/bulk', { action: 'pack', orderNumbers: [...made, annDelivery] });
      assert.deepStrictEqual([r.json.data.done.sort(), r.json.data.failed.map((f) => f.orderNumber)], [made.sort(), [annDelivery]]);
      assert.strictEqual((await Ad('POST', '/api/admin/merch/orders/bulk', { action: 'deliver', orderNumbers: made })).status, 422, 'only pack / ready in bulk');
      const print = await Ad('GET', `/admin/merch/orders/print?orders=${made.join(',')}`);
      assert(print.text.includes('data-pick-list') && (print.text.match(/data-slip=/g) || []).length === 2);
      assert(/<td class="py-1.5 text-right text-base font-bold">2<\/td>/.test(print.text), 'pick list adds up the pins');
      const x = await Ad('GET', `/admin/merch/orders/export.xlsx?q=${encodeURIComponent(TAG.toUpperCase())}`);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.buf);
      assert(wb.getWorksheet('Orders').rowCount >= 6);
      const list = await Ad('GET', '/admin/merch/orders');
      assert(list.text.includes(annDelivery) && list.text.includes('data-count="PAID"'));
    });

    await test('an order ready for pickup for 7 days gets one reminder', async () => {
      await B('POST', '/api/store/cart', { variantId: pin.id, quantity: 1 });
      const n = (await B('POST', '/api/store/checkout', { fulfilment: 'PICKUP', pickupPointId: point.id })).json.data.orderNumber;
      await pay(n);
      await orders.applyStep(n, 'pack', {}, admin.id);
      await orders.applyStep(n, 'ready', {}, admin.id);
      await prisma.merchOrder.update({ where: { orderNumber: n }, data: { readyAt: new Date(Date.now() - 8 * 864e5) } });
      const first = await orders.remindUncollected();
      assert(first >= 1);
      const o = await prisma.merchOrder.findUnique({ where: { orderNumber: n } });
      assert(o.pickupReminderAt, 'reminder recorded');
      const again = await prisma.merchOrder.count({ where: { orderNumber: n, pickupReminderAt: null } });
      assert.strictEqual(again, 0);
      await orders.remindUncollected();
      const events = await prisma.merchOrderEvent.count({ where: { order: { orderNumber: n }, note: { startsWith: 'Reminder sent' } } });
      assert.strictEqual(events, 1, 'only once');
    });

    await test('My Addresses: add, make default, remove', async () => {
      const r = await B('POST', '/api/store/addresses', address({ recipientName: 'Ben Reyes', isDefault: true }));
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      await B('POST', '/api/store/addresses', address({ recipientName: 'Ben Office', addressType: 'OFFICE', isDefault: true }));
      const list = (await B('GET', '/api/store/addresses')).json.data.addresses;
      assert.deepStrictEqual(list.map((a) => [a.recipientName, a.isDefault]), [['Ben Office', true], ['Ben Reyes', false]]);
      assert((await B('GET', '/store/addresses')).text.includes('Ben Office'));
      await B('DELETE', `/api/store/addresses/${list[0].id}`);
      const after = (await B('GET', '/api/store/addresses')).json.data.addresses;
      assert.deepStrictEqual(after.map((a) => [a.recipientName, a.isDefault]), [['Ben Reyes', true]], 'the other becomes default');
    });

    await test('admin pages render; members are kept out', async () => {
      for (const p of ['/admin/merch/orders', `/admin/merch/orders/${annDelivery}`, '/admin/merch/pickup', '/admin/merch/fulfilment']) {
        assert.strictEqual((await Ad('GET', p)).status, 200, p);
      }
      assert((await Ad('GET', '/admin/merch/fulfilment')).text.includes(`${TAG} Zone`));
      assert.notStrictEqual((await B('GET', '/admin/merch/orders')).status, 200);
      assert.strictEqual((await B('POST', `/api/admin/merch/orders/${annDelivery}/steps/pack`)).status, 403);
      assert.strictEqual((await B('PUT', `/api/admin/merch/zones/${zone.id}`, { fee: '0' })).status, 403);
    });
  } finally {
    server.close();
    await settingsService.setPaymentsEnabled(saved.payments);
    if (saved.open === null) await prisma.siteSetting.deleteMany({ where: { key: 'merchStoreOpen' } }).catch(() => {});
    else await settingsService.setSetting('merchStoreOpen', saved.open);
    const ids = users.map((u) => u.id);
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: product.id } } }).catch((e) => console.error(e.message));
    await prisma.merchOrder.deleteMany({ where: { userId: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.merchCartItem.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.merchProduct.delete({ where: { id: product.id } }).catch((e) => console.error(e.message));
    const payIds = (await prisma.payment.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    await prisma.paymentWebhook.deleteMany({ where: { webhookId: { startsWith: `evt_${TAG}` } } }).catch(() => {});
    await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }, { paymentId: { in: payIds } }] } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: { in: payIds } } }).catch((e) => console.error(e.message));
    await prisma.merchPickupPoint.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.merchDeliveryZone.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.psgcArea.deleteMany({ where: { code: { in: [R, P, C, B1, B2, C3, B3, RN, CN, BN, RX, CX, BX] } } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.5' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
