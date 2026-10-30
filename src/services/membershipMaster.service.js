const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const { isLifetime } = require('./membership.service');

// Membership Master (Master List -> Membership).
//
//   Every member account (admins excluded) with its member type, student
//   organization, account status and membership status, filtered by student
//   organization, member type, membership status and a name/email search.
//   The same filters drive the page, its counts and the .xlsx export.
//
//   Membership status, derived (nothing new is stored):
//     ACTIVE   membershipExpiresAt is in the future (lifetime included)
//     PENDING  not active, but a membership payment is under way
//              (PENDING/PROCESSING), i.e. waiting for PayMongo to confirm
//     EXPIRED  had a membership that has lapsed, nothing under way
//     NONE     never had one, nothing under way
//
//   "Approved" is when the latest membership payment was confirmed (paid).

const PAGE_SIZE = 25;
const EXPORT_LIMIT = 20000;
const STATUSES = ['ACTIVE', 'PENDING', 'EXPIRED', 'NONE'];
const STATUS_LABELS = { ACTIVE: 'Active', PENDING: 'Pending', EXPIRED: 'Expired', NONE: 'No membership' };
const MEMBERSHIP = 'MEMBERSHIP_REGISTRATION';
const UNDER_WAY = ['PENDING', 'PROCESSING'];

const pendingPayment = { some: { purpose: MEMBERSHIP, status: { in: UNDER_WAY } } };
const noPendingPayment = { none: { purpose: MEMBERSHIP, status: { in: UNDER_WAY } } };

function statusWhere(status, now) {
  if (status === 'ACTIVE') return { membershipExpiresAt: { gt: now } };
  if (status === 'PENDING') {
    return { OR: [{ membershipExpiresAt: null }, { membershipExpiresAt: { lte: now } }], payments: pendingPayment };
  }
  if (status === 'EXPIRED') return { membershipExpiresAt: { lte: now }, payments: noPendingPayment };
  if (status === 'NONE') return { membershipExpiresAt: null, payments: noPendingPayment };
  return null;
}

// Cleans the query string into filters; anything unrecognised is ignored.
function parseFilters(query = {}) {
  const q = String(query.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const org = query.org === 'NONE' ? 'NONE' : (/^[1-9]\d*$/.test(String(query.org || '')) ? Number(query.org) : null);
  const type = query.type === 'NONE' ? 'NONE' : (/^[1-9]\d*$/.test(String(query.type || '')) ? Number(query.type) : null);
  const status = STATUSES.includes(String(query.status || '').toUpperCase()) ? String(query.status).toUpperCase() : null;
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  return { q, org, type, status, page };
}

// Everything except the membership status, so the counts can show how the
// current selection splits across statuses.
function baseWhere({ q, org, type }) {
  const and = [{ role: { not: 'ADMIN' } }];
  if (org === 'NONE') and.push({ organizationId: null });
  else if (org) and.push({ organizationId: org });
  if (type === 'NONE') and.push({ memberTypeId: null });
  else if (type) and.push({ memberTypeId: type });
  // Every word must match a name part or the email, so "juan cruz" finds Juan
  // Dela Cruz.
  q.split(' ').filter(Boolean).forEach((word) => {
    and.push({
      OR: [
        { firstName: { contains: word } },
        { middleInitial: { contains: word } },
        { lastName: { contains: word } },
        { email: { contains: word } },
      ],
    });
  });
  return { AND: and };
}

function whereFor(filters, now = new Date()) {
  const base = baseWhere(filters);
  const status = filters.status ? statusWhere(filters.status, now) : null;
  return status ? { AND: [...base.AND, status] } : base;
}

const SELECT = {
  id: true,
  firstName: true,
  middleInitial: true,
  lastName: true,
  email: true,
  status: true,
  membershipExpiresAt: true,
  memberType: { select: { name: true } },
  organization: { select: { name: true, type: true } },
  payments: {
    where: { purpose: MEMBERSHIP, status: { in: ['PAID', ...UNDER_WAY] } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { status: true, paidAt: true },
  },
};

function present(u, now) {
  const paid = u.payments.filter((p) => p.status === 'PAID' && p.paidAt)
    .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))[0];
  const underWay = u.payments.some((p) => UNDER_WAY.includes(p.status));
  const exp = u.membershipExpiresAt;
  let membershipStatus = 'NONE';
  if (exp && new Date(exp) > now) membershipStatus = 'ACTIVE';
  else if (underWay) membershipStatus = 'PENDING';
  else if (exp) membershipStatus = 'EXPIRED';
  return {
    id: u.id,
    firstName: u.firstName,
    middleName: u.middleInitial || '',
    lastName: u.lastName,
    email: u.email,
    memberType: u.memberType ? u.memberType.name : null,
    organization: u.organization ? u.organization.name : null,
    approvedAt: paid ? paid.paidAt : null,
    expiresAt: exp || null,
    lifetime: Boolean(exp && isLifetime(exp)),
    accountStatus: u.status,
    membershipStatus,
    membershipLabel: STATUS_LABELS[membershipStatus],
  };
}

async function counts(filters, now) {
  const base = baseWhere(filters);
  const [all, ...each] = await Promise.all([
    prisma.user.count({ where: base }),
    ...STATUSES.map((s) => prisma.user.count({ where: { AND: [...base.AND, statusWhere(s, now)] } })),
  ]);
  const out = { ALL: all };
  STATUSES.forEach((s, i) => { out[s] = each[i]; });
  return out;
}

async function listMemberships(query) {
  const filters = parseFilters(query);
  const now = new Date();
  const where = whereFor(filters, now);
  const [total, rows, totals] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      select: SELECT,
      skip: (filters.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    counts(filters, now),
  ]);
  return {
    filters,
    members: rows.map((u) => present(u, now)),
    total,
    page: filters.page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: totals,
  };
}

const ACCOUNT_LABELS = { PENDING: 'Pending approval', APPROVED: 'Approved', REJECTED: 'Rejected' };

// The filtered list as a workbook, every row (not one page).
async function exportMembershipsExcel(query) {
  const filters = parseFilters(query);
  const now = new Date();
  const rows = await prisma.user.findMany({
    where: whereFor(filters, now),
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    select: SELECT,
    take: EXPORT_LIMIT,
  });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Membership');
  sheet.columns = [
    { header: 'First name', key: 'firstName', width: 18 },
    { header: 'Middle name', key: 'middleName', width: 12 },
    { header: 'Last name', key: 'lastName', width: 18 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Member type', key: 'memberType', width: 20 },
    { header: 'Student organization', key: 'organization', width: 32 },
    { header: 'Approved', key: 'approvedAt', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Expiration', key: 'expiresAt', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Account status', key: 'accountStatus', width: 18 },
    { header: 'Membership status', key: 'membershipStatus', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  rows.map((u) => present(u, now)).forEach((m) => {
    sheet.addRow({
      ...m,
      memberType: m.memberType || '',
      organization: m.organization || '',
      approvedAt: m.approvedAt ? new Date(m.approvedAt) : null,
      expiresAt: m.lifetime ? 'Lifetime' : (m.expiresAt ? new Date(m.expiresAt) : null),
      accountStatus: ACCOUNT_LABELS[m.accountStatus] || m.accountStatus,
      membershipStatus: m.membershipLabel,
    });
  });
  sheet.autoFilter = { from: 'A1', to: 'J1' };
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  ACCOUNT_LABELS,
  parseFilters,
  listMemberships,
  exportMembershipsExcel,
};
