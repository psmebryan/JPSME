// Cross-user access: member A has records, member B (and a chapter admin from
// a different organization) try to read, change and delete them. Every attempt
// must be refused (403/404) or must touch only the caller's own data.
//
// Runs the real app over HTTP against the dev database, signing in through the
// real login endpoint. No mail leaves the machine: the transport is pointed at
// nothing (registration emails go to the job queue, which nothing runs here,
// and the test removes the jobs it caused).

require('dotenv').config();
// Each signed-in user gets their own address, so the per-IP login limits and
// counts never interfere between them.
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.BREVO_API_KEY = '';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const organizationService = require('../src/services/organization.service');

const TAG = `__xu${Date.now()}`;
const PASSWORD = 'cross-user-password-1';
let passed = 0;
let failed = 0;
const results = [];

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

// Signs in through /login and the real API; returns a client with its cookie.
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
  if (res.status !== 200) throw new Error(`sign-in for ${email} failed: ${res.status} ${(await res.json()).message}`);
  // Login regenerates the session: take the new cookie, then a token for it.
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const t = await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } });
  const csrf = (await t.json()).data.csrfToken;

  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      redirect: 'manual',
      headers: {
        Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch (e) { /* PDFs, pages */ }
    return { status: r.status, json };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b || {}),
    put: (p, b) => call('PUT', p, b || {}),
    del: (p) => call('DELETE', p),
  };
}

function refused(r, label) {
  results.push(`${String(r.status).padEnd(4)} ${label}`);
  assert([403, 404].includes(r.status), `${label}: expected 403 or 404, got ${r.status} (${r.json && r.json.message})`);
}

