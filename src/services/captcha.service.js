const config = require('../config');
const logger = require('../utils/logger');
const challengeService = require('./challenge.service');

// Bot protection for the handful of public forms that create records or send
// mail to an address the sender chose — registration, resend-verification, and
// the guest "request an invitation" form. Those are what a bot actually wants;
// login is left to its existing five-tries-per-quarter-hour limit, because
// challenging every member on every sign-in costs more than it saves.
//
// Two independent layers, because they fail in different ways:
//
//   1. A honeypot, which needs no keys and no third party, and therefore works
//      right now. Most abuse is a script filling every field it can find; a
//      field a human never sees and never fills catches that outright.
//
//   2. Either Cloudflare Turnstile, or — when its keys are not configured — a
//      built-in challenge the server generates and checks itself. Turnstile is
//      much the stronger of the two and is nearly invisible to a real person,
//      so it wins whenever it is available; the built-in one exists so that a
//      deployment without keys still has something a visitor can see working,
//      rather than a hidden field and a promise.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// The hidden field's name. Deliberately plausible — a bot fills what looks
// fillable, so "website" catches far more than "honeypot_do_not_fill" would.
const HONEYPOT_FIELD = 'website';

function isTurnstileConfigured() {
  return Boolean(config.captcha.turnstileSecretKey && config.captcha.turnstileSiteKey);
}

// A real person never sees this field, so anything in it came from something
// filling the form blind.
function failedHoneypot(body) {
  const value = body && body[HONEYPOT_FIELD];
  return typeof value === 'string' && value.trim() !== '';
}

// Asks Cloudflare about one token. Returns { ok, reason }.
//
// The distinction that matters here is between "Cloudflare says no" and "we
// could not ask Cloudflare". A definitive rejection blocks the request. An
// infrastructure failure — their API down, DNS broken, egress blocked — does
// not, because refusing every registration during someone else's outage is a
// worse failure than briefly falling back to the honeypot. That fallback is
// recorded, so it shows up rather than passing silently.
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing-token' };
  }

  const params = new URLSearchParams({
    secret: config.captcha.turnstileSecretKey,
    response: token,
  });
  // Passed so Cloudflare can weigh the origin. Omitted rather than guessed when
  // it is not a plain address; behind a proxy req.ip can be a list.
  if (remoteIp && /^[0-9a-fA-F.:]+$/.test(remoteIp)) params.set('remoteip', remoteIp);

  let response;
  try {
    const controller = new AbortController();
    // A signup form must not hang on someone else's slow API.
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.error('turnstile: could not reach Cloudflare, falling back to the honeypot only', { err: err.message });
    return { ok: true, reason: 'verifier-unreachable', degraded: true };
  }

  if (!response.ok) {
    logger.error('turnstile: verifier returned an error, falling back to the honeypot only', { status: response.status });
    return { ok: true, reason: 'verifier-error', degraded: true };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: true, reason: 'verifier-unparseable', degraded: true };
  }

  if (payload.success) return { ok: true, reason: 'verified' };
  return { ok: false, reason: (payload['error-codes'] || ['rejected']).join(',') };
}

// Express middleware. Applied per route rather than globally so it is obvious
// at the route which forms are protected and which are deliberately not.
function requireHuman() {
  return async (req, res, next) => {
    if (failedHoneypot(req.body)) {
      logger.warn('captcha: honeypot filled', { path: req.path, ip: req.ip });
      // Deliberately the same message a failed Turnstile check gives. Telling a
      // script which layer caught it is telling it what to change.
      return res.status(400).json({
        success: false,
        message: 'We could not verify that you are human. Please reload the page and try again.',
        errors: null,
      });
    }

    // No Turnstile keys: the built-in challenge is the visible layer instead.
    if (!isTurnstileConfigured()) {
      if (!challengeService.verify(req.session, req.body && req.body.challengeAnswer)) {
        logger.warn('captcha: challenge answer wrong or missing', { path: req.path, ip: req.ip });
        return res.status(400).json({
          success: false,
          message: 'The characters did not match. Please try the new image.',
          errors: null,
        });
      }
      return next();
    }

    const result = await verifyTurnstileToken(req.body && req.body.captchaToken, req.ip);
    if (result.ok) {
      if (result.degraded) {
        req.captchaDegraded = true;
      }
      return next();
    }

    logger.warn('captcha: turnstile rejected a submission', { path: req.path, ip: req.ip, reason: result.reason });
    return res.status(400).json({
      success: false,
      message: 'We could not verify that you are human. Please reload the page and try again.',
      errors: null,
    });
  };
}

module.exports = {
  HONEYPOT_FIELD,
  isTurnstileConfigured,
  failedHoneypot,
  verifyTurnstileToken,
  requireHuman,
};
