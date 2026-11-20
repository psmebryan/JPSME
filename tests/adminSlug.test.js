// The admin panel lives at /jpsme_admin, not /admin: the old address is a
// plain 404 (for everyone, signed in or not), the new one works, and no public
// page links to it. The API stays at /api/admin. Tagged users only.

require('dotenv').config();
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.BREVO_API_KEY = '';
delete process.env.MAINTENANCE_MODE;

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

const TAG = `__as${Date.now()}`;
const PASSWORD = 'admin-slug-password-1';
const IP = '198.18.1.10';
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

let base;
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { 'X-Forwarded-For': IP, ...(cookie ? { Cookie: cookie } : {}) } });

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await prisma.user.create({
    data: {
      firstName: 'Admin', lastName: TAG, email: `${TAG}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  try {
    const page = await get('/jpsme_admin/login');
    let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
    const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': IP },
      body: JSON.stringify({ email: admin.email, password: PASSWORD, context: 'admin' }),
    });
    assert.strictEqual(login.status, 200, 'admin sign-in');
    cookie = (login.headers.get('set-cookie') || cookie).split(';')[0];

    await test('the old /admin addresses do not exist, signed in or not', async () => {
      for (const p of ['/admin', '/admin/login', '/admin/dashboard', '/admin/settings']) {
        assert.strictEqual((await get(p)).status, 404, `${p} signed out`);
        assert.strictEqual((await get(p, cookie)).status, 404, `${p} signed in`);
      }
    });

    await test('the panel works at /jpsme_admin', async () => {
      assert.strictEqual(page.status, 200, 'sign-in page');
      assert.strictEqual((await get('/jpsme_admin/dashboard', cookie)).status, 200);
      assert.strictEqual((await get('/jpsme_admin/settings', cookie)).status, 200);
      const signedOut = await get('/jpsme_admin/dashboard');
      assert.strictEqual(signedOut.status, 302);
      assert.strictEqual(signedOut.headers.get('location'), '/jpsme_admin/login');
      const html = await (await get('/jpsme_admin/dashboard', cookie)).text();
      assert(!/href="\/admin[/"]/.test(html), 'no link left to /admin');
    });

    await test('the API is unchanged at /api/admin', async () => {
      const r = await get('/api/admin/members', cookie);
      assert.strictEqual(r.status, 200);
    });

    await test('public pages do not link to the admin address', async () => {
      for (const p of ['/', '/events', '/login', '/contact']) {
        const html = await (await get(p)).text();
        assert(!html.includes('jpsme_admin'), `${p} mentions the admin address`);
      }
    });
  } finally {
    server.close();
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: admin.id }, { targetUserId: admin.id }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: IP } }).catch(() => {});
    await prisma.user.delete({ where: { id: admin.id } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
