// Tests for the Membership Master (Master List -> Membership).
//
// Filters (student organization, member type, membership status, search), the
// status counts, the columns, the .xlsx export, and that only the main admin
// can see it. Runs the real app over HTTP against the dev database; every row
// it makes is tagged and removed afterwards. No mail leaves the machine.

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

const TAG = `__mm${Date.now()}`;
const PASSWORD = 'membership-master-1';
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
  const ip = `198.51.100.${200 + ipSeq}`;
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

// Just the rows of the table, as text.
const rowsOf = (html) => (html.match(/<tr class="admin-tr" data-member="\d+">[\s\S]*?<\/tr>/g) || [])
  .map((r) => r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const countOf = (html, key) => Number(((html.match(new RegExp(`data-count="${key}"[\\s\\S]*?tabular-nums[^>]*>([\\d,]+)<`)) || [])[1] || 'NaN').replace(/,/g, ''));

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const day = 864e5;

  const province = await prisma.organization.findFirst({ where: { type: 'PROVINCE' } });
  const org = await prisma.organization.create({ data: { name: `${TAG} Student Unit`, type: 'STUDENT_UNIT', parentId: province ? province.id : null } }).catch(() => null);
  const type = await prisma.memberType.create({ data: { name: `${TAG} Type`, membershipFeeCentavos: 30000 } });

  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const active = await makeUser('Active', { middleInitial: 'Q', membershipExpiresAt: new Date(Date.now() + 100 * day), memberTypeId: type.id, organizationId: org ? org.id : null });
  const expired = await makeUser('Expired', { membershipExpiresAt: new Date(Date.now() - 10 * day), memberTypeId: type.id });
  const pending = await makeUser('Pending', { status: 'PENDING' });
  const none = await makeUser('None');
  const users = [admin, active, expired, pending, none];
  const q = encodeURIComponent(TAG);
  try {
    await prisma.payment.create({ data: { userId: active.id, purpose: 'MEMBERSHIP_REGISTRATION', amount: 30000, status: 'PAID', paidAt: new Date(Date.now() - 5 * day), gatewayPaymentId: `${TAG}-pay` } });
    await prisma.payment.create({ data: { userId: pending.id, purpose: 'MEMBERSHIP_REGISTRATION', amount: 30000, status: 'PENDING' } });

    const get = await signIn(admin.email, 'admin');

    await test('lists the tagged members with every column', async () => {
      const r = await get(`/admin/master/memberships?q=${q}`);
      assert.strictEqual(r.status, 200);
      const html = r.buffer.toString();
      assert(html.includes('Membership Master'));
      const rows = rowsOf(html);
      assert.strictEqual(rows.length, 4, `admins excluded: ${rows.length}`);
      const a = rows.find((t) => t.startsWith('Active '));
      assert(a.includes(' Q ') && a.includes(`${TAG}-active@example.invalid`) && a.includes(`${TAG} Type`), a);
      if (org) assert(a.includes(`${TAG} Student Unit`), 'organization shown');
      assert(/ Active Edit$/.test(a) && a.includes('Approved'), a);
    });

    await test('membership status: active, pending, expired, none', async () => {
      for (const [status, who] of [['ACTIVE', 'Active'], ['PENDING', 'Pending'], ['EXPIRED', 'Expired'], ['NONE', 'None']]) {
        const rows = rowsOf((await get(`/admin/master/memberships?q=${q}&status=${status}`)).buffer.toString());
        assert.deepStrictEqual(rows.map((t) => t.split(' ')[0]), [who], status);
      }
    });

    await test('counts active, pending and expired for the current filters', async () => {
      const html = (await get(`/admin/master/memberships?q=${q}`)).buffer.toString();
      assert.deepStrictEqual(['ALL', 'ACTIVE', 'PENDING', 'EXPIRED', 'NONE'].map((k) => countOf(html, k)), [4, 1, 1, 1, 1]);
    });

    await test('filters by member type (and no type), organization and search words', async () => {
      let rows = rowsOf((await get(`/admin/master/memberships?q=${q}&type=${type.id}`)).buffer.toString());
      assert.deepStrictEqual(rows.map((t) => t.split(' ')[0]).sort(), ['Active', 'Expired']);
      rows = rowsOf((await get(`/admin/master/memberships?q=${q}&type=NONE`)).buffer.toString());
      assert.deepStrictEqual(rows.map((t) => t.split(' ')[0]).sort(), ['None', 'Pending']);
      if (org) {
        rows = rowsOf((await get(`/admin/master/memberships?q=${q}&org=${org.id}`)).buffer.toString());
        assert.deepStrictEqual(rows.map((t) => t.split(' ')[0]), ['Active']);
      }
      rows = rowsOf((await get(`/admin/master/memberships?q=${encodeURIComponent(`expired ${TAG}`)}`)).buffer.toString());
      assert.deepStrictEqual(rows.map((t) => t.split(' ')[0]), ['Expired'], 'every word must match');
      assert.strictEqual((await get('/admin/master/memberships?status=BOGUS&type=x&org=;drop')).status, 200, 'junk filters ignored');
    });

    await test('Export XLS downloads the filtered rows as a workbook', async () => {
      const r = await get(`/admin/master/memberships/export.xlsx?q=${q}&type=${type.id}`);
      assert.strictEqual(r.status, 200);
      assert(/spreadsheetml/.test(r.headers.get('content-type')));
      assert(/attachment; filename="jpsme-membership-/.test(r.headers.get('content-disposition')));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.buffer);
      const sheet = wb.getWorksheet('Membership');
      assert.deepStrictEqual(sheet.getRow(1).values.slice(1), ['First name', 'Middle name', 'Last name', 'Email', 'Member type',
        'Student organization', 'Approved', 'Expiration', 'Account status', 'Membership status']);
      const firsts = [];
      sheet.eachRow((row, n) => { if (n > 1) firsts.push(row.getCell(1).value); });
      assert.deepStrictEqual(firsts.sort(), ['Active', 'Expired']);
    });

    await test('members cannot see it or export it', async () => {
      const m = await signIn(none.email);
      assert.notStrictEqual((await m('/admin/master/memberships')).status, 200);
      assert.notStrictEqual((await m('/admin/master/memberships/export.xlsx')).status, 200);
      const anon = await fetch(`${base}/admin/master/memberships/export.xlsx`, { redirect: 'manual' });
      assert.notStrictEqual(anon.status, 200);
    });
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await prisma.payment.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.2' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.memberType.delete({ where: { id: type.id } }).catch(() => {});
    if (org) await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
