// Tests for Reports: Transaction Report, Student Organization Member Summary
// and Student Organization Event Registration.
//
// Builds its own region -> province -> two student units, members, an event,
// registrations and payments, all tagged, checks each page's filters, totals
// and .xlsx export, then removes everything. Runs the real app over HTTP
// against the dev database. No mail leaves the machine, PayMongo is not called.

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

const TAG = `__rp${Date.now()}`;
const PASSWORD = 'reports-password-1';
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
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `198.51.100.${230 + ipSeq}`;
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
  return async (p) => {
    const r = await fetch(`${base}${p}`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip }, redirect: 'manual' });
    return { status: r.status, headers: r.headers, buffer: Buffer.from(await r.arrayBuffer()) };
  };
}

async function makeOrg(name, type, parent) {
  const org = await prisma.organization.create({
    data: { name: `${TAG} ${name}`, slug: `${TAG}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type, parentId: parent ? parent.id : null },
  });
  return prisma.organization.update({ where: { id: org.id }, data: { path: `${parent ? parent.path : '/'}${org.id}/`, depth: parent ? parent.depth + 1 : 0 } });
}

async function makeUser(label, extra = {}) {
  return prisma.user.create({
    data: {
      firstName: label, lastName: TAG.toUpperCase(),
      email: `${TAG}-${label.toLowerCase()}@example.invalid`,
      password: await bcrypt.hash(PASSWORD, 4),
      role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
      ...extra,
    },
  });
}

const text = (r) => r.buffer.toString();
const rowsOf = (html) => (html.match(/<tr class="admin-tr" data-row[^>]*>[\s\S]*?<\/tr>/g) || [])
  .map((r) => r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const totalOf = (html, key) => Number(((html.match(new RegExp(`data-(?:total|sum)="${key}"[\\s\\S]*?tabular-nums[^>]*>([^<]+)<`)) || [])[1] || 'NaN').replace(/[₱,]/g, ''));
async function sheetRows(r) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buffer);
  const sheet = wb.worksheets[0];
  const out = [];
  sheet.eachRow((row) => out.push(row.values.slice(1)));
  return out;
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const made = { orgs: [], users: [], events: [] };

  try {
    const national = await prisma.organization.findFirst({ where: { type: 'NATIONAL' } });
    const region = await makeOrg('Region', 'REGION', national);
    const province = await makeOrg('Province', 'PROVINCE', region);
    const unitA = await makeOrg('Unit A', 'STUDENT_UNIT', province);
    const unitB = await makeOrg('Unit B', 'STUDENT_UNIT', province);
    made.orgs.push(unitA, unitB, province, region);

    const admin = await makeUser('Admin', { role: 'ADMIN' });
    const ann = await makeUser('Ann', { organizationId: unitA.id, membershipExpiresAt: new Date(Date.now() + 90 * 864e5) });
    const ben = await makeUser('Ben', { organizationId: unitA.id });
    const cy = await makeUser('Cy', { organizationId: unitB.id });
    made.users.push(admin, ann, ben, cy);

    const ev1 = await prisma.event.create({ data: { title: `${TAG} Summit`, startDate: new Date(Date.now() + 5 * 864e5), isPublished: false, feeCentavos: 50000 } });
    const ev2 = await prisma.event.create({ data: { title: `${TAG} Webinar`, startDate: new Date(Date.now() + 8 * 864e5), isPublished: false } });
    made.events.push(ev1, ev2);
    const reg = (user, event, data) => prisma.eventRegistration.create({
      data: { userId: user.id, eventId: event.id, fullName: `${user.firstName} ${user.lastName}`, email: user.email, organizationId: user.organizationId, status: 'REGISTERED', ...data },
    });
    // Ann: Summit paid online, Webinar free. Ben: Summit fee to collect. Cy: Summit, cancelled.
    await reg(ann, ev1, { feeCentavos: 50000, registrationNumber: `${TAG}-1` });
    await reg(ann, ev2, { feeCentavos: 0, registrationNumber: `${TAG}-2` });
    await reg(ben, ev1, { feeCentavos: 50000, feeOptionName: 'Student', registrationNumber: `${TAG}-3` });
    await reg(cy, ev1, { feeCentavos: 50000, status: 'CANCELLED', registrationNumber: `${TAG}-4` });
    await prisma.payment.create({ data: { userId: ann.id, purpose: 'EVENT_REGISTRATION', eventId: ev1.id, amount: 51500, status: 'PAID', paidAt: new Date(), gatewayPaymentId: `${TAG}-pe` } });
    await prisma.payment.create({ data: { userId: ann.id, purpose: 'MEMBERSHIP_REGISTRATION', amount: 30900, status: 'PAID', paidAt: new Date(), gatewayPaymentId: `${TAG}-pm` } });
    await prisma.payment.create({ data: { userId: cy.id, purpose: 'MEMBERSHIP_REGISTRATION', amount: 30900, status: 'PENDING' } });

    const get = await signIn(admin.email, 'admin');
    const q = encodeURIComponent(TAG);

    await test('transactions, Event Registration: online, offline, free, cancelled', async () => {
      const r = await get(`/admin/reports/transactions?q=${q}`);
      assert.strictEqual(r.status, 200);
      const rows = rowsOf(text(r));
      assert.strictEqual(rows.length, 4);
      const by = (ref) => rows.find((t) => t.includes(ref));
      assert(/Online \(PayMongo\) Paid/.test(by(`${TAG}-1`)) && by(`${TAG}-1`).includes('515.00'), by(`${TAG}-1`));
      assert(/Free Free/.test(by(`${TAG}-2`)), by(`${TAG}-2`));
      assert(/Offline \(to organizers\) To collect/.test(by(`${TAG}-3`)) && by(`${TAG}-3`).includes('Student'), by(`${TAG}-3`));
      assert(/Cancelled/.test(by(`${TAG}-4`)), by(`${TAG}-4`));
      const html = text(r);
      assert.strictEqual(totalOf(html, 'count'), 4);
      assert.strictEqual(totalOf(html, 'paid'), 515);
      assert.strictEqual(totalOf(html, 'collect'), 500);
    });

    await test('transaction filters: payment, status, organization, event, date range', async () => {
      const count = async (extra) => rowsOf(text(await get(`/admin/reports/transactions?q=${q}&${extra}`))).length;
      assert.strictEqual(await count('payment=OFFLINE'), 2, 'offline = to collect + cancelled');
      assert.strictEqual(await count('status=PAID'), 1);
      assert.strictEqual(await count(`org=${unitB.id}`), 1);
      assert.strictEqual(await count(`event=${ev2.id}`), 1);
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      assert.strictEqual(await count(`from=${today}&to=${today}`), 4);
      assert.strictEqual(await count('from=2000-01-01&to=2000-01-02'), 0);
      assert.strictEqual((await get('/admin/reports/transactions?from=bogus&status=x&org=;&page=-4')).status, 200, 'junk ignored');
    });

    await test('transactions, Membership Registration: paid and pending', async () => {
      const r = await get(`/admin/reports/transactions?kind=membership&q=${q}`);
      const rows = rowsOf(text(r));
      assert.strictEqual(rows.length, 2);
      assert(rows.some((t) => t.startsWith('') && /Ann .* Paid/.test(t)));
      assert(rows.some((t) => /Cy .* Pending/.test(t)));
      assert.strictEqual(rowsOf(text(await get(`/admin/reports/transactions?kind=membership&q=${q}&status=PENDING`))).length, 1);
    });

    await test('transaction export matches the filters', async () => {
      const r = await get(`/admin/reports/transactions/export.xlsx?q=${q}&event=${ev1.id}`);
      assert.strictEqual(r.status, 200);
      assert(/spreadsheetml/.test(r.headers.get('content-type')));
      const rows = await sheetRows(r);
      assert.deepStrictEqual(rows[0].slice(0, 6), ['Date', 'Reference', 'Name', 'Email', 'Student organization', 'Event']);
      assert.strictEqual(rows.filter((x) => String(x[1] || '').startsWith(TAG)).length, 3);
      const m = await sheetRows(await get(`/admin/reports/transactions/export.xlsx?kind=membership&q=${q}`));
      assert.strictEqual(m[0][5], 'Member type');
      assert.strictEqual(m.filter((x) => String(x[3] || '').includes(TAG)).length, 2);
    });

    await test('member summary: totals, top 5 and region / organization filters', async () => {
      const html = text(await get(`/admin/reports/organization-members?region=${region.id}`));
      assert.deepStrictEqual(['members', 'regions', 'provinces', 'studentOrgs'].map((k) => totalOf(html, k)), [3, 1, 1, 2]);
      const rows = rowsOf(html);
      assert(rows[0].includes(`${TAG} Unit A`) && / 2 1$/.test(rows[0]), rows[0]);
      assert(rows[1].includes(`${TAG} Unit B`) && / 1 0$/.test(rows[1]), rows[1]);
      assert(/data-top[\s\S]*Unit A[\s\S]*Unit B/.test(html), 'top list in order');
      const one = text(await get(`/admin/reports/organization-members?org=${unitB.id}`));
      assert.deepStrictEqual(['members', 'regions', 'provinces', 'studentOrgs'].map((k) => totalOf(one, k)), [1, 1, 1, 1]);
      const x = await sheetRows(await get(`/admin/reports/organization-members/export.xlsx?region=${region.id}`));
      assert.deepStrictEqual(x[0], ['Rank', 'Region', 'Province', 'Student organization', 'Members', 'Active memberships']);
      assert.deepStrictEqual(x.slice(1).map((r) => [r[3], r[4], r[5]]), [[`${TAG} Unit A`, 2, 1], [`${TAG} Unit B`, 1, 0]]);
    });

    await test('event registration per organization: registrants vs individuals', async () => {
      const html = text(await get(`/admin/reports/organization-events?region=${region.id}`));
      assert.deepStrictEqual(['registrants', 'individuals', 'studentOrgs'].map((k) => totalOf(html, k)), [3, 2, 1]);
      const rows = rowsOf(html);
      assert.strictEqual(rows.length, 1, 'Unit B only has a cancelled registration');
      assert(/Unit A 3 2 2$/.test(rows[0]), rows[0]);
      const one = text(await get(`/admin/reports/organization-events?region=${region.id}&event=${ev1.id}`));
      assert.deepStrictEqual(['registrants', 'individuals'].map((k) => totalOf(one, k)), [2, 2]);
      const x = await sheetRows(await get(`/admin/reports/organization-events/export.xlsx?region=${region.id}`));
      assert.deepStrictEqual(x[0], ['Region', 'Province', 'Student organization', 'Total registrants', 'Total individuals', 'Events']);
      assert.deepStrictEqual(x[1].slice(2, 5), [`${TAG} Unit A`, 3, 2]);
    });

    await test('members cannot open reports or exports', async () => {
      const m = await signIn(ben.email);
      for (const p of ['/admin/reports/transactions', '/admin/reports/transactions/export.xlsx',
        '/admin/reports/organization-members/export.xlsx', '/admin/reports/organization-events/export.xlsx']) {
        assert.notStrictEqual((await m(p)).status, 200, p);
      }
      assert.notStrictEqual((await fetch(`${base}/admin/reports/transactions/export.xlsx`, { redirect: 'manual' })).status, 200);
    });
  } finally {
    server.close();
    const ids = made.users.map((u) => u.id);
    const evIds = made.events.map((e) => e.id);
    await prisma.payment.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    // Refused on a database whose seats table is damaged; then these rows stay.
    await prisma.eventRegistration.deleteMany({ where: { eventId: { in: evIds } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: evIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.23' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    // Where the seats table is damaged the deletes above are refused. Remove
    // this run's own tagged rows anyway, with key checks off for just them.
    if (await prisma.eventRegistration.count({ where: { registrationNumber: { startsWith: TAG } } })) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=0');
        await tx.$executeRawUnsafe('DELETE FROM EventRegistration WHERE registrationNumber LIKE ?', `${TAG}-%`);
        if (evIds.length) await tx.$executeRawUnsafe(`DELETE FROM Event WHERE id IN (${evIds.map(Number).join(',')})`);
        if (ids.length) await tx.$executeRawUnsafe(`DELETE FROM User WHERE id IN (${ids.map(Number).join(',')})`);
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=1');
      }).catch(() => {});
    }
    for (const o of made.orgs) await prisma.organization.delete({ where: { id: o.id } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
