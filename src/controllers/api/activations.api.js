const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const activationTracking = require('../../services/activationTracking.service');
const mergoActivation = require('../../services/mergoActivation.service');
const passwordResetService = require('../../services/passwordReset.service');

// The Activations page's data and its three actions.
//
// Kept out of admin.api.js, which is already a very large file, because this is
// a self-contained feature with its own service.

const list = asyncHandler(async (req, res) => {
  const result = await activationTracking.loadStates({
    search: String(req.query.search || '').trim(),
    state: String(req.query.state || '').trim(),
    emailStatus: String(req.query.emailStatus || '').trim(),
    page: req.query.page,
    pageSize: req.query.pageSize,
  });
  return success(res, {
    ...result,
    mergo: {
      configured: mergoActivation.isConfigured(),
      sheetUrl: mergoActivation.sheetUrl(),
      ...(await mergoActivation.todayUsage()),
      summary: await mergoActivation.summary(),
    },
  });
});

const attemptHistory = asyncHandler(async (req, res) => {
  const attempts = await mergoActivation.attemptHistory(req.params.userId);
  return success(res, { attempts });
});

// One person, for when somebody says theirs never arrived.
const resendOne = asyncHandler(async (req, res) => {
  const result = await activationTracking.resendFor(req.params.id, {
    actorId: req.session.user.id,
  });
  if (!result.queued) {
    // Distinguished rather than collapsed into one message: "already activated"
    // means the admin is looking at a stale page and the member is fine, which
    // is a completely different thing from a missing account.
    if (result.reason === 'ALREADY_ACTIVATED') {
      return error(res, 'That member has already activated, so there is nothing to send.', 400);
    }
    if (result.reason === 'MERGO_LINK_PENDING') {
      return error(res, passwordResetService.MERGO_LINK_PENDING_MESSAGE, 409);
    }
    return error(res, 'No such member.', 404);
  }
  return success(res, null, 'Activation link queued. It will arrive in the next minute or two.');
});

// Everyone in one state at once — the "resend all expired" and "resend all
// bounced" buttons.
const resendState = asyncHandler(async (req, res) => {
  const state = String(req.body.state || '').trim();
  const result = await activationTracking.resendForState(state, {
    actorId: req.session.user.id,
  });

  if (result.reason === 'NOT_RESENDABLE') {
    return error(res, 'That is not a state a bulk resend makes sense for.', 400);
  }
  if (!result.queued) {
    return success(res, result, 'Nobody in that state needs a link right now — they are already queued, '
      + 'or their Mergo email is still on its way. Nothing was sent.');
  }

  const label = activationTracking.STATE_LABELS[state] || state;
  const capped = result.skipped
    ? ` Capped at ${result.limit} per press — press again for the rest.`
    : '';
  return success(res, result,
    `Queued ${result.queued} link(s) for members whose invitation shows "${label}".${capped}`);
});

const prepareMergo = asyncHandler(async (req, res) => {
  const result = await mergoActivation.prepareSelected(req.body.userIds, {
    actorId: req.session.user.id,
  });
  if (!result.ok) {
    const messages = {
      MERGO_SHEETS_NOT_CONFIGURED: ['Configure the Mergo activation Sheet ID and Google service account first.', 503],
      NO_RECIPIENTS: ['Select at least one eligible member.', 400],
      BATCH_TOO_LARGE: [`Select no more than ${result.max} members at a time.`, 400],
      DAILY_CAP: [`Daily activation cap reached. ${result.preparedToday} of ${result.cap} are already prepared today.`, 429],
      APP_URL_NOT_PUBLIC: [`Nothing was added to Mergo. ${result.detail} Run this from the live site.`, 409],
    };
    const [message, status] = messages[result.error] || ['Could not prepare this campaign.', 400];
    return error(res, message, status, result);
  }
  const ready = result.outcomes.filter((item) => item.ok).length;
  const skipped = result.outcomes.length - ready;
  return success(res, result, `Prepared ${ready} Mergo activation email(s)${skipped ? `; ${skipped} skipped or failed` : ''}. Mergo sends them after its campaign is launched or its new-row schedule runs.`);
});

