const { google } = require('googleapis');
const config = require('../config');
const prisma = require('../config/prisma');

const SPREADSHEET_ID = config.googleSheets.sheetId;

// Deliberately does NOT require payment.service.js (which requires this file
// to trigger syncs) — that would create a circular require where whichever
// module loads second captures the other's pre-export-assignment {} object.
// Every payment lookup below queries prisma directly instead.

let sheetsClient = null;
function getSheetsClient() {
  if (!sheetsClient) {
    const auth = new google.auth.JWT({
      email: config.googleSheets.serviceAccountEmail,
      key: (config.googleSheets.serviceAccountPrivateKey || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

let warnedNotConfigured = false;
function isConfigured() {
  const configured = !!(SPREADSHEET_ID && config.googleSheets.serviceAccountEmail && config.googleSheets.serviceAccountPrivateKey);
  if (!configured && !warnedNotConfigured) {
    warnedNotConfigured = true;
    console.warn('sheetsSync: GOOGLE_SHEETS_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set — live report sync disabled.');
  }
  return configured;
}

async function listTabs(sheets) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties' });
  return res.data.sheets || [];
}

async function ensureTab(sheets, title) {
  const tabs = await listTabs(sheets);
  const found = tabs.find((s) => s.properties.title === title);
  if (found) return { sheetId: found.properties.sheetId, title };
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return { sheetId: res.data.replies[0].addSheet.properties.sheetId, title };
}

// Event tabs are matched by a stable "Event #<id> " prefix rather than the
// full title, so renaming an event in the admin panel renames its existing
// tab instead of leaving an orphaned duplicate behind.
function eventTabPrefix(eventId) {
  return `Event #${eventId} `;
}
function eventTabTitle(event) {
  const raw = `${eventTabPrefix(event.id)}- ${event.title}`;
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}

async function ensureEventTab(sheets, event) {
  const title = eventTabTitle(event);
  const tabs = await listTabs(sheets);
  const found = tabs.find((s) => s.properties.title.startsWith(eventTabPrefix(event.id)));

  if (found) {
    if (found.properties.title !== title) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ updateSheetProperties: { properties: { sheetId: found.properties.sheetId, title }, fields: 'title' } }],
        },
      });
    }
    return { sheetId: found.properties.sheetId, title };
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return { sheetId: res.data.replies[0].addSheet.properties.sheetId, title };
}

// The one tab this file only ever READS, never writes over (every other tab
// here — Membership, Event #N, Invitations — is a generated report this app
// fully owns and rewrites on every sync). This one is admin-maintained: they
// paste/type in rows of non-member contacts (Name, Email, School, Chapter,
// Company) and the Invitations page pulls them in on demand via "Fetch from
// Google Sheet". Created with just a header row if missing (so the admin
// knows the expected columns), but existing content is never touched.
const CONTACTS_TAB_NAME = 'Contacts to Invite';
const CONTACTS_HEADER = ['Name', 'Email', 'School', 'Chapter', 'Company'];
// Matches createInvitations' own per-request cap — no point fetching more
// than can ever actually be sent in one batch.
const MAX_IMPORTED_CONTACTS = 200;

async function fetchContactsToInvite() {
  if (!isConfigured()) {
    throw new Error('Google Sheets is not configured.');
  }
  const sheets = getSheetsClient();
  const tabs = await listTabs(sheets);
  const exists = tabs.some((s) => s.properties.title === CONTACTS_TAB_NAME);

  if (!exists) {
    await ensureTab(sheets, CONTACTS_TAB_NAME);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${CONTACTS_TAB_NAME}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [CONTACTS_HEADER] },
    });
    return []; // just created — nothing to import yet
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CONTACTS_TAB_NAME}'!A2:E${MAX_IMPORTED_CONTACTS + 1}`,
  });

  return (res.data.values || [])
    .map(([fullName, email, school, chapter, company]) => ({
      fullName: (fullName || '').trim(),
      email: (email || '').trim(),
      school: (school || '').trim() || null,
      chapter: (chapter || '').trim() || null,
      company: (company || '').trim() || null,
    }))
    .filter((c) => c.fullName && c.email); // blank/incomplete rows are silently skipped, not errors
}

