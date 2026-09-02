// Test members spread across the organization hierarchy, for exercising
// anything that depends on where a member sits: the admin member lists,
// subtree aggregation on the dashboard, organization-scoped RBAC, and the
// approvals queue.
//
//   npm run seed:dummy           create them
//   npm run seed:dummy -- --clean   remove them again
//
// Every account uses the DUMMY_DOMAIN below, and cleanup deletes strictly by
// that exact suffix — never a loose pattern, so a real account can't be caught
// by it.
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const organizationService = require('../src/services/organization.service');

const DUMMY_DOMAIN = '@dummy.test';
const PASSWORD = 'Dummy123!';

// Covers both levels a member can attach to — a province and a student unit —
// so subtree counts have something to roll up, plus a couple of PENDING
// accounts so the approvals queue is not empty.
const PLAN = [
  { type: 'PROVINCE', count: 3, status: 'APPROVED' },
  { type: 'STUDENT_UNIT', count: 5, status: 'APPROVED' },
  { type: 'STUDENT_UNIT', count: 2, status: 'PENDING' },
];

const FIRST = ['Ana', 'Ben', 'Cara', 'Dino', 'Elsa', 'Fritz', 'Gina', 'Hugo', 'Iris', 'Jomar', 'Kaye', 'Lito', 'Mika', 'Noel'];
const LAST = ['Reyes', 'Santos', 'Cruz', 'Bautista', 'Ocampo', 'Villanueva', 'Mendoza', 'Aquino', 'Navarro', 'Del Rosario', 'Gatchalian', 'Panganiban', 'Salazar', 'Tolentino'];

async function clean() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DUMMY_DOMAIN } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) {
    console.log('No dummy accounts found.');
    return;
  }
  // Clear dependent rows first; a member may have been made an org admin below.
  // OrganizationAdminAudit references a user through three separate columns —
  // there is no `userId` — and changedBy is a non-nullable FK, so a row naming
  // a dummy account in any of them has to go before the account can be deleted.
  await prisma.organizationAdminAudit.deleteMany({
    where: {
      OR: [
        { oldUserId: { in: ids } },
        { newUserId: { in: ids } },
        { changedBy: { in: ids } },
      ],
    },
  });
  await prisma.organizationAdmin.deleteMany({ where: { userId: { in: ids } } });
  await prisma.eventRegistration.deleteMany({ where: { userId: { in: ids } } });
  const removed = await prisma.user.deleteMany({ where: { email: { endsWith: DUMMY_DOMAIN } } });
  console.log(`Removed ${removed.count} dummy account(s).`);
}

async function main() {
  if (process.argv.includes('--clean')) return clean();

  const existing = await prisma.user.count({ where: { email: { endsWith: DUMMY_DOMAIN } } });
  if (existing > 0) {
    console.log(`${existing} dummy account(s) already exist. Run with --clean first to reset them.`);
    return;
  }

  const hashed = await bcrypt.hash(PASSWORD, 12);
  let n = 0;
  const created = [];

  for (const group of PLAN) {
    const orgs = await prisma.organization.findMany({
      where: { type: group.type, isActive: true },
      select: { id: true, name: true },
      take: group.count,
      orderBy: { id: 'asc' },
    });
    if (!orgs.length) {
      console.log(`(skipped ${group.count} x ${group.type} — no such organization exists yet)`);
      continue;
    }

    for (let i = 0; i < group.count; i += 1) {
      const org = orgs[i % orgs.length];
      const firstName = FIRST[n % FIRST.length];
      const lastName = LAST[n % LAST.length];
      const email = `dummy${n + 1}${DUMMY_DOMAIN}`;
      n += 1;

      const user = await prisma.user.create({
        data: {
          firstName,
          lastName,
          email,
          password: hashed,
          role: 'USER',
          status: group.status,
          // Verified regardless of status: an unverified account can't log in
          // at all, which would make the PENDING ones untestable.
          emailVerifiedAt: new Date(),
          organizationId: org.id,
        },
      });
      created.push({ user, org, status: group.status, type: group.type });
    }
  }

  // One scoped admin, so organization-subtree RBAC has something to test
  // against: they should see their own organization's members and nothing
  // outside it. Chosen as the org with the most members beneath it, so the
  // scope is actually meaningful rather than empty.
  const provinceCandidate = created.find((c) => c.type === 'PROVINCE' && c.status === 'APPROVED');
  if (provinceCandidate) {
    await prisma.user.update({
      where: { id: provinceCandidate.user.id },
      data: { role: 'CHAPTER_ADMIN' },
    });
    await prisma.organizationAdmin.create({
      data: { organizationId: provinceCandidate.org.id, userId: provinceCandidate.user.id },
    });
  }

  console.log(`Created ${created.length} dummy account(s). Password for all: ${PASSWORD}\n`);
  for (const c of created) {
    const path = await organizationService.getOrganizationPathLabel(c.org.id);
    const role = c.user.id === (provinceCandidate && provinceCandidate.user.id) ? 'CHAPTER_ADMIN' : 'USER';
    console.log(`  ${c.user.email.padEnd(22)} ${role.padEnd(14)} ${c.status.padEnd(9)} ${path}`);
  }
  console.log('\nRun with --clean to remove them.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
