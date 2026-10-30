const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');

// Reports (admin sidebar -> Reports). Read-only; nothing here writes.
//
//   Transaction report        every event registration or every membership
//                             payment, filtered by date range, payment
//                             (online / offline / free), payment status,
//                             student organization, event and a search.
//   Org member summary        members per student organization, with region
//                             and province totals and the top 5.
//   Org event registrations   per student organization: registrations
//                             (registrants) and distinct people (individuals).
//
// Each page's filters live in its URL and its Export uses the same filters,
// so the workbook is exactly what is on screen (every page of it).
//
// Organizations form a tree whose `path` lists every ancestor id
// (/national/region/province/unit/), so a student unit's region and province
// are read from its path rather than stored again.

const PAGE_SIZE = 25;
const ROW_LIMIT = 50000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// --- shared --------------------------------------------------------------------------

const idParam = (v) => (/^[1-9]\d*$/.test(String(v || '')) ? Number(v) : null);
const dateParam = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : null);
const pageParam = (v) => Math.max(1, Math.min(100000, Number.parseInt(v, 10) || 1));
const searchParam = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 100);

// Philippine calendar days: "from" is the start of that day, "to" the end of it.
function dateRange(from, to) {
  const range = {};
  if (from) range.gte = new Date(`${from}T00:00:00+08:00`);
  if (to) range.lt = new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 864e5);
  return Object.keys(range).length ? range : null;
}

// Every word must appear somewhere in the row's text.
function matchesSearch(q, ...fields) {
  if (!q) return true;
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(' ').every((w) => text.includes(w));
}

function paginate(rows, page) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(page, totalPages);
  return { rows: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), page: p, totalPages, total: rows.length, pageSize: PAGE_SIZE };
}

// The organization tree once per request: regions, provinces and student
// units, each unit labelled with its province and region.
async function loadOrgs() {
  const all = await prisma.organization.findMany({
    where: { type: { in: ['REGION', 'PROVINCE', 'STUDENT_UNIT'] } },
    select: { id: true, name: true, type: true, path: true, isActive: true },
    orderBy: { name: 'asc' },
  });
  const byId = new Map(all.map((o) => [o.id, o]));
  const ancestor = (o, type) => String(o.path || '').split('/').filter(Boolean).map(Number)
    .map((id) => byId.get(id)).find((a) => a && a.type === type) || null;
  const label = (o) => {
    if (!o) return { region: null, province: null, regionId: null, provinceId: null };
    const region = o.type === 'REGION' ? o : ancestor(o, 'REGION');
    const province = o.type === 'PROVINCE' ? o : ancestor(o, 'PROVINCE');
    return {
      region: region ? region.name : null, regionId: region ? region.id : null,
      province: province ? province.name : null, provinceId: province ? province.id : null,
    };
  };
  const units = all.filter((o) => o.type === 'STUDENT_UNIT').map((o) => ({ ...o, ...label(o) }));
  return {
    byId,
    label,
    regions: all.filter((o) => o.type === 'REGION'),
    provinces: all.filter((o) => o.type === 'PROVINCE').map((o) => ({ ...o, ...label(o) })),
    units,
    unitById: new Map(units.map((u) => [u.id, u])),
  };
}