async function makeUser(label, extra = {}) {
  return prisma.user.create({
    data: {
      firstName: label, lastName: TAG.toUpperCase(),
      email: `${TAG}-${label.toLowerCase()}@example.invalid`,
      password: await bcrypt.hash(PASSWORD, 4),
      role: 'USER', status: 'APPROVED',
      emailVerifiedAt: new Date(), passwordSetAt: new Date(),
      ...extra,
    },
  });
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  // Two unrelated organizations: A belongs to one, the chapter admin to the other.
  // Siblings under the national root, so neither contains the other.
  const root = await prisma.organization.findFirst({ where: { parentId: null }, select: { id: true } });
  const orgA = await organizationService.createOrganization({ name: `${TAG} Org A`, type: 'REGION', parentId: root.id });
  const orgC = await organizationService.createOrganization({ name: `${TAG} Org C`, type: 'REGION', parentId: root.id });
  const event = await prisma.event.create({
    data: { title: `${TAG} Event`, startDate: new Date(Date.now() + 7 * 864e5), isPublished: true },
  });
  const userA = await makeUser('Alice', { organizationId: orgA.id });
  const userB = await makeUser('Bob', { organizationId: orgA.id });
  const adminC = await makeUser('Carol', { role: 'CHAPTER_ADMIN', organizationId: orgC.id });

  try {
    const A = await signIn(userA.email);
    const B = await signIn(userB.email);

    // A creates a record: a registration for the event.
    const reg = await A.post(`/api/events/${event.id}/register`);
    assert([200, 201].includes(reg.status), `A could not register: ${reg.status} ${reg.json && reg.json.message}`);
    const registration = await prisma.eventRegistration.findUnique({
      where: { userId_eventId: { userId: userA.id, eventId: event.id } },
    });
    assert(registration, 'A has a registration');

    await test('B cannot read A\'s ticket, QR or certificate', async () => {
      refused(await B.get(`/api/events/${event.id}/ticket.pdf`), 'B GET A\'s ticket PDF');
      refused(await B.get(`/api/events/${event.id}/ticket/qr.png`), 'B GET A\'s ticket QR');
      refused(await B.get(`/api/certificates/events/${event.id}/download`), 'B GET A\'s event certificate');
    });

    await test('B\'s own registration list does not include A\'s', async () => {
      const r = await B.get('/api/registrations/me');
      assert.strictEqual(r.status, 200);
      const ids = JSON.stringify(r.json.data);
      assert(!ids.includes(registration.registrationNumber), 'A\'s registration is not in B\'s list');
      results.push(`200  B GET /api/registrations/me (returns only B's own; A's absent)`);
    });

    await test('B cannot read A\'s attendance or seat by registration id', async () => {
      refused(await B.get(`/api/events/${event.id}/registrations/${registration.id}/attendance`), 'B GET A\'s attendance history');
      refused(await B.get(`/api/events/${event.id}/seating/registrations/${registration.id}/seat`), 'B GET A\'s seat');
      refused(await B.get(`/api/events/${event.id}/rooms`), 'B GET event rooms (staff only)');
    });

    await test('B cannot cancel A\'s registration', async () => {
      refused(await B.post(`/api/events/${event.id}/cancel`), 'B POST cancel (no registration of B\'s own)');
      const after = await prisma.eventRegistration.findUnique({ where: { id: registration.id } });
      assert.strictEqual(after.status, registration.status, 'A\'s registration unchanged');
    });

    await test('B cannot read, change or delete A\'s account', async () => {
      refused(await B.get('/api/admin/users'), 'B GET admin user list');
      refused(await B.put(`/api/admin/users/${userA.id}`, { firstName: 'HACKED' }), 'B PUT A\'s account');
      refused(await B.del(`/api/admin/users/${userA.id}`), 'B DELETE A\'s account');
      refused(await B.post(`/api/admin/users/${userA.id}/reject`), 'B POST reject A');
      refused(await B.get(`/api/admin/organization-members?organizationId=${orgA.id}`), 'B GET organization members');
      const a = await prisma.user.findUnique({ where: { id: userA.id } });
      assert(a && a.firstName === 'Alice', 'A untouched');
    });

    await test('a userId in the profile body is ignored: B can only edit B', async () => {
      const r = await B.put('/api/auth/me/profile', { userId: userA.id, id: userA.id, firstName: 'Mallory', role: 'ADMIN', status: 'APPROVED', email: 'x@example.invalid' });
      assert.strictEqual(r.status, 200);
      const [a, b] = await Promise.all([
        prisma.user.findUnique({ where: { id: userA.id } }),
        prisma.user.findUnique({ where: { id: userB.id } }),
      ]);
      assert.strictEqual(a.firstName, 'Alice', 'A untouched');
      assert.strictEqual(b.firstName, 'MALLORY', 'only B changed');
      assert.strictEqual(b.role, 'USER', 'role not settable');
      assert.strictEqual(b.email, userB.email, 'email not settable');
      results.push('200  B PUT /api/auth/me/profile with A\'s id, role, email -> only B\'s name changed');
    });

    const C = await signIn(adminC.email, 'admin');

    await test('a chapter admin from another organization cannot touch A', async () => {
      refused(await C.get(`/api/admin/organization-members?organizationId=${orgA.id}`), 'C GET members of A\'s organization');
      refused(await C.put(`/api/admin/users/${userA.id}`, { firstName: 'HACKED' }), 'C PUT A\'s account');
      refused(await C.del(`/api/admin/users/${userA.id}`), 'C DELETE A\'s account');
    });

    await test('a chapter admin cannot move into A\'s organization through their own profile', async () => {
      await C.put('/api/auth/me/profile', { organizationId: orgA.id });
      refused(await C.get(`/api/admin/organization-members?organizationId=${orgA.id}`), 'C (after self-move) GET members of A\'s organization');
      refused(await C.put(`/api/admin/users/${userA.id}`, { firstName: 'HACKED' }), 'C (after self-move) PUT A\'s account');
      const a = await prisma.user.findUnique({ where: { id: userA.id } });
      assert.strictEqual(a.firstName, 'Alice', 'A untouched');
      const c = await prisma.user.findUnique({ where: { id: adminC.id } });
      assert.strictEqual(c.organizationId, orgC.id, 'C is still in their own organization');
    });

    await test('a member can still change their own organization', async () => {
      const r = await B.put('/api/auth/me/profile', { organizationId: orgC.id });
      assert.strictEqual(r.status, 200);
      const b = await prisma.user.findUnique({ where: { id: userB.id } });
      assert.strictEqual(b.organizationId, orgC.id, 'members choose their own organization as before');
      results.push('200  B PUT own organization (members may still change theirs)');
    });
  } finally {
    server.close();
    const ids = [userA.id, userB.id, adminC.id];
    await prisma.job.deleteMany({ where: { OR: ids.map((id) => ({ payload: { contains: `"userId":${id}` } })) } }).catch(() => {});
    await prisma.eventRegistration.deleteMany({ where: { eventId: event.id } }).catch(() => {});
    await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.2' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgC.id] } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    console.log('\nEvery cross-user attempt (status, attempt):');
    results.forEach((line) => console.log(`  ${line}`));
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
