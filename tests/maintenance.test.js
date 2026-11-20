// Maintenance mode: the main admin switches it on in Site Settings; everyone
// else gets the maintenance page (503, with a countdown when a duration is
// set), the main admin keeps working, signing in and webhooks still get
// through, and switching it off opens the site again. The setting is put back
// as it was; tagged users only.

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
const maintenance = require('../src/services/maintenance.service');

const TAG = `__mt${Date.now()}`;
const PASSWORD = 'maintenance-test-password-1';
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); passed += 1; } catch (err) { console.error(`FAIL: ${name}\n      ${err.message}`); failed += 1; }
}

let base;
let ipSeq = 0;
const anon = (p, opts = {}) => fetch(`${base}${p}`, { redirect: 'manual', ...opts, headers: { 'X-Forwarded-For': '198.18.0.250', ...(opts.headers || {}) } });
async function signIn(email, context) {
  ipSeq += 1;
  const ip = `198.18.0.${ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/jpsme_admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
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
    const r = await fetch(`${base}${p}`, {
      method, redirect: 'manual', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text, headers: r.headers };
  };
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const saved = await prisma.siteSetting.findUnique({ where: { key: 'maintenance' } });
  const make = async (label, role) => prisma.user.create({
    data: {
      firstName: label, lastName: TAG, email: `${TAG}-${label.toLowerCase()}@example.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role, status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  const admin = await make('Admin', 'ADMIN');
  const member = await make('Member', 'USER');
  const users = [admin, member];

  try {
    await prisma.siteSetting.deleteMany({ where: { key: 'maintenance' } });
    maintenance.clearCache();
    const Ad = await signIn(admin.email, 'admin');
    const M = await signIn(member.email, 'user');

    await test('off: the site is open and the status says so', async () => {
      assert.strictEqual((await anon('/')).status, 200);
      const s = await (await anon('/api/maintenance')).json();
      assert.strictEqual(s.data.on, false);
    });

    await test('only the main admin can switch it, with sane input', async () => {
      const r = await M('PUT', '/api/admin/settings/maintenance', { on: true });
      assert([401, 403, 404].includes(r.status), `member got ${r.status}`);
      assert.strictEqual((await Ad('PUT', '/api/admin/settings/maintenance', { on: true, durationMinutes: 0 })).status, 422);
      assert.strictEqual((await Ad('PUT', '/api/admin/settings/maintenance', { on: true, durationMinutes: 99999 })).status, 422);
      assert.strictEqual((await anon('/')).status, 200, 'still open after refused attempts');
    });

    await test('on with 30 minutes: visitors and members get the countdown page', async () => {
      const r = await Ad('PUT', '/api/admin/settings/maintenance', { on: true, durationMinutes: 30, message: 'Upgrading the membership system.' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      const page = await anon('/', { headers: { Accept: 'text/html' } });
      assert.strictEqual(page.status, 503);
      const retry = Number(page.headers.get('retry-after'));
      assert(retry > 1700 && retry <= 1800, `Retry-After ${retry}`);
      const html = await page.text();
      assert(html.includes("We&#39;re doing some maintenance") || html.includes("We're doing some maintenance"));
      assert(html.includes('data-until=') && html.includes('Upgrading the membership system.'));
      assert.strictEqual((await anon('/events')).status, 503);
      assert.strictEqual((await M('GET', '/profile')).status, 503, 'a signed-in member too');
      const api = await anon('/api/events', { headers: { Accept: 'application/json' } });
      assert.strictEqual(api.status, 503);
      assert.strictEqual((await api.json()).code, 'MAINTENANCE');
      const s = await (await anon('/api/maintenance')).json();
      assert.strictEqual(s.data.on, true);
      assert(s.data.until);
    });

    await test('still reachable: styles, the admin login and webhooks', async () => {
      assert.strictEqual((await anon('/css/tailwind.css')).status, 200);
      assert.strictEqual((await anon('/jpsme_admin/login')).status, 200);
      const hook = await anon('/api/webhooks/paymongo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.notStrictEqual(hook.status, 503, 'webhooks are not blocked');
    });

    await test('the main admin can always get back in: signed out, any admin page leads to the sign-in form', async () => {
      for (const p of ['/jpsme_admin', '/jpsme_admin/dashboard', '/jpsme_admin/settings']) {
        const r = await anon(p);
        assert.strictEqual(r.status, 302, `${p} -> ${r.status}`);
        assert.strictEqual(r.headers.get('location'), '/jpsme_admin/login');
      }
      const page = await (await anon('/', { headers: { Accept: 'text/html' } })).text();
      assert(!page.includes('jpsme_admin'), 'the public maintenance page does not reveal the admin address');
      // A fresh sign-in during maintenance reaches the dashboard and can end it.
      const Fresh = await signIn(admin.email, 'admin');
      assert.strictEqual((await Fresh('GET', '/jpsme_admin/dashboard')).status, 200);
      assert.strictEqual((await Fresh('GET', '/jpsme_admin/settings')).status, 200);
    });

    await test('signed in with another account: the page offers sign out and admin sign-in', async () => {
      const r = await M('GET', '/jpsme_admin/dashboard');
      assert.strictEqual(r.status, 503);
      assert(r.text.includes(`Signed in as Member ${TAG}`) && r.text.includes('href="/logout"') && !r.text.includes('jpsme_admin'));
    });

    await test('the main admin keeps working, with a reminder bar', async () => {
      const home = await Ad('GET', '/');
      assert.strictEqual(home.status, 200);
      assert(home.text.includes('Maintenance mode is on: only you can see the site.'));
      const settings = await Ad('GET', '/jpsme_admin/settings');
      assert.strictEqual(settings.status, 200);
      assert(settings.text.includes('data-maint="end"'));
    });

    await test('on with no duration: no countdown', async () => {
      assert.strictEqual((await Ad('PUT', '/api/admin/settings/maintenance', { on: true, durationMinutes: null })).status, 200);
      const html = await (await anon('/', { headers: { Accept: 'text/html' } })).text();
      assert(!html.includes('data-until='), 'no countdown block');
      assert(html.includes('as soon as possible'));
    });

    await test('off again: the site opens', async () => {
      const r = await Ad('PUT', '/api/admin/settings/maintenance', { on: false });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await anon('/')).status, 200);
      assert.strictEqual((await M('GET', '/profile')).status, 200);
    });
  } finally {
    server.close();
    await prisma.siteSetting.deleteMany({ where: { key: 'maintenance' } }).catch(() => {});
    if (saved) await prisma.siteSetting.create({ data: { key: 'maintenance', value: saved.value } }).catch(() => {});
    maintenance.clearCache();
    const ids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.18.0.' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