// Student units grouped by region, for the filter dropdowns.
function unitsByRegion(orgs) {
  const groups = {};
  orgs.units.forEach((u) => { (groups[u.region || 'No region'] = groups[u.region || 'No region'] || []).push(u); });
  return Object.keys(groups).sort().map((region) => ({ region, units: groups[region] }));
}

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  sheets.forEach(({ name, columns, rows, notes }) => {
    const sheet = wb.addWorksheet(name);
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    rows.forEach((r) => sheet.addRow(r));
    if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    if (notes) {
      sheet.addRow([]);
      notes.forEach((n) => sheet.addRow([n]));
    }
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const peso = { numFmt: '"₱"#,##0.00' };
const ymd = { numFmt: 'yyyy-mm-dd hh:mm' };

// --- transaction report --------------------------------------------------------------

const KINDS = { EVENT: 'Event Registration', MEMBERSHIP: 'Membership Registration' };
const CHANNELS = { ONLINE: 'Online (PayMongo)', OFFLINE: 'Offline (to organizers)', FREE: 'Free' };
const TX_STATUSES = {
  PAID: 'Paid',
  PENDING: 'Pending',
  TO_COLLECT: 'To collect',
  FREE: 'Free',
  FAILED: 'Failed / expired',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

function paymentStatus(s) {
  if (s === 'PAID') return 'PAID';
  if (s === 'PENDING' || s === 'PROCESSING') return 'PENDING';
  if (s === 'REFUNDED') return 'REFUNDED';
  return 'FAILED'; // FAILED, EXPIRED, CANCELLED
}

function parseTransactionFilters(query = {}) {
  const kind = String(query.kind || '').toUpperCase() === 'MEMBERSHIP' ? 'MEMBERSHIP' : 'EVENT';
  return {
    kind,
    from: dateParam(query.from),
    to: dateParam(query.to),
    payment: Object.keys(CHANNELS).includes(String(query.payment || '').toUpperCase()) ? String(query.payment).toUpperCase() : null,
    status: Object.keys(TX_STATUSES).includes(String(query.status || '').toUpperCase()) ? String(query.status).toUpperCase() : null,
    org: query.org === 'NONE' ? 'NONE' : idParam(query.org),
    event: kind === 'EVENT' ? idParam(query.event) : null,
    q: searchParam(query.q),
    page: pageParam(query.page),
  };
}

async function eventTransactions(f, orgs) {
  const created = dateRange(f.from, f.to);
  const regs = await prisma.eventRegistration.findMany({
    where: { ...(created ? { createdAt: created } : {}), ...(f.event ? { eventId: f.event } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ROW_LIMIT,
    select: {
      id: true, userId: true, eventId: true, fullName: true, email: true, status: true, registrationNumber: true,
      feeCentavos: true, feeOptionName: true, organizationId: true, createdAt: true,
      event: { select: { title: true } },
      user: { select: { organizationId: true } },
    },
  });
  // Online payments for these registrations, newest first per person+event.
  const payments = regs.length ? await prisma.payment.findMany({
    where: { purpose: 'EVENT_REGISTRATION', eventId: { in: [...new Set(regs.map((r) => r.eventId))] }, userId: { in: [...new Set(regs.map((r) => r.userId))] } },
    orderBy: { createdAt: 'desc' },
    select: { userId: true, eventId: true, amount: true, status: true, paidAt: true, gatewayPaymentId: true },
  }) : [];
  const latest = new Map();
  payments.forEach((p) => { const k = `${p.userId}:${p.eventId}`; if (!latest.has(k)) latest.set(k, p); });

  return regs.map((r) => {
    const pay = latest.get(`${r.userId}:${r.eventId}`);
    const fee = Number(r.feeCentavos) || 0;
    let channel;
    let status;
    let amount;
    if (pay) {
      channel = 'ONLINE'; status = paymentStatus(pay.status); amount = pay.amount;
    } else if (fee > 0) {
      channel = 'OFFLINE'; status = r.status === 'PENDING_PAYMENT' ? 'PENDING' : 'TO_COLLECT'; amount = fee;
    } else {
      channel = 'FREE'; status = 'FREE'; amount = 0;
    }
    if (r.status === 'CANCELLED' && status !== 'REFUNDED') status = 'CANCELLED';
    const orgId = r.organizationId || (r.user && r.user.organizationId) || null;
    const unit = orgId ? orgs.unitById.get(orgId) : null;
    const org = orgId ? orgs.byId.get(orgId) : null;
    return {
      date: r.createdAt,
      reference: r.registrationNumber || `REG-${r.id}`,
      name: r.fullName,
      email: r.email,
      orgId,
      organization: org ? org.name : null,
      isUnit: Boolean(unit),
      event: r.event ? r.event.title : '',
      option: r.feeOptionName || '',
      amount,
      channel,
      status,
      paidAt: pay && pay.status === 'PAID' ? pay.paidAt : null,
      gatewayRef: pay ? pay.gatewayPaymentId || '' : '',
    };
  });
}

async function membershipTransactions(f, orgs) {
  const created = dateRange(f.from, f.to);
  const payments = await prisma.payment.findMany({
    where: { purpose: 'MEMBERSHIP_REGISTRATION', ...(created ? { createdAt: created } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: ROW_LIMIT,
    select: {
      id: true, amount: true, status: true, paidAt: true, gatewayPaymentId: true, createdAt: true,
      user: { select: { firstName: true, middleInitial: true, lastName: true, email: true, organizationId: true, memberType: { select: { name: true } } } },
    },
  });
  return payments.map((p) => {
    const u = p.user || {};
    const org = u.organizationId ? orgs.byId.get(u.organizationId) : null;
    return {
      date: p.createdAt,
      reference: `membership-${p.id}`,
      name: [u.firstName, u.middleInitial, u.lastName].filter(Boolean).join(' '),
      email: u.email,
      orgId: u.organizationId || null,
      organization: org ? org.name : null,
      event: '',
      option: u.memberType ? u.memberType.name : '',
      amount: p.amount,
      channel: 'ONLINE',
      status: paymentStatus(p.status),
      paidAt: p.status === 'PAID' ? p.paidAt : null,
      gatewayRef: p.gatewayPaymentId || '',
    };
  });
}

async function transactionRows(f) {
  const orgs = await loadOrgs();
  const all = f.kind === 'MEMBERSHIP' ? await membershipTransactions(f, orgs) : await eventTransactions(f, orgs);
  const rows = all.filter((r) => (!f.payment || r.channel === f.payment)
    && (!f.status || r.status === f.status)
    && (f.org === null || (f.org === 'NONE' ? !r.orgId : r.orgId === f.org))
    && matchesSearch(f.q, r.name, r.email, r.reference, r.event, r.organization, r.option, r.gatewayRef));
  return { rows, orgs };
}

function transactionSummary(rows) {
  const sum = (list) => list.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const paid = rows.filter((r) => r.status === 'PAID');
  const pending = rows.filter((r) => r.status === 'PENDING');
  const toCollect = rows.filter((r) => r.status === 'TO_COLLECT');
  return {
    count: rows.length,
    paidCount: paid.length,
    paidAmount: sum(paid),
    pendingCount: pending.length,
    pendingAmount: sum(pending),
    toCollectCount: toCollect.length,
    toCollectAmount: sum(toCollect),
  };
}

async function transactionReport(query) {
  const filters = parseTransactionFilters(query);
  const [{ rows, orgs }, events] = await Promise.all([
    transactionRows(filters),
    prisma.event.findMany({ orderBy: [{ startDate: 'desc' }, { id: 'desc' }], select: { id: true, title: true, startDate: true } }),
  ]);
  return {
    filters,
    summary: transactionSummary(rows),
    ...paginate(rows, filters.page),
    events,
    orgGroups: unitsByRegion(orgs),
    kinds: KINDS,
    channels: CHANNELS,
    statuses: TX_STATUSES,
  };
}

async function exportTransactions(query) {
  const f = parseTransactionFilters(query);
  const { rows } = await transactionRows(f);
  const isEvent = f.kind === 'EVENT';
  const s = transactionSummary(rows);
  return workbook([{
    name: KINDS[f.kind],
    columns: [
      { header: 'Date', key: 'date', width: 18, style: ymd },
      { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Student organization', key: 'organization', width: 32 },
      ...(isEvent ? [{ header: 'Event', key: 'event', width: 32 }, { header: 'Fee option', key: 'option', width: 18 }]
        : [{ header: 'Member type', key: 'option', width: 18 }]),
      { header: 'Amount', key: 'amount', width: 14, style: peso },
      { header: 'Payment', key: 'channel', width: 22 },
      { header: 'Payment status', key: 'status', width: 16 },
      { header: 'Paid on', key: 'paidAt', width: 18, style: ymd },
      { header: 'PayMongo reference', key: 'gatewayRef', width: 26 },
    ],
    rows: rows.map((r) => ({
      ...r,
      date: r.date ? new Date(r.date) : null,
      paidAt: r.paidAt ? new Date(r.paidAt) : null,
      organization: r.organization || '',
      amount: (Number(r.amount) || 0) / 100,
      channel: CHANNELS[r.channel],
      status: TX_STATUSES[r.status],
    })),
    notes: [
      `${rows.length} transactions. Paid: ${s.paidCount} (PHP ${(s.paidAmount / 100).toFixed(2)}). Pending: ${s.pendingCount}. To collect: ${s.toCollectCount} (PHP ${(s.toCollectAmount / 100).toFixed(2)}).`,
      'Online amounts include the PayMongo channel fee the payer was charged.',
    ],
  }]);
}

// --- student organization member summary -----------------------------------------------

function parseScopeFilters(query = {}) {
  return { region: idParam(query.region), org: idParam(query.org), event: idParam(query.event), page: pageParam(query.page) };
}

// The student units a region / organization filter covers.
function scopedUnits(orgs, f) {
  return orgs.units.filter((u) => (!f.region || u.regionId === f.region) && (!f.org || u.id === f.org));
}

async function memberSummaryData(f) {
  const orgs = await loadOrgs();
  const units = scopedUnits(orgs, f);
  const ids = units.map((u) => u.id);
  const now = new Date();
  const [members, active] = ids.length ? await Promise.all([
    prisma.user.groupBy({ by: ['organizationId'], where: { role: { not: 'ADMIN' }, organizationId: { in: ids } }, _count: { _all: true } }),
    prisma.user.groupBy({ by: ['organizationId'], where: { role: { not: 'ADMIN' }, organizationId: { in: ids }, membershipExpiresAt: { gt: now } }, _count: { _all: true } }),
  ]) : [[], []];
  const count = new Map(members.map((m) => [m.organizationId, m._count._all]));
  const activeCount = new Map(active.map((m) => [m.organizationId, m._count._all]));
  const rows = units.map((u) => ({
    id: u.id, region: u.region, province: u.province, name: u.name,
    members: count.get(u.id) || 0, activeMembers: activeCount.get(u.id) || 0,
  })).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));

  // Regions and provinces in scope: everything under the filter, so an empty
  // province still counts as one of the region's provinces.
  let regionCount;
  let provinceCount;
  if (f.org) {
    regionCount = units.filter((u) => u.regionId).length ? 1 : 0;
    provinceCount = units.filter((u) => u.provinceId).length ? 1 : 0;
  } else {
    regionCount = f.region ? orgs.regions.filter((r) => r.id === f.region).length : orgs.regions.length;
    provinceCount = orgs.provinces.filter((p) => !f.region || p.regionId === f.region).length;
  }
  return {
    orgs,
    rows,
    totals: {
      members: rows.reduce((t, r) => t + r.members, 0),
      activeMembers: rows.reduce((t, r) => t + r.activeMembers, 0),
      regions: regionCount,
      provinces: provinceCount,
      studentOrgs: rows.length,
    },
  };
}

async function memberSummary(query) {
  const filters = parseScopeFilters(query);
  const { orgs, rows, totals } = await memberSummaryData(filters);
  return {
    filters,
    totals,
    top: rows.filter((r) => r.members > 0).slice(0, 5),
    ...paginate(rows, filters.page),
    regions: orgs.regions,
    orgGroups: unitsByRegion(orgs),
  };
}

async function exportMemberSummary(query) {
  const f = parseScopeFilters(query);
  const { rows, totals } = await memberSummaryData(f);
  return workbook([
    {
      name: 'Student organizations',
      columns: [
        { header: 'Rank', key: 'rank', width: 7 },
        { header: 'Region', key: 'region', width: 22 },
        { header: 'Province', key: 'province', width: 22 },
        { header: 'Student organization', key: 'name', width: 40 },
        { header: 'Members', key: 'members', width: 12 },
        { header: 'Active memberships', key: 'activeMembers', width: 18 },
      ],
      rows: rows.map((r, i) => ({ ...r, rank: i + 1, region: r.region || '', province: r.province || '' })),
    },
    {
      name: 'Summary',
      columns: [{ header: 'Total', key: 'label', width: 28 }, { header: 'Count', key: 'value', width: 12 }],
      rows: [
        { label: 'Total members', value: totals.members },
        { label: 'Active memberships', value: totals.activeMembers },
        { label: 'Total regions', value: totals.regions },
        { label: 'Total provinces', value: totals.provinces },
        { label: 'Total student organizations', value: totals.studentOrgs },
      ],
    },
  ]);
}

// --- student organization event registrations ------------------------------------------

async function eventRegistrationData(f) {
  const orgs = await loadOrgs();
  const units = scopedUnits(orgs, f);
  const unitIds = new Set(units.map((u) => u.id));
  const regs = await prisma.eventRegistration.findMany({
    where: { status: 'REGISTERED', ...(f.event ? { eventId: f.event } : {}) },
    select: { userId: true, eventId: true, organizationId: true, user: { select: { organizationId: true } } },
    take: ROW_LIMIT * 4,
  });
  const per = new Map(units.map((u) => [u.id, { registrants: 0, people: new Set(), events: new Set() }]));
  const allPeople = new Set();
  let registrants = 0;
  regs.forEach((r) => {
    // The organization recorded when they registered; older rows fall back
    // to the member's current one.
    const orgId = r.organizationId || (r.user && r.user.organizationId);
    if (!unitIds.has(orgId)) return;
    const row = per.get(orgId);
    row.registrants += 1;
    row.people.add(r.userId);
    row.events.add(r.eventId);
    registrants += 1;
    allPeople.add(r.userId);
  });
  const rows = units.map((u) => {
    const r = per.get(u.id);
    return {
      id: u.id, region: u.region, province: u.province, name: u.name,
      registrants: r.registrants, individuals: r.people.size, events: r.events.size,
    };
  }).filter((r) => r.registrants > 0 || f.org)
    .sort((a, b) => b.registrants - a.registrants || b.individuals - a.individuals || a.name.localeCompare(b.name));
  return {
    orgs,
    rows,
    totals: { registrants, individuals: allPeople.size, studentOrgs: rows.filter((r) => r.registrants > 0).length },
  };
}

async function eventRegistrationReport(query) {
  const filters = parseScopeFilters(query);
  const [{ orgs, rows, totals }, events] = await Promise.all([
    eventRegistrationData(filters),
    prisma.event.findMany({ orderBy: [{ startDate: 'desc' }, { id: 'desc' }], select: { id: true, title: true, startDate: true } }),
  ]);
  return {
    filters, totals, ...paginate(rows, filters.page), events, regions: orgs.regions, orgGroups: unitsByRegion(orgs),
  };
}

async function exportEventRegistrations(query) {
  const f = parseScopeFilters(query);
  const { rows, totals } = await eventRegistrationData(f);
  return workbook([{
    name: 'Event registrations',
    columns: [
      { header: 'Region', key: 'region', width: 22 },
      { header: 'Province', key: 'province', width: 22 },
      { header: 'Student organization', key: 'name', width: 40 },
      { header: 'Total registrants', key: 'registrants', width: 18 },
      { header: 'Total individuals', key: 'individuals', width: 18 },
      { header: 'Events', key: 'events', width: 10 },
    ],
    rows: rows.map((r) => ({ ...r, region: r.region || '', province: r.province || '' })),
    notes: [
      `Total registrants: ${totals.registrants}. Total individuals: ${totals.individuals}. Student organizations: ${totals.studentOrgs}.`,
      'Registrants counts every registration; individuals counts each person once. Cancelled and unpaid registrations are not counted.',
    ],
  }]);
}

module.exports = {
  XLSX,
  transactionReport,
  exportTransactions,
  memberSummary,
  exportMemberSummary,
  eventRegistrationReport,
  exportEventRegistrations,
};
