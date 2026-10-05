const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const jobService = require('./job.service');
const passwordResetService = require('./passwordReset.service');
const auditService = require('./audit.service');
const logger = require('../utils/logger');

// What happened to each member's activation invitation, and what to do about it.
//
// The states below are DERIVED, not stored. There is no single column saying
// "bounced", because the truth is spread across three places that are each
// authoritative for their own part:
//
//   User.passwordSetAt      whether they ever activated. The only thing that
//                           actually matters; everything else is about getting
//                           them to this point.
//   PasswordResetToken      the one live link, and when it expires. Upserted,
//                           so there is never more than one usable link.
//   ActivationInvite        the history of attempts to deliver that link.
//
// Deriving rather than storing means the page can never disagree with reality.
// A stored status would need updating when a link quietly expires — which is an
// event nothing observes, because expiry is just a date passing.

// The order here is the order of precedence when several could apply, and it is
// deliberate: ACTIVATED first because a member who got in does not care that
// their second invite bounced, and BOUNCED before EXPIRED because a bad address
// needs fixing whereas an expired link only needs resending.
const STATES = {
  ACTIVATED: 'ACTIVATED',
  BOUNCED: 'BOUNCED',
  SEND_FAILED: 'SEND_FAILED',
  EXPIRED: 'EXPIRED',
  INVITED: 'INVITED',
  NEVER_INVITED: 'NEVER_INVITED',
};

// Shown on the page. Kept here rather than in the template so the API and the
// page cannot drift on what a state means.
const STATE_LABELS = {
  ACTIVATED: 'Activated',
  BOUNCED: 'Bounced',
  SEND_FAILED: 'Send failed',
  EXPIRED: 'Link expired',
  INVITED: 'Invited',
  NEVER_INVITED: 'Not invited yet',
};

// Which states a resend is useful for. Resending to someone who has already
// activated does nothing but confuse them, and resending to an address that just
// bounced will bounce again — but that one is still offered, because the usual
// fix is to correct the address first and then resend, and the button is where
// the admin already is.
const RESENDABLE = new Set([STATES.BOUNCED, STATES.SEND_FAILED, STATES.EXPIRED, STATES.NEVER_INVITED, STATES.INVITED]);

function deriveState(user, token, latestInvite, now = Date.now()) {
  if (user.passwordSetAt !== null) return STATES.ACTIVATED;

  if (latestInvite) {
    if (latestInvite.status === 'BOUNCED') return STATES.BOUNCED;
    if (latestInvite.status === 'FAILED') return STATES.SEND_FAILED;
  }

  // No token at all means nothing was ever issued for them, whatever an invite
  // row might claim — the link is the thing being tracked.
  if (!token) return STATES.NEVER_INVITED;
  if (token.usedAt) {
    // A used token with no passwordSetAt should not be possible: completeReset
    // sets both in one transaction. If it happens, say so rather than silently
    // showing them as invited, because it means that transaction broke.
    logger.warn('activation: token used but passwordSetAt is null', { userId: user.id });
    return STATES.INVITED;
  }
  if (new Date(token.expiresAt).getTime() <= now) return STATES.EXPIRED;
  return STATES.INVITED;
}

