require('dotenv').config();

// Single source of truth for process.env — every other file should read
// config values from here instead of process.env directly, so the full
// config surface is visible in one place and a bad driver value fails fast
// at startup instead of surfacing later as a confusing runtime error deep in
// a service.
//
// Every value below is a getter, not a snapshot taken at require time — some
// callers (paymongo.service.js's getSecretKey, the reconciliation sweeps'
// "is a provider even configured" checks, tests/paymongo.service.test.js
// which deliberately flips PAYMONGO_SECRET_KEY at runtime) rely on reading
// the live process.env value on every call, exactly like the scattered
// process.env.X reads this module replaces did. A plain frozen object here
// would silently break all of that the moment process.env changes after
// startup.
//
// SESSION_STORE / STORAGE_DRIVER / JOB_DRIVER / EMAIL_PROVIDER / PAYMENT_PROVIDER
// each name the *only* driver currently supported — they exist so that adding
// a second driver later (e.g. STORAGE_DRIVER=s3) is a change to one function
// per service instead of a repo-wide search-and-replace, not because a second
// driver is implemented today. oneOf() below enforces that: setting an
// unsupported value throws immediately rather than being silently ignored.

function oneOf(name, allowed, fallback) {
  const value = process.env[name] || fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name}=${value} is not supported yet (expected one of: ${allowed.join(', ')})`);
  }
  return value;
}

// Both the .env.example placeholder and this project's own dev-only value
// (the .env checked out for local XAMPP work) are checked by name — a
// generic "too short" fallback below also catches any other weak secret
// nobody bothered to replace. Only enforced in production so local dev never
// has to think about it.
const PLACEHOLDER_SESSION_SECRETS = new Set([
  'change-this-to-a-long-random-string',
  'dev-only-secret-change-me-please-8f92k3nd8s',
]);
const MIN_SESSION_SECRET_LENGTH = 32;

function requireSessionSecret() {
  const value = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!value || PLACEHOLDER_SESSION_SECRETS.has(value) || value.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET is missing, a known placeholder, or too short (< ${MIN_SESSION_SECRET_LENGTH} chars) — ` +
        'refusing to start in production. Generate a real one, e.g.: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
      );
    }
  }
  return value;
}

const config = {
  get env() { return process.env.NODE_ENV || 'development'; },
  get isProduction() { return process.env.NODE_ENV === 'production'; },
  get port() { return Number(process.env.PORT) || 3000; },
  get appUrl() { return process.env.APP_URL || `http://localhost:${config.port}`; },
  get trustProxy() { return process.env.TRUST_PROXY === 'true'; },
  get clusterWorkers() { return Math.max(1, Number(process.env.CLUSTER_WORKERS) || 1); },

  database: {
    get url() { return process.env.DATABASE_URL; },
  },

  session: {
    get secret() { return requireSessionSecret(); },
    get store() { return oneOf('SESSION_STORE', ['mysql'], 'mysql'); },
  },

  storage: {
    get driver() { return oneOf('STORAGE_DRIVER', ['local'], 'local'); },
  },

  jobs: {
    get driver() { return oneOf('JOB_DRIVER', ['local'], 'local'); },
    invitationReconciliation: {
      get lookbackDays() { return Number(process.env.INVITATION_RECONCILIATION_LOOKBACK_DAYS) || 14; },
      get sweepIntervalMinutes() { return Number(process.env.INVITATION_RECONCILIATION_SWEEP_INTERVAL_MINUTES) || 30; },
    },
    paymentReconciliation: {
      get stuckThresholdMinutes() { return Number(process.env.RECONCILIATION_STUCK_THRESHOLD_MINUTES) || 10; },
      get sweepIntervalMinutes() { return Number(process.env.RECONCILIATION_SWEEP_INTERVAL_MINUTES) || 15; },
    },
    get broadcastSendIntervalMs() { return Number(process.env.BROADCAST_SEND_INTERVAL_MS) || 350; },
  },

  email: {
    get provider() { return oneOf('EMAIL_PROVIDER', ['brevo'], 'brevo'); },
    get brevoApiKey() { return process.env.BREVO_API_KEY; },
    get brevoSender() { return process.env.BREVO_SENDER; },
    get brevoWebhookSecret() { return process.env.BREVO_WEBHOOK_SECRET; },
    smtp: {
      get host() { return process.env.SMTP_HOST; },
      get port() { return Number(process.env.SMTP_PORT) || 587; },
      get secure() { return process.env.SMTP_SECURE === 'true'; },
      get user() { return process.env.SMTP_USER; },
      get pass() { return process.env.SMTP_PASS; },
    },
    get from() { return process.env.SMTP_FROM || process.env.BREVO_SENDER || 'JPSME <no-reply@jpsme.local>'; },
  },

  payment: {
    get provider() { return oneOf('PAYMENT_PROVIDER', ['paymongo'], 'paymongo'); },
    get paymongoSecretKey() { return process.env.PAYMONGO_SECRET_KEY; },
    get paymongoPublicKey() { return process.env.PAYMONGO_PUBLIC_KEY; },
    get paymongoWebhookSecret() { return process.env.PAYMONGO_WEBHOOK_SECRET; },
  },

  googleSheets: {
    get sheetId() { return process.env.GOOGLE_SHEETS_ID; },
    get serviceAccountEmail() { return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL; },
    get serviceAccountPrivateKey() { return process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY; },
  },
};

module.exports = config;
