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

// The old .env.example placeholder (that file is gone, but the value may
// still be sitting in someone's .env) and this project's own dev-only value
// are both checked by name — a
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

// Reads a boolean setting from the environment without being fussy about how
// it was written.
//
// Environment values arrive as strings, but the person typing one into a
// hosting panel has no way to know that, and some panels advise wrapping
// values in quotes and then store the quotes. A strict === "true" turns any of
// that into a silently disabled setting — which for TRUST_PROXY means sessions
// quietly stop working, with nothing to connect the symptom to the cause.
//
// So: surrounding quotes are stripped, case and whitespace are ignored, and the
// spellings people actually use all count. Anything unrecognised is false,
// which keeps the default off for a setting nobody deliberately enabled.
function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

const config = {
  get env() { return process.env.NODE_ENV || 'development'; },
  get isProduction() { return process.env.NODE_ENV === 'production'; },
  get port() { return Number(process.env.PORT) || 3000; },
  get appUrl() { return process.env.APP_URL || `http://localhost:${config.port}`; },
  get trustProxy() { return envFlag('TRUST_PROXY'); },
  get clusterWorkers() { return Math.max(1, Number(process.env.CLUSTER_WORKERS) || 1); },

  database: {
    // DATABASE_URL first, because Prisma needs a single URL and an explicit
    // value should always win.
    //
    // Failing that, build one from DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD.
    // Managed platforms attach a database by injecting those five variables
    // rather than a URL — nothing sets DATABASE_URL for you, so without this
    // the app cannot see a database that is sitting right there, already
    // provisioned and already reachable.
    get url() {
      if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

      const host = process.env.DB_HOST;
      const name = process.env.DB_NAME;
      const user = process.env.DB_USER;
      if (!host || !name || !user) return undefined;

      const port = process.env.DB_PORT || 3306;
      // Encoded, not interpolated raw: an injected password is not chosen by
      // anyone and routinely contains @ # / or ?, each of which would end the
      // URL early and produce a parse error naming the wrong component.
      const auth = process.env.DB_PASSWORD
        ? `${encodeURIComponent(user)}:${encodeURIComponent(process.env.DB_PASSWORD)}`
        : encodeURIComponent(user);

      return `mysql://${auth}@${host}:${port}/${encodeURIComponent(name)}`;
    },

    // Which of the two the value came from. Worth reporting at startup: "no
    // database" and "the wrong database" look identical in a connection error,
    // and on a platform that injects credentials it is genuinely unobvious
    // which set is in play.
    // Runs `prisma migrate deploy` at startup. Off unless asked for, because
    // schema changes should normally be a deliberate step, not a side effect
    // of a restart. It exists for platforms that give you no shell — where
    // otherwise a freshly attached database stays empty forever and every
    // page fails on a missing table, with no way in to fix it.
    get migrateOnBoot() { return envFlag('RUN_MIGRATIONS_ON_BOOT'); },

    get source() {
      if (process.env.DATABASE_URL) return "DATABASE_URL";
      if (process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER) return "DB_* variables";
      return "nothing";
    },
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
    // 'inline' (default) runs the job queue inside the web server, so a host
    // that keeps only one process alive still sends confirmation emails.
    // 'external' leaves the queue entirely to `npm run worker`, which is the
    // better arrangement where a second process can actually be relied on.
    get workerMode() { return oneOf('WORKER_MODE', ['inline', 'external'], 'inline'); },
  },

  email: {
    get provider() { return oneOf('EMAIL_PROVIDER', ['brevo'], 'brevo'); },
    get brevoApiKey() { return process.env.BREVO_API_KEY; },
    get brevoSender() { return process.env.BREVO_SENDER; },
    get brevoWebhookSecret() { return process.env.BREVO_WEBHOOK_SECRET; },
    smtp: {
      get host() { return process.env.SMTP_HOST; },
      get port() { return Number(process.env.SMTP_PORT) || 587; },
      get secure() { return envFlag('SMTP_SECURE'); },
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

  captcha: {
    // Both must be set for Turnstile to do anything. The site key is public
    // (it is rendered into the page); the secret key never leaves the server.
    // With neither set, the honeypot in captcha.service.js still runs.
    get turnstileSiteKey() { return process.env.TURNSTILE_SITE_KEY; },
    get turnstileSecretKey() { return process.env.TURNSTILE_SECRET_KEY; },
  },

  googleSheets: {
    get sheetId() { return process.env.GOOGLE_SHEETS_ID; },
    get serviceAccountEmail() { return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL; },
    get serviceAccountPrivateKey() { return process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY; },
  },
};

module.exports = config;
