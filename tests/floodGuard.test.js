// The flood guard (src/middleware/floodGuard.middleware.js): an IP over the
// limit is blocked for a while, others are not; static files, the allowlist
// and Cloudflare's real-visitor header behave; a main admin can lift a block.
// Limits are lowered for the run. Tagged rows only, removed afterwards.

require('dotenv').config();
process.env.TRUST_PROXY = 'true';
process.env.EMAIL_PROVIDER = 'smtp';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '1';
process.env.BREVO_API_KEY = '';
process.env.FLOOD_GUARD = 'on';
process.env.FLOOD_MAX_REQUESTS = '20';
process.env.FLOOD_WINDOW_SECONDS = '30';
process.env.FLOOD_BLOCK_MINUTES = '5';
process.env.FLOOD_ALLOWLIST = '192.0.2.240';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const prisma = require('../src/config/prisma');

const TAG = `__fg${Date.now()}`;
const PASSWORD = 'flood-guard-password-1';
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
const hit = (p, ip, headers = {}) => fetch(`${base}${p}`, { headers: { 'X-Forwarded-For': ip, ...headers } });
async function burst(n, p, ip, headers) {
  const statuses = [];
  for (let i = 0; i < n; i += 1) {
    const r = await hit(p, ip, typeof headers === 'function' ? headers(i) : headers);
    await r.arrayBuffer();
    statuses.push(r.status);
  }
  return statuses;
}

async function signIn(email, context, ip) {
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
      method, headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text };
  };
}

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
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
    await test('an IP over the limit is blocked, with Retry-After; another IP is not', async () => {
      const s = await burst(20, '/api/csrf-token', '192.0.2.241');
      assert(s.every((x) => x === 200), s.join(','));
      const over = await hit('/api/csrf-token', '192.0.2.241');
      assert.strictEqual(over.status, 429);
      assert(Number(over.headers.get('retry-after')) > 200, 'about 5 minutes');
      assert.match((await over.json()).message, /Too many requests/);
      const page = await hit('/', '192.0.2.241', { Accept: 'text/html' });
      assert.strictEqual(page.status, 429, 'pages too while blocked');
      assert.match(await page.text(), /<h1[^>]*>Too many requests/);
      assert.strictEqual((await hit('/api/csrf-token', '192.0.2.242')).status, 200, 'someone else is fine');
    });

    await test('static files do not count; the allowlist is never blocked', async () => {
      const css = await burst(40, '/css/tailwind.css', '192.0.2.243');
      assert(css.every((x) => x === 200 || x === 304), css.join(','));
      assert.strictEqual((await hit('/api/csrf-token', '192.0.2.243')).status, 200);
      const allowed = await burst(40, '/api/csrf-token', '192.0.2.240');
      assert(allowed.every((x) => x === 200), allowed.join(','));
    });

    await test('through Cloudflare the visitor is counted, not the edge; the header is ignored from elsewhere', async () => {
      // Different Cloudflare edges, one visitor: blocked together.
      const viaCf = await burst(21, '/api/csrf-token', '', (i) => ({ 'X-Forwarded-For': `104.16.0.${i + 1}`, 'CF-Connecting-IP': '203.0.113.77' }));
      assert.strictEqual(viaCf.at(-1), 429, viaCf.join(','));
      // The same edge, a different visitor: fine.
      assert.strictEqual((await hit('/api/csrf-token', '104.16.0.1', { 'CF-Connecting-IP': '203.0.113.78' })).status, 200);
      // Not from Cloudflare: a made-up header changes nothing, so it cannot dodge the block.
      const spoof = await burst(21, '/api/csrf-token', '192.0.2.244', (i) => ({ 'CF-Connecting-IP': `198.51.100.${i + 1}` }));
      assert.strictEqual(spoof.at(-1), 429, spoof.join(','));
    });

    await test('a main admin sees the block in Settings and lifts it; a member cannot', async () => {
      const Ad = await signIn(admin.email, 'admin', '192.0.2.240');
      const settings = await Ad('GET', '/jpsme_admin/settings');
      assert.strictEqual(settings.status, 200);
      assert(settings.text.includes('data-blocked-ip="192.0.2.241"'));
      assert(settings.text.includes('<strong>20</strong> requests in <strong>30 seconds</strong>'));
      const M = await signIn(member.email, 'user', '192.0.2.246');
      const refused = await M('POST', '/api/admin/settings/blocked-ips/unblock', { ip: '192.0.2.241' });
      assert([401, 403, 404].includes(refused.status), `member got ${refused.status}`);
      assert.strictEqual((await Ad('POST', '/api/admin/settings/blocked-ips/unblock', { ip: 'nonsense' })).status, 422);
      const r = await Ad('POST', '/api/admin/settings/blocked-ips/unblock', { ip: '192.0.2.241' });
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.strictEqual(r.json.data.lifted, true);
      assert(!r.json.data.blocked.some((b) => b.ip === '192.0.2.241'));
      assert.strictEqual((await hit('/api/csrf-token', '192.0.2.241')).status, 200, 'back in');
    });
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { in: ['192.0.2.240', '192.0.2.246'] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch((e) => console.error(e.message));
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
