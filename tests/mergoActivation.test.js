// Isolated Mergo integration tests. Google Sheets and Prisma are stubbed so
// retries, idempotency and status sync can be exercised without live accounts.
const assert = require('assert');

process.env.MERGO_ACTIVATION_SHEET_ID = 'test-sheet-id';
process.env.MERGO_ACTIVATION_TAB = 'JPSME Activations';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'sheets-test@example.invalid';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'test-key';
process.env.MERGO_DAILY_ACTIVATION_CAP = '500';
process.env.APP_URL = 'https://jpsme.example';
delete process.env.MERGO_ALLOW_LOCAL_LINKS;

const prismaPath = require.resolve('../src/config/prisma');
const settingsPath = require.resolve('../src/services/settings.service');
const resetPath = require.resolve('../src/services/passwordReset.service');
const auditPath = require.resolve('../src/services/audit.service');
const googlePath = require.resolve('googleapis');

const memory = { users: [], attempts: [], tokenRows: new Map(), jobs: [], sheet: [] };
let failNextBatch = false;
const batches = [];
let failEveryBatch = false;
let failAfterBatchCells = 0;

function countAttempts(where = {}) {
  return memory.attempts.filter((attempt) => {
    if (where.channel && attempt.channel !== where.channel) return false;
    if (where.providerStatus && typeof where.providerStatus === 'string' && attempt.providerStatus !== where.providerStatus) return false;
    if (where.providerStatus && where.providerStatus.in && !where.providerStatus.in.includes(attempt.providerStatus)) return false;
    if (where.activatedAt && where.activatedAt.not === null && !attempt.activatedAt) return false;
    if (where.createdAt && where.createdAt.gte && attempt.createdAt < where.createdAt.gte) return false;
    return true;
  }).length;
}

const fakePrisma = {
  user: {
    async findMany({ where }) { return memory.users.filter((u) => where.id.in.includes(u.id) && u.role === 'USER'); },
    async findUnique({ where }) { return memory.users.find((u) => u.id === where.id) || null; },
    async count({ where }) { return memory.users.filter((u) => u.role === where.role && (where.passwordSetAt === null ? !u.passwordSetAt : Boolean(u.passwordSetAt))).length; },
  },
  job: { async findMany() { return memory.jobs.slice(); } },
  siteSetting: { async upsert() {} },
  passwordResetToken: {
    async findUnique({ where }) { return memory.tokenRows.get(where.userId) || null; },
    async upsert({ where, create, update }) {
      const old = memory.tokenRows.get(where.userId);
      const row = old ? { ...old, ...update } : { ...create };
      memory.tokenRows.set(where.userId, row);
      return row;
    },
  },
  activationInvite: {
    async count({ where }) { return countAttempts(where); },
    async findFirst({ where }) {
      return memory.attempts.find((a) => a.userId === where.userId && a.channel === where.channel && where.providerStatus.in.includes(a.providerStatus)) || null;
    },
    async create({ data }) {
      const row = { id: memory.attempts.length + 1, createdAt: new Date(), ...data };
      memory.attempts.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = memory.attempts.find((a) => a.id === where.id || a.attemptId === where.attemptId);
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }) {
      let count = 0;
      memory.attempts.forEach((a) => {
        const ids = where.attemptId && where.attemptId.in;
        if ((!ids || ids.includes(a.attemptId)) && (!where.providerStatus || where.providerStatus === a.providerStatus)) {
          Object.assign(a, data); count += 1;
        }
      });
      return { count };
    },
    async findMany({ where }) {
      if (where.attemptId && where.attemptId.in) return memory.attempts.filter((a) => where.attemptId.in.includes(a.attemptId)).map((a) => ({ ...a }));
      return memory.attempts.filter((a) => a.channel === where.channel && (!where.attemptId || a.attemptId)).map((a) => ({ ...a }));
    },
    async findUnique({ where, include }) {
      const attempt = memory.attempts.find((a) => a.attemptId === where.attemptId) || null;
      return attempt && include ? { ...attempt, user: memory.users.find((u) => u.id === attempt.userId) } : attempt;
    },
  },
  async $transaction(fn) {
    const tx = {
      ...fakePrisma,
      async $queryRawUnsafe() { return [{ value: String(settingsServiceCap) }]; },
      user: {
        async findUnique({ where }) {
          const user = memory.users.find((u) => u.id === where.id);
          return user ? { ...user, passwordResetToken: memory.tokenRows.get(user.id) || null } : null;
        },
      },
      activationInvite: fakePrisma.activationInvite,
    };
    return fn(tx);
  },
};

