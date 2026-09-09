const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Reporting on the door, kept apart from checkin.service.js on purpose. That
// file runs a live entrance and every query in it sits on a hot path; this one
// runs afterwards, reads widely, and aggregates. Mixing them would put report
// queries one careless import away from a scanner queue.
//
// Everything here reads the EventCheckIn log rather than recomputing from
// registrations, because the questions worth asking after an event are about
// attempts, not just outcomes: how many people were turned away, at which
// entrance, and how often somebody tried a code that was never ours.

const RESULTS = [
  'SUCCESS', 'ALREADY_CHECKED_IN', 'INVALID_QR', 'WRONG_EVENT',
  'NOT_REGISTERED', 'CANCELLED', 'UNPAID', 'REJECTED', 'UNDONE',
];

const PAGE_SIZE = 50;

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'medium' });
}

async function getEvent(eventId) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  return event;
}

// --- aggregates -------------------------------------------------------------

// One row per result value, including the ones that did not happen. A report
// that silently omits "WRONG_EVENT: 0" reads as though the question was never
// asked, which is a different thing from the answer being none.
async function getResultBreakdown(eventId) {
  const grouped = await prisma.eventCheckIn.groupBy({
    by: ['result'],
    where: { eventId: Number(eventId) },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(grouped.map((g) => [g.result, g._count._all]));
  return RESULTS.map((result) => ({ result, count: counts[result] || 0 }));
}

// Scans per entrance. Counts every attempt and, separately, the ones that
// actually admitted somebody — a station with a high total and a low success
// count is usually a station pointed at the wrong queue, which is worth seeing.
//
// Undone check-ins get their own column rather than joining "refused". They are
// the opposite of a refusal: somebody was let in and then taken back out, and
// folding the two together would make a station that corrected two mistakes
// look identical to one that turned two people away.
async function getStationBreakdown(eventId) {
  const grouped = await prisma.eventCheckIn.groupBy({
    by: ['scannerIdentifier', 'result'],
    where: { eventId: Number(eventId) },
    _count: { _all: true },
  });

  const stations = new Map();
  grouped.forEach((row) => {
    const key = row.scannerIdentifier || '(unnamed station)';
    const entry = stations.get(key) || {
      station: key, total: 0, admitted: 0, refused: 0, undone: 0,
    };
    entry.total += row._count._all;
    if (row.result === 'SUCCESS') entry.admitted += row._count._all;
    else if (row.result === 'UNDONE') entry.undone += row._count._all;
    else entry.refused += row._count._all;
    stations.set(key, entry);
  });

  return [...stations.values()].sort((a, b) => b.total - a.total);
}

// The scan log itself, newest first. Filterable by result and station because
// those are the two questions actually asked afterwards: "show me everything
// that was refused" and "what happened at entrance 2".
async function listScans(eventId, { result, station, page = 1 } = {}) {
  const where = { eventId: Number(eventId) };
  if (result) where.result = result;
  if (station) {
    // The sentinel used in the breakdown above has to map back to a real query,
    // or filtering by "(unnamed station)" would silently return everything.
    where.scannerIdentifier = station === '(unnamed station)' ? null : station;
  }

  const [total, scans] = await Promise.all([
    prisma.eventCheckIn.count({ where }),
    prisma.eventCheckIn.findMany({
      where,
      orderBy: { scannedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        eventRegistration: { select: { fullName: true, registrationNumber: true, status: true } },
        scanner: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  return { scans, total, page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

// --- registration-side views ------------------------------------------------

async function getCheckedIn(eventId) {
  return prisma.eventRegistration.findMany({
    where: { eventId: Number(eventId), status: 'REGISTERED', checkedInAt: { not: null } },
    orderBy: { checkedInAt: 'asc' },
    select: {
      fullName: true, email: true, registrationNumber: true,
      organizationPath: true, checkedInAt: true, id: true,
    },
  });
}

// Confirmed registrations that never came through a door. The list an organiser
// actually wants the morning after.
async function getNotCheckedIn(eventId) {
  return prisma.eventRegistration.findMany({
    where: { eventId: Number(eventId), status: 'REGISTERED', checkedInAt: null },
    orderBy: { fullName: 'asc' },
    select: {
      fullName: true, email: true, phone: true, registrationNumber: true,
      organizationPath: true, id: true,
    },
  });
}

async function getReportSummary(eventId) {
  const id = Number(eventId);
  const [registered, checkedIn, scanTotal, resultBreakdown, stations] = await Promise.all([
    prisma.eventRegistration.count({ where: { eventId: id, status: 'REGISTERED' } }),
    prisma.eventRegistration.count({ where: { eventId: id, status: 'REGISTERED', checkedInAt: { not: null } } }),
    prisma.eventCheckIn.count({ where: { eventId: id } }),
    getResultBreakdown(id),
    getStationBreakdown(id),
  ]);

  return {
    registered,
    checkedIn,
    notCheckedIn: registered - checkedIn,
    rate: registered ? Math.round((checkedIn / registered) * 10000) / 100 : 0,
    scanTotal,
    resultBreakdown,
    stations,
  };
}

// --- export -----------------------------------------------------------------

function styleHeader(sheet) {
  sheet.getRow(1).font = { bold: true };
}

// One workbook, five sheets, rather than five separate downloads. An organiser
// reconciling an event wants the summary and the lists side by side; handing
// them files one at a time makes them do the joining.
async function exportReportExcel(eventId) {
  const event = await getEvent(eventId);
  const [summary, checkedIn, notCheckedIn, allScans] = await Promise.all([
    getReportSummary(eventId),
    getCheckedIn(eventId),
    getNotCheckedIn(eventId),
    prisma.eventCheckIn.findMany({
      where: { eventId: Number(eventId) },
      orderBy: { scannedAt: 'asc' },
      include: {
        eventRegistration: { select: { fullName: true, registrationNumber: true } },
        scanner: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  const workbook = new ExcelJS.Workbook();

  // Summary
  const s = workbook.addWorksheet('Summary');
  s.columns = [{ header: 'Measure', key: 'k', width: 32 }, { header: 'Value', key: 'v', width: 40 }];
  styleHeader(s);
  s.addRow({ k: 'Event', v: event.title });
  s.addRow({ k: 'Event date', v: fmt(event.startDate) });
  s.addRow({ k: 'Report generated', v: fmt(new Date()) });
  s.addRow({ k: '', v: '' });
  s.addRow({ k: 'Confirmed registrations', v: summary.registered });
  s.addRow({ k: 'Checked in', v: summary.checkedIn });
  s.addRow({ k: 'Did not attend', v: summary.notCheckedIn });
  s.addRow({ k: 'Attendance rate', v: `${summary.rate}%` });
  s.addRow({ k: 'Total scans (all outcomes)', v: summary.scanTotal });
  s.addRow({ k: '', v: '' });
  summary.resultBreakdown.forEach((r) => s.addRow({ k: `Scans — ${r.result}`, v: r.count }));

  // Checked in
  const ci = workbook.addWorksheet('Checked In');
  ci.columns = [
    { header: 'Registration No.', key: 'no', width: 20 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Organization', key: 'org', width: 40 },
    { header: 'Checked In At', key: 'at', width: 24 },
  ];
  styleHeader(ci);
  checkedIn.forEach((r) => ci.addRow({
    no: r.registrationNumber || '', name: r.fullName, email: r.email,
    org: r.organizationPath || '', at: fmt(r.checkedInAt),
  }));

  // Not checked in
  const nci = workbook.addWorksheet('Not Checked In');
  nci.columns = [
    { header: 'Registration No.', key: 'no', width: 20 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Organization', key: 'org', width: 40 },
  ];
  styleHeader(nci);
  notCheckedIn.forEach((r) => nci.addRow({
    no: r.registrationNumber || '', name: r.fullName, email: r.email,
    phone: r.phone || '', org: r.organizationPath || '',
  }));

  // Every scan, including the refusals — this is the sheet that answers
  // "what actually happened at the door", which the two lists above cannot.
  const sc = workbook.addWorksheet('All Scans');
  sc.columns = [
    { header: 'Time', key: 'at', width: 24 },
    { header: 'Result', key: 'result', width: 22 },
    { header: 'Action', key: 'action', width: 18 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Registration No.', key: 'no', width: 20 },
    { header: 'Station', key: 'station', width: 20 },
    { header: 'Operator', key: 'op', width: 26 },
  ];
  styleHeader(sc);
  allScans.forEach((r) => sc.addRow({
    at: fmt(r.scannedAt),
    result: r.result,
    action: r.action,
    // An INVALID_QR scan has no registration behind it by definition, so the
    // name column is legitimately empty rather than missing data.
    name: r.eventRegistration ? r.eventRegistration.fullName : '',
    no: r.eventRegistration ? (r.eventRegistration.registrationNumber || '') : '',
    station: r.scannerIdentifier || '',
    op: r.scanner ? `${r.scanner.firstName} ${r.scanner.lastName}` : '',
  }));

  // Stations
  const st = workbook.addWorksheet('Stations');
  st.columns = [
    { header: 'Station', key: 'station', width: 24 },
    { header: 'Total Scans', key: 'total', width: 14 },
    { header: 'Admitted', key: 'admitted', width: 14 },
    { header: 'Refused', key: 'refused', width: 14 },
    { header: 'Undone', key: 'undone', width: 14 },
  ];
  styleHeader(st);
  summary.stations.forEach((r) => st.addRow(r));

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  RESULTS,
  PAGE_SIZE,
  getEvent,
  getResultBreakdown,
  getStationBreakdown,
  listScans,
  getCheckedIn,
  getNotCheckedIn,
  getReportSummary,
  exportReportExcel,
};
