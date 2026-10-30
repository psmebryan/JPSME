// Tests for the National President role (Role PRESIDENT).
//
// The main admin ticks which admin modules a President may open (Site
// Settings -> National President access). A President must reach exactly
// those, pages and API alike; everything else, and every path in no module,
// is refused. A President can never change the main admin or another
// President, nor hand out either role, whatever modules they have.
//
// Runs the real app over HTTP against the dev database. The access setting is
// put back as it was afterwards; every row made is tagged and removed.

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
const { modulesForPath } = require('../src/config/adminModules');

const TAG = `__pr${Date.now()}`;
const PASSWORD = 'president-password-1';
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
  const ip = `198.51.100.${70 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password: PASSWORD, context }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status} ${await res.text()}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      redirect: 'manual',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, location: r.headers.get('location'), json, text };
  };
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), put: (p, b) => call('PUT', p, b || {}), del: (p) => call('DELETE', p),
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

const opens = (r) => r.status === 200;
const refusedPage = (r) => r.status === 302 && !/\/admin\/login/.test(r.location || '');

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const savedAccess = await settingsService.getSetting('presidentModules', null);
  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const president = await makeUser('President', { role: 'PRESIDENT' });
  const member = await makeUser('Member');
  const other = await makeUser('Other');
  const users = [admin, president, member, other];
  const event = await prisma.event.create({ data: { title: `${TAG} Summit`, startDate: new Date(Date.now() + 5 * 864e5), isPublished: false } });

  try {
    await test('every admin page and API path is placed in a module, and settings / data export in none', () => {
      assert.deepStrictEqual(modulesForPath('/admin/settings'), null);
      assert.deepStrictEqual(modulesForPath('/api/admin/settings/president-access'), null);
      assert.deepStrictEqual(modulesForPath('/api/admin/data/export'), null);
      assert.deepStrictEqual(modulesForPath('/admin/events/5/desk'), ['checkin']);
      assert.deepStrictEqual(modulesForPath('/admin/events/5/certificate'), ['certificates']);
      assert.deepStrictEqual(modulesForPath('/admin/events/5/edit'), ['events']);
      assert.deepStrictEqual(modulesForPath('/admin/master/event-fees'), ['masterEvents']);
      assert.deepStrictEqual(modulesForPath('/admin/master/member-types'), ['masterMembers']);
    });

    const A = await signIn(admin.email);

    await test('main admin ticks the President\'s modules; unknown names are dropped', async () => {
      const r = await A.put('/api/admin/settings/president-access', {
        modules: ['dashboard', 'events', 'certificates', 'emails', 'organizations', 'masterEvents', 'sponsors', 'articles', 'bogus'],
      });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert(!r.json.data.modules.includes('bogus'));
      const page = await A.get('/admin/settings');
      assert(page.text.includes('National President access') && page.text.includes(`${president.firstName} ${president.lastName}`));
    });

    const P = await signIn(president.email);

    await test('the President signs in to the admin and opens each ticked module', async () => {
      for (const p of ['/admin/dashboard', '/admin/events', `/admin/events/${event.id}/edit`, '/admin/event-certificates',
        '/admin/event-emails', '/admin/broadcasts', '/admin/organizations', '/admin/organization-admins',
        '/admin/master/event-fees', '/admin/sponsors', '/admin/articles', '/admin/articles/new']) {
        assert(opens(await P.get(p)), `page ${p}`);
      }
      for (const p of ['/api/events/admin/all', `/api/admin/event-fees/${event.id}/options`, '/api/articles/admin/all',
        '/api/admin/sponsors', '/api/admin/organization-admins']) {
        assert(opens(await P.get(p)), `api ${p}`);
      }
    });

    await test('everything not ticked is refused, pages and API', async () => {
      for (const p of ['/admin/settings', '/admin/users/all', '/admin/payments', '/admin/reports/transactions',
        '/admin/master/member-types', '/admin/master/memberships', '/admin/audit-log', '/admin/check-in', `/admin/events/${event.id}/desk`]) {
        assert(refusedPage(await P.get(p)), `page ${p} should redirect`);
      }
      for (const [m, p] of [['GET', '/api/admin/payments'], ['GET', '/api/admin/member-types'], ['GET', '/api/admin/users'],
        ['GET', '/api/admin/data/export'], ['PUT', '/api/admin/settings/president-access'], ['GET', '/api/admin/settings/payments-enabled'],
        ['GET', `/api/events/${event.id}/checkin/stats`]]) {
        const r = m === 'GET' ? await P.get(p) : await P.put(p, { modules: ['payments'] });
        assert.strictEqual(r.status, 403, `${m} ${p}: ${r.status}`);
      }
    });

    await test('the sidebar shows only the ticked modules', async () => {
      const html = (await P.get('/admin/dashboard')).text;
      const nav = html.slice(html.indexOf('id="admin-nav"'), html.indexOf('</nav>', html.indexOf('id="admin-nav"')));
      ['/admin/events"', '/admin/articles"', '/admin/sponsors"', '/admin/master/event-fees"', '/admin/event-certificates"', '/admin/broadcasts"']
        .forEach((h) => assert(nav.includes(h), `shows ${h}`));
      ['/admin/settings"', '/admin/payments"', '/admin/users/all"', '/admin/master/member-types"', '/admin/reports/transactions"', '/admin/check-in"']
        .forEach((h) => assert(!nav.includes(h), `hides ${h}`));
      assert(html.includes('National President'));
    });

    await test('changing the ticks takes effect on the next request', async () => {
      await A.put('/api/admin/settings/president-access', { modules: ['dashboard', 'events', 'users', 'checkin'] });
      assert(refusedPage(await P.get('/admin/articles')), 'articles now refused');
      assert.strictEqual((await P.get('/api/articles/admin/all')).status, 403);
      assert(opens(await P.get('/admin/users/all')), 'users now open');
      assert(opens(await P.get(`/admin/events/${event.id}/desk`)), 'check-in now open');
      assert.strictEqual((await P.get(`/api/events/${event.id}/checkin/stats`)).status, 200, 'check-in API follows the tick');
    });

    await test('with Users, the President manages members but never the main admin or a President', async () => {
      assert.strictEqual((await P.put(`/api/admin/users/${member.id}`, { firstName: 'Renamed' })).status, 200, 'edit a member');
      assert.strictEqual((await P.put(`/api/admin/users/${admin.id}`, { firstName: 'Hacked' })).status, 403, 'edit main admin');
      assert.strictEqual((await P.put(`/api/admin/users/${member.id}`, { role: 'ADMIN' })).status, 403, 'make an admin');
      assert.strictEqual((await P.put(`/api/admin/users/${member.id}`, { role: 'PRESIDENT' })).status, 403, 'make a President');
      assert.strictEqual((await P.del(`/api/admin/users/${admin.id}`)).status, 403, 'delete main admin');
      assert.strictEqual((await P.post('/api/admin/users/bulk-delete', { ids: [other.id, admin.id] })).status, 403, 'bulk delete including admin');
      assert.strictEqual((await P.post(`/api/admin/users/${admin.id}/reject`)).status, 403, 'reject main admin');
      assert.strictEqual((await P.put(`/api/admin/users/${admin.id}/password`, { password: 'x-new-password-123' })).status, 403, 'reset admin password');
      const still = await prisma.user.findUnique({ where: { id: admin.id } });
      assert.deepStrictEqual([still.role, still.firstName, still.status], ['ADMIN', 'Admin', 'APPROVED']);
      assert.strictEqual((await prisma.user.findUnique({ where: { id: member.id } })).role, 'USER');
    });

    await test('only the main admin gives the President role; it signs that person out', async () => {
      const O = await signIn(other.email, 'user');
      const r = await A.put(`/api/admin/users/${other.id}`, { role: 'PRESIDENT' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.strictEqual((await prisma.user.findUnique({ where: { id: other.id } })).role, 'PRESIDENT');
      assert.notStrictEqual((await O.get('/api/auth/me')).status, 200, 'old session ended');
      const edit = await A.get(`/admin/users/${other.id}/edit`);
      assert(edit.text.includes('value="PRESIDENT"'), 'main admin sees the choice');
      const asPresident = await P.get(`/admin/users/${member.id}/edit`);
      assert(!asPresident.text.includes('value="PRESIDENT"') && !asPresident.text.includes('value="ADMIN"'), 'President does not');
      await A.put(`/api/admin/users/${other.id}`, { role: 'USER' });
    });

    await test('a President cannot be made a chapter admin by accident', async () => {
      await A.put('/api/admin/settings/president-access', { modules: ['organizations'] });
      const org = await prisma.organization.findFirst({ where: { type: 'STUDENT_UNIT' } });
      const r = await A.post('/api/admin/organization-admins/assign', { organizationId: org.id, userId: president.id });
      assert.strictEqual(r.status, 400);
      assert.strictEqual((await prisma.user.findUnique({ where: { id: president.id } })).role, 'PRESIDENT');
    });

    await test('with nothing ticked, the President is sent to the public site', async () => {
      await A.put('/api/admin/settings/president-access', { modules: [] });
      const r = await P.get('/admin/dashboard');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/');
    });

    await test('members still cannot open the admin', async () => {
      const M = await signIn(member.email, 'user');
      assert.notStrictEqual((await M.get('/admin/dashboard')).status, 200);
      assert.strictEqual((await M.get('/api/articles/admin/all')).status, 403);
    });
  } finally {
    server.close();
    if (savedAccess === null) await prisma.siteSetting.deleteMany({ where: { key: 'presidentModules' } }).catch(() => {});
    else await settingsService.setSetting('presidentModules', savedAccess);
    const ids = users.map((u) => u.id);
    await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
    await prisma.organizationAdminAudit.deleteMany({ where: { OR: [{ newUserId: { in: ids } }, { oldUserId: { in: ids } }, { changedBy: { in: ids } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.job.deleteMany({ where: { OR: ids.map((id) => ({ payload: { contains: `"userId":${id}` } })) } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.7' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