// One query per table rather than per member: this page lists everybody, and the
// obvious shape (findMany with two includes) issues a query per row.
async function loadStates({ search = '', state = '', emailStatus = '', page = 1, pageSize = 50, unpaged = false } = {}) {
  const where = { role: 'USER' };
  if (search) {
    where.OR = [
      { email: { contains: search } },
      { firstName: { contains: search } },
      { lastName: { contains: search } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, firstName: true, lastName: true, email: true,
      status: true, passwordSetAt: true, createdAt: true,
      organization: { select: { name: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  if (!users.length) {
    return { rows: [], counts: emptyCounts(), total: 0, page: 1, pageSize, pages: 1 };
  }

  const ids = users.map((u) => u.id);

  const tokens = await prisma.passwordResetToken.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, expiresAt: true, usedAt: true, createdAt: true },
  });
  const tokenByUser = new Map(tokens.map((t) => [t.userId, t]));

  // Latest attempt per member. Read newest-first and keep the first one seen,
  // which is cheaper than a correlated subquery and needs no window function —
  // this has to work on the MariaDB the live host runs.
  const invites = await prisma.activationInvite.findMany({
    where: { userId: { in: ids } },
    select: {
      userId: true, attemptId: true, channel: true, status: true, providerStatus: true,
      failureReason: true, email: true, failedAt: true, activatedAt: true, retryOfAttemptId: true,
      sentAt: true, openedAt: true, bouncedAt: true, lastSyncedAt: true, createdAt: true,
    },
    orderBy: [{ userId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  const latestByUser = new Map();
  const attemptsByUser = new Map();
  for (const inv of invites) {
    if (!latestByUser.has(inv.userId)) latestByUser.set(inv.userId, inv);
    attemptsByUser.set(inv.userId, (attemptsByUser.get(inv.userId) || 0) + 1);
  }

  const now = Date.now();
  const all = users.map((u) => {
    const token = tokenByUser.get(u.id) || null;
    const latest = latestByUser.get(u.id) || null;
    const derived = deriveState(u, token, latest, now);
    return {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      accountStatus: u.status,
      organization: u.organization ? u.organization.name : null,
      state: derived,
      stateLabel: STATE_LABELS[derived],
      resendable: RESENDABLE.has(derived),
      attempts: attemptsByUser.get(u.id) || 0,
      channel: latest ? latest.channel : null,
      failureReason: latest ? latest.failureReason : null,
      attemptId: latest ? latest.attemptId : null,
      emailStatus: latest ? latest.providerStatus : null,
      attemptEmail: latest ? latest.email : null,
      failedAt: latest ? latest.failedAt : null,
      attemptActivatedAt: latest ? latest.activatedAt : null,
      retryOfAttemptId: latest ? latest.retryOfAttemptId : null,
      lastSyncedAt: latest ? latest.lastSyncedAt : null,
      invitedAt: latest ? latest.sentAt || latest.createdAt : (token ? token.createdAt : null),
      openedAt: latest ? latest.openedAt : null,
      bouncedAt: latest ? latest.bouncedAt : null,
      linkExpiresAt: token && !token.usedAt ? token.expiresAt : null,
      activatedAt: u.passwordSetAt,
      eligibleForMergo: u.passwordSetAt === null
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || '')),
      createdAt: u.createdAt,
    };
  });

  // Counted over everything matching the search, not over the current page —
  // a tally that changes when you turn the page is worse than no tally.
  const counts = emptyCounts();
  for (const r of all) counts[r.state] += 1;
  counts.TOTAL = all.length;

  let filtered = state ? all.filter((r) => r.state === state) : all;
  if (emailStatus) filtered = filtered.filter((r) => r.emailStatus === emailStatus);
  // For the bulk actions, which act on everyone in a state rather than on a page.
  if (unpaged) return { rows: filtered, counts, total: filtered.length, page: 1, pageSize: filtered.length, pages: 1 };
  const size = Math.max(1, Math.min(200, Number(pageSize) || 50));
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.max(1, Math.min(pages, Number(page) || 1));
  const rows = filtered.slice((current - 1) * size, current * size);

  return { rows, counts, total: filtered.length, page: current, pageSize: size, pages };
}

function emptyCounts() {
  return {
    ACTIVATED: 0, BOUNCED: 0, SEND_FAILED: 0, EXPIRED: 0, INVITED: 0, NEVER_INVITED: 0, TOTAL: 0,
  };
}

// --- recording what happened -------------------------------------------------

// Called by the job handler once the transport has answered. Until this existed
// the handler discarded sendActivationEmail's return value, so a job that failed
// to send still closed as COMPLETED and the failure lived only in a log line.
async function recordSendOutcome(userId, { ok, channel = 'SITE', reason = null } = {}) {
  try {
    return await prisma.activationInvite.create({
      data: {
        userId: Number(userId),
        channel,
        status: ok ? 'SENT' : 'FAILED',
        providerStatus: ok ? 'SENT' : 'FAILED',
        sentAt: ok ? new Date() : null,
        failedAt: ok ? null : new Date(),
        failureReason: ok ? null : String(reason || 'The mail transport rejected the message.').slice(0, 255),
      },
    });
  } catch (err) {
    // Tracking must never be the reason an invitation fails. A missing row makes
    // the page less informative; a thrown error here would retry a job whose
    // email has already gone out, and send the member a second link.
    logger.error('activation: could not record the send outcome', { userId, reason: err.message });
    return null;
  }
}

// --- resending ---------------------------------------------------------------

// The queued job mints the link, so nothing here touches tokens. Returns false
// rather than throwing when there is nothing to do, so a caller can say why.
async function resendFor(userId, { actorId = null } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, email: true, passwordSetAt: true },
  });
  if (!user) return { queued: false, reason: 'NOT_FOUND' };
  if (user.passwordSetAt !== null) return { queued: false, reason: 'ALREADY_ACTIVATED' };
  if ((await passwordResetService.usersWithPendingMergoLink([user.id])).has(user.id)) {
    return { queued: false, reason: 'MERGO_LINK_PENDING' };
  }

  await jobService.enqueue('SEND_ACTIVATION_EMAIL', { userId: user.id });
  await auditService.log({
    action: 'ACTIVATION_INVITE_RESENT',
    actorId,
    // targetUserId is the field audit.service.js destructures; anything else is
    // accepted by the call and silently dropped.
    targetUserId: user.id,
    metadata: { email: user.email },
  });
  return { queued: true };
}

// Everyone currently in one of the given states. Used by the page's "resend all
// expired" and "resend all bounced" buttons.
//
// Bounded, and deliberately so. An unbounded version of this is one click away
// from queueing thousands of sends against a daily quota shared with every
// password reset the site needs to send that day.
const BULK_LIMIT = 200;

async function resendForState(state, { actorId = null } = {}) {
  if (!RESENDABLE.has(state) || state === STATES.INVITED) {
    return { queued: 0, skipped: 0, reason: 'NOT_RESENDABLE' };
  }
  // Every member in the state, not one page of them: the cap below is what
  // bounds a press, and it can only report "press again for the rest" if it
  // can see that there is a rest.
  const { rows } = await loadStates({ state, unpaged: true });

  // Skipped rather than sent again: anyone whose invitation from an earlier
  // press is still in the queue (they stay in this state until the job runs),
  // and anyone whose live link is in a Mergo email that has not failed.
  const queuedJobs = await prisma.job.findMany({
    where: { type: 'SEND_ACTIVATION_EMAIL', status: { in: ['PENDING', 'PROCESSING'] } },
    select: { payload: true },
  });
  const alreadyQueued = new Set();
  queuedJobs.forEach((j) => {
    try { alreadyQueued.add(Number(JSON.parse(j.payload).userId)); } catch (err) { /* unreadable payload */ }
  });
  const mergoPending = await passwordResetService.usersWithPendingMergoLink(rows.map((r) => r.id));
  const eligible = rows.filter((r) => !alreadyQueued.has(r.id) && !mergoPending.has(r.id));
  const targets = eligible.slice(0, BULK_LIMIT);

  let queued = 0;
  for (const row of targets) {
    // eslint-disable-next-line no-await-in-loop
    await jobService.enqueue('SEND_ACTIVATION_EMAIL', { userId: row.id });
    queued += 1;
  }

  if (queued) {
    await auditService.log({
      action: 'ACTIVATION_INVITES_SENT',
      actorId,
      metadata: { queued, state, viaBulkStateResend: true },
    });
  }
  return { queued, skipped: eligible.length - targets.length, limit: BULK_LIMIT };
}

// --- reading Mergo's tracking back in ----------------------------------------

// Mergo writes what it learned about each row back into the sheet it merged
// from. This reads those columns and records them as delivery outcomes.
//
// It is the ONLY way a bounce enters this system: the site sends over SMTP, and
// SMTP accepting a message tells us nothing about whether it was delivered. The
// failure notice arrives hours later as an ordinary email in the sending
// mailbox, which nothing here reads.
//
// Matched on email, not on a row number or an id, because the sheet has been
// through Google Sheets and a person by the time it comes back — rows get
// sorted, filtered and inserted, and any positional assumption breaks silently.
const MERGO_STATUS_MAP = {
  bounced: 'BOUNCED',
  bounce: 'BOUNCED',
  failed: 'FAILED',
  error: 'FAILED',
  delivered: 'DELIVERED',
  sent: 'SENT',
  opened: 'DELIVERED',
  open: 'DELIVERED',
  clicked: 'DELIVERED',
};

function headerIndex(row) {
  const index = {};
  row.eachCell((cell, col) => {
    const key = String(cell.value || '').trim().toLowerCase();
    if (key) index[key] = col;
  });
  return index;
}

function cellText(row, col) {
  if (!col) return '';
  const v = row.getCell(col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.text) return String(v.text).trim();
  if (typeof v === 'object' && v.result !== undefined) return String(v.result).trim();
  return String(v).trim();
}

async function importMergoStatuses(buffer, { actorId = null, dryRun = false } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  // Whichever sheet the statuses are on. The export names it Invites, but a
  // person who has been working in Sheets may well have renamed or copied it,
  // so fall back to the first sheet that has an email column.
  let sheet = workbook.getWorksheet('Invites');
  let header = sheet ? headerIndex(sheet.getRow(1)) : null;
  if (!sheet || !header.email) {
    for (const ws of workbook.worksheets) {
      const h = headerIndex(ws.getRow(1));
      if (h.email) { sheet = ws; header = h; break; }
    }
  }
  if (!sheet || !header || !header.email) {
    return { ok: false, error: 'No sheet in that file has an "Email" column in row 1. Upload the sheet Mergo merged from.' };
  }

  // Mergo's own column names vary by version and by what the user turned on, so
  // several are accepted rather than insisting on one.
  const statusCol = header['merge status'] || header['mergo status'] || header.status
    || header['email status'] || header['delivery status'] || null;
  const reasonCol = header['error message'] || header.error || header.reason || header['bounce reason'] || null;
  const openedCol = header.opened || header['opened at'] || header['first opened'] || null;

  if (!statusCol) {
    return {
      ok: false,
      error: 'That sheet has no status column. Mergo adds one (usually "Merge status") once it has sent — '
        + 'export the sheet after the merge has finished, not before.',
    };
  }

  const errors = [];
  const updates = [];
  const seen = new Set();

  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const email = cellText(row, header.email).toLowerCase();
    if (!email) continue;

    const raw = cellText(row, statusCol).toLowerCase();
    if (!raw) continue;

    if (seen.has(email)) {
      errors.push(`Row ${r}: ${email} appears more than once. Only the first was used.`);
      continue;
    }
    seen.add(email);

    // Matched loosely: Mergo writes things like "Bounced (550 ...)" rather than
    // a bare keyword.
    const key = Object.keys(MERGO_STATUS_MAP).find((k) => raw.includes(k));
    if (!key) {
      errors.push(`Row ${r}: "${cellText(row, statusCol)}" is not a status this can read. Left unchanged.`);
      continue;
    }

    updates.push({
      row: r,
      email,
      status: MERGO_STATUS_MAP[key],
      opened: ['opened', 'open', 'clicked'].includes(key),
      reason: reasonCol ? cellText(row, reasonCol) : '',
      openedText: openedCol ? cellText(row, openedCol) : '',
    });
  }

  if (!updates.length) {
    return { ok: false, error: 'No readable statuses were found in that sheet.', errors };
  }

  // Resolve emails to members in one query. An address in the sheet that is not
  // a member is reported rather than ignored — it usually means the sheet has
  // been edited, and silently skipping it would hide that.
  const users = await prisma.user.findMany({
    where: { email: { in: updates.map((u) => u.email) } },
    select: { id: true, email: true },
  });
  const idByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  const applied = [];
  for (const u of updates) {
    const userId = idByEmail.get(u.email);
    if (!userId) {
      errors.push(`Row ${u.row}: no member has the address ${u.email}.`);
      continue;
    }
    applied.push({ ...u, userId });
  }

  const summary = {
    ok: true,
    dryRun: Boolean(dryRun),
    read: updates.length,
    matched: applied.length,
    bounced: applied.filter((a) => a.status === 'BOUNCED').length,
    delivered: applied.filter((a) => a.status === 'DELIVERED').length,
    failed: applied.filter((a) => a.status === 'FAILED').length,
    errors,
  };

  if (dryRun) return summary;

  const now = new Date();
  for (const a of applied) {
    const openedAt = parseDateish(a.openedText);
    // eslint-disable-next-line no-await-in-loop
    await prisma.activationInvite.create({
      data: {
        userId: a.userId,
        channel: 'MERGO',
        status: a.status,
        providerStatus: a.status === 'BOUNCED' ? 'BOUNCED'
          : (a.status === 'FAILED' ? 'FAILED'
            : (a.opened ? 'OPENED' : (a.status === 'SENT' ? 'SENT' : 'PREPARED'))),
        failureReason: a.reason ? String(a.reason).slice(0, 255) : null,
        // Mergo has already sent by the time it writes a status, so the message
        // did leave — recording sentAt keeps "invited at" truthful on the page.
        sentAt: now,
        openedAt: openedAt || (a.opened ? now : null),
        bouncedAt: a.status === 'BOUNCED' ? now : null,
        failedAt: ['BOUNCED', 'FAILED'].includes(a.status) ? now : null,
      },
    });
  }

  await auditService.log({
    action: 'ACTIVATION_DELIVERY_IMPORTED',
    actorId,
    metadata: {
      read: summary.read, matched: summary.matched,
      bounced: summary.bounced, delivered: summary.delivered, failed: summary.failed,
    },
  });

  return summary;
}

// Mergo writes dates in whatever the sheet's locale produced, and ExcelJS hands
// back a Date for a real date cell and a string for anything else. Anything
// unparseable becomes null rather than an Invalid Date, which would be stored
// and then fail to render.
function parseDateish(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = {
  STATES,
  STATE_LABELS,
  RESENDABLE,
  BULK_LIMIT,
  deriveState,
  loadStates,
  recordSendOutcome,
  resendFor,
  resendForState,
  importMergoStatuses,
};
