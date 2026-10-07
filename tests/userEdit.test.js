// Tests for the admin Edit User page's organization field.
//
// The bug this pins: the field was a dropdown of the first 100 organizations.
// A member whose school was not among them showed "(none)", and pressing Save —
// even to fix a typo in their name — sent organizationId="" and erased their
// organization. The page must always carry the member's current organization.
// Renders the real template; no database.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const file = path.join(__dirname, '..', 'views', 'admin', 'user-edit.ejs');
const src = fs.readFileSync(file, 'utf8');

function render(locals) {
  return ejs.render(src, { cspNonce: 'n', csrfToken: 't', restricted: false, ...locals }, { filename: file });
}

const member = {
  id: 4480, firstName: 'Ana', lastName: 'Reyes', email: 'ana@example.org', role: 'USER', yearLevel: null,
  organizationId: 627, organization: { id: 627, name: 'University of the East – Caloocan' },
};

// Any organization, however deep or however late in the list, is what Save sends.
const html = render({ user: member, currentOrganizationLabel: 'JPSME National › NCR › Caloocan City › University of the East – Caloocan' });
assert.match(html, /name="organizationId" id="org-id" value="627"/, 'Save sends the member\'s current organization');
assert(html.includes('Caloocan City'), 'the current organization is shown with its path');
assert(!/<select name="organizationId"/.test(html), 'no capped dropdown that can silently fall back to (none)');

// A member with no organization stays without one, and says so.
const none = render({ user: { ...member, organizationId: null, organization: null }, currentOrganizationLabel: null });
assert.match(none, /name="organizationId" id="org-id" value=""/);
assert(none.includes('No organization'));

// The page script still parses.
new Function(html.split('<script nonce="n">')[1].split('</script>')[0]); // eslint-disable-line no-new-func

console.log('User edit tests passed');
