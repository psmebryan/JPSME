const invitationService = require('../services/invitation.service');

// How far back an invitation is still worth polling Brevo about — see
// findInvitationsNeedingReconciliation for why this stays bounded rather than
// checking every invitation ever sent.
const LOOKBACK_DAYS = Number(process.env.INVITATION_RECONCILIATION_LOOKBACK_DAYS) || 14;
const SWEEP_INTERVAL_MINUTES = Number(process.env.INVITATION_RECONCILIATION_SWEEP_INTERVAL_MINUTES) || 30;

async function runSweep() {
  let candidates;
  try {
    candidates = await invitationService.findInvitationsNeedingReconciliation(LOOKBACK_DAYS);
  } catch (err) {
    console.error('Invitation reconciliation sweep: failed to query candidates:', err.message);
    return;
  }

  if (candidates.length === 0) return;
  if (!process.env.BREVO_API_KEY) return; // nothing to poll without a configured provider

  console.log(`Invitation reconciliation sweep: checking ${candidates.length} invitation(s)...`);
  const outcomes = {};
  // Sequential, same reasoning as the payment sweep — this app's invitation
  // volume never justifies a concurrency limiter, and it keeps calls to
  // Brevo's API gentle rather than bursting them all at once.
  // eslint-disable-next-line no-restricted-syntax
  for (const invitation of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await invitationService.reconcileInvitation(invitation.id);
      const key = result.updated ? `updated:${result.fields.join('+')}` : 'unchanged';
      outcomes[key] = (outcomes[key] || 0) + 1;
    } catch (err) {
      console.error(`Invitation reconciliation sweep: failed to reconcile invitation ${invitation.id}:`, err.message);
      outcomes.error = (outcomes.error || 0) + 1;
    }
  }
  console.log('Invitation reconciliation sweep: done —', JSON.stringify(outcomes));
}

let intervalHandle = null;

function startInvitationReconciliationSweep() {
  if (intervalHandle) return; // already running — don't double-schedule on a hot reload
  // Offset from the payment sweep's own 30s first-run so they don't both hit
  // their providers in the same instant on every boot.
  setTimeout(runSweep, 45 * 1000);
  intervalHandle = setInterval(runSweep, SWEEP_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Invitation reconciliation sweep scheduled: every ${SWEEP_INTERVAL_MINUTES}m, lookback ${LOOKBACK_DAYS}d`);
}

function stopInvitationReconciliationSweep() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startInvitationReconciliationSweep, stopInvitationReconciliationSweep, runSweep };
