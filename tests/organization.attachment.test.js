// End-to-end check that the organization a member picks at registration is
// actually persisted on their account, readable back everywhere it matters,
// and frozen onto an event registration. Run against a live dev server.
const http = require('http');
const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const organizationService = require('../src/services/organization.service');

const EMAIL = 'attachcheck@dummy.test';
let cookies = {};

function jar() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 3000, path, method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: jar(),
        ...(cookies['jpsme.csrf'] ? { 'X-CSRF-Token': decodeURIComponent(cookies['jpsme.csrf']) } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      (res.headers['set-cookie'] || []).forEach((c) => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies[pair.slice(0, i)] = pair.slice(i + 1);
      });
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function csrf() {
  const r = await req('GET', '/api/csrf-token');
  const t = JSON.parse(r.body).data.csrfToken;
  cookies['jpsme.csrf'] = encodeURIComponent(t);
  return t;
}

// Registration is behind a human check, so a test that posts nothing is
// correctly refused with HUMAN_CHECK_FAILED — which is what this file started
// doing the moment that check was added, long before anybody noticed.
//
// Rather than bypass it, this seeds a challenge whose answer is known and then
// answers it. The endpoint, the middleware and challenge.verify all run exactly
// as they do for a real visitor; the only thing arranged is which five letters
// the image would have shown. Only the hash is ever stored on the session (the
// plaintext is never persisted anywhere), and it is an unsalted SHA-256 of the
// uppercased text — so a test with database access can write a known one.
const KNOWN_ANSWER = 'ABCDE';

