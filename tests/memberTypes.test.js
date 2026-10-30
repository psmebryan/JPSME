// Event fees are tested separately (eventFees.test.js).
//
// Tests for the Master List's member types: their membership amount (the
// only membership fee; PayMongo's channel fee goes on top), the on/off switch, members choosing a type when they avail
// membership, and registrants picking an event's fee option.
//
// Runs the real app over HTTP against the dev database. No mail leaves the
// machine (the transport points at nothing; queued registration emails are
// removed). Online payment is switched off for the run, as it is on the live
// site, and put back as it was afterwards, so PayMongo is never called.

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
const paymentService = require('../src/services/payment.service');
const memberTypes = require('../src/services/memberType.service');
const organizationService = require('../src/services/organization.service');

const TAG = `__mt${Date.now()}`;
const PASSWORD = 'member-type-password-1';
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

async function rejects(fn, status, label) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert(caught, `${label}: expected an error`);
  assert.strictEqual(caught.statusCode, status, `${label}: expected ${status}, got ${caught.statusCode} (${caught.message})`);
}

let base;
let ipSeq = 0;
async function signIn(email, context = 'user') {
  ipSeq += 1;
  const ip = `198.51.100.${120 + ipSeq}`;
  const page = await fetch(`${base}${context === 'admin' ? '/admin/login' : '/login'}`, { headers: { 'X-Forwarded-For': ip } });
  let cookie = (page.headers.get('set-cookie') || '').split(';')[0];
  const token = ((await page.text()).match(/name="csrf-token" content="([^"]*)"/) || [])[1];
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': token, 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password: PASSWORD, context }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${email}: ${res.status} ${(await res.json()).message}`);
  cookie = (res.headers.get('set-cookie') || cookie).split(';')[0];
  const csrf = (await (await fetch(`${base}/api/csrf-token`, { headers: { Cookie: cookie, 'X-Forwarded-For': ip } })).json()).data.csrfToken;
  const call = async (method, p, body) => {
    const isForm = body instanceof FormData;
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
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

const regFor = (userId, eventId) => prisma.eventRegistration.findUnique({ where: { userId_eventId: { userId, eventId } } });

async function main() {
  const paymentsWere = await settingsService.getPaymentsEnabled();
  await settingsService.setPaymentsEnabled(false);
  const activeBefore = await prisma.memberType.count({ where: { isActive: true } });
  const createdTypeIds = [];
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const root = await prisma.organization.findFirst({ where: { parentId: null }, select: { id: true } });
  const org = await organizationService.createOrganization({ name: `${TAG} Org`, type: 'REGION', parentId: root.id });
  const event = await prisma.event.create({
    data: { title: `${TAG} Paid Event`, startDate: new Date(Date.now() + 7 * 864e5), isPublished: true, feeCentavos: 50000 },
  });
  const freeEvent = await prisma.event.create({
    data: { title: `${TAG} Free Event`, startDate: new Date(Date.now() + 7 * 864e5), isPublished: true },
  });
  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const alice = await makeUser('Alice', { organizationId: org.id });
  const bob = await makeUser('Bob', { organizationId: org.id });
  const chapterAdmin = await makeUser('Chapter', { role: 'CHAPTER_ADMIN', organizationId: org.id });

  try {
    let student;
    let regular;
    let offType;

    let renewal;
    let lifetime;

    await test('types carry amount, renewable and validity; the channel fee is PayMongo\'s; no limit on how many', async () => {
      student = await memberTypes.createMemberType({ name: `${TAG} Student`, membershipFee: '300', validityYears: '1' });
      regular = await memberTypes.createMemberType({ name: `${TAG} Regular`, membershipFee: '500', validityYears: '3' });
      renewal = await memberTypes.createMemberType({ name: `${TAG} Student - RENEWAL`, membershipFee: '250', renewable: true });
      lifetime = await memberTypes.createMemberType({ name: `${TAG} Life`, membershipFee: '14500', validityYears: 'lifetime' });
      offType = await memberTypes.createMemberType({ name: `${TAG} Off`, membershipFee: '100', isActive: false });
      createdTypeIds.push(student.id, regular.id, renewal.id, lifetime.id, offType.id);
      assert.strictEqual(student.membershipFeeCentavos, 30000);
      assert.strictEqual(student.channelFeeCentavos, await paymentService.calculateGatewaySurcharge(30000), 'channel fee follows the PayMongo rate');
      assert(student.channelFeeCentavos > 0);
      await rejects(() => memberTypes.createMemberType({ name: `${TAG} No amount`, membershipFee: '' }), 422, 'the amount is required');
      assert.strictEqual(regular.validityYears, 3);
      assert.strictEqual(renewal.renewable, true);
      assert.strictEqual(renewal.validityYears, 1, 'validity defaults to 1 year');
      assert.strictEqual(lifetime.validityYears, null, 'lifetime');
      assert(activeBefore + 4 > 3, 'more than three can be switched on at once');
      await rejects(() => memberTypes.createMemberType({ name: `${TAG} Student`, membershipFee: '300' }), 409, 'duplicate name');
      await rejects(() => memberTypes.updateMemberType(student.id, { membershipFee: '-5' }), 422, 'negative amount');
      assert.strictEqual((await memberTypes.updateMemberType(student.id, { validityYears: '4' })).validityYears, 4, 'any whole number of years');
      for (const bad of ['0', '100', '2.5', 'abc', '']) await rejects(() => memberTypes.updateMemberType(student.id, { validityYears: bad }), 422, `validity ${bad || 'empty'} refused`);
      await memberTypes.updateMemberType(student.id, { validityYears: '1' });
    });

    await test('first-timers see NEW rates, lapsed members see RENEWAL rates', async () => {
      const fresh = (await memberTypes.choicesFor('NONE')).map((t) => t.id);
      assert(fresh.includes(student.id) && fresh.includes(lifetime.id), 'NEW rates offered');
      assert(!fresh.includes(renewal.id), 'no RENEWAL rate for a first membership');
      assert(!fresh.includes(offType.id), 'switched-off type hidden');
      const lapsed = (await memberTypes.choicesFor('EXPIRED')).map((t) => t.id);
      assert(lapsed.includes(renewal.id) && !lapsed.includes(student.id), 'RENEWAL rates for a renewal');
    });

    await test('validity: the type sets how long a membership lasts, lifetime included', async () => {
      const membership = require('../src/services/membership.service');
      const from = new Date('2026-10-27T00:00:00Z');
      assert.strictEqual(membership.nextMembershipExpiry(null, from, 3).getUTCFullYear(), 2029, '3 years');
      assert.strictEqual(membership.nextMembershipExpiry(null, from).getUTCFullYear(), 2027, 'no type: 1 year');
      const life = membership.nextMembershipExpiry(null, from, null);
      assert(membership.isLifetime(life), 'lifetime');
      const status = membership.classifyMembership({ membershipExpiresAt: life }, null);
      assert.deepStrictEqual([status.state, status.lifetime], ['ACTIVE', true]);
    });

    await test('membership quote: the type\'s amount, PayMongo\'s fee on top; no type, nothing to pay yet', async () => {
      await prisma.user.update({ where: { id: alice.id }, data: { memberTypeId: student.id } });
      let q = await memberTypes.membershipQuote(alice.id);
      assert.strictEqual(q.amountCentavos, 30000);
      assert.strictEqual(q.channelFeeCentavos, await paymentService.calculateGatewaySurcharge(30000));
      assert.strictEqual(q.validityYears, 1);
      await prisma.user.update({ where: { id: alice.id }, data: { memberTypeId: null } });
      q = await memberTypes.membershipQuote(alice.id);
      assert.strictEqual(q.amountCentavos, null, 'no site-wide fee any more');
    });

    await test('membership checkout needs a member type picked first', async () => {
      await rejects(() => paymentService.createMembershipCheckout(alice.id), 422, 'no type picked');
      await prisma.user.update({ where: { id: alice.id }, data: { memberTypeId: student.id } });
      // Past the type check; stopped only because online payment is off here.
      await rejects(() => paymentService.createMembershipCheckout(alice.id), 503, 'type picked, payments off');
      await prisma.user.update({ where: { id: alice.id }, data: { memberTypeId: null } });
    });

    const A = await signIn(admin.email, 'admin');
    const Alice = await signIn(alice.email);
    const Bob = await signIn(bob.email);

    await test('a member picks a switched-on type on the membership page', async () => {
      let page = await Alice.get('/membership-payment');
      assert.strictEqual(page.status, 200);
      assert(page.text.includes('Choose your member type') && page.text.includes(`${TAG} Student`), 'choices shown');
      assert(!page.text.includes(`${TAG} Off`), 'a switched-off type is not offered');
      assert(!page.text.includes(`${TAG} Student - RENEWAL`), 'no RENEWAL rate for a first membership');

      let r = await Alice.put('/api/auth/me/member-type', { memberTypeId: offType.id });
      assert.strictEqual(r.status, 422, 'cannot pick a switched-off type');
      r = await Alice.put('/api/auth/me/member-type', { memberTypeId: student.id });
      assert.strictEqual(r.status, 200, `pick: ${r.status} ${r.json && r.json.message}`);
      assert.strictEqual(r.json.data.quote.amountCentavos, 30000);
      page = await Alice.get('/membership-payment');
      const at = page.text.indexOf('Registration Fee');
      const total = ((30000 + await paymentService.calculateGatewaySurcharge(30000)) / 100).toFixed(2);
      assert(page.text.includes(total), `fee shown is amount + PayMongo channel fee (${total}); page shows: ${page.text.slice(at, at + 400).replace(/\s+/g, ' ')}`);
      assert(page.text.includes('PayMongo channel fee'), 'labelled as PayMongo\'s channel fee');
    });

    await test('the type is locked while a membership year is running', async () => {
      await prisma.user.update({ where: { id: alice.id }, data: { membershipExpiresAt: new Date(Date.now() + 30 * 864e5) } });
      const r = await Alice.put('/api/auth/me/member-type', { memberTypeId: regular.id });
      assert.strictEqual(r.status, 409);
      await prisma.user.update({ where: { id: alice.id }, data: { membershipExpiresAt: null } });
    });

    await test('admins assign any type (on or off); chapter admins and members cannot manage types', async () => {
      let r = await A.put(`/api/admin/users/${bob.id}`, { memberTypeId: String(offType.id) });
      assert.strictEqual(r.status, 200, 'admin may set a switched-off type');
      assert.strictEqual((await prisma.user.findUnique({ where: { id: bob.id } })).memberTypeId, offType.id);
      const C = await signIn(chapterAdmin.email, 'admin');
      r = await C.put(`/api/admin/users/${alice.id}`, { memberTypeId: String(regular.id), firstName: 'Alice' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await prisma.user.findUnique({ where: { id: alice.id } })).memberTypeId, student.id, 'chapter admin cannot change it');
      assert.strictEqual((await Bob.get('/api/admin/member-types')).status, 403);
      assert.strictEqual((await Bob.put(`/api/admin/member-types/${student.id}`, { membershipFee: '0' })).status, 403);
      r = await A.put(`/api/admin/member-types/${student.id}`, { membershipFee: '320' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.data.memberType.membershipFeeCentavos, 32000, 'admin edits the amount');
      await A.put(`/api/admin/member-types/${student.id}`, { membershipFee: '300' });
    });

    await test('the users list filters by member type, or by no type (non-member / guest)', async () => {
      const ids = async (q) => {
        const r = await A.get(`/api/admin/members?search=${encodeURIComponent(TAG)}&${q}`);
        assert.strictEqual(r.status, 200, `${q}: ${r.status} ${r.json && r.json.message}`);
        return r.json.data.users.map((u) => u.id).sort();
      };
      assert.deepStrictEqual(await ids(`memberType=${offType.id}`), [bob.id], 'by a type');
      assert.deepStrictEqual(await ids(`memberType=${student.id}`), [alice.id], 'by another type');
      const none = await ids('memberType=NONE');
      assert(none.includes(chapterAdmin.id) && !none.includes(alice.id) && !none.includes(bob.id), 'no type');
      assert.strictEqual((await A.get('/api/admin/members?memberType=abc')).status, 422, 'bad value refused');
      const page = await A.get('/admin/users/all');
      assert(page.text.includes('name="memberType"') && page.text.includes('Non-Member / Guest'), 'filter on the page');
    });

    await test('the admin and member pages render', async () => {
      for (const p of ['/admin/master/member-types', `/admin/users/${bob.id}/edit`, '/admin/events/new',
        `/admin/events/${event.id}/edit`, `/admin/events/${event.id}/registrations`]) {
        const r = await A.get(p);
        assert.strictEqual(r.status, 200, `${p} rendered ${r.status}`);
      }
      const ml = await A.get('/admin/master/member-types');
      assert(['Add Member Type', 'Search member types', 'data-toggle-active', 'Channel fee', 'Lifetime', `${TAG} Student - RENEWAL`].every((x) => ml.text.includes(x)), 'member type master shows the add button, search, toggles, validity and rows');
    });

    await test('removing a type clears it from the members who had it', async () => {
      await memberTypes.deleteMemberType(student.id);
      createdTypeIds.splice(createdTypeIds.indexOf(student.id), 1);
      assert.strictEqual((await prisma.user.findUnique({ where: { id: alice.id } })).memberTypeId, null);
    });
  } finally {
    server.close();
    await settingsService.setPaymentsEnabled(paymentsWere);
    const userIds = [admin.id, alice.id, bob.id, chapterAdmin.id];
    await prisma.job.deleteMany({ where: { OR: userIds.map((id) => ({ payload: { contains: `"userId":${id}` } })) } }).catch(() => {});
    // On a database whose seats table is damaged, deleting registrations is
    // refused (see the test notes); that leaves these rows, harmlessly.
    await prisma.eventRegistration.deleteMany({ where: { eventId: { in: [event.id, freeEvent.id] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: [event.id, freeEvent.id] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: userIds } }, { actorId: { in: userIds } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.1' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.memberType.deleteMany({ where: { id: { in: createdTypeIds } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