async function deleteEventTab(eventId) {
  if (!isConfigured()) return;
  try {
    const sheets = getSheetsClient();
    const tabs = await listTabs(sheets);
    const found = tabs.find((s) => s.properties.title.startsWith(eventTabPrefix(eventId)));
    if (!found) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteSheet: { sheetId: found.properties.sheetId } }] },
    });
  } catch (err) {
    console.error('sheetsSync: failed to delete tab for event', eventId, err.message);
  }
}

// Full-refresh (clear then rewrite) rather than tracking a row-to-record
// mapping for surgical single-cell updates — simpler, always correct, and
// this app's write volume is far below Sheets API quotas even at this rate.
// `columnCount` is the header's column count — used to merge the summary
// banner across the same width and to bound the formatting/auto-resize
// requests below.
async function writeTab(sheets, sheetId, title, rows, columnCount) {
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `'${title}'!A1:Z10000` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  // Formatting pass: everything left-aligned (numeric ID/Amount columns
  // default to right-aligned otherwise, which reads inconsistently next to
  // text columns), header row bold, summary banner merged+bold across the
  // full width instead of a single cell overflowing into empty neighbors,
  // and columns auto-resized so long emails/timestamps don't get clipped.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: columnCount },
            cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        },
        {
          mergeCells: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
            mergeType: 'MERGE_ALL',
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.92, green: 0.94, blue: 1 } } },
            fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: columnCount },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount },
          },
        },
      ],
    },
  });
}

function pct(numerator, denominator) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function timestamp() {
  return new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

async function syncMembership() {
  if (!isConfigured()) return;
  try {
    const sheets = getSheetsClient();
    const { sheetId, title } = await ensureTab(sheets, 'Membership');

    const users = await prisma.user.findMany({
      where: { role: { not: 'ADMIN' } },
      include: { organization: true },
      orderBy: { createdAt: 'desc' },
    });

    const payments = users.length
      ? await prisma.payment.findMany({
          where: { userId: { in: users.map((u) => u.id) }, purpose: 'MEMBERSHIP_REGISTRATION' },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const latestPaymentByUser = new Map();
    payments.forEach((p) => {
      if (!latestPaymentByUser.has(p.userId)) latestPaymentByUser.set(p.userId, p); // first hit per user = most recent (already desc-sorted)
    });

    const counts = { APPROVED: 0, PENDING: 0, REJECTED: 0 };
    users.forEach((u) => { counts[u.status] = (counts[u.status] || 0) + 1; });
    const total = users.length;

    const summary = [
      `Total: ${total}`,
      `Approved: ${counts.APPROVED} (${pct(counts.APPROVED, total)})`,
      `Pending: ${counts.PENDING} (${pct(counts.PENDING, total)})`,
      `Rejected: ${counts.REJECTED} (${pct(counts.REJECTED, total)})`,
      `Last updated: ${timestamp()}`,
    ].join('   |   ');

    const header = ['ID', 'Name', 'Email', 'Organization', 'Status', 'Payment Status', 'Registered At'];
    const rows = users.map((u) => {
      const payment = latestPaymentByUser.get(u.id);
      return [
        u.id,
        `${u.firstName} ${u.lastName}`,
        u.email,
        (u.organization && u.organization.name) || '-',
        u.status,
        payment ? payment.status : 'N/A',
        new Date(u.createdAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
      ];
    });

    await writeTab(sheets, sheetId, title, [[summary], [], header, ...rows], header.length);
  } catch (err) {
    console.error('sheetsSync: failed to sync Membership tab:', err.message);
  }
}

// One tab per event, same reasoning as ensureEventTab for registrations: a
// single cross-event tab grows unbounded as invitation volume increases
// across many events, eventually flooding one sheet with rows that don't
// even belong to the event the admin is currently looking at. Matched by a
// stable "Invites #<id> " prefix (not the full title) for the same reason
// event tabs are — renaming the event renames its tab instead of orphaning
// a duplicate. Kept as a visually distinct tab from "Event #<id> - <title>"
// (registrations) rather than merged into it, since invitees and registrants
// are overlapping but different sets of people.
function eventInvitationsTabPrefix(eventId) {
  return `Invites #${eventId} `;
}
function eventInvitationsTabTitle(event) {
  const raw = `${eventInvitationsTabPrefix(event.id)}- ${event.title}`;
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}

async function ensureEventInvitationsTab(sheets, event) {
  const title = eventInvitationsTabTitle(event);
  const tabs = await listTabs(sheets);
  const found = tabs.find((s) => s.properties.title.startsWith(eventInvitationsTabPrefix(event.id)));

  if (found) {
    if (found.properties.title !== title) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ updateSheetProperties: { properties: { sheetId: found.properties.sheetId, title }, fields: 'title' } }],
        },
      });
    }
    return { sheetId: found.properties.sheetId, title };
  }

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return { sheetId: res.data.replies[0].addSheet.properties.sheetId, title };
}

