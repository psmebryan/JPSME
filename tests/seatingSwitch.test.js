// Tests for the site-wide seating switch (SEATING_FEATURE, off by default).
//
// While it is off, assigned seating must be unreachable for members and
// admins alike — no links, and a 404 for every seating page and API even when
// typed in — whatever an event's own seatingEnabled says. Turning it on must
// bring it back. The seats table itself is never read here.

require('dotenv').config();
const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

delete process.env.SEATING_FEATURE;
const app = require('../src/app');
const config = require('../src/config');
const { isSeatingOn } = require('../src/services/seating.service');

const NAV = path.join(__dirname, '..', 'views', 'partials', 'event-ops-nav.ejs');
const navHtml = (seatingFeature) => ejs.renderFile(NAV, {
  event: { id: 7, title: 'T' },
  currentUser: { role: 'ADMIN' },
  seatingFeature,
  active: 'overview',
});

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(`${base}${p}`, { redirect: 'manual' });
  try {
    // --- off (the default) ---------------------------------------------------
    assert.strictEqual(config.seatingFeature, false, 'off unless SEATING_FEATURE is set');
    assert.strictEqual(isSeatingOn({ seatingEnabled: true }), false, 'an event with seating on is still off');

    let r = await get('/events/1/seat');
    assert.strictEqual(r.status, 404, 'member seat picker page is a 404');
    r = await get('/admin/events/1/seating');
    assert.strictEqual(r.status, 404, 'admin seating page is a 404');
    for (const p of ['/api/events/1/seating/my-map', '/api/events/1/seating/available', '/api/events/1/seating/map']) {
      r = await get(p);
      assert.strictEqual(r.status, 404, `${p} is a 404`);
    }
    r = await fetch(`${base}/api/events/1/seating/seats/1/hold`, { method: 'POST' });
    assert.strictEqual(r.status, 404, 'hold is a 404, before any auth or CSRF check');
    r = await fetch(`${base}/api/events/1/seating`, { method: 'PUT' });
    assert.strictEqual(r.status, 404, 'turning seating on for an event is a 404');

    r = await get('/api/events');
    assert.strictEqual(r.status, 200, 'the rest of the events API is untouched');

    let html = await navHtml(false);
    assert(!html.includes('/seating'), 'no Seating tab in the event menu');
    assert(html.includes('/desk'), 'the other tabs are still there');

    // --- on --------------------------------------------------------------------
    process.env.SEATING_FEATURE = 'true';
    assert.strictEqual(isSeatingOn({ seatingEnabled: true }), true, 'on, for an event that uses it');
    assert.strictEqual(isSeatingOn({ seatingEnabled: false }), false, 'still off for an event that does not');

    r = await get('/events/1/seat');
    assert.strictEqual(r.status, 302, 'seat page reachable again (signed out, so sent to login)');
    r = await get('/api/events/1/seating/my-map');
    assert.strictEqual(r.status, 401, 'member seating API reachable again (asks for sign-in)');

    html = await navHtml(true);
    assert(html.includes('/admin/events/7/seating'), 'Seating tab back for a main admin');

    console.log('Seating switch tests passed');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    delete process.env.SEATING_FEATURE;
    server.close();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
