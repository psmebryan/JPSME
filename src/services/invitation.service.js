const crypto = require('crypto');
const ExcelJS = require('exceljs');
const config = require('../config');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const mailService = require('./mail.service');
const sheetsSyncService = require('./sheetsSync.service');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Best-effort — never lets a mail-provider failure block the admin's bulk
// "invite" action from finishing for the other recipients. Persists the
// outcome onto the row itself rather than throwing, so the caller can just
// fire this per-invitation without a try/catch of its own.
async function sendInvitation(invitation, event) {
  try {
    await mailService.sendEventInvitationEmail(invitation, event);
    return prisma.eventInvitation.update({
      where: { id: invitation.id },
      data: { status: 'SENT', sentAt: new Date(), failureReason: null },
    });
  } catch (err) {
    console.error('Failed to send event invitation to', invitation.email, ':', err.message);
    return prisma.eventInvitation.update({
      where: { id: invitation.id },
      data: { status: 'FAILED', failureReason: String(err.message || 'Send failed').slice(0, 191) },
    });
  }
}

// invitees: [{ userId?, fullName, email, chapter?, school?, company?, source? }].
// source defaults to ADMIN_SENT; the public self-service endpoint is the only
// caller that ever passes 'SELF_REQUESTED' (see invitation.api.js). Re-inviting an
// email already invited to this event reuses the existing row (idempotent —
// @@unique([eventId, email]) backs this) rather than creating a duplicate or
// resetting its tracking history; only genuinely new invitees get sent here.
async function createInvitations(eventId, invitees) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const results = [];
  // Sequential — this is an admin-initiated bulk action of modest size
  // (dozens, not thousands), and keeps outbound send calls to Brevo gentle
  // rather than bursting them all at once.
  // eslint-disable-next-line no-restricted-syntax
  for (const invitee of invitees) {
    const email = String(invitee.email || '').trim().toLowerCase();
    if (!email || !invitee.fullName) continue; // eslint-disable-line no-continue

    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.eventInvitation.findUnique({
      where: { eventId_email: { eventId: event.id, email } },
    });
    if (existing) {
      results.push(existing);
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    const created = await prisma.eventInvitation.create({
      data: {
        eventId: event.id,
        userId: invitee.userId ? Number(invitee.userId) : null,
        fullName: invitee.fullName,
        email,
        chapter: invitee.chapter || null,
        school: invitee.school || null,
        company: invitee.company || null,
        source: invitee.source === 'SELF_REQUESTED' ? 'SELF_REQUESTED' : 'ADMIN_SENT',
        token: generateToken(),
      },
    });
    // eslint-disable-next-line no-await-in-loop
    const sent = await sendInvitation(created, event);
    results.push(sent);
  }

  sheetsSyncService.syncInvitations(event.id);
  return results;
}

async function resendInvitation(invitationId) {
  const invitation = await prisma.eventInvitation.findUnique({
    where: { id: Number(invitationId) },
    include: { event: true },
  });
  if (!invitation) throw new AppError('Invitation not found', 404);
  if (invitation.registeredAt) throw new AppError('This person has already registered — nothing to resend.', 409);
  const result = await sendInvitation(invitation, invitation.event);
  sheetsSyncService.syncInvitations(invitation.eventId);
  return result;
}

async function listInvitationsForEvent(eventId) {
  return prisma.eventInvitation.findMany({
    where: { eventId: Number(eventId) },
    orderBy: { createdAt: 'desc' },
  });
}

// Lightweight (email + status only) — backs the "Existing Members" picker's
// already-invited map on the Invitations page. Needs every invitation for
// the event regardless of the report table's current page, or a member
// invited on, say, page 2 would misleadingly show as "not yet invited" and
// the admin could re-add them to the pending list.
async function getInvitedEmailStatusesForEvent(eventId) {
  const rows = await prisma.eventInvitation.findMany({
    where: { eventId: Number(eventId) },
    select: { email: true, status: true },
  });
  return rows;
}