async function deleteEventInvitationsTab(eventId) {
  if (!isConfigured()) return;
  try {
    const sheets = getSheetsClient();
    const tabs = await listTabs(sheets);
    const found = tabs.find((s) => s.properties.title.startsWith(eventInvitationsTabPrefix(eventId)));
    if (!found) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteSheet: { sheetId: found.properties.sheetId } }] },
    });
  } catch (err) {
    console.error('sheetsSync: failed to delete invitations tab for event', eventId, err.message);
  }
}

async function syncInvitations(eventId) {
  if (!isConfigured()) return;
  try {
    const sheets = getSheetsClient();
    const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
    if (!event) return; // event was deleted mid-flight (its tab is removed separately by deleteEventInvitationsTab)

    const { sheetId, title } = await ensureEventInvitationsTab(sheets, event);

    const invitations = await prisma.eventInvitation.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'desc' },
    });

    const total = invitations.length;
    const sentCount = invitations.filter((i) => i.sentAt).length;
    const registeredCount = invitations.filter((i) => i.registeredAt).length;
    const requestedCount = invitations.filter((i) => i.source === 'SELF_REQUESTED').length;
    const attendingNotRegistered = invitations.filter((i) => !i.userId && i.rsvpStatus === 'ATTENDING' && !i.registeredAt).length;

    const summary = [
      `Total: ${total}`,
      `Sent: ${sentCount}`,
      `Registered: ${registeredCount} (${pct(registeredCount, total)})`,
      `Requested: ${requestedCount}`,
      `Attending but Not Registered: ${attendingNotRegistered}`,
      `Last updated: ${timestamp()}`,
    ].join('   |   ');

    const rsvpLabels = { ATTENDING: 'Attending', NOT_ATTENDING: 'Not Attending', PENDING: 'No response' };
    const header = ['Name', 'Email', 'Chapter', 'School', 'Company', 'Type', 'Source', 'Delivery Status', 'Sent At', 'Opened At', 'Clicked At', 'RSVP', 'Registered At'];
    const rows = invitations.map((i) => [
      i.fullName,
      i.email,
      i.chapter || '-',
      i.school || '-',
      i.company || '-',
      i.userId ? 'Member' : 'Guest',
      i.source === 'SELF_REQUESTED' ? 'Requested' : 'Admin-Sent',
      i.status,
      i.sentAt ? new Date(i.sentAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '-',
      i.openedAt ? new Date(i.openedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '-',
      i.clickedAt ? new Date(i.clickedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '-',
      i.userId ? '-' : (rsvpLabels[i.rsvpStatus] || i.rsvpStatus),
      i.registeredAt ? new Date(i.registeredAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '-',
    ]);

    await writeTab(sheets, sheetId, title, [[summary], [], header, ...rows], header.length);
  } catch (err) {
    console.error('sheetsSync: failed to sync invitations tab for event', eventId, err.message);
  }
}

async function syncEventRegistrations(eventId) {
  if (!isConfigured()) return;
  try {
    const sheets = getSheetsClient();
    const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
    if (!event) return; // event was deleted mid-flight (its tab is removed separately by deleteEventTab)

    const { sheetId, title } = await ensureEventTab(sheets, event);

    const registrations = await prisma.eventRegistration.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'desc' },
    });
    const hasFee = event.feeCentavos > 0;

    const payments = hasFee
      ? await prisma.payment.findMany({
          where: { eventId: event.id, purpose: 'EVENT_REGISTRATION' },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const latestPaymentByUser = new Map();
    payments.forEach((p) => {
      if (!latestPaymentByUser.has(p.userId)) latestPaymentByUser.set(p.userId, p);
    });

    const activeCount = registrations.filter((r) => r.status === 'REGISTERED' || r.status === 'PENDING_PAYMENT').length;
    const paidCount = registrations.filter((r) => {
      const p = latestPaymentByUser.get(r.userId);
      return p && p.status === 'PAID';
    }).length;

    const summary = [
      `Capacity: ${event.capacity || 'Unlimited'}`,
      `Registered: ${activeCount}`,
      event.capacity ? `Capacity Filled: ${pct(activeCount, event.capacity)}` : null,
      hasFee ? `Paid: ${paidCount}/${registrations.length}` : 'Free Event',
      hasFee ? `Payment Completion: ${pct(paidCount, registrations.length)}` : null,
      `Last updated: ${timestamp()}`,
    ].filter(Boolean).join('   |   ');

    // "Amount Paid" is the actual charge on that registrant's own Payment row,
    // not a static event.feeCentavos lookup — since the payer now covers
    // PayMongo's surcharge on top of the fee, the real amount charged can
    // differ registrant-to-registrant (e.g. if the surcharge rate changed
    // between two people registering). "Fee Deducted"/"Net Received" mirror
    // the admin Payments report, sourced from PayMongo's own reported fee
    // once each payment actually settles (0/blank before then).
    // Organization comes from the registration's own frozen snapshot, never a
    // live lookup through the user — that is the whole reason the column
    // exists. A member who transfers to another chapter after this event must
    // still appear here under the organization they actually attended under.
    const header = ['Name', 'Email', 'Phone', 'School', 'Organization', 'Status', 'Payment Status', 'Amount Paid', 'Fee Deducted', 'Net Received', 'Registered At'];
    const rows = registrations.map((r) => {
      const p = latestPaymentByUser.get(r.userId);
      const isPaid = p && p.status === 'PAID';
      return [
        r.fullName,
        r.email,
        r.phone || '-',
        r.school || '-',
        r.organizationPath || '-',
        r.status,
        hasFee ? (p ? p.status : 'N/A') : 'FREE',
        hasFee && p ? `PHP ${(p.amount / 100).toFixed(2)}` : (hasFee ? '-' : 'FREE'),
        hasFee && isPaid ? `PHP ${(p.gatewayFeeCentavos / 100).toFixed(2)}` : '-',
        hasFee && isPaid ? `PHP ${((p.amount - p.gatewayFeeCentavos) / 100).toFixed(2)}` : '-',
        new Date(r.createdAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
      ];
    });

    await writeTab(sheets, sheetId, title, [[summary], [], header, ...rows], header.length);
  } catch (err) {
    console.error('sheetsSync: failed to sync event tab for event', eventId, err.message);
  }
}

module.exports = { syncMembership, syncEventRegistrations, syncInvitations, fetchContactsToInvite, deleteEventTab, deleteEventInvitationsTab, isConfigured };
