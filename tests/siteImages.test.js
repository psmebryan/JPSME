// Tests for uploaded images surviving a deploy, and for the four places they
// are used.
//
// The host wipes the filesystem on every publish, so an image uploaded through
// the admin panel worked until the next deploy and then 404'd on every page —
// which is exactly where the site logo and every sponsor image had ended up.
// Uploads now live in the database instead.
//
// Covers the storage driver, the route that serves those bytes back, the
// settings that point at them, and the pages that render them.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const prisma = require('../src/config/prisma');
const storage = require('../src/services/storage.service');
const dbDriver = require('../src/services/storage/dbStorage.driver');
const settingsService = require('../src/services/settings.service');
const config = require('../src/config');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

async function assertRejects(fn, message) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  assert(threw, `${message} — it did not throw`);
  return threw;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const TAG = '__imgtest__';

async function cleanup() {
  await prisma.storedFile.deleteMany({ where: { key: { contains: TAG } } });
  await prisma.siteSetting.deleteMany({
    where: { key: { in: ['site_favicon', 'site_hero_image', 'site_og_image'] } },
  }).catch(() => {});
}

async function main() {
  await cleanup();

  // --- the driver -----------------------------------------------------------

  await test('the database is the default store, since the disk does not survive a deploy', async () => {
    assertEqual(config.storage.driver, 'database', 'default driver');
  });

  await test('an uploaded file round-trips through the database byte for byte', async () => {
    const url = await storage.saveUpload(PNG, { folder: TAG, prefix: 'logo', extension: '.png' });
    const key = url.replace(/^\//, '');
    const back = await storage.read(key);
    assertEqual(Buffer.compare(PNG, back), 0, 'identical bytes');
  });

  await test('the URL is the key, so nothing that stored a path needed rewriting', async () => {
    // The whole reason the switch needed no data migration: the database driver
    // kept the exact identifier the filesystem driver used.
    const url = await storage.saveUpload(PNG, { folder: TAG, prefix: 'logo', extension: '.png' });
    assert(url.startsWith(`/uploads/${TAG}/logo-`), `looks like the old paths, got ${url}`);
    assert(url.endsWith('.png'), 'keeps the extension');
  });

  await test('the content type comes from the extension, not from the uploader', async () => {
    // It is served back as a Content-Type header, and a value chosen by whoever
    // uploaded the file is how an "image" gets interpreted as something else.
    const url = await storage.saveUpload(PNG, { folder: TAG, prefix: 'x', extension: '.svg' });
    const row = await prisma.storedFile.findUnique({ where: { key: url.replace(/^\//, '') } });
    assertEqual(row.mimeType, 'image/svg+xml', 'derived from .svg');
    assertEqual(row.size, PNG.length, 'size recorded');
  });

  await test('re-saving the same key replaces it, the way writing a file does', async () => {
    const key = `uploads/${TAG}/fixed.png`;
    await dbDriver.save(PNG, key);
    const second = Buffer.from('ffd8ffe0', 'hex');
    await dbDriver.save(second, key);
    const back = await dbDriver.read(key);
    assertEqual(Buffer.compare(second, back), 0, 'the newer bytes');
    assertEqual(await prisma.storedFile.count({ where: { key } }), 1, 'still one row');
  });

  await test('a missing file reports itself the way a missing file always did', async () => {
    // Callers already handle ENOENT; a different shape would need every one of
    // them to learn a second way of saying the same thing.
    const err = await assertRejects(() => dbDriver.read(`uploads/${TAG}/nope.png`), 'read of a missing key');
    assertEqual(err.code, 'ENOENT', 'the familiar code');
  });

  await test('deleting something already gone is a no-op, not an error', async () => {
    await storage.remove(`uploads/${TAG}/never-existed.png`);
  });

  await test('removeFolder clears a prefix and leaves its neighbours alone', async () => {
    await dbDriver.save(PNG, `uploads/${TAG}/keep/a.png`);
    await dbDriver.save(PNG, `uploads/${TAG}/drop/a.png`);
    await dbDriver.save(PNG, `uploads/${TAG}/drop/b.png`);
    await storage.removeFolder(`uploads/${TAG}/drop`);

    assertEqual(await dbDriver.exists(`uploads/${TAG}/drop/a.png`), false, 'gone');
    assertEqual(await dbDriver.exists(`uploads/${TAG}/drop/b.png`), false, 'gone');
    assertEqual(await dbDriver.exists(`uploads/${TAG}/keep/a.png`), true, 'untouched');
  });

  await test('a private key never becomes a public URL', async () => {
    // Certificates live under storage/ and are only ever served through an
    // authenticated endpoint. A URL for one would route around that entirely.
    assertEqual(dbDriver.getUrl('storage/certificates/e1/x.pdf'), null, 'no URL');
    assertEqual(dbDriver.getUrl(`uploads/${TAG}/x.png`), `/uploads/${TAG}/x.png`, 'but uploads do get one');
  });

  await test('a key that is neither an upload nor a generated file is refused', async () => {
    await assertRejects(() => dbDriver.save(PNG, 'etc/passwd'), 'an unmanaged key');
    await assertRejects(() => dbDriver.read('../../secret'), 'a traversal-shaped key');
  });

  await test('readStream yields the same bytes, for the callers that stream', async () => {
    const key = `uploads/${TAG}/stream.png`;
    await dbDriver.save(PNG, key);
    const chunks = await new Promise((resolve, reject) => {
      const out = [];
      const stream = dbDriver.readStream(key);
      stream.on('data', (c) => out.push(c));
      stream.on('end', () => resolve(out));
      stream.on('error', reject);
    });
    assertEqual(Buffer.compare(Buffer.concat(chunks), PNG), 0, 'identical');
  });

  await test('a stream for a missing file errors rather than ending empty', async () => {
    // Ending empty would hand a caller a zero-byte file and look like success.
    const err = await new Promise((resolve) => {
      const stream = dbDriver.readStream(`uploads/${TAG}/missing.png`);
      stream.on('error', resolve);
      stream.on('end', () => resolve(null));
      stream.resume();
    });
    assert(err, 'the stream errored');
  });

  // --- the settings ---------------------------------------------------------

  await test('an unset favicon and banner are null, not a path to nothing', async () => {
    // Both are rendered conditionally; a made-up path would just be a 404 in a
    // <link> tag on every page.
    assertEqual(await settingsService.getFaviconUrl(), null, 'favicon');
    assertEqual(await settingsService.getHeroImageUrl(), null, 'banner');
  });

  await test('the link preview falls back to the logo rather than to nothing', async () => {
    // A shared link with the seal on it reads as the organisation; an empty box
    // reads as a dead link.
    const logo = await settingsService.getLogoUrl();
    assertEqual(await settingsService.getOgImageUrl(), logo, 'falls back');

    await settingsService.setOgImageUrl(`/uploads/${TAG}/og.png`);
    assertEqual(await settingsService.getOgImageUrl(), `/uploads/${TAG}/og.png`, 'an explicit one wins');
  });

  // --- the pages ------------------------------------------------------------

  const V = (p) => path.join(__dirname, '..', 'views', p);
  const render = (file, locals) => ejs.render(fs.readFileSync(V(file), 'utf8'), locals, { filename: V(file) });

  const homeLocals = (extra) => Object.assign({
    cspNonce: 'n',
    currentUser: null,
    logoUrl: '/uploads/logo/seal.png',
    events: [],
    stats: { memberCount: 12, eventCount: 3, registrationCount: 40 },
    sponsors: [],
  }, extra);

  await test('the home page draws the blueprint when no banner is uploaded', async () => {
    const html = render('index.ejs', homeLocals({ heroImageUrl: null }));
    assert(html.includes("bg-[url('/img/blueprint.svg')]"), 'the built-in artwork');
    assert(html.includes('/uploads/logo/seal.png'), 'and the uploaded seal');
  });

  await test('an uploaded banner covers the blueprint instead of sitting beside it', async () => {
    const html = render('index.ejs', homeLocals({ heroImageUrl: '/uploads/hero/banner.png' }));
    assert(html.includes('/uploads/hero/banner.png'), 'the banner is rendered');
    assert(html.includes('object-cover'), 'as a covering image');
  });

  await test('the banner is an img, not an inline style, because CSP would drop it', async () => {
    // styleSrc carries a nonce and no 'unsafe-inline', so a style attribute
    // built from a database value is simply not applied — silently, and only
    // in production.
    const html = render('index.ejs', homeLocals({ heroImageUrl: '/uploads/hero/banner.png' }));
    assert(!/style="[^"]*background-image/i.test(html), 'no inline background-image');
  });

  await test('both login pages identify themselves with the seal', async () => {
    // Each is the page most likely to be reached from an emailed link, where
    // somebody arrives with no other clue whose site this is.
    const member = render('login.ejs', { cspNonce: 'n', currentUser: null, logoUrl: '/uploads/logo/seal.png' });
    assert(member.includes('/uploads/logo/seal.png'), 'member login');

    const admin = render('admin/login.ejs', { cspNonce: 'n', currentUser: null, logoUrl: '/uploads/logo/seal.png' });
    assert(admin.includes('/uploads/logo/seal.png'), 'admin login');
  });

  await test('the layout asks for a favicon whether or not one is uploaded', async () => {
    // A browser requests /favicon.ico regardless, which is why it was 404ing on
    // every page load before there was anything to point at.
    const base = {
      cspNonce: 'n', currentUser: null, title: 'Home', csrfToken: 't',
      body: '<p>x</p>', logoUrl: '/uploads/logo/seal.png',
    };
    const withNone = render('layout.ejs', Object.assign({}, base, { faviconUrl: null, ogImageUrl: null }));
    assert(withNone.includes('/img/favicon.svg'), 'falls back to the bundled icon');

    const withOne = render('layout.ejs', Object.assign({}, base, { faviconUrl: '/uploads/favicon/f.png', ogImageUrl: null }));
    assert(withOne.includes('/uploads/favicon/f.png'), 'an uploaded one wins');
  });

  await test('a shared link carries a preview image when there is one', async () => {
    const base = {
      cspNonce: 'n', currentUser: null, title: 'Home', csrfToken: 't',
      body: '<p>x</p>', logoUrl: '/uploads/logo/seal.png', faviconUrl: null,
    };
    const withOg = render('layout.ejs', Object.assign({}, base, { ogImageUrl: '/uploads/og/card.png' }));
    assert(withOg.includes('property="og:image"'), 'the tag is there');
    assert(withOg.includes('/uploads/og/card.png'), 'pointing at the image');

    const without = render('layout.ejs', Object.assign({}, base, { ogImageUrl: null }));
    assert(!without.includes('property="og:image"'), 'and omitted rather than left empty');
  });

  await test('the settings page offers all four uploads, each explained', async () => {
    const html = render('admin/settings.ejs', {
      cspNonce: 'n', currentUser: { id: 1, role: 'ADMIN' },
      logoUrl: '/uploads/logo/seal.png', faviconUrl: null, heroImageUrl: null, ogImageUrl: null,
      membershipFeeCentavos: 50000, paymentsEnabled: true,
      gatewaySurchargePercent: 2.4976, membershipPaymentRequired: false,
    });
    ['logo-form', 'favicon-form', 'hero-form', 'og-form'].forEach((id) => {
      assert(html.includes(`id="${id}"`), `${id} is present`);
    });
    assert(/browser tab/i.test(html), 'the favicon says where it shows');
    assert(/Messenger/i.test(html), 'the link preview says where it shows');
    assert(/built-in blueprint/i.test(html), 'and an unset banner says what it falls back to');
  });
}

main()
  .catch((err) => {
    console.error('Test run failed:', err);
    failed += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
