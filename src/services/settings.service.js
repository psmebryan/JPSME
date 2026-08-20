const prisma = require('../config/prisma');

const LOGO_KEY = 'site_logo';
const DEFAULT_LOGO = '/img/default-logo.svg';

// Stored in centavos (PHP's smallest unit, matching PayMongo's own amount
// convention) so payment code never has to deal with float currency math.
const MEMBERSHIP_FEE_KEY = 'membership_fee_centavos';
const DEFAULT_MEMBERSHIP_FEE_CENTAVOS = 50000; // placeholder ₱500.00 — set the real fee from /admin/settings before going live

// Kill switch: lets a MAIN_ADMIN stop new payments (membership or event fees)
// from being created — e.g. during a PayMongo outage — without taking the
// rest of the site down. Never gates webhook processing; an already-issued
// checkout must still be able to confirm/fail via its webhook regardless.
const PAYMENTS_ENABLED_KEY = 'payments_enabled';

async function getSetting(key, fallback = null) {
  const setting = await prisma.siteSetting.findUnique({ where: { key } });
  return setting ? setting.value : fallback;
}

async function setSetting(key, value) {
  return prisma.siteSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function getLogoUrl() {
  return getSetting(LOGO_KEY, DEFAULT_LOGO);
}

async function setLogoUrl(publicPath) {
  return setSetting(LOGO_KEY, publicPath);
}

async function getMembershipFeeCentavos() {
  const value = await getSetting(MEMBERSHIP_FEE_KEY, String(DEFAULT_MEMBERSHIP_FEE_CENTAVOS));
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : DEFAULT_MEMBERSHIP_FEE_CENTAVOS;
}

async function setMembershipFeeCentavos(centavos) {
  return setSetting(MEMBERSHIP_FEE_KEY, String(Math.trunc(centavos)));
}

async function getPaymentsEnabled() {
  const value = await getSetting(PAYMENTS_ENABLED_KEY, 'true');
  return value !== 'false';
}

async function setPaymentsEnabled(enabled) {
  return setSetting(PAYMENTS_ENABLED_KEY, enabled ? 'true' : 'false');
}

module.exports = {
  getSetting,
  setSetting,
  getLogoUrl,
  setLogoUrl,
  getMembershipFeeCentavos,
  setMembershipFeeCentavos,
  getPaymentsEnabled,
  setPaymentsEnabled,
  LOGO_KEY,
  MEMBERSHIP_FEE_KEY,
  PAYMENTS_ENABLED_KEY,
};
