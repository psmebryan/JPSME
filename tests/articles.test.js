// Tests for Articles: the admin editor (summary, publish date, link, cover,
// gallery add / remove / reorder), the safe text formatting, and the public
// News pages (landing sections, View All, category, year, search, the article
// page with its gallery and Explore More).
//
// Runs the real app over HTTP against the dev database. Uploaded test images
// are tiny generated PNGs and are deleted with their articles.

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
const storage = require('../src/services/storage.service');
const { render, excerpt } = require('../src/utils/articleFormat');

const TAG = `__ar${Date.now()}`;
const PASSWORD = 'articles-password-1';
// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
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
  const ip = `198.51.100.${120 + ipSeq}`;
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
  return async (method, p, bodyData) => {
    const isForm = bodyData instanceof FormData;
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Forwarded-For': ip, ...(bodyData && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: bodyData ? (isForm ? bodyData : JSON.stringify(bodyData)) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, json, text };
  };
}

function form(fields, files = {}) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  Object.entries(files).forEach(([k, list]) => list.forEach((buf, i) => fd.append(k, new Blob([buf], { type: 'image/png' }), `${k}${i}.png`)));
  return fd;
}

const page = async (p) => (await fetch(`${base}${p}`)).text();

async function main() {
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await prisma.user.create({
    data: {
      firstName: 'Admin', lastName: TAG, email: `${TAG}-admin@example.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role: 'ADMIN', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  const member = await prisma.user.create({
    data: {
      firstName: 'Member', lastName: TAG, email: `${TAG}-member@example.invalid`, password: await bcrypt.hash(PASSWORD, 4),
      role: 'USER', status: 'APPROVED', emailVerifiedAt: new Date(), passwordSetAt: new Date(),
    },
  });
  const made = [];

  try {
    await test('formatting is escaped first: marks become HTML, tags and bad links do not', () => {
      const html = render('# Head\n**b** *i* https://ex.org/a?b=1&c=2\n- one\n<img src=x onerror=alert(1)>\n[x](javascript:alert(1))');
      assert(html.includes('<h2>Head</h2>') && html.includes('<strong>b</strong>') && html.includes('<em>i</em>'));
      assert(html.includes('href="https://ex.org/a?b=1&amp;c=2"') && html.includes('rel="noopener noreferrer"'));
      assert(html.includes('<ul><li>one</li></ul>'));
      assert(html.includes('&lt;img') && !/<img/.test(html), 'tags stay text');
      assert(!/href="javascript/i.test(html), 'javascript: links refused');
      assert.strictEqual(render('line one\nline two'), '<p>line one<br>line two</p>', 'old plain text reads the same');
      assert.strictEqual(excerpt('# T\n**Bold** [x](https://a.b)'), 'T Bold x');
    });

    const call = await signIn(admin.email, 'admin');
    let circular;
    let newsletter;

    await test('admin creates an article with summary, date, link, cover and gallery', async () => {
      const r = await call('POST', '/api/articles', form({
        title: `${TAG} Circular One`, category: `${TAG} Circulars`, authorName: 'National Board', summary: 'Short teaser.',
        body: '# Awards\nNominate **now**.', linkUrl: 'https://heyzine.com/flip-book/x.html', linkLabel: 'Read the full newsletter',
        publishedAt: '2024-11-26', isPublished: 'true',
      }, { image: [PNG], gallery: [PNG, PNG, PNG] }));
      assert.strictEqual(r.status, 201, `${r.status} ${r.text.slice(0, 200)}`);
      circular = await prisma.article.findUnique({ where: { id: r.json.data.article.id }, include: { images: { orderBy: { sortOrder: 'asc' } } } });
      made.push(circular.id);
      assert.strictEqual(circular.images.length, 3);
      assert(circular.coverImage && await storage.exists(circular.coverImage), 'cover saved');
      assert.strictEqual(circular.publishedAt.toISOString().slice(0, 10), '2024-11-26', 'own date kept');
      assert.strictEqual(circular.linkUrl, 'https://heyzine.com/flip-book/x.html');

      newsletter = (await call('POST', '/api/articles', form({
        title: `${TAG} Newsletter Q2`, category: `${TAG} Newsletters`, body: 'Plain text\nsecond line', isPublished: 'true',
      }))).json.data.article;
      made.push(newsletter.id);
      const draft = (await call('POST', '/api/articles', form({ title: `${TAG} Draft`, category: `${TAG} Circulars`, body: 'secret draft', isPublished: 'false' }))).json.data.article;
      made.push(draft.id);
    });

    await test('bad input is refused: link scheme, date, non-images, too many photos', async () => {
      assert.strictEqual((await call('POST', '/api/articles', form({ title: 'x', body: 'y', linkUrl: 'javascript:alert(1)' }))).status, 422);
      assert.strictEqual((await call('POST', '/api/articles', form({ title: 'x', body: 'y', publishedAt: 'yesterday' }))).status, 422);
      const notImage = new FormData();
      notImage.append('title', 'x'); notImage.append('body', 'y');
      notImage.append('gallery', new Blob(['<script>'], { type: 'image/png' }), 'evil.png');
      assert.strictEqual((await call('POST', '/api/articles', notImage)).status, 400, 'bytes are checked');
      assert.strictEqual((await call('POST', '/api/articles', form({ title: 'x', body: 'y' }, { gallery: Array(13).fill(PNG) }))).status, 400);
    });

    await test('edit: remove one photo, reorder, add one, change the date', async () => {
      const [p1, p2, p3] = circular.images;
      const r = await call('PUT', `/api/articles/${circular.id}`, form({
        title: `${TAG} Circular One`, category: `${TAG} Circulars`, body: '# Awards\nNominate **now**.', isPublished: 'true',
        removeImageIds: String(p2.id), imageOrder: `${p3.id},${p1.id}`, publishedAt: '2025-01-15',
        linkUrl: 'https://heyzine.com/flip-book/x.html', linkLabel: 'Read the full newsletter', summary: 'Short teaser.',
      }, { gallery: [PNG] }));
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      const after = await prisma.articleImage.findMany({ where: { articleId: circular.id }, orderBy: { sortOrder: 'asc' } });
      assert.deepStrictEqual(after.slice(0, 2).map((i) => i.id), [p3.id, p1.id]);
      assert.strictEqual(after.length, 3);
      assert(!(await storage.exists(p2.url)), 'removed photo file deleted');
      const art = await prisma.article.findUnique({ where: { id: circular.id } });
      assert.strictEqual(art.publishedAt.toISOString().slice(0, 10), '2025-01-15');
    });

    await test('editor preview uses the same formatter; members cannot use it', async () => {
      const r = await call('POST', '/api/articles/preview', { body: '## Hi\n<b>x</b>' });
      assert.strictEqual(r.json.data.html, '<h3>Hi</h3>\n<p>&lt;b&gt;x&lt;/b&gt;</p>');
      const m = await signIn(member.email);
      assert.notStrictEqual((await m('POST', '/api/articles/preview', { body: 'x' })).status, 200);
      assert.notStrictEqual((await m('POST', '/api/articles', form({ title: 'x', body: 'y' }))).status, 201);
    });

    await test('News landing: a section per category, View All, By Year', async () => {
      const html = await page('/articles');
      assert(html.includes(`data-news-section="${TAG} Circulars"`) && html.includes(`data-news-section="${TAG} Newsletters"`));
      assert(html.includes('View All') && html.includes('data-news-years') && html.includes('/articles?year=2025'));
      assert(!html.includes(`${TAG} Draft`), 'drafts never shown');
      assert((await page('/articles?view=all')).includes('Short teaser.'), 'summary used as the teaser');
    });

    await test('View All, category, year and search lists', async () => {
      assert((await page('/articles?view=all')).includes(`${TAG} Newsletter Q2`));
      const cat = await page(`/articles?category=${encodeURIComponent(`${TAG} Circulars`)}`);
      assert(cat.includes(`${TAG} Circular One`) && !cat.includes(`${TAG} Newsletter Q2`) && !cat.includes(`${TAG} Draft`));
      const year = await page('/articles?year=2025');
      assert(year.includes(`${TAG} Circular One`) && year.includes('News from 2025'));
      const search = await page(`/articles?q=${encodeURIComponent(`${TAG} newsletter`)}`);
      assert(search.includes(`${TAG} Newsletter Q2`) && !search.includes(`${TAG} Circular One`));
    });

    await test('article page: formatted body, link button, gallery, Explore More', async () => {
      const html = await page(`/articles/${circular.id}`);
      assert(html.includes('<h2>Awards</h2>') && html.includes('<strong>now</strong>'));
      assert(html.includes('data-article-link') && html.includes('Read the full newsletter') && html.includes('href="https://heyzine.com/flip-book/x.html"'));
      assert.strictEqual((html.match(/data-gallery-open=/g) || []).length, 3);
      assert(html.includes('Explore More') && html.includes(`${TAG} Newsletter Q2`));
      assert((await page(`/articles/${newsletter.id}`)).includes('<p>Plain text<br>second line</p>'));
      assert.strictEqual((await fetch(`${base}/articles/${made[2]}`)).status, 404, 'a draft is not public');
    });

    await test('admin list and editor pages', async () => {
      const list = await call('GET', '/admin/articles');
      assert(list.text.includes(`${TAG} Circular One`) && list.text.includes('article-search') && list.text.includes('3 photos'));
      const edit = await call('GET', `/admin/articles/${circular.id}/edit`);
      assert(edit.text.includes('Formatting guide') && edit.text.includes('value="2025-01-15"') && (edit.text.match(/data-image-id=/g) || []).length === 3);
      assert((await call('GET', '/admin/articles/new')).text.includes('Create Article'));
    });

    await test('deleting an article removes its cover and photos', async () => {
      const art = await prisma.article.findUnique({ where: { id: circular.id }, include: { images: true } });
      const files = [art.coverImage, ...art.images.map((i) => i.url)];
      assert.strictEqual((await call('DELETE', `/api/articles/${circular.id}`)).status, 200);
      for (const f of files) assert(!(await storage.exists(f)), `file gone: ${f}`);
      assert.strictEqual(await prisma.articleImage.count({ where: { articleId: circular.id } }), 0);
    });
  } finally {
    server.close();
    for (const id of made) {
      const art = await prisma.article.findUnique({ where: { id }, include: { images: true } }).catch(() => null);
      if (!art) continue;
      for (const u of [art.coverImage, ...art.images.map((i) => i.url)].filter(Boolean)) await storage.remove(u).catch(() => {});
      await prisma.article.delete({ where: { id } }).catch(() => {});
    }
    await prisma.article.deleteMany({ where: { title: { startsWith: 'x' }, body: 'y', createdAt: { gte: new Date(Date.now() - 3600e3) } } }).catch(() => {});
    const ids = [admin.id, member.id];
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: '198.51.100.12' } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM sessions WHERE data LIKE ?', `%${TAG}%`).catch(() => {});
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
