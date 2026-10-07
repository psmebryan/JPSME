// Tests for public/js/admin-nav.js: how the admin sidebar opens a page.
//
// The sidebar swaps a page's HTML into place without a reload. A browser never
// runs a <script> inserted that way, so a page carrying its own script (Invite
// Members, Events, Organizations...) rendered but did nothing — no table, dead
// buttons, an import that never refreshed the list. Those pages must get a real
// page load instead. Run in a vm with a fake DOM, no browser needed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-nav.js'), 'utf8');

function run(html) {
  const content = { innerHTML: 'old', scrollIntoView() {} };
  const nav = { querySelectorAll: () => [] };
  const events = [];
  const location = { href: '/admin/dashboard', pathname: '/admin/dashboard', search: '' };
  const context = {
    console,
    URL,
    CustomEvent: class { constructor(type) { this.type = type; } },
    decodeURIComponent,
    window: { location, history: { pushState() {} }, addEventListener() {} },
    document: {
      getElementById: (id) => ({ 'admin-nav': nav, 'admin-content': content })[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent: (e) => events.push(e.type),
    },
    fetch: async () => ({ redirected: false, ok: true, url: '/x', headers: { get: () => null }, text: async () => html }),
  };
  context.window.location = location;
  vm.createContext(context);
  vm.runInContext(src, context);
  return { context, content, location, events };
}

async function main() {
  // A page with its own script: full page load, nothing swapped in.
  {
    const t = run('<div id="page">Invite Members</div><script nonce="abc">doThings()</script>');
    await t.context.loadAdminPage('/admin/activations', true);
    assert.strictEqual(t.location.href, '/admin/activations', 'navigates for real');
    assert.strictEqual(t.content.innerHTML, 'old', 'does not swap in a page whose script would not run');
    assert.deepStrictEqual(t.events, [], 'and does not announce a swap that did not happen');
  }

  // A page without one (Users, driven by admin.js): still swapped in.
  {
    const t = run('<div id="users-module">Users</div>');
    await t.context.loadAdminPage('/admin/users/all', true);
    assert.strictEqual(t.content.innerHTML, '<div id="users-module">Users</div>', 'swapped in place');
    assert.strictEqual(t.location.href, '/admin/dashboard', 'no reload');
    assert.deepStrictEqual(t.events, ['admin:content-loaded'], 'admin.js is told to bind the new page');
  }

  console.log('Admin navigation tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