const fakeSheets = {
  spreadsheets: {
    async get() { return { data: { sheets: [{ properties: { title: 'JPSME Activations' } }] } }; },
    async batchUpdate() { return { data: { replies: [] } }; },
    values: {
      async get({ range }) {
        if (range.endsWith('!1:1')) return { data: { values: memory.sheet.length ? [memory.sheet[0]] : [] } };
        return { data: { values: memory.sheet.map((r) => r.slice()) } };
      },
      async update({ range, requestBody }) {
        const match = /!([A-Z]+)(\d+)/.exec(range);
        if (/!A1:[A-Z]+1$/.test(range)) { memory.sheet[0] = requestBody.values[0].slice(); return { data: {} }; }
        const col = columnNumber(match[1]) - 1;
        const row = Number(match[2]) - 1;
        while (memory.sheet.length <= row) memory.sheet.push([]);
        memory.sheet[row][col] = requestBody.values[0][0];
        return { data: {} };
      },
      async batchUpdate({ requestBody }) {
        batches.push({ mode: requestBody.valueInputOption, values: requestBody.data.map((d) => d.values[0][0]) });
        const data = requestBody.data;
        const limit = failAfterBatchCells > 0 ? Math.min(failAfterBatchCells, data.length) : data.length;
        for (const item of data.slice(0, limit)) {
          const match = /!([A-Z]+)(\d+)/.exec(item.range);
          const col = columnNumber(match[1]) - 1;
          const row = Number(match[2]) - 1;
          while (memory.sheet.length <= row) memory.sheet.push([]);
          memory.sheet[row][col] = item.values[0][0];
        }
        if (failEveryBatch || failNextBatch) {
          failNextBatch = false;
          failAfterBatchCells = 0;
          throw new Error('temporary Sheets API failure');
        }
        failAfterBatchCells = 0;
        return { data: {} };
      },
    },
  },
};

function columnNumber(letters) {
  return letters.split('').reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
}

require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: {
    async getMergoActivationDailyCap() { return settingsServiceCap; },
    async setMergoActivationDailyCap() {},
  },
};
require.cache[resetPath] = {
  id: resetPath, filename: resetPath, loaded: true,
  exports: {
    ACTIVATION_TTL_MS: 3 * 24 * 60 * 60 * 1000,
    async issueResetLink(userId, { ttlMs }) {
      const hash = String(userId).padStart(64, '0');
      memory.tokenRows.set(userId, { usedAt: null, expiresAt: new Date(Date.now() + ttlMs), tokenHash: hash });
      return { url: `https://jpsme.example/reset-password?uid=${userId}&token=SECRET_TOKEN`, ttlMs, tokenHash: hash };
    },
  },
};
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { async log() {} } };
require.cache[googlePath] = {
  id: googlePath, filename: googlePath, loaded: true,
  exports: { google: { auth: { JWT: class {} }, sheets: () => fakeSheets } },
};

const service = require('../src/services/mergoActivation.service');

function reset() {
  memory.users = [
    { id: 1, role: 'USER', email: 'member@example.org', firstName: 'Mina', lastName: 'Member', passwordSetAt: null },
    { id: 2, role: 'USER', email: 'broken-address', firstName: 'Bad', lastName: 'Address', passwordSetAt: null },
    { id: 3, role: 'USER', email: 'already@example.org', firstName: 'Ari', lastName: 'Active', passwordSetAt: new Date() },
  ];
  memory.attempts = [];
  memory.tokenRows.clear();
  memory.jobs = [];
  memory.sheet = [];
  failNextBatch = false;
  failEveryBatch = false;
  failAfterBatchCells = 0;
}

