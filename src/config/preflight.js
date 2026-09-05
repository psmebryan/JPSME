const config = require('./index');

// Checks the things that, when wrong in production, break the app in ways that
// do not look like configuration problems.
//
// Every entry here is a real failure someone would otherwise have to debug from
// symptoms. TRUST_PROXY is the clearest example: get it wrong behind a proxy
// and the secure session cookie is silently never set, so login appears to
// succeed and then does nothing at all — while the rate limiter, seeing every
// visitor as one address, locks the whole site out after five failed attempts
// by anybody.
//
// Development is left alone entirely. None of this fires unless NODE_ENV is
// production, because a local machine is meant to run on http://localhost with
// test keys.

function check() {
  const problems = [];
  const warnings = [];

  const add = (list, title, detail) => list.push({ title, detail });

  if (!config.isProduction) {
    // One nudge, not a wall of text: a developer running locally does not need
    // to be told about their own machine every time they start the server.
    return { problems, warnings, skipped: true };
  }

  const appUrl = config.appUrl || '';

  if (/localhost|127\.0\.0\.1/.test(appUrl)) {
    add(problems, 'APP_URL still points at localhost',
      `It is "${appUrl}". Every link this app emails — e-tickets, event details, the `
      + 'verification page — would send people to their own machine.');
  }

  if (appUrl && !appUrl.startsWith('https://')) {
    add(problems, 'APP_URL is not HTTPS',
      `It is "${appUrl}". Session cookies are marked secure in production and will not be sent `
      + 'over plain HTTP, and PayMongo requires a publicly trusted certificate to deliver webhooks.');
  }

  if (!config.trustProxy) {
    add(problems, 'TRUST_PROXY is not enabled',
      'Almost all hosting puts a proxy in front of Node (cPanel/Passenger, nginx, Cloudflare). '
      + 'Without this, Express sees plain HTTP and refuses to set the secure session cookie, so '
      + 'logging in appears to work and then does nothing — and every rate limit counts all '
      + 'visitors as one address, so five failed logins can lock out the entire site. '
      + 'Set TRUST_PROXY=true unless Node is genuinely facing the internet directly.');
  }

  const secretKey = config.payment.paymongoSecretKey || '';
  if (secretKey.startsWith('sk_test')) {
    add(warnings, 'PayMongo is using a TEST key in production',
      'No real payment can be taken. Swap in the live secret key, and remember the live mode '
      + 'has its own webhook and its own signing secret — reusing the test one silently rejects '
      + 'every delivery as an invalid signature.');
  }
  if (!secretKey) {
    add(problems, 'PAYMONGO_SECRET_KEY is not set', 'Checkout creation and reconciliation will both fail.');
  }
  if (!config.payment.paymongoWebhookSecret) {
    add(problems, 'PAYMONGO_WEBHOOK_SECRET is not set',
      'Every incoming webhook will be rejected as unsigned, so no payment can ever confirm the fast way.');
  }

  if (!config.email.brevoApiKey && !config.email.smtp.host) {
    add(problems, 'No email transport configured',
      'Verification codes, confirmation emails and e-tickets all depend on it. Nobody could finish signing up.');
  }

  if (!config.captcha.turnstileSiteKey || !config.captcha.turnstileSecretKey) {
    add(warnings, 'Turnstile is not configured',
      'The built-in challenge and the honeypot still run, so registration is not unprotected — but '
      + 'Turnstile is the stronger check and is free.');
  }

  if (config.jobs.workerMode === 'external') {
    add(warnings, 'WORKER_MODE=external',
      'The web server will not drain the job queue, so `npm run worker` must be running as a '
      + 'second process. If it is not, confirmation emails and e-tickets are queued and never sent.');
  }

  return { problems, warnings, skipped: false };
}

// Reports rather than throws. A refusal to boot over a warning would be worse
// than the warning; a problem list printed unmissably at startup gets fixed,
// and an app that will not start at all on a host with no console is a much
// harder thing to diagnose from the outside.
function report(logger) {
  const { problems, warnings, skipped } = check();
  if (skipped) return { problems, warnings };

  if (problems.length) {
    logger.error('='.repeat(70));
    logger.error(`PRODUCTION PREFLIGHT: ${problems.length} problem(s) that will break this deployment`);
    problems.forEach((p, i) => {
      logger.error(`  ${i + 1}. ${p.title}`);
      logger.error(`     ${p.detail}`);
    });
    logger.error('='.repeat(70));
  }

  warnings.forEach((w) => logger.warn(`PREFLIGHT: ${w.title} — ${w.detail}`));

  if (!problems.length && !warnings.length) {
    logger.info('Production preflight: all clear');
  }

  return { problems, warnings };
}

module.exports = { check, report };
