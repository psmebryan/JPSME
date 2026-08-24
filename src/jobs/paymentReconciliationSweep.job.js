const paymentService = require('../services/payment.service');

// A payment stuck PENDING/PROCESSING this long past creation almost always
// means a lost webhook delivery (unreachable localhost, wrong URL, PayMongo
// outage) rather than a user who's simply still filling out the GCash form —
// checkout sessions themselves stay valid for far longer than this. Both are
// configurable via env vars since "normal" webhook latency and acceptable
// sweep frequency are operational judgment calls, not something to hardcode.
const STUCK_THRESHOLD_MINUTES = Number(process.env.RECONCILIATION_STUCK_THRESHOLD_MINUTES) || 10;
const SWEEP_INTERVAL_MINUTES = Number(process.env.RECONCILIATION_SWEEP_INTERVAL_MINUTES) || 15;

// Deliberately NOT gated by the payments-enabled kill switch — same reasoning
// as processWebhookEvent: disabling new checkout creation must never block
// resolving payments that are already in flight.
async function runSweep() {
  let stuck;
  try {
    stuck = await paymentService.findStuckPayments(STUCK_THRESHOLD_MINUTES);
  } catch (err) {
    console.error('Reconciliation sweep: failed to query stuck payments:', err.message);
    return;
  }

  if (stuck.length === 0) return;

  console.log(`Reconciliation sweep: checking ${stuck.length} stuck payment(s)...`);
  const outcomes = {};
  // Sequential, not parallel — this app's payment volume never justifies the
  // added complexity of a concurrency limiter, and it keeps the calls to
  // PayMongo's API gentle rather than bursting all at once.
  // eslint-disable-next-line no-restricted-syntax
  for (const payment of stuck) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await paymentService.reconcilePayment(payment.id, { triggeredBy: 'auto_sweep' });
      outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    } catch (err) {
      console.error(`Reconciliation sweep: failed to reconcile payment ${payment.id}:`, err.message);
      outcomes.error = (outcomes.error || 0) + 1;
    }
  }
  console.log('Reconciliation sweep: done —', JSON.stringify(outcomes));
}

let intervalHandle = null;

function startReconciliationSweep() {
  if (intervalHandle) return; // already running — don't double-schedule on a hot reload
  // First pass shortly after boot (not instantly — let the app finish
  // starting up) rather than waiting a full interval for the first check.
  setTimeout(runSweep, 30 * 1000);
  intervalHandle = setInterval(runSweep, SWEEP_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Reconciliation sweep scheduled: every ${SWEEP_INTERVAL_MINUTES}m, threshold ${STUCK_THRESHOLD_MINUTES}m`);
}

function stopReconciliationSweep() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startReconciliationSweep, stopReconciliationSweep, runSweep };