async function main() {
  reset();
  assert.strictEqual(service.normalizeMergoStatus('Sent'), 'SENT');
  assert.strictEqual(service.normalizeMergoStatus('Opened'), 'OPENED');
  assert.strictEqual(service.normalizeMergoStatus('Bounced (550 mailbox unavailable)'), 'BOUNCED');
  assert.strictEqual(service.normalizeMergoStatus('Not sent: address invalid'), 'FAILED');
  assert.strictEqual(service.normalizeMergoStatus('mystery'), null);
  assert.strictEqual(service.columnLetter(28), 'AB');
  assert.match(service.makeAttemptId(), /^ACT-\d{8}-[A-F0-9]{10}$/);

  const prepared = await service.prepareSelected([1, 1, 2, 3, 999]);
  assert.strictEqual(prepared.outcomes.filter((o) => o.ok).length, 1, 'a valid member is prepared once');
  assert.strictEqual(prepared.outcomes.find((o) => o.userId === 2).reason, 'INVALID_EMAIL');
  assert.strictEqual(prepared.outcomes.find((o) => o.userId === 3).reason, 'ALREADY_ACTIVATED');
  assert.strictEqual(memory.attempts.length, 1);
  assert.strictEqual(memory.attempts[0].providerStatus, 'QUEUED');
  assert.strictEqual(memory.attempts[0].tokenHash.length, 64);
  assert(JSON.stringify(memory.sheet).includes('SECRET_TOKEN'), 'the private sheet carries the activation link Mergo must send');
  assert(!JSON.stringify(prepared.outcomes).includes('SECRET_TOKEN'), 'the API result does not disclose bearer tokens');

  const tooEarly = await service.retryAttempt(memory.attempts[0].attemptId);
  assert.strictEqual(tooEarly.reason, 'ATTEMPT_STILL_ACTIVE', 'a queued email is not retried — that would break its link');
  assert.strictEqual(memory.attempts.length, 1, 'and no second attempt is minted');

  const duplicate = await service.prepareSelected([1]);
  assert.strictEqual(duplicate.outcomes[0].reason, 'ACTIVE_ATTEMPT_EXISTS', 'repeat selection does not mint another row');
  assert.strictEqual(memory.attempts.length, 1);

  // The button Mergo turns into a linked image: {{Activation Button}} in the draft.
  const buttonCol = memory.sheet[0].indexOf('Activation Button');
  assert(buttonCol >= 0, 'the sheet gets an Activation Button column');
  const button = memory.sheet[1][buttonCol];
  assert.match(button, /^=HYPERLINK\("https:\/\/jpsme\.example\/reset-password\?uid=1&token=SECRET_TOKEN", IMAGE\("https:\/\/jpsme\.example\/img\/mergo-activate-button-sm\.png"\)\)$/);
  assert(batches.some((b) => b.mode === 'RAW') && batches.some((b) => b.mode === 'USER_ENTERED'), 'data and formula are written separately');
  assert(batches.filter((b) => b.mode === 'USER_ENTERED').every((b) => b.values.every((v) => /^=HYPERLINK\(/.test(v))),
    'only the button cell is written as a formula');
  assert(batches.filter((b) => b.mode === 'RAW').every((b) => b.values.every((v) => !/^=HYPERLINK\(/.test(String(v)))),
    'member data is never evaluated as a formula');
  assert.strictEqual(service.buttonFormula('https://x/a?b="c"'), '=HYPERLINK("https://x/a?b=""c""", IMAGE("https://jpsme.example/img/mergo-activate-button-sm.png"))',
    'quotes inside the link cannot break out of the formula');

  // Mergo adds/owns its own column. Sync reads that column without rewriting it.
  memory.sheet[0].push('Merge Status');
  const mergoCol = memory.sheet[0].length - 1;
  memory.sheet[1][mergoCol] = 'OPENED';
  const attemptId = memory.attempts[0].attemptId;
  const opened = await service.syncStatuses();
  assert.strictEqual(opened.synced, 1);
  assert.strictEqual(memory.attempts[0].providerStatus, 'OPENED');
  assert(memory.attempts[0].openedAt, 'open is recorded as a tracking signal');
  const openedAgain = await service.syncStatuses();
  assert.strictEqual(openedAgain.unchanged, 1, 'repeated sync is idempotent');
  assert.strictEqual(memory.sheet[1][mergoCol], 'OPENED', 'sync leaves the Mergo-owned value untouched');

  memory.sheet[1][mergoCol] = 'Bounced (550 rejected)';
  await service.syncStatuses();
  assert.strictEqual(memory.attempts[0].providerStatus, 'BOUNCED');
  memory.sheet[1][mergoCol] = 'Sent';
  await service.syncStatuses();
  assert.strictEqual(memory.attempts[0].providerStatus, 'BOUNCED', 'a stale sent status cannot downgrade a bounce');
  memory.sheet.push(memory.sheet[1].slice());
  const duplicateRow = await service.syncStatuses();
  assert.strictEqual(duplicateRow.duplicates, 1, 'duplicate sheet attempt IDs are reported and ignored');
  memory.sheet.pop();
  memory.sheet[1][mergoCol] = 'not-a-status';
  const unknown = await service.syncStatuses();
  assert(unknown.errors.some((entry) => entry.includes('unsupported Mergo status')));
  memory.sheet[1][mergoCol] = 'Bounced (550 rejected)';

  const retry = await service.retryAttempt(attemptId);
  assert.strictEqual(retry.ok, true);
  assert.notStrictEqual(retry.attemptId, attemptId);
  assert.strictEqual(retry.retryOfAttemptId, attemptId);
  assert.strictEqual(memory.attempts.length, 2, 'retry preserves the original attempt');

  reset();
  failNextBatch = true;
  failAfterBatchCells = 3;
  const repairedWrite = await service.prepareSelected([1]);
  assert.strictEqual(repairedWrite.outcomes[0].ok, true, 'a partially applied write is repaired by stable attempt ID');
  assert.strictEqual(memory.attempts[0].providerStatus, 'QUEUED');
  const partialId = memory.attempts[0].attemptId;
  assert.strictEqual(memory.sheet.length, 2, 'a timed-out partial write is repaired in its existing row');
  await service.writeRows([{
    attemptId: partialId, userId: 1, firstName: 'Mina', lastName: 'Member',
    email: 'member@example.org', activationLink: 'https://jpsme.example/reset-password?uid=1&token=SECRET_TOKEN',
    campaignId: 'JPSME-ACT-TEST', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(),
  }]);
  assert.strictEqual(memory.sheet.length, 2, 'retry repairs the same attempt row instead of appending a duplicate');
  assert.strictEqual(memory.sheet[1][5].includes('SECRET_TOKEN'), true);

  reset();
  failEveryBatch = true;
  const failedWrite = await service.prepareSelected([1]);
  assert.strictEqual(failedWrite.outcomes[0].reason, 'SHEET_WRITE_FAILED');
  assert.strictEqual(memory.attempts[0].providerStatus, 'FAILED');

  reset();
  memory.users.push({ id: 4, role: 'USER', email: 'second@example.org', firstName: 'Second', lastName: 'Member', passwordSetAt: null });
  settingsServiceCap = 1;
  const capResult = await service.prepareSelected([1, 4]);
  assert.strictEqual(capResult.outcomes.filter((o) => o.ok).length, 1, 'daily cap applies per recipient');
  assert.strictEqual(capResult.outcomes.find((o) => o.reason === 'DAILY_CAP').reason, 'DAILY_CAP');
  settingsServiceCap = 500;

  // A delivered email whose link has since expired can be retried.
  reset();
  await service.prepareSelected([1]);
  memory.attempts[0].providerStatus = 'SENT';
  memory.tokenRows.get(1).expiresAt = new Date(Date.now() - 1000);
  const afterExpiry = await service.retryAttempt(memory.attempts[0].attemptId);
  assert.strictEqual(afterExpiry.ok, true, 'an expired link can be replaced');

  // A local copy must never put localhost links in front of real members.
  reset();
  process.env.APP_URL = 'http://localhost:3001';
  const local = await service.prepareSelected([1]);
  assert.strictEqual(local.error, 'APP_URL_NOT_PUBLIC', 'localhost links are refused');
  assert.strictEqual(memory.sheet.length, 0, 'nothing reaches the campaign sheet');
  assert.strictEqual(memory.attempts.length, 0, 'and no link is minted');
  process.env.APP_URL = 'http://jpsme.example';
  assert.strictEqual((await service.prepareSelected([1])).error, 'APP_URL_NOT_PUBLIC', 'plain http is refused too');
  process.env.APP_URL = 'http://localhost:3001';
  process.env.MERGO_ALLOW_LOCAL_LINKS = 'true';
  assert.strictEqual((await service.prepareSelected([1])).ok, true, 'the explicit test-sheet override still works');
  delete process.env.MERGO_ALLOW_LOCAL_LINKS;
  process.env.APP_URL = 'https://jpsme.example';

  // An ID pasted out of a table brings a tab character along; Google then says
  // the file does not exist. The settings are trimmed so that cannot happen.
  // eslint-disable-next-line global-require
  const config = require('../src/config');
  const savedId = process.env.MERGO_ACTIVATION_SHEET_ID;
  const savedTab = process.env.MERGO_ACTIVATION_TAB;
  process.env.MERGO_ACTIVATION_SHEET_ID = '\t1ZUxY3j8WsJ5WA7iXv-QEo8rT56b_MReBx730KM3ZLHo ';
  process.env.MERGO_ACTIVATION_TAB = ' JPSME Activations\t';
  assert.strictEqual(config.googleSheets.mergoActivationSheetId, '1ZUxY3j8WsJ5WA7iXv-QEo8rT56b_MReBx730KM3ZLHo');
  assert.strictEqual(config.googleSheets.mergoActivationTab, 'JPSME Activations');
  process.env.MERGO_ACTIVATION_SHEET_ID = savedId;
  process.env.MERGO_ACTIVATION_TAB = savedTab;

  console.log('Mergo activation integration tests passed');
}

let settingsServiceCap = 500;
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
