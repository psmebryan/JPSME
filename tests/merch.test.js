// Tests for the merchandise store, phase 1: products, variants, photos, the
// stock ledger and price history (admin -> Merchandise).
//
// Runs the real app over HTTP against the dev database. Everything made is
// tagged and removed; photos are tiny generated PNGs, deleted with their rows.

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
const storage = require('../src/services/storage.service');
const settingsService = require('../src/services/settings.service');

const TAG = `__mc${Date.now()}`;
const PASSWORD = 'merch-password-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
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

let base;
let ipSeq = 0;
async function signIn(email, context = 'admin') {
  ipSeq += 1;
  const ip = `198.51.100.${30 + ipSeq}`;
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
    const isForm = body instanceof FormData;
    const r = await fetch(`${base}${p}`, {
      method,
      redirect: 'manual',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString()); } catch (e) { /* page or file */ }
    return { status: r.status, json, text: buf.toString(), buf, headers: r.headers };
  };
}

async function makeUser(label, role) {
  return prisma.user.create({
    data: {
      firstName: label, lastName: TAG.toUpperCase(), email: `${TAG}-${label.toLowerCase()}@example.invalid`,
      password: await bcrypt.hash(PASSWORD, 4), role, status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
}

const photos = (n, kind = 'png') => {
  const fd = new FormData();
  for (let i = 0; i < n; i += 1) {
    fd.append('photos', kind === 'svg'
      ? new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/png' })
      : new Blob([PNG], { type: 'image/png' }), `p${i}.png`);
  }
  return fd;
};

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const savedAccess = await settingsService.getSetting('presidentModules', null);
  const admin = await makeUser('Admin', 'ADMIN');
  const president = await makeUser('President', 'PRESIDENT');
  const member = await makeUser('Member', 'USER');
  const users = [admin, president, member];
  const productIds = [];

  try {
    const A = await signIn(admin.email);
    let polo;
    let large;
    let pin;

    await test('a product is added switched off; names are unique', async () => {
      const r = await A('POST', '/api/admin/merch/products', { name: `${TAG} Polo shirt`, description: 'Official polo' });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      polo = r.json.data.product;
      productIds.push(polo.id);
      assert.strictEqual(polo.isActive, false, 'off until the store opens');
      assert.strictEqual((await A('POST', '/api/admin/merch/products', { name: `${TAG} Polo shirt` })).status, 409);
      assert.strictEqual((await A('POST', '/api/admin/merch/products', { name: '' })).status, 422);
      const p2 = await A('POST', '/api/admin/merch/products', { name: `${TAG} Pin` });
      productIds.push(p2.json.data.product.id);
      pin = p2.json.data.product;
    });

    await test('variants: prices may stay TBD, SKU is made when empty, bad values refused', async () => {
      let r = await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'Navy / L', size: 'L', color: 'Navy', lowStockLevel: '5' });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      large = r.json.data.variant;
      assert.deepStrictEqual([large.memberPriceCentavos, large.priceCentavos, large.costCentavos], [null, null, null], 'TBD');
      assert(/NAVY-L$/.test(large.sku), `sku ${large.sku}`);
      assert.strictEqual(large.stockState, 'SOLD_OUT', 'nothing received yet');
      r = await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'Navy / L' });
      assert.strictEqual(r.status, 409, 'same name twice');
      assert.strictEqual((await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'X', sku: 'bad sku!' })).status, 422);
      assert.strictEqual((await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'Y', price: '-1' })).status, 422);
      assert.strictEqual((await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'Z', limitPerBuyer: '0' })).status, 422);
      r = await A('POST', `/api/admin/merch/products/${pin.id}/variants`, { label: 'Standard', sku: `PIN-${TAG.slice(4)}`, memberPrice: '50', price: '80', cost: '22.5' });
      assert.strictEqual(r.status, 201);
      assert.deepStrictEqual([r.json.data.variant.memberPriceCentavos, r.json.data.variant.priceCentavos, r.json.data.variant.costCentavos], [5000, 8000, 2250]);
    });

    await test('prices accept how people type them (₱, commas); anything else is refused, never saved as TBD', async () => {
      let r = await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'White / XS', color: 'White', memberPrice: '₱1,500.50', price: 'PHP 2,000', cost: ' 150 ' });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      assert.deepStrictEqual([r.json.data.variant.memberPriceCentavos, r.json.data.variant.priceCentavos, r.json.data.variant.costCentavos], [150050, 200000, 15000]);
      for (const bad of ['abc', '350php5', '1.234', '-5']) {
        r = await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: `Bad ${bad}`, memberPrice: bad });
        assert.strictEqual(r.status, 422, `"${bad}" refused`);
      }
      // "Set prices" sends only the filled boxes: the others keep their value.
      const white = r = await A('POST', `/api/admin/merch/products/${polo.id}/variants`, { label: 'White / S', color: 'White' });
      r = await A('PUT', `/api/admin/merch/products/${polo.id}/variants/${white.json.data.variant.id}`, { memberPrice: '350' });
      assert.deepStrictEqual([r.json.data.variant.memberPriceCentavos, r.json.data.variant.priceCentavos], [35000, null]);
      assert((await A('GET', `/admin/merch/products/${polo.id}`)).text.includes('Set prices'));
    });

    await test('every price and cost change is kept, with who changed it', async () => {
      await A('PUT', `/api/admin/merch/products/${polo.id}/variants/${large.id}`, { memberPrice: '350', price: '450' });
      await A('PUT', `/api/admin/merch/products/${polo.id}/variants/${large.id}`, { memberPrice: '380', price: '450', cost: '210' });
      const h = (await A('GET', `/api/admin/merch/variants/${large.id}/price-history`)).json.data.history;
      const seq = h.map((x) => [x.field, x.oldValue, x.newValue]).reverse();
      assert.deepStrictEqual(seq.filter((x) => x[0] === 'memberPriceCentavos'), [['memberPriceCentavos', null, 35000], ['memberPriceCentavos', 35000, 38000]]);
      assert.deepStrictEqual(seq.filter((x) => x[0] === 'priceCentavos'), [['priceCentavos', null, 45000]], 'an unchanged price adds no line');
      assert(h.every((x) => x.by === `Admin ${TAG.toUpperCase()}`));
    });

    await test('photos: PNG/JPEG/WEBP only, checked by their bytes, at most 6', async () => {
      let r = await A('POST', `/api/admin/merch/products/${polo.id}/photos`, photos(2));
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      assert.strictEqual(r.json.data.product.images.length, 2);
      assert(await storage.exists(r.json.data.product.images[0].url), 'stored');
      assert.strictEqual((await A('POST', `/api/admin/merch/products/${polo.id}/photos`, photos(1, 'svg'))).status, 400, 'svg refused');
      assert.strictEqual((await A('POST', `/api/admin/merch/products/${polo.id}/photos`, photos(5))).status, 422, '2 + 5 > 6');
      const img = r.json.data.product.images[1];
      r = await A('DELETE', `/api/admin/merch/products/${polo.id}/photos/${img.id}`);
      assert.strictEqual(r.status, 200);
      assert(!(await storage.exists(img.url)), 'file removed');
    });

    await test('the ledger: receive, write off with a reason, count corrections', async () => {
      const stock = (body) => A('POST', `/api/admin/merch/variants/${large.id}/stock`, body);
      let r = await stock({ action: 'receive', quantity: '10', supplier: 'Shirt Co', unitCost: '210' });
      assert.strictEqual(r.status, 201, r.text.slice(0, 200));
      assert.strictEqual(r.json.data.onHand, 10);
      assert.strictEqual((await stock({ action: 'writeoff', quantity: '2' })).status, 422, 'a reason is required');
      assert.strictEqual((await stock({ action: 'writeoff', quantity: '11', reason: 'x' })).status, 422, 'not more than on hand');
      r = await stock({ action: 'writeoff', quantity: '3', reason: 'Torn in storage' });
      assert.strictEqual(r.json.data.onHand, 7);
      r = await stock({ action: 'count', counted: '5', reason: 'Monthly count' });
      assert.deepStrictEqual([r.json.data.movement.quantity, r.json.data.onHand], [-2, 5]);
      r = await stock({ action: 'count', counted: '5', reason: 'Recount' });
      assert.deepStrictEqual([r.json.data.movement.type, r.json.data.movement.quantity], ['COUNT_CORRECTION', 0], 'a matching count is still recorded');
      assert.strictEqual((await stock({ action: 'sell', quantity: '1' })).status, 422, 'only staff movements here');
      const m = (await A('GET', `/api/admin/merch/variants/${large.id}/movements`)).json.data;
      assert.strictEqual(m.onHand, 5);
      assert.deepStrictEqual(m.movements.map((x) => x.quantity).reverse(), [10, -3, -2, 0]);
      assert.strictEqual(m.movements.at(-1).supplier, 'Shirt Co');
    });

    await test('two people writing off the last items at once cannot take stock below zero', async () => {
      const stock = () => A('POST', `/api/admin/merch/variants/${large.id}/stock`, { action: 'writeoff', quantity: '5', reason: 'race' });
      const results = await Promise.all([stock(), stock(), stock()]);
      assert.strictEqual(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(','));
      const m = (await A('GET', `/api/admin/merch/variants/${large.id}/movements`)).json.data;
      assert.strictEqual(m.onHand, 0);
      await A('POST', `/api/admin/merch/variants/${large.id}/stock`, { action: 'receive', quantity: '4' });
    });

    await test('inventory: on hand, low and sold-out states, value at cost, export', async () => {
      const page = await A('GET', `/admin/merch/inventory?q=${encodeURIComponent(TAG)}`);
      assert.strictEqual(page.status, 200);
      assert(page.text.includes('Navy / L') && page.text.includes('Standard'));
      assert(/data-row="\d+"[^>]*data-on-hand="4"/.test(page.text), 'polo L shows 4');
      const low = await A('GET', `/admin/merch/inventory?q=${encodeURIComponent(TAG)}&state=LOW`);
      assert(low.text.includes('Navy / L') && !low.text.includes('>Standard<'), '4 <= 5 is low');
      const out = await A('GET', `/admin/merch/inventory?q=${encodeURIComponent(TAG)}&state=SOLD_OUT`);
      assert(out.text.includes('Standard'), 'pin never received');
      const x = await A('GET', `/admin/merch/inventory/export.xlsx?q=${encodeURIComponent(TAG)}`);
      assert.strictEqual(x.status, 200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.buf);
      assert.deepStrictEqual(wb.worksheets.map((s) => s.name), ['On hand', 'Movements']);
      const onHand = [];
      wb.getWorksheet('On hand').eachRow((r, n) => { if (n > 1) onHand.push([r.getCell(2).value, r.getCell(4).value, r.getCell(10).value]); });
      assert.deepStrictEqual(onHand.find((r) => r[0] === 'Navy / L'), ['Navy / L', 4, 840], '4 x PHP 210');
      assert.strictEqual(wb.getWorksheet('Movements').rowCount, 7, 'header + 6 movements');
    });

    await test('history is protected: no removing a variant or product with movements; switching off works', async () => {
      assert.strictEqual((await A('DELETE', `/api/admin/merch/products/${polo.id}/variants/${large.id}`)).status, 409);
      assert.strictEqual((await A('DELETE', `/api/admin/merch/products/${polo.id}`)).status, 409);
      const r = await A('PUT', `/api/admin/merch/products/${polo.id}/variants/${large.id}`, { isActive: false });
      assert.strictEqual(r.json.data.variant.isActive, false);
      const page = await A('GET', `/admin/merch/inventory?q=${encodeURIComponent(TAG)}`);
      assert(!page.text.includes('Navy / L'), 'switched-off variants hidden by default');
      assert((await A('GET', `/admin/merch/inventory?q=${encodeURIComponent(TAG)}&showOff=1`)).text.includes('Navy / L'));
    });

    await test('admin pages render; the Merchandise sidebar group shows', async () => {
      const list = await A('GET', '/admin/merch/products');
      assert(list.text.includes(`${TAG} Polo shirt`) && list.text.includes('merch-submenu'));
      const one = await A('GET', `/admin/merch/products/${polo.id}`);
      assert(one.text.includes('Variants and prices') && one.text.includes('Navy / L') && one.text.includes('₱380.00'));
    });

    await test('access: a President only with the Merchandise tick; members never', async () => {
      await A('PUT', '/api/admin/settings/president-access', { modules: ['dashboard', 'events'] });
      const P = await signIn(president.email);
      assert.strictEqual((await P('GET', '/api/admin/merch/products')).status, 403);
      assert.strictEqual((await P('GET', '/admin/merch/inventory')).status, 302);
      await A('PUT', '/api/admin/settings/president-access', { modules: ['dashboard', 'merchandise'] });
      assert.strictEqual((await P('GET', '/api/admin/merch/products')).status, 200);
      assert.strictEqual((await P('GET', '/admin/merch/inventory')).status, 200);
      const M = await signIn(member.email, 'user');
      assert.notStrictEqual((await M('GET', '/admin/merch/products')).status, 200);
      assert.strictEqual((await M('POST', `/api/admin/merch/variants/${large.id}/stock`, { action: 'receive', quantity: '1' })).status, 403);
    });
  } finally {
    server.close();
    if (savedAccess === null) await prisma.siteSetting.deleteMany({ where: { key: 'presidentModules' } }).catch(() => {});
    else await settingsService.setSetting('presidentModules', savedAccess);
    const imgs = await prisma.merchProductImage.findMany({ where: { productId: { in: productIds } } });
    for (const i of imgs) await storage.remove(i.url).catch(() => {});
    await prisma.merchStockMovement.deleteMany({ where: { variant: { productId: { in: productIds } } } }).catch(() => {});
    await prisma.merchProduct.deleteMany({ where: { id: { in: productIds } } }).catch(() => {});
    const ids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.3' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
