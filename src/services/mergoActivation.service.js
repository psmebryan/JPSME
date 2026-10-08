const crypto = require('crypto');
const config = require('../config');
const prisma = require('../config/prisma');
const settingsService = require('./settings.service');
const passwordResetService = require('./passwordReset.service');
const auditService = require('./audit.service');
const logger = require('../utils/logger');

const OWNED_COLUMNS = [
  'Attempt ID', 'User ID', 'First Name', 'Last Name', 'Email',
  'Activation Link', 'Campaign', 'Created At', 'Expires At',
];
// Written as a Sheets formula rather than as a value. Gmail's link box will not
// take a Mergo marker, so a clickable button cannot be built in the draft;
// Mergo instead turns a =HYPERLINK(url, IMAGE(...)) cell into a linked image,
// and the draft just carries {{Activation Button}}. See help.mergo.app,
// "Insert Dynamic Links in your Emails".
const FORMULA_COLUMNS = ['Activation Button'];
const ALL_COLUMNS = OWNED_COLUMNS.concat(FORMULA_COLUMNS);
// Versioned by file name rather than overwritten: Gmail caches images by URL,
// so a resized picture under the old name would keep showing the old size.
const BUTTON_IMAGE_PATH = '/img/mergo-activate-button-sm.png';
const ACTIVE_PROVIDER_STATUSES = ['PREPARED', 'QUEUED', 'SENT', 'OPENED'];

let sheetsClient = null;
function getSheetsClient() {
  if (!sheetsClient) {
    // eslint-disable-next-line global-require
    const { google } = require('googleapis');
    const auth = new google.auth.JWT({
      email: config.googleSheets.serviceAccountEmail,
      key: (config.googleSheets.serviceAccountPrivateKey || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

function isConfigured() {
  return Boolean(config.googleSheets.mergoActivationSheetId
    && config.googleSheets.serviceAccountEmail
    && config.googleSheets.serviceAccountPrivateKey);
}

// Why a link written now would not work for the member who receives it, or
// null when it would.
//
// The link embeds APP_URL and its token lives in THIS database. A local copy
// pointed at the real campaign sheet therefore puts links in front of real
// members that open http://localhost on their own phone, for a token the live
// site has never seen — and Mergo may send them the moment the row appears.
// build-mergo-export.js has always refused this; the in-app path did not.
function linkBaseProblem() {
  if (config.googleSheets.mergoAllowLocalLinks) return null;
  const base = String(config.appUrl || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base)) {
    return `APP_URL is ${base}, so every activation link would point at this computer.`;
  }
  if (!/^https:\/\//i.test(base)) {
    return `APP_URL is ${base || '(not set)'}; activation links must use the live https address.`;
  }
  return null;
}

function sheetUrl() {
  if (!isConfigured()) return null;
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.googleSheets.mergoActivationSheetId)}/edit`;
}

function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

function columnLetter(number) {
  let n = Number(number);
  let output = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    n = Math.floor((n - 1) / 26);
  }
  return output;
}

async function ensureTab(sheets) {
  const spreadsheetId = config.googleSheets.mergoActivationSheetId;
  const title = config.googleSheets.mergoActivationTab;
  const book = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = (book.data.sheets || []).find((s) => s.properties.title === title);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
  return title;
}

async function ensureHeaders(sheets, title) {
  const spreadsheetId = config.googleSheets.mergoActivationSheetId;
  const quoted = quoteTab(title);
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoted}!1:1` });
  const current = (result.data.values && result.data.values[0]) || [];
  if (!current.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoted}!A1:${columnLetter(ALL_COLUMNS.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [ALL_COLUMNS] },
    });
    return ALL_COLUMNS.slice();
  }

  const normalized = current.map((v) => String(v || '').trim().toLowerCase());
  const headers = current.slice();
  // Add only missing JPSME-owned headers, one cell at a time. This does not
  // rewrite or shift Mergo's reserved tracking columns.
  for (const name of ALL_COLUMNS) {
    if (!normalized.includes(name.toLowerCase())) {
      const col = headers.length + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoted}!${columnLetter(col)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [[name]] },
      });
      headers.push(name);
      normalized.push(name.toLowerCase());
    }
  }
  return headers;
}