const syncMergo = asyncHandler(async (req, res) => {
  const result = await mergoActivation.syncStatuses({ actorId: req.session.user.id });
  if (!result.ok) {
    const messages = {
      MERGO_SHEETS_NOT_CONFIGURED: ['Configure the Mergo activation Google Sheet first.', 503],
      STATUS_COLUMN_MISSING: ['Mergo has not added a status column yet. Open the sheet in Mergo, choose the Email column and your Gmail draft, then launch the campaign. Refresh status here after Mergo updates the sheet.', 422],
      IDENTITY_COLUMNS_MISSING: ['The campaign sheet is missing the Attempt ID or Email column.', 422],
    };
    const [message, status] = messages[result.error] || ['Could not read the Mergo campaign sheet.', 502];
    return error(res, message, status);
  }
  return success(res, result, `Synced ${result.synced} changed status(es); ${result.unchanged} unchanged, ${result.unknown} unknown attempt(s).`);
});

const retryMergo = asyncHandler(async (req, res) => {
  const result = await mergoActivation.retryAttempt(req.params.attemptId, { actorId: req.session.user.id });
  if (!result.ok) {
    const messages = {
      NOT_FOUND: ['Mergo activation attempt not found.', 404],
      ALREADY_ACTIVATED: ['That member has already activated.', 400],
      DAILY_CAP: [`Daily activation cap reached (${result.preparedToday}/${result.cap}).`, 429],
      INVALID_EMAIL: ['The member has no valid email address.', 400],
      ATTEMPT_STILL_ACTIVE: ['This member still has a working activation link from an email that is queued or was delivered. '
        + 'Retry once that email fails or bounces, or its link expires — retrying now would break the link they have.', 409],
      APP_URL_NOT_PUBLIC: [`Nothing was added to Mergo. ${result.detail} Run this from the live site.`, 409],
    };
    const [message, status] = messages[result.reason] || ['Could not retry the Mergo activation.', 400];
    return error(res, message, status);
  }
  return success(res, result, 'A new Mergo activation attempt was prepared. The previous attempt remains in history.');
});

const mergoUsage = asyncHandler(async (req, res) => {
  return success(res, {
    configured: mergoActivation.isConfigured(),
    sheetUrl: mergoActivation.sheetUrl(),
    ...(await mergoActivation.todayUsage()),
    summary: await mergoActivation.summary(),
  });
});

const setMergoCap = asyncHandler(async (req, res) => {
  const result = await mergoActivation.setDailyCap(req.body.cap, { actorId: req.session.user.id });
  if (!result.ok) return error(res, 'Daily cap must be a whole number between 1 and 10,000.', 400);
  return success(res, result, `Daily Mergo activation cap set to ${result.cap}.`);
});

// Reading Mergo's delivery outcomes back in. This is the only route by which a
// bounce enters the system at all, so a dry run is offered first — the same
// preview-then-apply shape as the member import, and for the same reason: a
// sheet that has been through a person's hands is worth looking at before it
// writes anything.
const importDelivery = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return error(res, 'Attach the spreadsheet Mergo merged from.', 400);
  }

  const dryRun = String(req.body.dryRun || '') === 'true';
  const result = await activationTracking.importMergoStatuses(req.file.buffer, {
    actorId: req.session.user.id,
    dryRun,
  });

  if (!result.ok) {
    return error(res, result.error, 422, result.errors || []);
  }

  const parts = [];
  if (result.bounced) parts.push(`${result.bounced} bounced`);
  if (result.delivered) parts.push(`${result.delivered} delivered`);
  if (result.failed) parts.push(`${result.failed} failed`);
  const detail = parts.length ? parts.join(', ') : 'no delivery outcomes';

  return success(res, result, dryRun
    ? `Preview only, nothing saved: ${result.matched} of ${result.read} row(s) matched a member — ${detail}.`
    : `Recorded ${result.matched} delivery outcome(s): ${detail}.`);
});

module.exports = { list, attemptHistory, resendOne, resendState, importDelivery, prepareMergo, syncMergo, retryMergo, mergoUsage, setMergoCap };