async function seedChallenge() {
  // Issue a real one first, so the session row exists and carries whatever
  // express-session already put there. Then swap the hash for a known one.
  await req('GET', '/api/captcha');

  // 's:<sid>.<signature>' — express-session signs the cookie; the store is
  // keyed by the bare sid.
  const raw = decodeURIComponent(cookies['jpsme.sid'] || '');
  const sid = raw.startsWith('s:') ? raw.slice(2).split('.')[0] : raw;
  if (!sid) throw new Error('no session cookie to seed a challenge on');

  const rows = await prisma.$queryRawUnsafe('SELECT data FROM sessions WHERE session_id = ?', sid);
  if (!rows.length) throw new Error(`no session row for ${sid}`);

  const data = JSON.parse(rows[0].data);
  data.challenge = {
    hash: crypto.createHash('sha256').update(KNOWN_ANSWER).digest('hex'),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  await prisma.$executeRawUnsafe('UPDATE sessions SET data = ? WHERE session_id = ?', JSON.stringify(data), sid);
}

const pass = [];
const fail = [];
function check(label, ok, detail) {
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // Clean slate
  await prisma.eventRegistration.deleteMany({ where: { user: { email: EMAIL } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  // Prefer a unit nested under a province so the path has something to
  // resolve, but fall back to any organization at all — the point of this test
  // is that the chosen organization sticks, not how deep it sits.
  const chosen = await prisma.organization.findFirst({
    where: { type: 'STUDENT_UNIT', parent: { type: 'PROVINCE' } },
    select: { id: true, name: true },
  }) || await prisma.organization.findFirst({ select: { id: true, name: true } });

  if (!chosen) {
    console.log('No organizations exist — nothing to attach a member to. Skipping.');
    console.log('Create at least one organization (Admin → Organizations → Structure) and re-run.');
    await prisma.$disconnect();
    process.exit(0);
  }
  const chosenPath = await organizationService.getOrganizationPathLabel(chosen.id);
  console.log(`Member will choose: ${chosen.name} (id ${chosen.id})`);
  console.log(`Full path:          ${chosenPath}\n`);

  console.log('1. REGISTRATION');
  await csrf();
  await seedChallenge();
  const reg = await req('POST', '/api/auth/register', {
    firstName: 'Attach', lastName: 'Check', email: EMAIL,
    password: 'TestPass123', organizationId: chosen.id,
    challengeAnswer: KNOWN_ANSWER,
  });
  const regBody = JSON.parse(reg.body);
  check('registration accepted', reg.status === 201, `http ${reg.status}`);
  check('response carries the organizationId', regBody.data.user.organizationId === chosen.id);
  check('response resolves the organization object', regBody.data.user.organization?.name === chosen.name);

  console.log('\n2. PERSISTED IN THE DATABASE');
  const stored = await prisma.user.findUnique({
    where: { email: EMAIL },
    include: { organization: true },
  });
  check('user row has organizationId', stored.organizationId === chosen.id, `stored ${stored.organizationId}`);
  check('foreign key resolves to the right row', stored.organization?.id === chosen.id, stored.organization?.name);
  check('ancestor path resolves from the member', (await organizationService.getOrganizationPathLabel(stored.organizationId)) === chosenPath);

  console.log('\n3. READ BACK AFTER LOGIN');
  await prisma.user.update({ where: { id: stored.id }, data: { status: 'APPROVED', emailVerifiedAt: new Date() } });
  cookies = {};
  await csrf();
  const login = await req('POST', '/api/auth/login', { email: EMAIL, password: 'TestPass123' });
  const loginBody = JSON.parse(login.body);
  check('login succeeds', login.status === 200, `http ${login.status}`);
  check('session user carries organizationId', loginBody.data.user.organizationId === chosen.id);
  const profile = await req('GET', '/profile');
  check('profile page renders', profile.status === 200, `http ${profile.status}`);
  check('profile page shows the organization name', profile.body.includes(chosen.name));

  console.log('\n4. VISIBLE TO ADMIN');
  const adminCookies = {};
  const saved = cookies; cookies = adminCookies;
  await csrf();
  await req('POST', '/api/auth/login', { email: 'admin@jpsme.local', password: 'ChangeMe123!', context: 'admin' });
  const members = await req('GET', '/api/admin/members?search=attachcheck');
  const found = JSON.parse(members.body).data.users.find((u) => u.email === EMAIL);
  check('appears in the admin member list', !!found);
  check('admin list shows their organization', found?.organization?.name === chosen.name, found?.organization?.name);
  const scoped = await req('GET', `/api/admin/members?organizationId=${chosen.id}`);
  const inFilter = JSON.parse(scoped.body).data.users.some((u) => u.email === EMAIL);
  check('filtering by that organization returns them', inFilter);
  cookies = saved;

  console.log('\n5. FROZEN ONTO AN EVENT REGISTRATION');
  const event = await prisma.event.create({
    data: { title: 'ATTACHCHECK Event', startDate: new Date(Date.now() + 864e5), isPublished: true },
  });
  const registrationService = require('../src/services/registration.service');
  const fresh = await prisma.user.findUnique({ where: { id: stored.id } });
  const evReg = await registrationService.registerForEvent(fresh, event.id);
  check('registration captured organizationId', evReg.organizationId === chosen.id);
  check('registration captured the path label', evReg.organizationPath === chosenPath, evReg.organizationPath);

  console.log('\n6. SURVIVES THE MEMBER MOVING ELSEWHERE');
  // Any organization other than the one they registered with — the assertion
  // is that moving breaks the link to the *original*, so which one they move
  // to does not matter.
  const other = await prisma.organization.findFirst({
    where: { id: { not: chosen.id } },
    select: { id: true, name: true },
  });
  if (!other) {
    console.log('  SKIP  only one organization exists, nothing to move the member to');
    await prisma.eventRegistration.deleteMany({ where: { eventId: event.id } });
    await prisma.job.deleteMany({ where: { type: 'SEND_EVENT_REGISTRATION_EMAIL' } });
    await prisma.event.delete({ where: { id: event.id } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    console.log(`\n${pass.length} passed, ${fail.length} failed`);
    await prisma.$disconnect();
    process.exit(fail.length ? 1 : 0);
  }
  await prisma.user.update({ where: { id: stored.id }, data: { organizationId: other.id } });
  const after = await prisma.eventRegistration.findUnique({ where: { id: evReg.id } });
  const nowUser = await prisma.user.findUnique({ where: { id: stored.id } });
  check('member now points at the new organization', nowUser.organizationId === other.id, other.name);
  check('past registration still shows the original', after.organizationId === chosen.id && after.organizationPath === chosenPath);

  // Cleanup
  await prisma.eventRegistration.deleteMany({ where: { eventId: event.id } });
  await prisma.job.deleteMany({ where: { type: 'SEND_EVENT_REGISTRATION_EMAIL' } });
  await prisma.event.delete({ where: { id: event.id } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });

  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  if (fail.length) fail.forEach((f) => console.log('  FAILED: ' + f));
  await prisma.$disconnect();
  process.exit(fail.length ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e.message); await prisma.$disconnect(); process.exit(1); });
