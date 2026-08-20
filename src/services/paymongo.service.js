const crypto = require('crypto');
const AppError = require('../utils/AppError');

// Reference: https://docs.paymongo.com (Checkout Sessions, Refunds, Webhooks —
// fetched live while building this, not recalled from memory). Re-verify against
// PayMongo's current docs before going live if this file is touched again later.
const PAYMONGO_API_BASE = 'https://api.paymongo.com/v1';

function getSecretKey() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new AppError('Payment gateway is not configured', 503);
  return key;
}

function authHeader() {
  // PayMongo uses HTTP Basic auth with the secret key as the username and an
  // empty password.
  return `Basic ${Buffer.from(`${getSecretKey()}:`).toString('base64')}`;
}

const REQUEST_TIMEOUT_MS = 15000;

async function paymongoRequest(method, path, body) {
  // Resolved BEFORE the try block on purpose: authHeader() throws a 503
  // "gateway not configured" AppError when PAYMONGO_SECRET_KEY is missing,
  // and that's a config error, not a network failure — if it were evaluated
  // inside the try (as part of the fetch() call's argument list), the catch
  // below would swallow it and misreport it as a 502 "could not reach the
  // gateway", masking a config problem as a connectivity one.
  const authorization = authHeader();

  let res;
  try {
    res = await fetch(`${PAYMONGO_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      // Without this, a hung connection to PayMongo would leave the request
      // (and the user's browser) waiting indefinitely instead of failing cleanly.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('PayMongo request timed out after', REQUEST_TIMEOUT_MS, 'ms');
      throw new AppError('The payment gateway took too long to respond. Please try again.', 504);
    }
    console.error('PayMongo request failed (network):', err.message);
    throw new AppError('Could not reach the payment gateway. Please try again.', 502);
  }

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('PayMongo API error:', res.status, JSON.stringify(json));
    const message = json?.errors?.[0]?.detail || 'The payment gateway rejected the request';
    throw new AppError(message, 502);
  }

  return json;
}

// Creates a GCash-only Checkout Session for the given amount (integer centavos).
// Returns { checkoutId, checkoutUrl }. amountCentavos is always server-computed
// by the caller (never trust a client-sent amount) before this is called.
async function createGcashCheckout({ amountCentavos, description, referenceNumber, successUrl, cancelUrl, metadata }) {
  const payload = {
    data: {
      attributes: {
        line_items: [
          {
            amount: amountCentavos,
            currency: 'PHP',
            name: description,
            quantity: 1,
          },
        ],
        payment_method_types: ['gcash'],
        description,
        reference_number: referenceNumber,
        success_url: successUrl,
        cancel_url: cancelUrl,
        send_email_receipt: false,
        show_line_items: true,
        metadata,
      },
    },
  };

  const json = await paymongoRequest('POST', '/checkout_sessions', payload);
  const checkoutId = json?.data?.id;
  const checkoutUrl = json?.data?.attributes?.checkout_url;

  if (!checkoutId || !checkoutUrl) {
    console.error('PayMongo checkout response missing expected fields:', JSON.stringify(json));
    throw new AppError('The payment gateway returned an unexpected response', 502);
  }

  return { checkoutId, checkoutUrl };
}

// Fetches the current state of a Checkout Session directly from PayMongo —
// used for reconciliation/manual status checks, independent of webhooks.
async function getCheckoutSession(checkoutId) {
  const json = await paymongoRequest('GET', `/checkout_sessions/${checkoutId}`);
  return json?.data;
}

// Requests a refund for a previously PAID PayMongo payment. The returned
// resource's status starts as "pending"/"processing" — it only reaches
// "succeeded"/"failed" once PayMongo's own refund webhook confirms it, never
// from this synchronous response alone.
async function createRefund({ gatewayPaymentId, amountCentavos, reason, notes }) {
  const payload = {
    data: {
      attributes: {
        amount: amountCentavos,
        payment_id: gatewayPaymentId,
        reason,
        notes,
      },
    },
  };
  const json = await paymongoRequest('POST', '/refunds', payload);
  const refund = json?.data;
  if (!refund?.id) {
    console.error('PayMongo refund response missing expected fields:', JSON.stringify(json));
    throw new AppError('The payment gateway returned an unexpected response', 502);
  }
  return refund;
}

// Rejects a signature whose t= timestamp is further from "now" than this —
// defense in depth against a captured (signature, body) pair being replayed
// long after the fact. Same-event replay/duplicate-delivery is already fully
// handled at the DB level by the (gateway, webhookId) unique constraint in
// payment.service.js regardless of this window; this only narrows the time
// an intercepted-in-transit payload would remain independently valid.
// Stripe's own webhook guidance (PayMongo's signing scheme is modeled on it)
// recommends 5 minutes as a reasonable default.
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

// Verifies the `Paymongo-Signature` header against the *raw* request body.
// Per PayMongo's documented scheme: the header is `t=<timestamp>,te=<test
// signature>,li=<live signature>`; the signed string is `${timestamp}.${rawBody}`,
// HMAC-SHA256'd with the webhook endpoint secret. `te` is checked in test mode,
// `li` in live mode. Must run BEFORE any JSON parsing of the body — even a single
// byte of reformatting invalidates the signature.
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader || typeof rawBody !== 'string') return false;

  const parts = {};
  signatureHeader.split(',').forEach((segment) => {
    const eq = segment.indexOf('=');
    if (eq === -1) return;
    parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  });

  const { t: timestamp, te: testSignature, li: liveSignature } = parts;
  if (!timestamp) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expectedHex = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  const isLiveMode = (process.env.PAYMONGO_SECRET_KEY || '').startsWith('sk_live_');
  const candidate = isLiveMode ? liveSignature : testSignature;
  if (!candidate) return false;

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  let candidateBuf;
  try {
    candidateBuf = Buffer.from(candidate, 'hex');
  } catch (err) {
    return false;
  }
  if (expectedBuf.length !== candidateBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

module.exports = {
  createGcashCheckout,
  getCheckoutSession,
  createRefund,
  verifyWebhookSignature,
};
