// Tests for the invitation member picker — who it offers, and what it says
// about them.
//
// The bug this guards against had no error and no stack trace: the picker
// listed only APPROVED accounts, so on a newly launched site, where every
// member is still PENDING, it came up empty and looked broken. Worse, somebody
// could have paid in full and still be invisible, because approval is an
// admin's own to-do list rather than a fact about the person.
//
// Runs with no database. Prisma is stubbed so the assertion is on the query
// that gets built rather than on rows that happen to exist, and the view is
// rendered directly — both halves of the change, neither needing MySQL up.

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

let passed = 0;
let failed = 0;

function record(name, err) {
  if (err) {
    console.error(`FAIL: ${name}`);
    console.error(`      ${String(err.message).split('\n').join('\n      ')}`);
    failed += 1;
  } else {
    console.log(`PASS: ${name}`);
    passed += 1;
  }
}

function test(name, fn) {
  try { fn(); record(name); } catch (err) { record(name, err); }
}

async function testAsync(name, fn) {
  try { await fn(); record(name); } catch (err) { record(name, err); }
}

function has(html, needle, message) {
  if (!html.includes(needle)) throw new Error(`${message}\n  expected to find: ${JSON.stringify(needle)}`);
}

function hasNot(html, needle, message) {
  if (html.includes(needle)) throw new Error(`${message}\n  expected NOT to find: ${JSON.stringify(needle)}`);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

// --- the query -------------------------------------------------------------

// Stubbed before user.service is required, so it never opens a connection.
const findManyCalls = [];
const prismaPath = require.resolve('../src/config/prisma');
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { user: { findMany: (args) => { findManyCalls.push(args); return Promise.resolve([]); } } },
};

// eslint-disable-next-line import/order
const userService = require('../src/services/user.service');

async function queryTests() {
  await testAsync('several statuses become one IN, and a rejected account is never among them', async () => {
    findManyCalls.length = 0;
    await userService.listByStatus(['APPROVED', 'PENDING']);
    assertEqual(
      findManyCalls[0].where,
      { status: { in: ['APPROVED', 'PENDING'] }, role: { not: 'ADMIN' } },
      'the where clause'
    );
  });

  await testAsync('a single status still builds the query it always did', async () => {
    // listByStatus has three other callers passing a plain string; widening it
    // must not change what any of them get back.
    findManyCalls.length = 0;
    await userService.listByStatus('PENDING');
    assertEqual(findManyCalls[0].where, { status: 'PENDING', role: { not: 'ADMIN' } }, 'the where clause');
  });

  await testAsync('no status still means every non-admin account', async () => {
    findManyCalls.length = 0;
    await userService.listByStatus();
    assertEqual(findManyCalls[0].where, { role: { not: 'ADMIN' } }, 'the where clause');
  });
}

// --- what the picker shows -------------------------------------------------

const VIEW = path.join(__dirname, '..', 'views', 'admin', 'invitations.ejs');
const SOURCE = fs.readFileSync(VIEW, 'utf8');
const EVENTS = [{ id: 7, title: 'General Assembly', startDate: new Date(), _count: { registrations: 1, invitations: 1 } }];
const A_YEAR_AWAY = new Date(Date.now() + 365 * 86400000);
const YESTERDAY = new Date(Date.now() - 86400000);

function renderPicker(members) {
  return ejs.render(SOURCE, {
    cspNonce: 'test-nonce',
    currentUser: { id: 1, role: 'ADMIN' },
    events: EVENTS,
    selectedEvent: EVENTS[0],
    invitations: [],
    total: 0,
    page: 1,
    totalPages: 1,
    filterOptions: { chapters: [], events: EVENTS },
    summary: {
      total: 0, registered: 0, registeredPct: 0, attendingGuests: 0, requested: 0,
      adminSent: { total: 0, registered: 0, pct: 0 },
      selfRequested: { total: 0, registered: 0, pct: 0 },
    },
    members,
    invitedEmailStatuses: [],
    sourceFilter: '',
  }, { filename: VIEW });
}

function member(overrides) {
  return Object.assign({
    id: 1,
    firstName: 'Ana',
    lastName: 'Cruz',
    email: 'ana@example.com',
    status: 'APPROVED',
    membershipExpiresAt: A_YEAR_AWAY,
    organization: { id: 500, name: 'Garcia College', path: '/1/3/9/500/' },
    organizationPath: 'JPSME National › Visayas › Aklan › Garcia College',
  }, overrides);
}

function pickerTests() {
  test('a current, approved member reads as a member and carries no warning', () => {
    const html = renderPicker([member({})]);
    has(html, '>Member<', 'the membership badge is there');
    hasNot(html, 'Non-Member', 'and does not contradict itself');
    hasNot(html, 'Pending approval', 'nothing is outstanding on this account');
  });

  test('an account still awaiting approval is listed at all', () => {
    // The entire bug: before this, the row did not exist, and an admin looking
    // at an empty picker had no way to tell that from having no members.
    const html = renderPicker([member({ id: 2, firstName: 'Ben', status: 'PENDING', membershipExpiresAt: null })]);
    has(html, 'Ben', 'the person is offered');
    hasNot(html, 'Nobody has registered an account yet', 'the empty state is not shown');
  });

  test('a pending account says so, so inviting is not mistaken for approving', () => {
    const html = renderPicker([member({ id: 2, firstName: 'Ben', status: 'PENDING', membershipExpiresAt: null })]);
    has(html, 'Pending approval', 'the approval is flagged');
    has(html, 'Non-Member', 'and the membership is stated separately');
  });

  test('paid in full but not yet approved shows both facts, not one', () => {
    // The case that proves the two are independent: money is in, the button
    // has not been pressed. Reporting only one of these would be a lie.
    const html = renderPicker([member({ id: 3, firstName: 'Cara', status: 'PENDING' })]);
    has(html, 'Cara', 'listed');
    has(html, '>Member<', 'their membership is current');
    has(html, 'Pending approval', 'and approval is still outstanding');
  });

  test('a lapsed membership is labelled, never hidden', () => {
    const html = renderPicker([member({ id: 4, firstName: 'Dio', membershipExpiresAt: YESTERDAY })]);
    has(html, 'Dio', 'still pickable');
    has(html, 'Non-Member', 'shown as lapsed');
    hasNot(html, 'Pending approval', 'approval is not what is wrong here');
  });

  test('a member with no membership record at all is a non-member, not a crash', () => {
    const html = renderPicker([member({ id: 5, firstName: 'Eli', membershipExpiresAt: undefined })]);
    has(html, 'Eli', 'listed');
    has(html, 'Non-Member', 'and classified rather than blank');
  });

  test('the account column and the invitation column are named apart', () => {
    // There are now two kinds of status on this row. Calling them both "Status"
    // would make the table unreadable.
    const html = renderPicker([member({})]);
    has(html, '<th class="p-2 text-left">Membership</th>', 'the account side');
    has(html, '<th class="p-2 text-left">Invited</th>', 'the invitation side');
  });

  test('an empty roster says nobody has registered, not nobody is approved', () => {
    // The old wording described a filter that no longer exists, and would have
    // sent an admin looking for accounts to approve that were never there.
    const html = renderPicker([]);
    has(html, 'Nobody has registered an account yet', 'the empty state is accurate');
    hasNot(html, 'No approved members yet', 'the stale wording is gone');
  });
}

(async () => {
  await queryTests();
  pickerTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
