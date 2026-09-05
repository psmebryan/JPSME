const config = require('../config');
const logger = require('../utils/logger');
const paymongoService = require('../services/paymongo.service');
const auditService = require('../services/audit.service');

// Asks PayMongo whether it can still reach us, and says so loudly when it
// cannot.
//
// This exists because of a real failure that took a while to spot: the webhook
// registered with PayMongo had been switched off, so no payment could ever be
// confirmed the fast way. Nothing was broken in a way anyone could see — the
// reconciliation sweep quietly picked payments up ten to twenty-five minutes
// later, so the only symptom was "paying feels slow", which is a very hard
// thing to trace back to a disabled webhook.
//
// A dead webhook is not an outage; it is a silent downgrade to the slow path.
// That is precisely the kind of fault worth an alarm, because nothing else will
// ever raise one.

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Compares what PayMongo has registered against where this deployment actually
// answers. Returns a plain verdict rather than throwing — a health check that
// can take the server down with it is worse than the thing it watches.
async function checkWebhookHealth() {
  if (!config.payment.paymongoSecretKey) {
    return { ok: false, reason: 'no-secret-key', detail: 'PAYMONGO_SECRET_KEY is not set' };
  }

  let hooks;
  try {
    hooks = await paymongoService.listWebhooks();
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }

  if (!hooks.length) {
    return {
      ok: false,
      reason: 'none-registered',
      detail: 'PayMongo has no webhook registered, so it has nowhere to send payment confirmations',
    };
  }

  const expectedUrl = `${config.appUrl.replace(/\/$/, '')}/api/webhooks/paymongo`;
  const enabled = hooks.filter((h) => h.attributes && h.attributes.status === 'enabled');

  if (!enabled.length) {
    return {
      ok: false,
      reason: 'disabled',
      detail: `every registered webhook is disabled (${hooks.map((h) => h.attributes.url).join(', ')})`,
    };
  }

  // A mismatch is reported but not treated as a failure. APP_URL is frequently
  // localhost in development while the webhook legitimately points at a tunnel
  // in front of it, and calling that broken would cry wolf on every dev machine.
  const matching = enabled.find((h) => h.attributes.url === expectedUrl);
  if (!matching) {
    return {
      ok: true,
      reason: 'url-mismatch',
      detail: `enabled webhook points at ${enabled.map((h) => h.attributes.url).join(', ')}, `
        + `while APP_URL implies ${expectedUrl} — fine if a tunnel or proxy sits in front, `
        + 'wrong if the address is simply stale',
    };
  }

  return { ok: true, reason: 'healthy', detail: matching.attributes.url };
}

async function runCheck() {
  let verdict;
  try {
    verdict = await checkWebhookHealth();
  } catch (err) {
    logger.error('webhook health check: failed unexpectedly', { err: err.message });
    return;
  }

  if (verdict.ok && verdict.reason === 'healthy') {
    logger.info('webhook health check: PayMongo can reach us', { url: verdict.detail });
    return;
  }

  if (verdict.ok) {
    logger.warn(`webhook health check: ${verdict.reason} — ${verdict.detail}`);
    return;
  }

  // Written to the audit log as well as the console, because a console line on
  // a server nobody is watching is not a warning anyone will receive.
  logger.error(
    `webhook health check: PAYMENTS WILL CONFIRM SLOWLY — ${verdict.reason}: ${verdict.detail}. `
    + 'Until this is fixed, payments are only resolved by the reconciliation sweep, which takes minutes rather than seconds.'
  );
  await auditService.log({
    action: 'WEBHOOK_REJECTED',
    metadata: { check: 'webhook-health', reason: verdict.reason, detail: verdict.detail },
  });
}

let intervalHandle = null;

function startWebhookHealthCheck() {
  if (intervalHandle) return;
  // Soon after boot rather than instantly, so it does not compete with startup,
  // and then hourly — this changes rarely, and the check costs an API call.
  setTimeout(runCheck, 45 * 1000);
  intervalHandle = setInterval(runCheck, CHECK_INTERVAL_MS);
  logger.info('Webhook health check scheduled: hourly');
}

function stopWebhookHealthCheck() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startWebhookHealthCheck, stopWebhookHealthCheck, runCheck, checkWebhookHealth };
