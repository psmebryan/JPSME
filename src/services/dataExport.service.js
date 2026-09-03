const ExcelJS = require('exceljs');
const prisma = require('./../config/prisma');
const organizationService = require('./organization.service');
const paymentService = require('./payment.service');

// One workbook, one sheet per entity, for offline tracking and reporting.
//
// The Organizations and Members sheets are also the import format — the same
// columns are read back by dataImport.service.js, so an export can be edited in
// Excel and re-imported. That round trip is why those two sheets lead with a
// stable key column and why parents are written as a readable path rather than
// a raw id: a spreadsheet someone edits by hand must not depend on database ids
// that mean nothing to them and that they might renumber.
function fmtDateTime(value) {
  return value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '';
}
function fmtDate(value) {
  return value ? new Date(value).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }) : '';
}
function peso(centavos) {
  return typeof centavos === 'number' ? Number((centavos / 100).toFixed(2)) : '';
}

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (sheet.rowCount > 1) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  }
}

async function buildWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JPSME';
  workbook.created = new Date();

  // --- Organizations -------------------------------------------------------
  const orgs = await prisma.organization.findMany({
    orderBy: [{ depth: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { children: true, users: true } } },
  });
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  // Resolved from the materialized path in memory rather than one query per
  // row — an export of a few thousand organizations should not issue a few
  // thousand lookups.
  const labelFor = (org, includeSelf) => organizationService
    .parsePathIds(org.path)
    .slice(0, includeSelf ? undefined : -1)
    .map((id) => (orgById.get(id) || {}).name)
    .filter(Boolean)
    .join(' > ');

  // Two different things, and conflating them corrupts a round trip. An
  // organization's own row needs its PARENT's path (that is what the column
  // means). A member's row needs the FULL path down to and including the
  // organization they belong to — writing the parent there would re-import as
  // "move this member up one level".
  const parentPath = (org) => labelFor(org, false);
  const fullPath = (org) => labelFor(org, true);

  const orgSheet = workbook.addWorksheet('Organizations');
  orgSheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Name', key: 'name', width: 52 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Parent Path', key: 'parentPath', width: 46 },
    { header: 'Code', key: 'code', width: 12 },
    { header: 'Institution', key: 'institution', width: 34 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Active', key: 'isActive', width: 9 },
    { header: 'Needs Review', key: 'needsReview', width: 13 },
    { header: 'Children', key: 'children', width: 10 },
    { header: 'Members', key: 'members', width: 10 },
  ];
  orgs.forEach((o) => orgSheet.addRow({
    id: o.id,
    name: o.name,
    type: o.type,
    parentPath: parentPath(o),
    code: o.code || '',
    institution: o.institution || '',
    email: o.email || '',
    isActive: o.isActive ? 'Yes' : 'No',
    needsReview: o.needsReview ? 'Yes' : 'No',
    children: o._count.children,
    members: o._count.users,
  }));
  styleHeader(orgSheet);

  // --- Members -------------------------------------------------------------
  const users = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } },
    orderBy: { createdAt: 'desc' },
    include: { organization: true },
  });
  const payments = await paymentService.getLatestMembershipStatusForUsers(users.map((u) => u.id));

  const memberSheet = workbook.addWorksheet('Members');
  memberSheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'First Name', key: 'firstName', width: 18 },
    { header: 'M.I.', key: 'middleInitial', width: 6 },
    { header: 'Last Name', key: 'lastName', width: 18 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'School', key: 'school', width: 30 },
    { header: 'Year Level', key: 'yearLevel', width: 12 },
    { header: 'Organization', key: 'organization', width: 40 },
    { header: 'Organization Path', key: 'organizationPath', width: 46 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Membership', key: 'membership', width: 13 },
    { header: 'Membership Expires', key: 'expires', width: 20 },
    { header: 'Last Payment', key: 'payment', width: 14 },
    { header: 'Email Verified', key: 'verified', width: 20 },
    { header: 'Registered', key: 'createdAt', width: 20 },
  ];
  const YEAR = { FIRST: '1st Year', SECOND: '2nd Year', THIRD: '3rd Year', FOURTH: '4th Year' };
  users.forEach((u) => {
    const membership = paymentService.classifyMembership(u, payments.get(u.id));
    memberSheet.addRow({
      id: u.id,
      firstName: u.firstName,
      middleInitial: u.middleInitial || '',
      lastName: u.lastName,
      email: u.email,
      phone: u.phone || '',
      school: u.school || '',
      yearLevel: YEAR[u.yearLevel] || '',
      organization: u.organization ? u.organization.name : '',
      organizationPath: u.organization ? fullPath(u.organization) : '',
      status: u.status,
      membership: membership.tier === 'MEMBER' ? 'Member' : 'Non-Member',
      expires: fmtDate(membership.expiresAt),
      payment: payments.get(u.id) ? payments.get(u.id).status : 'Unpaid',
      verified: fmtDateTime(u.emailVerifiedAt),
      createdAt: fmtDateTime(u.createdAt),
    });
  });
  styleHeader(memberSheet);

  // --- Events --------------------------------------------------------------
  const events = await prisma.event.findMany({
    orderBy: { startDate: 'desc' },
    include: { _count: { select: { registrations: true, invitations: true } } },
  });
  const eventSheet = workbook.addWorksheet('Events');
  eventSheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Title', key: 'title', width: 42 },
    { header: 'Start', key: 'start', width: 20 },
    { header: 'End', key: 'end', width: 20 },
    { header: 'Location', key: 'location', width: 28 },
    { header: 'Modality', key: 'modality', width: 14 },
    { header: 'Capacity', key: 'capacity', width: 10 },
    { header: 'Fee (PHP)', key: 'fee', width: 11 },
    { header: 'Published', key: 'published', width: 11 },
    { header: 'Registrations', key: 'registrations', width: 14 },
    { header: 'Invitations', key: 'invitations', width: 12 },
  ];
  events.forEach((e) => eventSheet.addRow({
    id: e.id,
    title: e.title,
    start: fmtDateTime(e.startDate),
    end: fmtDateTime(e.endDate),
    location: e.location || '',
    modality: e.modality,
    capacity: e.capacity || '',
    fee: peso(e.feeCentavos),
    published: e.isPublished ? 'Yes' : 'No',
    registrations: e._count.registrations,
    invitations: e._count.invitations,
  }));
  styleHeader(eventSheet);

  // --- Registrations -------------------------------------------------------
  const registrations = await prisma.eventRegistration.findMany({
    orderBy: { createdAt: 'desc' },
    include: { event: { select: { title: true } } },
  });
  const regSheet = workbook.addWorksheet('Registrations');
  regSheet.columns = [
    { header: 'Event', key: 'event', width: 42 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'School', key: 'school', width: 30 },
    // The frozen snapshot, not the member's organization today — a member who
    // transfers must still appear here under the one they attended under.
    { header: 'Organization (at registration)', key: 'org', width: 46 },
    { header: 'Status', key: 'status', width: 17 },
    { header: 'Registered', key: 'createdAt', width: 20 },
  ];
  registrations.forEach((r) => regSheet.addRow({
    event: r.event ? r.event.title : '',
    name: r.fullName,
    email: r.email,
    phone: r.phone || '',
    school: r.school || '',
    org: r.organizationPath || '',
    status: r.status,
    createdAt: fmtDateTime(r.createdAt),
  }));
  styleHeader(regSheet);

  // --- Payments ------------------------------------------------------------
  const paymentRows = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: { firstName: true, lastName: true, email: true } },
      event: { select: { title: true } },
    },
  });
  const paySheet = workbook.addWorksheet('Payments');
  paySheet.columns = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Member', key: 'member', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Purpose', key: 'purpose', width: 24 },
    { header: 'Event', key: 'event', width: 34 },
    { header: 'Amount Paid (PHP)', key: 'amount', width: 18 },
    { header: 'Gateway Fee (PHP)', key: 'fee', width: 18 },
    { header: 'Net Received (PHP)', key: 'net', width: 18 },
    { header: 'Status', key: 'status', width: 13 },
    { header: 'Paid At', key: 'paidAt', width: 20 },
    { header: 'Created', key: 'createdAt', width: 20 },
  ];
  paymentRows.forEach((p) => paySheet.addRow({
    id: p.id,
    member: p.user ? `${p.user.firstName} ${p.user.lastName}` : '',
    email: p.user ? p.user.email : '',
    purpose: p.purpose,
    event: p.event ? p.event.title : '',
    amount: peso(p.amount),
    fee: p.status === 'PAID' ? peso(p.gatewayFeeCentavos) : '',
    net: p.status === 'PAID' ? peso(p.amount - p.gatewayFeeCentavos) : '',
    status: p.status,
    paidAt: fmtDateTime(p.paidAt),
    createdAt: fmtDateTime(p.createdAt),
  }));
  styleHeader(paySheet);

  // --- Invitations ---------------------------------------------------------
  const invitations = await prisma.eventInvitation.findMany({
    orderBy: { createdAt: 'desc' },
    include: { event: { select: { title: true } }, user: { select: { membershipExpiresAt: true } } },
  });
  const invSheet = workbook.addWorksheet('Invitations');
  invSheet.columns = [
    { header: 'Event', key: 'event', width: 42 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Type', key: 'type', width: 13 },
    { header: 'Source', key: 'source', width: 15 },
    { header: 'Delivery', key: 'status', width: 12 },
    { header: 'RSVP', key: 'rsvp', width: 14 },
    { header: 'Sent', key: 'sent', width: 20 },
    { header: 'Opened', key: 'opened', width: 20 },
    { header: 'Registered', key: 'registered', width: 20 },
  ];
  invitations.forEach((i) => {
    let type = 'Guest';
    if (i.userId) {
      const exp = i.user && i.user.membershipExpiresAt;
      type = exp && new Date(exp) > new Date() ? 'Member' : 'Non-Member';
    }
    invSheet.addRow({
      event: i.event ? i.event.title : '',
      name: i.fullName,
      email: i.email,
      type,
      source: i.source === 'SELF_REQUESTED' ? 'Requested' : 'Admin-Sent',
      status: i.status,
      rsvp: i.userId ? '' : (i.rsvpStatus || ''),
      sent: fmtDateTime(i.sentAt),
      opened: fmtDateTime(i.openedAt),
      registered: fmtDateTime(i.registeredAt),
    });
  });
  styleHeader(invSheet);

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
