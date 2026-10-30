// The admin modules, and which pages and API paths belong to each.
//
// Used for the National President role (Role PRESIDENT): the main admin ticks
// which modules a President may use (Site Settings -> National President
// access), and auth.middleware lets a President through an admin guard only
// when the request's path belongs to a ticked module. The main admin (ADMIN)
// always has everything; chapter admins are unaffected.
//
// DEFAULT DENY. A path that matches no module here is refused to a President,
// so an admin route added later stays main-admin only until it is listed. The
// first module whose pattern matches decides, so more specific modules (Check-in
// under /admin/events/:id/...) come before broader ones (Events).
//
// Each module's home is where its sidebar link goes and where a President
// lands when sent away from a page that is not theirs.
//
// Never listed, so never grantable: Site Settings (which includes this access
// list), the full data export / import, and anything else not below.

const MODULES = [
  {
    key: 'dashboard',
    home: '/admin/dashboard',
    label: 'Dashboard',
    hint: 'National totals and recent activity.',
    patterns: [/^\/admin\/?$/, /^\/admin\/dashboard$/],
  },
  {
    key: 'checkin',
    home: '/admin/check-in',
    label: 'Check-in',
    hint: 'Check-in stations, desk, attendance, rooms and check-in staff.',
    patterns: [
      /^\/admin\/check-in(\/|$)/,
      /^\/admin\/events\/\d+\/(check-in|attendance|desk|rooms|seating)(\/|$)/,
      /^\/api\/events\/\d+\/(checkin|rooms|sessions|seating|integration-keys)(\/|$)/,
      /^\/api\/events\/\d+\/registrations\/\d+\/attendance$/,
    ],
  },
  {
    key: 'certificates',
    home: '/admin/event-certificates',
    label: 'Certificates',
    hint: 'Membership certificate template and event certificates.',
    patterns: [
      /^\/admin\/(certificates|event-certificates)$/,
      /^\/admin\/events\/\d+\/certificate$/,
      /^\/api\/admin\/certificates(\/|$)/,
    ],
  },
  {
    key: 'emails',
    home: '/admin/event-emails',
    label: 'Emails',
    hint: 'Membership and event email templates, and broadcast emails.',
    patterns: [
      /^\/admin\/(emails|event-emails|broadcasts)$/,
      /^\/admin\/events\/\d+\/email$/,
      /^\/api\/admin\/(emails|broadcasts)(\/|$)/,
    ],
  },
  {
    key: 'events',
    home: '/admin/events',
    label: 'Events',
    hint: 'Create and edit events, registrations and invitations.',
    patterns: [
      /^\/admin\/events(\/|$)/,
      /^\/admin\/invitations$/,
      /^\/api\/events(\/|$)/,
      /^\/api\/admin\/invitations(\/|$)/,
    ],
  },
  {
    key: 'masterEvents',
    home: '/admin/master/event-fees',
    label: 'Master List: Event Fee',
    hint: 'Each event\'s registration fee options.',
    patterns: [/^\/admin\/master\/event-fees$/, /^\/api\/admin\/event-fees(\/|$)/],
  },
  {
    key: 'masterMembers',
    home: '/admin/master/member-types',
    label: 'Master List: Member Type, Student Organization, Membership',
    hint: 'Member types and fees, student organizations and officers, the membership list.',
    patterns: [
      /^\/admin\/master-list$/,
      /^\/admin\/master\/(member-types|student-organizations|memberships)(\/|$)/,
      /^\/api\/admin\/(member-types|student-organizations)(\/|$)/,
    ],
  },
  {
    key: 'organizations',
    home: '/admin/organizations',
    label: 'Organizations',
    hint: 'The organization structure, organization admins and organization members.',
    patterns: [
      /^\/admin\/(organizations|organization-admins|organization-members)(\/|$)/,
      /^\/api\/admin\/(organization-tree|organizations|organization-admins|organization-members)(\/|$)/,
    ],
  },
  {
    key: 'sponsors',
    home: '/admin/sponsors',
    label: 'Sponsors',
    hint: 'Sponsor logos on the site.',
    patterns: [/^\/admin\/sponsors$/, /^\/api\/admin\/sponsors(\/|$)/],
  },
  {
    key: 'articles',
    home: '/admin/articles',
    label: 'Articles',
    hint: 'News, circulars and newsletters.',
    patterns: [/^\/admin\/articles(\/|$)/, /^\/api\/articles(\/|$)/],
  },
  {
    key: 'reports',
    home: '/admin/reports/transactions',
    label: 'Reports',
    hint: 'Transaction, member and event registration reports and their exports.',
    patterns: [/^\/admin\/reports(\/|$)/],
  },
  {
    key: 'users',
    home: '/admin/users/approvals',
    label: 'Users & Approvals',
    hint: 'Approve and edit member accounts and send activations. A President can never change a main admin or President account.',
    patterns: [
      /^\/admin\/(users|activations)(\/|$)/,
      /^\/api\/admin\/(users|members|activations)(\/|$)/,
    ],
  },
  {
    key: 'payments',
    home: '/admin/payments',
    label: 'Payments',
    hint: 'All payments, including refunds.',
    patterns: [/^\/admin\/payments$/, /^\/api\/admin\/payments(\/|$)/],
  },
  {
    key: 'auditLog',
    home: '/admin/audit-log',
    label: 'Audit Log',
    hint: 'The record of admin actions.',
    patterns: [/^\/admin\/audit-log$/, /^\/api\/admin\/audit-log(\/|$)/],
  },
];

// The Jobs endpoint reports progress of certificate and email sends, so it
// belongs to whichever of those two the President has.
const SHARED = [
  { pattern: /^\/api\/admin\/jobs\/[^/]+$/, anyOf: ['certificates', 'emails'] },
];

// What a new President gets until the main admin changes it.
const DEFAULT_PRESIDENT_MODULES = ['dashboard', 'events', 'certificates', 'emails', 'organizations', 'masterEvents', 'sponsors', 'articles'];

const KEYS = MODULES.map((m) => m.key);

// The modules a path needs: one key, several (any of), or null (no module:
// never open to a President).
function modulesForPath(path) {
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  for (const s of SHARED) if (s.pattern.test(clean)) return s.anyOf;
  const hit = MODULES.find((m) => m.patterns.some((p) => p.test(clean)));
  return hit ? [hit.key] : null;
}

module.exports = { MODULES, KEYS, DEFAULT_PRESIDENT_MODULES, modulesForPath };
