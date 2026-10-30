// Tests for per-event registration fee options (Master List -> Event Fee).
//
// Each event keeps its own options (e.g. Student PHP 300, Professional PHP 800)
// with an Active switch; a registrant must pick one of the event's active
// options, and the option and fee are recorded. An event with none charges its
// single fee. Separate from member types, and not shared between events.
//
// Runs the real app over HTTP against the dev database. No mail leaves the
// machine, and online payment is switched off for the run (as on the live
// site) and put back afterwards, so PayMongo is never called.

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
const eventFees = require('../src/services/eventFee.service');

const TAG = `__ef${Date.now()}`;
const PASSWORD = 'event-fee-password-1';
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
  const ip = `198.51.100.${160 + ipSeq}`;
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

const regFor = (userId, eventId) => prisma.eventRegistration.findUnique({ where: { userId_eventId: { userId, eventId } } });

async function main() {
  const paymentsWere = await settingsService.getPaymentsEnabled();
  await settingsService.setPaymentsEnabled(false);
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const event = await prisma.event.create({
    data: { title: `${TAG} Convention`, startDate: new Date(Date.now() + 7 * 864e5), isPublished: true, feeCentavos: 50000 },
  });
  const otherEvent = await prisma.event.create({
    data: { title: `${TAG} Seminar`, startDate: new Date(Date.now() + 9 * 864e5), isPublished: true, feeCentavos: 20000 },
  });
  const memberEvent = await prisma.event.create({
    data: { title: `${TAG} Members Night`, startDate: new Date(Date.now() + 11 * 864e5), isPublished: true, feeCentavos: 0 },
  });
  const admin = await makeUser('Admin', { role: 'ADMIN' });
  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');
  const carol = await makeUser('Carol', { membershipExpiresAt: new Date(Date.now() + 200 * 864e5) });
  const opts = `/api/admin/event-fees/${event.id}/options`;

  try {
    const A = await signIn(admin.email, 'admin');
    let student;
    let pro;
    let early;

    await test('an event gets its own fee options: name, amount, PayMongo channel fee', async () => {
      let r = await A.post(opts, { name: 'Student', fee: '300' });
      assert.strictEqual(r.status, 201, `add: ${r.status} ${r.json && r.json.message}`);
      student = r.json.data.option;
      assert.deepStrictEqual([student.name, student.feeCentavos, student.isActive], ['Student', 30000, true]);
      assert.strictEqual(student.channelFeeCentavos, await paymentService.calculateGatewaySurcharge(30000));
      pro = (await A.post(opts, { name: 'Professional', fee: '800' })).json.data.option;
      early = (await A.post(opts, { name: 'Early Bird', fee: '250', isActive: false })).json.data.option;
      assert.strictEqual((await A.post(opts, { name: 'Student', fee: '1' })).status, 409, 'unique within the event');
      assert.strictEqual((await A.post(opts, { name: 'X', fee: '' })).status, 422, 'amount required');
      assert.strictEqual((await A.post(opts, { name: '', fee: '1' })).status, 422, 'name required');
      assert.strictEqual((await A.post('/api/admin/event-fees/999999999/options', { name: 'X', fee: '1' })).status, 404, 'unknown event');
    });

    await test('options belong to one event only', async () => {
      const other = await A.post(`/api/admin/event-fees/${otherEvent.id}/options`, { name: 'Student', fee: '150' });
      assert.strictEqual(other.status, 201, 'the same name is fine on another event');
      assert.strictEqual((await A.put(`/api/admin/event-fees/${otherEvent.id}/options/${student.id}`, { fee: '1' })).status, 404, 'cannot edit another event\'s option');
      assert.deepStrictEqual((await eventFees.listOptions(otherEvent.id)).map((o) => [o.name, o.feeCentavos]), [['Student', 15000]]);
      await A.del(`/api/admin/event-fees/${otherEvent.id}/options/${other.json.data.option.id}`);
    });

    await test('edit an option; an inactive one is hidden from registrants', async () => {
      const r = await A.put(`${opts}/${pro.id}`, { name: 'Professional', fee: '750' });
      assert.strictEqual(r.json.data.option.feeCentavos, 75000);
      assert.deepStrictEqual((await eventFees.listEventOptions(event)).map((o) => [o.label, o.feeCentavos]),
        [['Student', 30000], ['Professional', 75000]], 'Early Bird is off');
    });

    const Alice = await signIn(alice.email);
    const Bob = await signIn(bob.email);
    const Carol = await signIn(carol.email);

    await test('the event page lists the options and asks for a pick', async () => {
      const page = await Bob.get(`/events/${event.id}`);
      assert(page.text.includes('Choose your registration option'), 'asks for a pick');
      assert(page.text.includes('Professional') && page.text.includes('750.00'), 'options listed');
      assert(!page.text.includes('Early Bird'), 'inactive option hidden');
      assert(!page.text.includes('Everyone else'), 'no standard-fee option');
    });

    await test('registering needs a valid pick and records the option and fee', async () => {
      assert.strictEqual((await Bob.post(`/api/events/${event.id}/register`, {})).status, 422, 'no pick');
      assert.strictEqual((await Bob.post(`/api/events/${event.id}/register`, { feeOption: String(early.id) })).status, 422, 'inactive option');
      const r = await Bob.post(`/api/events/${event.id}/register`, { feeOption: String(pro.id) });
      assert.strictEqual(r.status, 201, `register: ${r.status} ${r.json && r.json.message}`);
      assert(/PHP 750\.00 \(Professional\)/.test(r.json.message), `tells them their fee: ${r.json.message}`);
      const reg = await regFor(bob.id, event.id);
      assert.deepStrictEqual([reg.status, reg.feeCentavos, reg.feeOptionName], ['REGISTERED', 75000, 'Professional']);
    });

    await test('an event with no options charges its single fee, no pick needed', async () => {
      const r = await Alice.post(`/api/events/${otherEvent.id}/register`, {});
      assert.strictEqual(r.status, 201, `register: ${r.status} ${r.json && r.json.message}`);
      const reg = await regFor(alice.id, otherEvent.id);
      assert.deepStrictEqual([reg.feeCentavos, reg.feeOptionName], [20000, null]);
    });

    await test('the Event Fee master lists events with their option counts; members are kept out', async () => {
      const master = await A.get('/admin/master/event-fees');
      assert.strictEqual(master.status, 200);
      const at = master.text.indexOf(`${TAG} Convention`);
      assert(at > 0, 'event listed');
      assert(/data-option-count>2</.test(master.text.slice(at, at + 3000).replace(/\s+/g, '')), 'two active options counted');
      assert(master.text.includes('Event Fee Master'));
      const newer = master.text.indexOf(`${TAG} Seminar`);
      assert(newer > 0 && newer < at, 'newest created first (the Seminar was created after the Convention)');
      const edit = await A.get(`/admin/events/${event.id}/edit`);
      assert(edit.text.includes('Registration fee options') && edit.text.includes(`/admin/master/event-fees?event=${event.id}`), 'edit page links to them');
      const regs = await A.get(`/admin/events/${event.id}/registrations`);
      assert(regs.text.includes('Professional'), 'registrations list shows the option');
      assert.strictEqual((await Bob.get(opts)).status, 403);
      assert.strictEqual((await Bob.post(opts, { name: 'Hack', fee: '0' })).status, 403);
    });

    await test('members-only and non-members-only options: each sees and pays their own price', async () => {
      const ev = memberEvent;
      const mo = `/api/admin/event-fees/${ev.id}/options`;
      const member = (await A.post(mo, { name: 'Member', fee: '300', audience: 'MEMBERS' })).json.data.option;
      const nonMember = (await A.post(mo, { name: 'Non-Member', fee: '800', audience: 'NON_MEMBERS' })).json.data.option;
      assert.deepStrictEqual([member.audience, nonMember.audience], ['MEMBERS', 'NON_MEMBERS']);
      assert.strictEqual((await A.post(mo, { name: 'Bad', fee: '1', audience: 'VIP' })).status, 422, 'unknown audience');

      // Carol has an active membership, Bob does not.
      const carolPage = await Carol.get(`/events/${ev.id}`);
      assert(/value="\d+"\s*disabled/.test(carolPage.text), 'the non-member option is disabled for a member');
      assert.strictEqual((await Carol.post(`/api/events/${ev.id}/register`, { feeOption: String(nonMember.id) })).status, 422, 'member cannot take the non-member price');
      assert.strictEqual((await Bob.post(`/api/events/${ev.id}/register`, { feeOption: String(member.id) })).status, 422, 'non-member cannot take the member price');
      assert.strictEqual((await Carol.post(`/api/events/${ev.id}/register`, { feeOption: String(member.id) })).status, 201);
      assert.strictEqual((await Bob.post(`/api/events/${ev.id}/register`, { feeOption: String(nonMember.id) })).status, 201);
      assert.deepStrictEqual([(await regFor(carol.id, ev.id)).feeCentavos, (await regFor(bob.id, ev.id)).feeCentavos], [30000, 80000]);

      // Members only, entirely: a non-member is told to become one.
      await A.put(`${mo}/${nonMember.id}`, { isActive: false });
      const r = await Alice.post(`/api/events/${ev.id}/register`, { feeOption: String(member.id) });
      assert.strictEqual(r.status, 403);
      assert(/members only/i.test(r.json.message), r.json.message);
    });

    await test('removing an option: registrations keep what they recorded', async () => {
      assert.strictEqual((await A.del(`${opts}/${pro.id}`)).status, 200);
      assert.strictEqual((await regFor(bob.id, event.id)).feeOptionName, 'Professional');
      assert.deepStrictEqual((await eventFees.listOptions(event.id)).map((o) => o.name), ['Student', 'Early Bird']);
    });
  } finally {
    server.close();
    await settingsService.setPaymentsEnabled(paymentsWere);
    const userIds = [admin.id, alice.id, bob.id, carol.id];
    await prisma.job.deleteMany({ where: { OR: userIds.map((id) => ({ payload: { contains: `"userId":${id}` } })) } }).catch(() => {});
    // On a database whose seats table is damaged, deleting registrations is
    // refused; that leaves these rows, harmlessly.
    await prisma.eventRegistration.deleteMany({ where: { eventId: { in: [event.id, otherEvent.id, memberEvent.id] } } }).catch(() => {});
    await prisma.eventFeeOption.deleteMany({ where: { eventId: { in: [event.id, otherEvent.id, memberEvent.id] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: [event.id, otherEvent.id, memberEvent.id] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: userIds } }, { actorId: { in: userIds } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.16' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
