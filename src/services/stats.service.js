const prisma = require('../config/prisma');
const auditService = require('./audit.service');

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
    chapters,
    auditLogPage,
    upcomingEvents,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', status: 'APPROVED' } }),
    prisma.user.count({ where: { role: 'USER', status: 'PENDING' } }),
    prisma.event.count(),
    prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
    prisma.user.findMany({ where: { role: 'USER', createdAt: { gte: windowStart } }, select: { createdAt: true } }),
    prisma.payment.findMany({ where: { status: 'PAID', paidAt: { gte: windowStart } }, select: { paidAt: true, amount: true } }),
    prisma.chapter.findMany({
      where: { isActive: true },
      select: { id: true, name: true, _count: { select: { users: { where: { role: 'USER', status: 'APPROVED' } } } } },
    }),
    auditService.listAuditLogs({ page: 1 }),
    prisma.event.findMany({
      where: { isPublished: true, startDate: { gte: new Date() } },
      orderBy: { startDate: 'asc' },
      take: 5,
      include: { _count: { select: { registrations: { where: { status: { in: ['REGISTERED', 'PENDING_PAYMENT'] } } } } } },
    }),
  ]);

  const membersByChapter = chapters
    .map((c) => ({ name: c.name, count: c._count.users }))
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
    membersByChapter,
    recentActivity: auditLogPage.logs.slice(0, 8),
    upcomingEvents,
  };
}

// CHAPTER_ADMIN dashboard — scoped to their own chapter, no payment/revenue
// data (matches the zero-payment-access rule enforced everywhere else).
async function getChapterAdminDashboard(chapterId) {
  const [totalMembers, pendingApprovals, upcomingEvents] = await Promise.all([
    prisma.user.count({ where: { role: 'USER', status: 'APPROVED', chapterId: Number(chapterId) } }),
    prisma.user.count({ where: { role: 'USER', status: 'PENDING', chapterId: Number(chapterId) } }),
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

module.exports = { getHomeStats, getMainAdminDashboard, getChapterAdminDashboard };