// Default view for the Invitations admin page before an event is picked from
// the dropdown — every invitation across every event, newest first. Includes
// the event's own title/id since nothing else on this cross-event view
// implies which event each row belongs to.
async function listAllInvitations() {
  return prisma.eventInvitation.findMany({
    orderBy: { createdAt: 'desc' },
    include: { event: { select: { id: true, title: true } } },
  });
}

const INVITATION_SORT_FIELDS = { name: 'fullName', sent: 'sentAt', opened: 'openedAt', clicked: 'clickedAt', registered: 'registeredAt' };

// Paginated + filtered + sorted — backs the admin Invitations Report table
// (both the cross-event view, eventId omitted, and the per-event view).
// listAllInvitations/listInvitationsForEvent above stay unbounded on purpose:
// they back the Excel export and the source-breakdown summary below, both of
// which need every matching row at once regardless of the table's current
// page/filter.
async function listInvitationsForAdmin({ eventId, chapter, school, type, status, source, sort, dir, page = 1, pageSize = 25 } = {}) {
  const where = {};
  if (eventId) where.eventId = Number(eventId);
  if (chapter) where.chapter = chapter;
  if (school) where.school = school;
  if (type === 'Member') where.userId = { not: null };
  if (type === 'Guest') where.userId = null;
  if (status) where.status = status;
  if (source === 'SELF_REQUESTED' || source === 'ADMIN_SENT') where.source = source;

  const orderField = INVITATION_SORT_FIELDS[sort];
  const orderBy = orderField ? { [orderField]: dir === 'asc' ? 'asc' : 'desc' } : { createdAt: 'desc' };

  const [total, invitations] = await Promise.all([
    prisma.eventInvitation.count({ where }),
    prisma.eventInvitation.findMany({
      where,
      orderBy,
      // membershipExpiresAt only — enough to tell a Member from a Non-Member
      // in the report without pulling whole user rows into a paginated list.
      // A null user is a Guest: invited to this one event, no account at all.
      include: {
        user: { select: { membershipExpiresAt: true } },
        ...(eventId ? {} : { event: { select: { id: true, title: true } } }),
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { invitations, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// Distinct chapter/school (and, cross-event only, event) values actually
// present on invitations — drives the filter dropdowns. Derived from
// EventInvitation itself (not the members table) so external contacts, who
// aren't members at all, still show up as filter options.
async function getInvitationFilterOptions(eventId) {
  const where = eventId ? { eventId: Number(eventId) } : {};
  const [chapterRows, schoolRows, eventRows] = await Promise.all([
    prisma.eventInvitation.findMany({ where, select: { chapter: true }, distinct: ['chapter'] }),
    prisma.eventInvitation.findMany({ where, select: { school: true }, distinct: ['school'] }),
    eventId
      ? Promise.resolve([])
      : prisma.eventInvitation.findMany({ where, select: { event: { select: { id: true, title: true } } }, distinct: ['eventId'] }),
  ]);
  return {
    chapters: chapterRows.map((r) => r.chapter).filter(Boolean).sort(),
    schools: schoolRows.map((r) => r.school).filter(Boolean).sort(),
    events: eventRows.map((r) => r.event).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title)),
  };
}

// Invited/registered/requested totals and the source-conversion breakdown —
// always computed over every invitation in scope (the whole event, or
// everything), never just the report table's current filter/page, since
// these numbers answer "how is this event's invitation campaign doing
// overall," not "how many rows match what I just filtered to."
async function getInvitationSummary(eventId) {
  const where = eventId ? { eventId: Number(eventId) } : {};
  const pct = (num, denom) => (denom ? Math.round((num / denom) * 100) : 0);

  const [total, registered, attendingGuests, adminSentTotal, adminSentRegistered, selfRequestedTotal, selfRequestedRegistered] = await Promise.all([
    prisma.eventInvitation.count({ where }),
    prisma.eventInvitation.count({ where: { ...where, registeredAt: { not: null } } }),
    prisma.eventInvitation.count({ where: { ...where, userId: null, rsvpStatus: 'ATTENDING' } }),
    prisma.eventInvitation.count({ where: { ...where, source: 'ADMIN_SENT' } }),
    prisma.eventInvitation.count({ where: { ...where, source: 'ADMIN_SENT', registeredAt: { not: null } } }),
    prisma.eventInvitation.count({ where: { ...where, source: 'SELF_REQUESTED' } }),
    prisma.eventInvitation.count({ where: { ...where, source: 'SELF_REQUESTED', registeredAt: { not: null } } }),
  ]);

  return {
    total,
    registered,
    registeredPct: pct(registered, total),
    requested: selfRequestedTotal,
    attendingGuests,
    adminSent: { total: adminSentTotal, registered: adminSentRegistered, pct: pct(adminSentRegistered, adminSentTotal) },
    selfRequested: { total: selfRequestedTotal, registered: selfRequestedRegistered, pct: pct(selfRequestedRegistered, selfRequestedTotal) },
  };
}

function fmtDateTime(date) {
  return date ? new Date(date).toLocaleString() : '';
}

// eventId: a specific event's invitations, or null/undefined for the
// cross-event "All Invitations" export. Two sheets: a Summary the admin asked
// for directly (how many invited/sent, who registered, who RSVP'd Attending
// but never actually registered, source breakdown) plus a full Details sheet
// so any of those groups can be isolated by filtering in Excel itself rather
// than needing a separate tab per question.
async function exportInvitationsExcel(eventId) {
  const invitations = eventId
    ? await listInvitationsForEvent(eventId)
    : await listAllInvitations();

  const event = eventId ? await prisma.event.findUnique({ where: { id: Number(eventId) } }) : null;
  if (eventId && !event) throw new AppError('Event not found', 404);

  const registered = invitations.filter((i) => i.registeredAt);
  // Guest-only signal (see recordRsvp) — a member invitee's real "coming or
  // not" answer is registeredAt, not rsvpStatus.
  const rsvpAttendingNotRegistered = invitations.filter((i) => !i.userId && i.rsvpStatus === 'ATTENDING' && !i.registeredAt);
  const adminSent = invitations.filter((i) => i.source !== 'SELF_REQUESTED');
  const selfRequested = invitations.filter((i) => i.source === 'SELF_REQUESTED');
  const sent = invitations.filter((i) => i.sentAt);
  const bounced = invitations.filter((i) => i.status === 'BOUNCED' || i.status === 'FAILED');

  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 45 },
    { header: 'Count', key: 'count', width: 14 },
  ];
  summary.getRow(1).font = { bold: true };
  const summaryRows = [
    { metric: eventId ? `Event: ${event.title}` : 'All Events', count: '' },
    { metric: 'Generated', count: fmtDateTime(new Date()) },
    { metric: '', count: '' },
    { metric: 'Total Invited', count: invitations.length },
    { metric: 'Emails Sent', count: sent.length },
    { metric: 'Bounced / Failed to Deliver', count: bounced.length },
    { metric: 'Registered', count: registered.length },
    { metric: 'Responded "Attending" but Not Yet Registered', count: rsvpAttendingNotRegistered.length },
    { metric: '', count: '' },
    { metric: 'Admin-Sent — Total', count: adminSent.length },
    { metric: 'Admin-Sent — Registered', count: adminSent.filter((i) => i.registeredAt).length },
    { metric: 'Self-Requested — Total', count: selfRequested.length },
    { metric: 'Self-Requested — Registered', count: selfRequested.filter((i) => i.registeredAt).length },
  ];
  summaryRows.forEach((row) => summary.addRow(row));
  summary.getColumn('count').alignment = { horizontal: 'right' };

  const details = workbook.addWorksheet('All Invitations');
  const detailColumns = [
    { header: 'Name', key: 'fullName', width: 26 },
    { header: 'Email', key: 'email', width: 30 },
  ];
  if (!eventId) detailColumns.push({ header: 'Event', key: 'event', width: 26 });
  detailColumns.push(
    { header: 'Chapter', key: 'chapter', width: 18 },
    { header: 'School', key: 'school', width: 22 },
    { header: 'Company', key: 'company', width: 22 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Delivery Status', key: 'status', width: 16 },
    { header: 'Sent At', key: 'sentAt', width: 20 },
    { header: 'Opened At', key: 'openedAt', width: 20 },
    { header: 'Clicked At', key: 'clickedAt', width: 20 },
    { header: 'RSVP (Guests)', key: 'rsvp', width: 16 },
    { header: 'Registered At', key: 'registeredAt', width: 20 }
  );
  details.columns = detailColumns;
  details.getRow(1).font = { bold: true };

  const rsvpLabels = { ATTENDING: 'Attending', NOT_ATTENDING: 'Not Attending', PENDING: 'No response' };

  invitations.forEach((inv) => {
    details.addRow({
      fullName: inv.fullName,
      email: inv.email,
      event: inv.event ? inv.event.title : undefined,
      chapter: inv.chapter || '',
      school: inv.school || '',
      company: inv.company || '',
      type: inv.userId ? 'Member' : 'Guest',
      source: inv.source === 'SELF_REQUESTED' ? 'Requested' : 'Admin-Sent',
      status: inv.status,
      sentAt: fmtDateTime(inv.sentAt),
      openedAt: fmtDateTime(inv.openedAt),
      clickedAt: fmtDateTime(inv.clickedAt),
      rsvp: inv.userId ? '' : (rsvpLabels[inv.rsvpStatus] || inv.rsvpStatus),
      registeredAt: fmtDateTime(inv.registeredAt),
    });
  });

  // Excel's own header-row filter dropdowns — every column (Type, Source,
  // Status, Chapter, School, RSVP, etc.) becomes filterable/sortable right
  // inside Excel, on top of whatever's already filtered here on the admin
  // page. columnLetter covers up to Z, which comfortably fits this sheet's
  // column count either way (13 per-event, 14 cross-event).
  const columnLetter = (n) => String.fromCharCode('A'.charCodeAt(0) + n - 1);
  details.autoFilter = { from: 'A1', to: `${columnLetter(detailColumns.length)}1` };

  return workbook.xlsx.writeBuffer();
}

async function getInvitationByToken(token) {
  const invitation = await prisma.eventInvitation.findUnique({ where: { token }, include: { event: true } });
  if (!invitation) throw new AppError('Invitation not found', 404);
  return invitation;
}

// Called once, the moment the invite link is actually visited — this is the
// authoritative "clicked" signal (a first-party hit on our own route), more
// reliable than waiting on Brevo's own click-tracking webhook event, which
// depends on Brevo's link-wrapping and can be blocked by the recipient's mail
// client. Idempotent: only the first visit sets the timestamp.
async function markClicked(token) {
  const invitation = await prisma.eventInvitation.findUnique({ where: { token } });
  if (!invitation) return null;
  if (invitation.clickedAt) return invitation;
  return prisma.eventInvitation.update({ where: { id: invitation.id }, data: { clickedAt: new Date() } });
}

// Guest-only lightweight yes/no — no account, no login, just the unguessable
// token. Deliberately NOT available to a member invitation (userId set):
// members already have a real registration path (with capacity/fee/payment
// logic), and letting them RSVP here instead would create a second, weaker
// "are they coming" signal that could disagree with registeredAt. Re-callable
// so someone can change their mind before the event.
async function recordRsvp(token, eventId, status) {
  if (status !== 'ATTENDING' && status !== 'NOT_ATTENDING') {
    throw new AppError('Invalid RSVP response', 422);
  }
  const invitation = await prisma.eventInvitation.findUnique({ where: { token } });
  if (!invitation) throw new AppError('Invitation not found', 404);
  if (invitation.eventId !== Number(eventId)) {
    throw new AppError('This invitation is for a different event.', 400);
  }
  if (invitation.userId) {
    throw new AppError('This invitation belongs to a member account — log in and register instead.', 409);
  }
  const updated = await prisma.eventInvitation.update({
    where: { id: invitation.id },
    data: { rsvpStatus: status, rsvpAt: new Date() },
  });
  sheetsSyncService.syncInvitations(invitation.eventId);
  return updated;
}

// Verifies the logged-in user is actually who this invitation was sent to
// before letting their registration link back to it — otherwise a forwarded
// invite link opened by someone already logged in as a different account
// would misattribute that registration as "the invited person registered".
function assertInvitationBelongsToUser(invitation, user) {
  if (invitation.userId) {
    if (invitation.userId !== user.id) {
      throw new AppError('This invitation was sent to a different person.', 403);
    }
    return;
  }
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError('This invitation was sent to a different email address.', 403);
  }
}

// Called from the register-for-event flow when a request carries an invite
// token — validates it applies to this event and this user, and returns the
// invitation row (or null if no token was supplied) for the registration
// service to link. Throws rather than silently ignoring a bad/mismatched
// token, since silently dropping it would make a legitimate invitee's
// registration look like an organic one in the report.
async function resolveInvitationForUser(token, eventId, user) {
  if (!token) return null;
  const invitation = await getInvitationByToken(token);
  if (invitation.eventId !== Number(eventId)) {
    throw new AppError('This invitation is for a different event.', 400);
  }
  assertInvitationBelongsToUser(invitation, user);
  return invitation;
}

// Called once an invited registration actually lands as REGISTERED — for a
// free event that's immediate; for a paid one it's deferred until
// applyPaymentPaid flips the PENDING_PAYMENT hold, matching what "registered"
// means everywhere else in this app (confirmed, not just started).
async function markRegistered(invitationId) {
  if (!invitationId) return;
  const updated = await prisma.eventInvitation.update({
    where: { id: Number(invitationId) },
    data: { registeredAt: new Date() },
  }).catch(() => null); // never let this block the registration it's tracking
  if (updated) sheetsSyncService.syncInvitations(updated.eventId);
}

// Brevo webhook → delivery-lifecycle status only (sent/delivered/bounced/
// etc.) plus openedAt. Deliberately ignores Brevo's own "click" event — see
// markClicked above for why our first-party route is the source of truth for
// that instead.
//
// Keyed on a normalized form (lowercased, underscores stripped) rather than
// the literal string, because Brevo's own naming is inconsistent between
// where it's used: the webhook *subscription* API rejected snake_case
// ("soft_bounce") and only accepted camelCase ("softBounce") when this
// webhook was registered, but Brevo's docs describe the *payload*'s `event`
// field in snake_case — normalizing both to the same key means this works
// correctly regardless of which convention actually shows up on the wire.
const STATUS_BY_EVENT = {
  delivered: 'DELIVERED',
  softbounce: 'BOUNCED',
  hardbounce: 'BOUNCED',
  blocked: 'BOUNCED',
  invalidemail: 'BOUNCED',
  invalid: 'BOUNCED',
  error: 'FAILED',
};

function normalizeEventType(eventType) {
  return String(eventType || '').toLowerCase().replace(/_/g, '');
}

async function applyWebhookEvent({ tag, eventType, reason }) {
  const match = /^invitation-(\d+)$/.exec(tag || '');
  if (!match) return { ignored: true, reasonIgnored: 'no matching invitation tag' };

  const invitationId = Number(match[1]);
  const invitation = await prisma.eventInvitation.findUnique({ where: { id: invitationId } });
  if (!invitation) return { ignored: true, reasonIgnored: 'invitation not found' };

  const normalized = normalizeEventType(eventType);
  if (normalized === 'opened' || normalized === 'firstopening' || normalized === 'uniqueopened') {
    if (!invitation.openedAt) {
      await prisma.eventInvitation.update({ where: { id: invitationId }, data: { openedAt: new Date() } });
      sheetsSyncService.syncInvitations(invitation.eventId);
    }
    return { updated: true, invitationId, field: 'openedAt' };
  }

  const nextStatus = STATUS_BY_EVENT[normalized];
  if (!nextStatus) return { ignored: true, reasonIgnored: `unhandled event type: ${eventType}` };

  // A later "bounced" event must never downgrade a status that already
  // reached DELIVERED — treat delivery as sticky once confirmed, same
  // defensive spirit as the payment state machine elsewhere in this app.
  if (invitation.status === 'DELIVERED' && nextStatus === 'BOUNCED') {
    return { ignored: true, reasonIgnored: 'already delivered' };
  }

  await prisma.eventInvitation.update({
    where: { id: invitationId },
    data: { status: nextStatus, failureReason: reason ? String(reason).slice(0, 191) : invitation.failureReason },
  });
  sheetsSyncService.syncInvitations(invitation.eventId);
  return { updated: true, invitationId, field: 'status', value: nextStatus };
}

const BREVO_EVENTS_URL = 'https://api.brevo.com/v3/smtp/statistics/events';
const BREVO_REQUEST_TIMEOUT_MS = 15000;

// Brevo's live webhook is best-effort and can silently drop an event — proven
// firsthand: an "opened" event showed up in Brevo's own event log but the
// corresponding webhook call never reached this app at all (confirmed via
// both this app's DB and the raw request log at the tunnel). This pulls the
// same event history directly from Brevo's Statistics API as a periodic
// backup, the same "push can miss things, so also poll the source of truth"
// pattern as the payment reconciliation sweep.
async function fetchBrevoEventsForInvitation(invitationId) {
  const url = `${BREVO_EVENTS_URL}?tags=invitation-${invitationId}&limit=50`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'api-key': config.email.brevoApiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(BREVO_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error('Could not reach Brevo to reconcile invitation status.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body && body.message) || 'Brevo rejected the events request.');
  }
  const body = await res.json().catch(() => ({}));
  return body.events || [];
}

// Re-derives status/openedAt from Brevo's own event history for one
// invitation — same event-name normalization and sticky-DELIVERED guard as
// the live webhook handler, but using each event's own recorded timestamp
// (not "now") so a backfilled "opened" reflects when it actually happened.
async function reconcileInvitation(invitationId) {
  const invitation = await prisma.eventInvitation.findUnique({ where: { id: Number(invitationId) } });
  if (!invitation) return { ignored: true, reasonIgnored: 'invitation not found' };

  const events = await fetchBrevoEventsForInvitation(invitation.id);
  if (!events.length) return { unchanged: true, invitationId: invitation.id };

  const data = {};

  if (!invitation.openedAt) {
    const openedEvents = events
      .filter((e) => ['opened', 'firstopening', 'uniqueopened'].includes(normalizeEventType(e.event)))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (openedEvents.length) data.openedAt = new Date(openedEvents[0].date);
  }

  if (invitation.status !== 'DELIVERED') {
    // Latest status-relevant event wins, same precedence as live webhook
    // delivery order — but still never let a bounce downgrade a delivery
    // that this same reconciliation pass (or an earlier webhook) confirmed.
    const statusEvents = events
      .filter((e) => STATUS_BY_EVENT[normalizeEventType(e.event)])
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const e of statusEvents) {
      const next = STATUS_BY_EVENT[normalizeEventType(e.event)];
      if (next === 'BOUNCED' && (data.status === 'DELIVERED' || invitation.status === 'DELIVERED')) continue; // eslint-disable-line no-continue
      data.status = next;
      if (next === 'BOUNCED' || next === 'FAILED') data.failureReason = (e.reason || invitation.failureReason || null);
    }
  }

  if (!Object.keys(data).length) return { unchanged: true, invitationId: invitation.id };

  await prisma.eventInvitation.update({ where: { id: invitation.id }, data });
  return { updated: true, invitationId: invitation.id, fields: Object.keys(data) };
}

// Candidates: sent within the last 14 days (older ones are vanishingly
// unlikely to still be missing a delivery/open confirmation and aren't worth
// the ongoing API calls) and either still stuck at SENT (no delivery/bounce
// confirmation at all) or never recorded an open — deliberately not "every
// invitation ever", to keep this bounded as the table grows.
async function findInvitationsNeedingReconciliation(withinDays = 14) {
  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000);
  return prisma.eventInvitation.findMany({
    where: {
      sentAt: { not: null, gte: cutoff },
      OR: [{ status: 'SENT' }, { openedAt: null }],
    },
    orderBy: { sentAt: 'asc' },
  });
}

module.exports = {
  createInvitations,
  resendInvitation,
  listInvitationsForEvent,
  getInvitedEmailStatusesForEvent,
  listAllInvitations,
  listInvitationsForAdmin,
  getInvitationFilterOptions,
  getInvitationSummary,
  exportInvitationsExcel,
  reconcileInvitation,
  findInvitationsNeedingReconciliation,
  getInvitationByToken,
  markClicked,
  recordRsvp,
  resolveInvitationForUser,
  markRegistered,
  applyWebhookEvent,
};
