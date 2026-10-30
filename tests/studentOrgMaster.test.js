// Tests for the Student Organization Master: listing the student units with
// their province and region, adding and editing one (president, email, year,
// province, active), its officers, and that only a main admin can use it.
//
// Runs the real app over HTTP against the dev database. Creates its own
// student organization under an existing province and removes it after.

require('dotenv').config();
process.env.TRUST_PROXY = 'true';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

const TAG = `__so${Date.now()}`;
const PASSWORD = 'student-org-password-1';
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
  const ip = `198.51.100.${60 + ipSeq}`;
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
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b || {}), del: (p) => call('DELETE', p) };
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

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const provinces = await prisma.organization.findMany({
    where: { type: 'PROVINCE', parent: { type: 'REGION' } },
    take: 2,
    include: { parent: true },
  });
  assert(provinces.length === 2, 'needs two provinces under regions in the local database');
  const region = await prisma.organization.findFirst({ where: { type: 'REGION' } });
  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const member = await makeUser('Member');
  let orgId = null;

  try {
    const A = await signIn(admin.email, 'admin');
    const M = await signIn(member.email);

    await test('an admin adds a student organization under a province', async () => {
      const r = await A.post('/api/admin/student-organizations', {
        name: `${TAG} State University`, provinceId: provinces[0].id, yearFounded: '2011',
        president: 'Juan A. Dela Cruz', email: 'SSO@Example.Invalid', isActive: true,
      });
      assert.strictEqual(r.status, 201, `create: ${r.status} ${r.json && r.json.message}`);
      const o = r.json.data.organization;
      orgId = o.id;
      assert.deepStrictEqual(
        [o.province, o.region, o.yearFounded, o.president, o.email, o.isActive],
        [provinces[0].name, provinces[0].parent.name, 2011, 'Juan A. Dela Cruz', 'sso@example.invalid', true]
      );
      const row = await prisma.organization.findUnique({ where: { id: orgId } });
      assert.strictEqual(row.type, 'STUDENT_UNIT', 'created in the organization tree as a student unit');
    });

    await test('bad input is refused: no name, a region as province, bad email or year', async () => {
      assert.strictEqual((await A.post('/api/admin/student-organizations', { name: '', provinceId: provinces[0].id })).status, 422);
      assert.strictEqual((await A.post('/api/admin/student-organizations', { name: `${TAG} X`, provinceId: region.id })).status, 422);
      assert.strictEqual((await A.post('/api/admin/student-organizations', { name: `${TAG} X`, provinceId: provinces[0].id, email: 'not-an-email' })).status, 422);
      assert.strictEqual((await A.post('/api/admin/student-organizations', { name: `${TAG} X`, provinceId: provinces[0].id, yearFounded: '1800' })).status, 422);
    });

    await test('edit: details, moving to another province, and the Active switch on its own', async () => {
      let r = await A.put(`/api/admin/student-organizations/${orgId}`, { president: 'Maria B. Santos', provinceId: provinces[1].id });
      assert.strictEqual(r.status, 200, `update: ${r.status} ${r.json && r.json.message}`);
      assert.deepStrictEqual([r.json.data.organization.president, r.json.data.organization.province], ['Maria B. Santos', provinces[1].name]);
      r = await A.put(`/api/admin/student-organizations/${orgId}`, { isActive: false });
      assert.strictEqual(r.json.data.organization.isActive, false);
      assert.strictEqual(r.json.data.organization.president, 'Maria B. Santos', 'toggling Active leaves the rest alone');
      const row = await prisma.organization.findUnique({ where: { id: orgId } });
      assert(row.path.includes(`/${provinces[1].id}/`), 'moved in the tree, path rewritten');
    });

    await test('officers: add, edit, remove; another organization\'s officer is not reachable', async () => {
      let r = await A.post(`/api/admin/student-organizations/${orgId}/officers`, { name: 'Ana Reyes', position: 'Vice President', termYear: '2026-2027' });
      assert.strictEqual(r.status, 201, `add officer: ${r.status} ${r.json && r.json.message}`);
      const officerId = r.json.data.officer.id;
      r = await A.put(`/api/admin/student-organizations/${orgId}/officers/${officerId}`, { name: 'Ana C. Reyes', position: 'Secretary', termYear: '' });
      assert.deepStrictEqual([r.json.data.officer.name, r.json.data.officer.position, r.json.data.officer.termYear], ['Ana C. Reyes', 'Secretary', null]);
      assert.strictEqual((await A.post(`/api/admin/student-organizations/${orgId}/officers`, { name: '', position: 'Adviser' })).status, 422, 'officer name required');
      const other = await prisma.organization.findFirst({ where: { type: 'STUDENT_UNIT', id: { not: orgId } } });
      if (other) {
        assert.strictEqual((await A.del(`/api/admin/student-organizations/${other.id}/officers/${officerId}`)).status, 404, 'officer of another organization');
      }
      r = await A.get(`/api/admin/student-organizations/${orgId}/officers`);
      assert.strictEqual(r.json.data.officers.length, 1);
      assert.strictEqual((await A.del(`/api/admin/student-organizations/${orgId}/officers/${officerId}`)).status, 200);
      assert.strictEqual((await A.get(`/api/admin/student-organizations/${orgId}/officers`)).json.data.officers.length, 0);
    });

    await test('the page lists it with region, province, president and an officers count', async () => {
      await A.post(`/api/admin/student-organizations/${orgId}/officers`, { name: 'Leo Cruz', position: 'Treasurer' });
      const page = await A.get('/admin/master/student-organizations');
      assert.strictEqual(page.status, 200);
      const at = page.text.indexOf(`${TAG} State University`);
      assert(at > 0, 'listed');
      const row = page.text.slice(at, at + 4000);
      assert(row.includes(provinces[1].name) && row.includes('Maria B. Santos'), 'province and president shown');
      assert(/data-officer-count>1</.test(row.replace(/\s+/g, '')), 'officer count shown');
      assert(page.text.includes('Add Student Organization') && page.text.includes('Search student organizations'));
    });

    await test('members cannot use it', async () => {
      assert.strictEqual((await M.get('/api/admin/student-organizations')).status, 403);
      assert.strictEqual((await M.put(`/api/admin/student-organizations/${orgId}`, { name: 'Hacked' })).status, 403);
      assert.strictEqual((await M.post(`/api/admin/student-organizations/${orgId}/officers`, { name: 'X', position: 'Y' })).status, 403);
    });
  } finally {
    server.close();
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const ids = [admin.id, member.id];
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.6' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
