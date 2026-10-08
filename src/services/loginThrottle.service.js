const crypto = require('crypto');
const prisma = require('../config/prisma');
const { canonicalEmail } = require('../utils/emailIdentity');
const logger = require('../utils/logger');

// Failed sign-ins, counted on the server, per account and per address.
//
// After CAPTCHA_AFTER failures within WINDOW_MS (by either count), the login
// form must pass the human check. Counted here rather than in the session, so
// clearing cookies or opening a private window does not reset it.
//
// The account count is keyed on the canonical form of whatever address was
// typed, whether or not an account exists for it. That is deliberate: the
// behaviour and the wording a visitor sees must be identical for registered
// and unregistered addresses, or this would answer "is this email signed up?".
//
// A successful sign-in clears that account's count. The address count is left
// to age out: it is shared by everyone behind one network.

const WINDOW_MS = 15 * 60 * 1000;
const CAPTCHA_AFTER = 3;
// Rows are only needed for the window; anything older than this is deleted as
// new failures are written, so the table never grows past a day of failures.
const RETAIN_MS = 24 * 60 * 60 * 1000;

function emailKey(email) {
  return crypto.createHash('sha256').update(canonicalEmail(email)).digest('hex');
}

function ipKey(ip) {
  return String(ip || 'unknown').slice(0, 64);
}

async function counts(email, ip) {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { emailKey: emailKey(email), createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ip: ipKey(ip), createdAt: { gte: since } } }),
  ]);
  return { byEmail, byIp };
}

// Whether the next sign-in for this address, from this network, needs the
// human check. Fails open on a database error: the per-IP rate limiter on the
// route still stands, and a counting fault must not stop every member signing in.
async function status(email, ip) {
  try {
    const c = await counts(email, ip);
    return { ...c, captchaRequired: c.byEmail >= CAPTCHA_AFTER || c.byIp >= CAPTCHA_AFTER };
  } catch (err) {
    logger.error('loginThrottle: could not read failure counts', { err: err.message });
    return { byEmail: 0, byIp: 0, captchaRequired: false };
  }
}

// Whether this network alone already needs the check. Used when rendering the
// login page, before anyone has typed an address.
async function ipNeedsCaptcha(ip) {
  try {
    const since = new Date(Date.now() - WINDOW_MS);
    const byIp = await prisma.loginAttempt.count({ where: { ip: ipKey(ip), createdAt: { gte: since } } });
    return byIp >= CAPTCHA_AFTER;
  } catch (err) {
    return false;
  }
}

// Records one failure and returns the counts after it.
async function recordFailure(email, ip) {
  try {
    await prisma.loginAttempt.create({ data: { emailKey: emailKey(email), ip: ipKey(ip) } });
    // Housekeeping, not awaited by anything that matters to the visitor.
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETAIN_MS) } } })
      .catch(() => {});
  } catch (err) {
    logger.error('loginThrottle: could not record a failure', { err: err.message });
  }
  return status(email, ip);
}

async function clearForEmail(email) {
  try {
    await prisma.loginAttempt.deleteMany({ where: { emailKey: emailKey(email) } });
  } catch (err) {
    logger.error('loginThrottle: could not clear failures', { err: err.message });
  }
}

module.exports = {
  WINDOW_MS,
  CAPTCHA_AFTER,
  emailKey,
  status,
  ipNeedsCaptcha,
  recordFailure,
  clearForEmail,
};
