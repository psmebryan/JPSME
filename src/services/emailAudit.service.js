// A read-only report on the Gmail address bug (see utils/emailIdentity.js).
//
// For a while the login, sign-up and reset forms stripped dots and +tags from
// Gmail addresses, while the member import stored them as typed. Two things can
// be left behind, and this finds both without changing anything:
//
//   affected   members whose stored Gmail address has a dot or +tag: the ones who
//              could not log in or reset their password until the fix.
//   duplicates two or more accounts on the same Gmail inbox, typically an
//              imported account plus one the member made by signing up again
//              when the first would not let them in.
//
// Each duplicate account carries its activation state and how many event
// registrations and payments hang off it, because that is what decides which
// one an admin keeps.

const prisma = require('../config/prisma');
const { canonicalEmail } = require('../utils/emailIdentity');

async function gmailIdentityReport() {
  const users = await prisma.user.findMany({
    where: {
      role: 'USER',
      OR: [{ email: { endsWith: '@gmail.com' } }, { email: { endsWith: '@googlemail.com' } }],
    },
    select: {
      id: true, email: true, firstName: true, lastName: true, status: true,
      passwordSetAt: true, createdAt: true,
      _count: { select: { registrations: true, payments: true } },
    },
    orderBy: { id: 'asc' },
  });

  const affected = users.filter((u) => /[.+]/.test(String(u.email).split('@')[0])).length;

  const byInbox = new Map();
  for (const u of users) {
    const inbox = canonicalEmail(u.email);
    if (!byInbox.has(inbox)) byInbox.set(inbox, []);
    byInbox.get(inbox).push(u);
  }

  const duplicates = [];
  let removable = 0;
  for (const [inbox, accounts] of byInbox) {
    if (accounts.length < 2) continue;
    const anyActivated = accounts.some((u) => u.passwordSetAt !== null);
    duplicates.push({
      inbox,
      accounts: accounts.map((u) => {
        const unused = isUnused(u);
        // Removable only when the member keeps a working account on this inbox.
        const canRemove = anyActivated && unused;
        if (canRemove) removable += 1;
        return {
          id: u.id,
          email: u.email,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          status: u.status,
          activated: u.passwordSetAt !== null,
          createdAt: u.createdAt,
          registrations: u._count.registrations,
          payments: u._count.payments,
          removable: canRemove,
        };
      }),
    });
  }

  return { gmailMembers: users.length, affected, duplicates, removable };
}

// Never activated, and nothing hangs off it: an account its owner has never
// used, so deleting it loses nothing.
function isUnused(u) {
  return u.passwordSetAt === null && u._count.registrations === 0 && u._count.payments === 0;
}

// Deletes the duplicates the report marks removable, and nothing else.
//
// Every account is re-read immediately before its delete, so the rules hold at
// that moment rather than when the report was drawn: a member who activated the
// duplicate, or registered with it, in between is left alone. The activated
// twin is re-checked the same way, so a member is never left with no working
// account. One failure (a related record the database will not let go) skips
// that account and carries on.
async function removeUnusedDuplicates() {
  const report = await gmailIdentityReport();
  const removed = [];
  const skipped = [];

  for (const group of report.duplicates) {
    for (const account of group.accounts.filter((a) => a.removable)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const fresh = await prisma.user.findUnique({
          where: { id: account.id },
          select: { id: true, email: true, role: true, passwordSetAt: true, _count: { select: { registrations: true, payments: true } } },
        });
        const twinIds = group.accounts.filter((a) => a.id !== account.id).map((a) => a.id);
        // eslint-disable-next-line no-await-in-loop
        const twinActivated = await prisma.user.count({ where: { id: { in: twinIds }, passwordSetAt: { not: null } } });
        if (!fresh || fresh.role !== 'USER' || !isUnused(fresh) || !twinActivated) {
          skipped.push({ id: account.id, email: account.email, reason: 'changed since the check' });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await prisma.user.delete({ where: { id: fresh.id } });
        removed.push({ id: fresh.id, email: fresh.email });
      } catch (err) {
        skipped.push({ id: account.id, email: account.email, reason: 'the database would not allow deleting it' });
      }
    }
  }

  return { removed, skipped };
}

module.exports = { gmailIdentityReport, removeUnusedDuplicates };