async function readCampaign(sheets, title) {
  const spreadsheetId = config.googleSheets.mergoActivationSheetId;
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteTab(title)}!A:AZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return result.data.values || [];
}

function headerMap(headers) {
  return new Map(headers.map((h, i) => [String(h || '').trim().toLowerCase(), i]));
}

function readCell(row, index) {
  if (index === undefined) return '';
  const value = row[index];
  return value === null || value === undefined ? '' : String(value).trim();
}

function parseSheetDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && value > 20000 && value < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeMergoStatus(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (/BOUNC|HARD.?FAIL|INVALID ADDRESS/.test(raw)) return 'BOUNCED';
  if (/FAIL|ERROR|NOT.?SENT|UNSENT/.test(raw)) return 'FAILED';
  if (/OPEN|CLICK|RESPOND/.test(raw)) return 'OPENED';
  if (/QUEUED|SCHEDULED/.test(raw)) return 'QUEUED';
  if (/SENT|DELIVERED|FOLLOW.?UP/.test(raw)) return 'SENT';
  return null;
}

function makeAttemptId(now = new Date()) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `ACT-${date}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function localDayStart(now = new Date()) {
  // The admins operate in Singapore/Philippines time (UTC+8). Use that local
  // calendar day for the configured JPSME cap and its dashboard counter.
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + offset);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset);
}

async function todayUsage(now = new Date()) {
  const count = await prisma.activationInvite.count({
    where: {
      channel: 'MERGO',
      createdAt: { gte: localDayStart(now) },
    },
  });
  const cap = await settingsService.getMergoActivationDailyCap();
  return { cap, preparedToday: count, remaining: Math.max(0, cap - count) };
}

async function summary() {
  const [totalAttempts, prepared, queued, sent, opened, failed, bounced, activated, pendingAccounts, activatedAccounts] = await Promise.all([
    prisma.activationInvite.count({ where: { channel: 'MERGO' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'PREPARED' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'QUEUED' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'SENT' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'OPENED' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'FAILED' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', providerStatus: 'BOUNCED' } }),
    prisma.activationInvite.count({ where: { channel: 'MERGO', activatedAt: { not: null } } }),
    prisma.user.count({ where: { role: 'USER', passwordSetAt: null } }),
    prisma.user.count({ where: { role: 'USER', passwordSetAt: { not: null } } }),
  ]);
  return { totalAttempts, prepared, queued, sent, opened, failed, bounced, activated, pendingAccounts, activatedAccounts };
}

async function attemptHistory(userId) {
  const attempts = await prisma.activationInvite.findMany({
    where: { userId: Number(userId) },
    select: {
      id: true, attemptId: true, channel: true, providerStatus: true, status: true,
      email: true, campaignId: true, retryOfAttemptId: true, failureReason: true,
      createdAt: true, sentAt: true, openedAt: true, bouncedAt: true, failedAt: true,
      activatedAt: true, lastSyncedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return attempts;
}

async function prepareOne(user, { retryOfAttemptId = null, campaignId } = {}) {
  if (!user || user.role !== 'USER') return { ok: false, reason: 'NOT_A_MEMBER' };
  const prepared = await prisma.$transaction(async (tx) => {
    // One locked cap row serializes reservations across requests and app
    // workers. Counting after the lock means two simultaneous admin batches
    // cannot both spend the same final slot.
    await tx.siteSetting.upsert({
      where: { key: 'mergo_activation_daily_cap' },
      update: {},
      create: { key: 'mergo_activation_daily_cap', value: String(config.googleSheets.mergoDailyActivationCap) },
    });
    const capRows = await tx.$queryRawUnsafe(
      'SELECT `value` FROM `SiteSetting` WHERE `key` = ? FOR UPDATE', 'mergo_activation_daily_cap'
    );
    const capValue = Number(capRows[0] && capRows[0].value);
    const cap = Number.isInteger(capValue) && capValue > 0 ? capValue : 2000;
    const usedToday = await tx.activationInvite.count({
      where: {
        channel: 'MERGO',
        createdAt: { gte: localDayStart() },
      },
    });

    // Serialize preparation per member so two admins cannot mint competing
    // links for the same account at the same time.
    await tx.$queryRawUnsafe('SELECT `id` FROM `User` WHERE `id` = ? FOR UPDATE', Number(user.id));
    const current = await tx.user.findUnique({
      where: { id: Number(user.id) },
      select: {
        id: true, firstName: true, lastName: true, email: true, role: true, passwordSetAt: true,
        passwordResetToken: { select: { usedAt: true, expiresAt: true } },
      },
    });
    if (!current || current.role !== 'USER') return { error: 'NOT_A_MEMBER' };
    if (!current.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(current.email)) return { error: 'INVALID_EMAIL' };
    if (current.passwordSetAt) return { error: 'ALREADY_ACTIVATED' };

    if (!retryOfAttemptId) {
      const activeAttempt = await tx.activationInvite.findFirst({
        where: { userId: current.id, channel: 'MERGO', providerStatus: { in: ACTIVE_PROVIDER_STATUSES } },
        select: { attemptId: true },
        orderBy: { createdAt: 'desc' },
      });
      if (activeAttempt) return { error: 'ACTIVE_ATTEMPT_EXISTS' };
      const pendingSiteJobs = await tx.job.findMany({
        where: {
          type: 'SEND_ACTIVATION_EMAIL',
          status: { in: ['PENDING', 'PROCESSING'] },
          payload: { contains: 'userId' },
        },
        select: { payload: true },
      });
      if (pendingSiteJobs.some((job) => {
        try { return Number(JSON.parse(job.payload).userId) === Number(current.id); }
        catch (err) { return false; }
      })) return { error: 'SITE_EMAIL_QUEUED' };
      if (current.passwordResetToken && !current.passwordResetToken.usedAt
          && new Date(current.passwordResetToken.expiresAt).getTime() > Date.now()) {
        return { error: 'ACTIVE_LINK_EXISTS' };
      }
    }
    if (usedToday >= cap) return { error: 'DAILY_CAP' };

    const issued = await passwordResetService.issueResetLink(current.id, {
      ttlMs: passwordResetService.ACTIVATION_TTL_MS,
      tx,
    });
    const createdAt = new Date();
    const attemptId = makeAttemptId(createdAt);
    const expiresAt = new Date(createdAt.getTime() + issued.ttlMs);
    const attempt = await tx.activationInvite.create({
      data: {
        userId: current.id,
        attemptId,
        email: current.email.toLowerCase(),
        tokenHash: issued.tokenHash,
        campaignId,
        retryOfAttemptId,
        channel: 'MERGO',
        status: 'PENDING',
        providerStatus: 'PREPARED',
      },
    });
    return {
      attempt,
      row: {
        attemptId,
        userId: current.id,
        firstName: current.firstName || '',
        lastName: current.lastName || '',
        email: current.email.toLowerCase(),
        activationLink: issued.url,
        campaignId,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  });
  if (prepared.error) return { ok: false, reason: prepared.error };
  return {
    ok: true,
    attempt: prepared.attempt,
    row: prepared.row,
  };
}

// A linked button image, as Mergo reads it: =HYPERLINK(url, IMAGE(url)).
// The image is served by this site, so it is public wherever APP_URL is.
// Quotes are doubled because that is how a Sheets formula escapes them.
function buttonFormula(activationLink) {
  const q = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const imageUrl = `${String(config.appUrl || '').replace(/\/+$/, '')}${BUTTON_IMAGE_PATH}`;
  return `=HYPERLINK(${q(activationLink)}, IMAGE(${q(imageUrl)}))`;
}

// One sheet write at a time. writeRows reads where the sheet ends and appends
// after it; two batches at once (two admins, or an import while someone presses
// "Add selected") both read the same last row and wrote over each other, so one
// batch's members were never emailed while JPSME showed them as queued. The
// live site is a single process, so an in-process queue is enough.
let sheetWriteChain = Promise.resolve();
function withSheetLock(fn) {
  const run = sheetWriteChain.then(fn, fn);
  sheetWriteChain = run.catch(() => {});
  return run;
}

function writeRows(rows) {
  return withSheetLock(() => writeRowsNow(rows));
}

async function writeRowsNow(rows) {
  if (!rows.length) return { written: 0, failed: [] };
  if (!isConfigured()) throw new Error('Mergo activation Google Sheet is not configured.');

  const sheets = getSheetsClient();
  const title = await ensureTab(sheets);
  const headers = await ensureHeaders(sheets, title);
  const allRows = await readCampaign(sheets, title);
  const columns = headerMap(headers);
  const attemptCol = columns.get('attempt id');
  const seen = new Map();
  allRows.slice(1).forEach((row, offset) => {
    const id = readCell(row, attemptCol);
    if (id && !seen.has(id)) seen.set(id, offset + 2);
  });

  const firstNewRow = Math.max(2, allRows.length + 1);
  const updates = [];
  const positions = new Map();
  let nextRow = firstNewRow;
  for (const data of rows) {
    const rowNumber = seen.has(data.attemptId) ? seen.get(data.attemptId) : nextRow++;
    positions.set(data.attemptId, rowNumber);
    const values = {
      'Attempt ID': data.attemptId,
      'User ID': data.userId,
      'First Name': data.firstName,
      'Last Name': data.lastName,
      Email: data.email,
      'Activation Link': data.activationLink,
      Campaign: data.campaignId,
      'Created At': data.createdAt,
      'Expires At': data.expiresAt,
    };
    for (const name of OWNED_COLUMNS) {
      const col = columns.get(name.toLowerCase());
      updates.push({
        range: `${quoteTab(title)}!${columnLetter(col + 1)}${rowNumber}`,
        values: [[values[name]]],
      });
    }
  }

  if (updates.length) {
    const request = (data) => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.googleSheets.mergoActivationSheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
    try {
      await request(updates);
    } catch (firstError) {
      // A timeout can happen after Google applied some or all of a batch. Read
      // back stable IDs, then repair JPSME-owned cells in those same rows and
      // place any missing IDs after the latest row. Never blindly append again.
      const currentRows = await readCampaign(sheets, title);
      const existingRows = new Map();
      currentRows.slice(1).forEach((row, offset) => {
        const id = readCell(row, attemptCol);
        if (id && !existingRows.has(id)) existingRows.set(id, offset + 2);
      });
      let repairRow = Math.max(2, currentRows.length + 1);
      const repair = [];
      for (const data of rows) {
        const rowNumber = existingRows.has(data.attemptId) ? existingRows.get(data.attemptId) : repairRow++;
        positions.set(data.attemptId, rowNumber);
        const values = {
          'Attempt ID': data.attemptId, 'User ID': data.userId,
          'First Name': data.firstName, 'Last Name': data.lastName,
          Email: data.email, 'Activation Link': data.activationLink,
          Campaign: data.campaignId, 'Created At': data.createdAt, 'Expires At': data.expiresAt,
        };
        for (const name of OWNED_COLUMNS) {
          repair.push({
            range: `${quoteTab(title)}!${columnLetter(columns.get(name.toLowerCase()) + 1)}${rowNumber}`,
            values: [[values[name]]],
          });
        }
      }
      try {
        await request(repair);
      } catch (repairError) {
        throw new Error(`Google Sheets batch write failed (${firstError.message}); recovery failed (${repairError.message}).`);
      }
    }
  }

  // The button cell, written separately because it is the one cell that must be
  // read as a formula. Everything above stays RAW, so a name or address that
  // happens to start with "=" can never be evaluated as one.
  //
  // Best effort: the plain Activation Link column is already in place and works
  // on its own, so a failure here costs the button, not the invitation.
  const buttonCol = columns.get('activation button');
  if (buttonCol !== undefined) {
    const formulas = rows.map((data) => ({
      range: `${quoteTab(title)}!${columnLetter(buttonCol + 1)}${positions.get(data.attemptId)}`,
      values: [[buttonFormula(data.activationLink)]],
    }));
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.googleSheets.mergoActivationSheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: formulas },
      });
    } catch (err) {
      logger.warn('Mergo activation: button cells could not be written', { reason: err.message });
    }
  }

  const writtenAt = new Date();
  for (const data of rows) {
    const rowNumber = positions.get(data.attemptId);
    // eslint-disable-next-line no-await-in-loop
    await prisma.activationInvite.update({
      where: { attemptId: data.attemptId },
      data: { sheetRow: rowNumber, providerStatus: 'QUEUED', lastSyncedAt: writtenAt },
    });
  }
  return { written: positions.size, failed: [], title };
}

async function prepareSelected(userIds, { actorId = null, retryOfAttemptIdByUser = {} } = {}) {
  if (!isConfigured()) return { ok: false, error: 'MERGO_SHEETS_NOT_CONFIGURED' };
  const linkProblem = linkBaseProblem();
  if (linkProblem) return { ok: false, error: 'APP_URL_NOT_PUBLIC', detail: linkProblem };
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return { ok: false, error: 'NO_RECIPIENTS' };
  if (ids.length > 500) return { ok: false, error: 'BATCH_TOO_LARGE', max: 500 };

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, role: 'USER' },
    select: {
      id: true, firstName: true, lastName: true, email: true,
      role: true, passwordSetAt: true,
      passwordResetToken: { select: { usedAt: true, expiresAt: true } },
    },
  });
  const byId = new Map(users.map((user) => [user.id, user]));
  const campaignId = `JPSME-ACT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const accepted = [];
  const outcomes = [];

  for (const id of ids) {
    const user = byId.get(id);
    if (!user) {
      outcomes.push({ userId: id, ok: false, reason: 'NOT_FOUND' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await prepareOne(user, {
        retryOfAttemptId: retryOfAttemptIdByUser[id] || null,
        campaignId,
      });
      if (!result.ok) outcomes.push({ userId: id, ...result });
      else {
        accepted.push(result);
        outcomes.push({ userId: id, attemptId: result.attempt.attemptId, ok: true, providerStatus: 'PREPARED' });
      }
    } catch (err) {
      logger.error('Mergo activation: could not prepare recipient', { userId: id, reason: err.message });
      outcomes.push({ userId: id, ok: false, reason: 'PREPARATION_FAILED' });
    }
  }

  if (accepted.length) {
    try {
      await writeRows(accepted.map((item) => item.row));
      await auditService.log({
        action: 'ACTIVATION_INVITES_SENT',
        actorId,
        metadata: {
          event: 'MERGO_ACTIVATION_BATCH_CREATED',
          rowEvent: 'MERGO_ACTIVATION_ROW_CREATED',
          campaignId,
          provider: 'MERGO',
          prepared: accepted.length,
          attemptIds: accepted.map((item) => item.attempt.attemptId),
          userIds: accepted.map((item) => item.attempt.userId),
        },
      });
    } catch (err) {
      logger.error('Mergo activation: campaign rows could not be written', { reason: err.message });
      const failedAt = new Date();
      await prisma.activationInvite.updateMany({
        where: { attemptId: { in: accepted.map((item) => item.attempt.attemptId) }, providerStatus: 'PREPARED' },
        data: {
          providerStatus: 'FAILED', status: 'FAILED', failedAt,
          failureReason: String(err.message || 'Google Sheets write failed').slice(0, 255),
        },
      });
      accepted.forEach((item) => {
        const outcome = outcomes.find((row) => row.attemptId === item.attempt.attemptId);
        if (outcome) { outcome.ok = false; outcome.reason = 'SHEET_WRITE_FAILED'; }
      });
    }
  }

  return { ok: true, campaignId, outcomes, usage: await todayUsage() };
}

async function retryAttempt(attemptId, { actorId = null } = {}) {
  const previous = await prisma.activationInvite.findUnique({
    where: { attemptId: String(attemptId) },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true, passwordSetAt: true } } },
  });
  if (!previous || previous.channel !== 'MERGO') return { ok: false, reason: 'NOT_FOUND' };
  if (previous.user.passwordSetAt) return { ok: false, reason: 'ALREADY_ACTIVATED' };
  const linkProblem = linkBaseProblem();
  if (linkProblem) return { ok: false, reason: 'APP_URL_NOT_PUBLIC', detail: linkProblem };

  // A retry mints a new link, and a member has exactly one: the new one
  // replaces whatever is in their inbox. So it is only allowed when the link it
  // replaces can no longer get them in — the email failed or bounced, or the
  // link expired or is gone. Retrying a queued or delivered email would send a
  // second message and turn the first one's button into "not valid".
  const token = await prisma.passwordResetToken.findUnique({
    where: { userId: previous.userId },
    select: { usedAt: true, expiresAt: true, tokenHash: true },
  });
  const linkLive = Boolean(token && !token.usedAt && new Date(token.expiresAt).getTime() > Date.now());
  if (linkLive) {
    const failed = ['FAILED', 'BOUNCED'].includes(previous.providerStatus);
    // A live link that is not this attempt's belongs to a newer attempt or a
    // site email, which this retry must not overwrite either.
    const isThisAttemptsLink = Boolean(previous.tokenHash) && previous.tokenHash === token.tokenHash;
    if (!failed || !isThisAttemptsLink) return { ok: false, reason: 'ATTEMPT_STILL_ACTIVE' };
  }

  const usage = await todayUsage();
  if (usage.remaining < 1) return { ok: false, reason: 'DAILY_CAP', ...usage };

  const user = { ...previous.user, passwordResetToken: null };
  const result = await prepareOne(user, {
    retryOfAttemptId: previous.attemptId,
    campaignId: previous.campaignId || `JPSME-ACT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
  });
  if (!result.ok) return result;
  try {
    await writeRows([result.row]);
  } catch (err) {
    await prisma.activationInvite.update({
      where: { attemptId: result.attempt.attemptId },
      data: { providerStatus: 'FAILED', status: 'FAILED', failedAt: new Date(), failureReason: String(err.message).slice(0, 255) },
    });
    return { ok: false, reason: 'SHEET_WRITE_FAILED' };
  }
  await auditService.log({
    action: 'ACTIVATION_INVITE_RESENT',
    actorId,
    targetUserId: previous.userId,
    metadata: {
      event: 'ACTIVATION_EMAIL_RETRY_CREATED', provider: 'MERGO',
      attemptId: result.attempt.attemptId, retryOfAttemptId: previous.attemptId,
    },
  });
  return { ok: true, attemptId: result.attempt.attemptId, retryOfAttemptId: previous.attemptId };
}

async function syncStatuses({ actorId = null } = {}) {
  if (!isConfigured()) return { ok: false, error: 'MERGO_SHEETS_NOT_CONFIGURED' };
  const sheets = getSheetsClient();
  const title = await ensureTab(sheets);
  const headers = await ensureHeaders(sheets, title);
  const rows = await readCampaign(sheets, title);
  const columns = headerMap(headers);
  const statusIndex = ['merge status', 'mergo status', 'email status', 'delivery status', 'status']
    .map((name) => columns.get(name)).find((i) => i !== undefined);
  const openIndex = columns.get('open status');
  const openedAtIndex = ['opened at', 'open date', 'opened'].map((name) => columns.get(name)).find((i) => i !== undefined);
  const sentAtIndex = ['sent at', 'sent date', 'merge date'].map((name) => columns.get(name)).find((i) => i !== undefined);
  if (statusIndex === undefined) return { ok: false, error: 'STATUS_COLUMN_MISSING' };
  const idIndex = columns.get('attempt id');
  const emailIndex = columns.get('email');
  if (idIndex === undefined || emailIndex === undefined) return { ok: false, error: 'IDENTITY_COLUMNS_MISSING' };

  const dataRows = rows.slice(1);
  const byId = new Map();
  const duplicateIds = new Set();
  dataRows.forEach((row, offset) => {
    const id = readCell(row, idIndex);
    if (!id) return;
    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, { row, rowNumber: offset + 2 });
  });
  if (!byId.size) return { ok: true, synced: 0, unchanged: 0, unknown: 0, duplicates: 0, missing: 0 };

  const attempts = await prisma.activationInvite.findMany({
    where: { attemptId: { in: [...byId.keys()] }, channel: 'MERGO' },
  });
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const summary = { ok: true, synced: 0, unchanged: 0, unknown: 0, duplicates: duplicateIds.size, missing: 0, errors: [] };
  const now = new Date();

  for (const [id, item] of byId) {
    if (duplicateIds.has(id)) {
      summary.errors.push(`Sheet rows contain duplicate Attempt ID ${id}.`);
      continue;
    }
    const attempt = attemptById.get(id);
    if (!attempt) { summary.unknown += 1; continue; }
    const email = readCell(item.row, emailIndex).toLowerCase();
    if (!email || email !== String(attempt.email || '').toLowerCase()) {
      summary.errors.push(`Attempt ${id}: sheet email does not match the saved attempt.`);
      continue;
    }
    const statusText = readCell(item.row, statusIndex);
    const openText = readCell(item.row, openIndex);
    const openedAt = openedAtIndex === undefined ? null : parseSheetDate(item.row[openedAtIndex]);
    const sentAt = sentAtIndex === undefined ? null : parseSheetDate(item.row[sentAtIndex]);
    const explicitOpen = /^(OPEN|OPENED|YES|TRUE|CLICKED)$/i.test(openText) || Boolean(openedAt);
    const rawStatus = explicitOpen ? (openText || 'OPENED') : statusText;
    const providerStatus = normalizeMergoStatus(rawStatus);
    if (!providerStatus) {
      if (rawStatus) summary.errors.push(`Attempt ${id}: unsupported Mergo status "${rawStatus}".`);
      continue;
    }

    const update = { lastSyncedAt: now, sheetRow: item.rowNumber };
    // A later spreadsheet refresh must not downgrade a terminal result.
    const rank = { PREPARED: 0, QUEUED: 1, SENT: 2, OPENED: 3 };
    const nextStatus = attempt.providerStatus === 'BOUNCED' ? 'BOUNCED'
      : (attempt.providerStatus === 'FAILED'
        ? (['SENT', 'OPENED'].includes(providerStatus) ? providerStatus : 'FAILED')
        : (rank[attempt.providerStatus] !== undefined && rank[providerStatus] !== undefined
          && rank[providerStatus] < rank[attempt.providerStatus] ? attempt.providerStatus : providerStatus));
    if (nextStatus !== attempt.providerStatus) update.providerStatus = nextStatus;
    if (nextStatus === 'SENT' || nextStatus === 'OPENED') {
      update.status = nextStatus === 'OPENED' ? 'DELIVERED' : 'SENT';
      update.sentAt = attempt.sentAt || sentAt || now;
      update.failureReason = null;
      update.failedAt = null;
    }
    if (nextStatus === 'OPENED' && !attempt.openedAt) update.openedAt = openedAt || now;
    if (nextStatus === 'BOUNCED') {
      update.status = 'BOUNCED';
      update.bouncedAt = attempt.bouncedAt || now;
      update.failedAt = attempt.failedAt || now;
      update.failureReason = rawStatus.slice(0, 255);
    }
    if (nextStatus === 'FAILED') {
      update.status = 'FAILED';
      update.failedAt = attempt.failedAt || now;
      update.failureReason = rawStatus.slice(0, 255);
    }
    // eslint-disable-next-line no-await-in-loop
    await prisma.activationInvite.update({ where: { id: attempt.id }, data: update });
    if (nextStatus === attempt.providerStatus) summary.unchanged += 1;
    else summary.synced += 1;
  }

  const localAttempts = await prisma.activationInvite.findMany({
    where: { channel: 'MERGO', providerStatus: { in: ACTIVE_PROVIDER_STATUSES } },
    select: { attemptId: true },
  });
  summary.missing = localAttempts.filter((attempt) => !attempt.attemptId || !byId.has(attempt.attemptId)).length;
  await auditService.log({
    action: 'ACTIVATION_DELIVERY_IMPORTED',
    actorId,
    metadata: {
      event: 'MERGO_STATUS_SYNCED', provider: 'MERGO', synced: summary.synced,
      unchanged: summary.unchanged, unknown: summary.unknown, duplicates: summary.duplicates,
    },
  });
  return summary;
}

async function setDailyCap(cap, { actorId = null } = {}) {
  const parsed = Number(cap);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) return { ok: false, reason: 'INVALID_CAP' };
  await settingsService.setMergoActivationDailyCap(parsed);
  await auditService.log({
    action: 'ACTIVATION_INVITES_SENT', actorId,
    metadata: { event: 'MERGO_ACTIVATION_CAP_UPDATED', provider: 'MERGO', dailyCapUpdated: parsed },
  });
  return { ok: true, ...(await todayUsage()) };
}

module.exports = {
  OWNED_COLUMNS,
  FORMULA_COLUMNS,
  buttonFormula,
  ACTIVE_PROVIDER_STATUSES,
  isConfigured,
  sheetUrl,
  normalizeMergoStatus,
  makeAttemptId,
  todayUsage,
  summary,
  attemptHistory,
  prepareSelected,
  retryAttempt,
  writeRows,
  syncStatuses,
  setDailyCap,
  // Exported for isolated tests without touching Google credentials.
  headerMap,
  columnLetter,
  parseSheetDate,
};
