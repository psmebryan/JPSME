const prisma = require('../config/prisma');
const auditService = require('./audit.service');
const organizationService = require('./organization.service');

// Real counts for the homepage stats bar (no invented marketing numbers).
async function getHomeStats() {
  const [memberCount, eventCount, registrationCount] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', status: 'APPROVED' } }),
    prisma.event.count(),
    prisma.eventRegistration.count({ where: { status: 'REGISTERED' } }),
  ]);
  return { memberCount, eventCount, registrationCount };
}

const MONTH_WINDOW = 6;

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Labels/keys for the trailing N months (including the current one), oldest
// first — bucketing happens in JS rather than a SQL GROUP BY on month() since
// this app's row counts are small and it avoids a MySQL-specific raw query.
function lastMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short' }) });
  }
  return months;
}

function bucketByMonth(records, dateField, months) {
  const counts = new Map(months.map((m) => [m.key, 0]));
  records.forEach((r) => {
    const key = monthKey(new Date(r[dateField]));
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  });
  return months.map((m) => ({ label: m.label, count: counts.get(m.key) }));
}

function sumByMonth(records, dateField, amountField, months) {
  const sums = new Map(months.map((m) => [m.key, 0]));
  records.forEach((r) => {
    const key = monthKey(new Date(r[dateField]));
    if (sums.has(key)) sums.set(key, sums.get(key) + r[amountField]);
  });
  return months.map((m) => ({ label: m.label, amount: sums.get(m.key) }));
}

// MAIN_ADMIN-only dashboard — includes revenue/payment data, which
// CHAPTER_ADMIN never has access to anywhere else in the app either.
async function getMainAdminDashboard() {
  const months = lastMonths(MONTH_WINDOW);
  const windowStart = new Date(new Date().getFullYear(), new Date().getMonth() - (MONTH_WINDOW - 1), 1);

  const [
    totalMembers,
    pendingApprovals,
    totalEvents,
    revenueAgg,
    newUsersInWindow,
    paidPaymentsInWindow,
    regions,
    auditLogPage,
    upcomingEvents,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', status: 'APPROVED' } }),
    prisma.user.count({ where: { role: 'USER', status: 'PENDING' } }),
    prisma.event.count(),
    prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
    prisma.user.findMany({ where: { role: 'USER', createdAt: { gte: windowStart } }, select: { createdAt: true } }),
    prisma.payment.findMany({ where: { status: 'PAID', paidAt: { gte: windowStart } }, select: { paidAt: true, amount: true } }),
    // The mother orgs are the useful top-level breakdown now that the
    // hierarchy is variable-depth — counting only direct members of each
    // organization would badly under-report one whose members all sit in
    // student units beneath it, so this aggregates the whole subtree below.
    prisma.organization.findMany({
      where: { isActive: true, type: 'MOTHER_ORG' },
      select: { id: true, name: true, path: true },
    }),
    auditService.listAuditLogs({ page: 1 }),
    prisma.event.findMany({
      where: { isPublished: true, startDate: { gte: new Date() } },
      orderBy: { startDate: 'asc' },
      take: 5,
      include: { _count: { select: { registrations: { where: { status: { in: ['REGISTERED', 'PENDING_PAYMENT'] } } } } } },
    }),
  ]);

  // Subtree aggregation in one pass: fetch every approved member's
  // organization path once, then attribute each to whichever mother org's
  // path is a prefix of theirs. Avoids a per-organization count query while
  // still counting members who sit several levels below it.
  const memberOrgs = await prisma.user.findMany({
    where: { role: 'USER', status: 'APPROVED', organizationId: { not: null } },
    select: { organization: { select: { path: true } } },
  });
  const membersByOrganization = regions
    .map((r) => ({
      name: r.name,
      count: memberOrgs.filter((m) => m.organization && m.organization.path.startsWith(r.path)).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    totals: {
      totalMembers,
      pendingApprovals,
      totalEvents,
      totalRevenueCentavos: revenueAgg._sum.amount || 0,
    },
    registrationsByMonth: bucketByMonth(newUsersInWindow, 'createdAt', months),
    revenueByMonth: sumByMonth(paidPaymentsInWindow, 'paidAt', 'amount', months),
    membersByOrganization,
    recentActivity: auditLogPage.logs.slice(0, 8),
    upcomingEvents,
  };
}

// Scoped-admin dashboard — covers their organization AND its descendants, so
// a cluster admin sees the members of the chapters/units beneath them rather
// than only those attached directly to the cluster. No payment/revenue data
// (matches the zero-payment-access rule enforced everywhere else).
async function getOrganizationAdminDashboard(organizationId) {
  const scopeIds = await organizationService.getDescendantIds(organizationId);
  const [totalMembers, pendingApprovals, upcomingEvents] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', status: 'APPROVED', organizationId: { in: scopeIds } } }),
    prisma.user.count({ where: { role: 'USER', status: 'PENDING', organizationId: { in: scopeIds } } }),
    prisma.event.findMany({
      where: { isPublished: true, startDate: { gte: new Date() } },
      orderBy: { startDate: 'asc' },
      take: 5,
      include: { _count: { select: { registrations: { where: { status: { in: ['REGISTERED', 'PENDING_PAYMENT'] } } } } } },
    }),
  ]);

  return {
    totals: { totalMembers, pendingApprovals },
    upcomingEvents,
  };
}

module.exports = { getHomeStats, getMainAdminDashboard, getOrganizationAdminDashboard };
