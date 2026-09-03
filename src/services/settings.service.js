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

// Whether a new member MUST pay the membership fee before they can use the
// site. Off by default: registration should work without payment, and the fee
// stays available as something a member can choose to settle later. This only
// controls the gate — it never affects whether the account or its data is
// kept, and an unpaid member's record is retained exactly like a paid one's.
// Turning it on restores the original behaviour, where a PENDING member is
// held on /membership-payment until their payment clears.
const MEMBERSHIP_PAYMENT_REQUIRED_KEY = 'membership_payment_required';

// The percentage PayMongo deducts from every GCash charge before crediting
// JPSME (currently 2.23% + 12% VAT on that fee ≈ 2.4976%, per
// paymongo.com/pricing — re-check there if this ever needs updating, PayMongo
// can change published rates without notice). Used to gross up what the payer
// is charged so JPSME still nets the full intended fee — see
// payment.service.js's calculateGatewaySurcharge. Stored as a plain decimal
// percent string (e.g. "2.4976"), not centavos — this multiplies an amount,
// it isn't one. Note: this is an upfront estimate for what to charge, not the
// real deducted amount — the actual fee PayMongo reports afterward (recorded
// separately as Payment.gatewayFeeCentavos) can differ by a centavo or two
// due to their own internal rounding, which is why that field exists too.
const GATEWAY_SURCHARGE_PERCENT_KEY = 'gateway_surcharge_percent';
const DEFAULT_GATEWAY_SURCHARGE_PERCENT = 2.4976;

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

// Defaults to false: membership is optional unless an admin turns it on.
async function getMembershipPaymentRequired() {
  const value = await getSetting(MEMBERSHIP_PAYMENT_REQUIRED_KEY, 'false');
  return value === 'true';
}

async function setMembershipPaymentRequired(required) {
  return setSetting(MEMBERSHIP_PAYMENT_REQUIRED_KEY, required ? 'true' : 'false');
}

async function getGatewaySurchargePercent() {
  const value = await getSetting(GATEWAY_SURCHARGE_PERCENT_KEY, String(DEFAULT_GATEWAY_SURCHARGE_PERCENT));
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_GATEWAY_SURCHARGE_PERCENT;
}

async function setGatewaySurchargePercent(percent) {
  return setSetting(GATEWAY_SURCHARGE_PERCENT_KEY, String(percent));
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
  getMembershipPaymentRequired,
  setMembershipPaymentRequired,
  getGatewaySurchargePercent,
  setGatewaySurchargePercent,
  LOGO_KEY,
  MEMBERSHIP_FEE_KEY,
  PAYMENTS_ENABLED_KEY,
  MEMBERSHIP_PAYMENT_REQUIRED_KEY,
  GATEWAY_SURCHARGE_PERCENT_KEY,
};
