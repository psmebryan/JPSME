// The Student organization filter on Admin -> Manage Users: one student
// organization, any, or none, alongside the other filters. Tagged rows only,
// removed afterwards.

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

const TAG = `__so${Date.now()}`;
const PASSWORD = 'student-org-filter-1';
const IP = '192.0.2.231';
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
async function signInAdmin(email) {
  const page = await fetch(`${base}/admin/login`, { headers: { 'X-Forwarded-For': IP } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': IP },
    body: JSON.stringify({ email, password: PASSWORD, context: 'admin' }),
  });
  if (res.status !== 200) throw new Error(`sign-in: ${res.status}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  return async (p) => {
    const r = await fetch(`${base}${p}`, { headers: { Cookie: cookie, 'X-Forwarded-For': IP } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text };
  };
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const national = await prisma.organization.findFirst({ where: { type: 'NATIONAL' } });
  const province = await prisma.organization.create({ data: { name: `${TAG} Province`, slug: `${TAG}-prov`, type: 'PROVINCE', parentId: national ? national.id : null } });
  const unit = await prisma.organization.create({ data: { name: `${TAG} Mechanical Engineering Society`, slug: `${TAG}-unit`, type: 'STUDENT_UNIT', parentId: province.id, institution: `${TAG} State University` } });
  const user = (label, extra) => prisma.user.create({
    data: {
      firstName: label, lastName: TAG, email: `${TAG}-${label.toLowerCase()}@example.invalid`,
      password: 'x', role: 'USER', status: 'APPROVED', ...extra,
    },
  });
  const admin = await prisma.user.create({
    data: {
      firstName: 'Admin', lastName: TAG, email: `${TAG}-admin@example.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  const inUnit = await user('Unit', { organizationId: unit.id });
  const inUnitPending = await user('Pending', { organizationId: unit.id, status: 'PENDING' });
  const inProvince = await user('Prov', { organizationId: province.id });
  const noOrg = await user('None', {});
  const users = [admin, inUnit, inUnitPending, inProvince, noOrg];

  try {
    const A = await signInAdmin(admin.email);
    const names = async (q) => {
      const r = await A(`/api/admin/members?search=${TAG}&${q}`);
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      return r.json.data.users.map((u) => u.firstName).sort();
    };

    await test('one student organization', async () => {
      assert.deepStrictEqual(await names(`studentOrg=${unit.id}`), ['Pending', 'Unit']);
    });
    await test('in any student organization / not in one', async () => {
      assert.deepStrictEqual(await names('studentOrg=ANY'), ['Pending', 'Unit']);
      assert.deepStrictEqual(await names('studentOrg=NONE'), ['None', 'Prov']);
      assert.deepStrictEqual(await names(''), ['None', 'Pending', 'Prov', 'Unit']);
    });
    await test('works with the other filters', async () => {
      assert.deepStrictEqual(await names(`studentOrg=${unit.id}&status=APPROVED`), ['Unit']);
      assert.deepStrictEqual(await names('studentOrg=NONE&membership=NON_MEMBER'), ['None', 'Prov']);
      assert.deepStrictEqual(await names(`studentOrg=${unit.id}&organizationId=${province.id}`), [], 'both must hold');
    });
    await test('a bad value is refused', async () => {
      const r = await A('/api/admin/members?studentOrg=abc');
      assert(r.status >= 400 && r.status < 500, `got ${r.status}`);
    });
    await test('the Manage Users page lists every student organization', async () => {
      const page = await A('/admin/users/all');
      assert.strictEqual(page.status, 200);
      assert(page.text.includes('name="studentOrg"'));
      assert(page.text.includes(`value="${unit.id}">${TAG} Mechanical Engineering Society (${TAG} State University)`));
      const total = await prisma.organization.count({ where: { type: 'STUDENT_UNIT', isActive: true } });
      const block = page.text.split('<optgroup label="Student organizations">')[1].split('</optgroup>')[0];
      assert.strictEqual((block.match(/<option /g) || []).length, total, 'all active student organizations');
      assert(!block.includes(`${TAG} Province`), 'provinces are not listed');
    });
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: IP } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.organization.delete({ where: { id: unit.id } }).catch((e) => console.error(e.message));
    await prisma.organization.delete({ where: { id: province.id } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
