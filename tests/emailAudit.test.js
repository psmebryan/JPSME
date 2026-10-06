// Tests for services/emailAudit.service.js: the Gmail login check and the
// "Remove unused duplicates" clean-up. Prisma is an in-memory fake, so nothing
// here touches a real database.

const assert = require('assert');

const prismaPath = require.resolve('../src/config/prisma');
let users = [];
const deleted = [];

function counts(u) { return { registrations: u.regs || 0, payments: u.pays || 0 }; }
function view(u, select) {
  const out = {};
  for (const k of Object.keys(select)) out[k] = k === '_count' ? counts(u) : u[k];
  return out;
}

const fakePrisma = {
  user: {
    async findMany({ select }) {
      return users.filter((u) => u.role === 'USER' && /@(gmail|googlemail)\.com$/.test(u.email)).map((u) => view(u, select));
    },
    async findUnique({ where, select }) {
      const u = users.find((x) => x.id === where.id);
      return u ? view(u, select) : null;
    },
    async count({ where }) {
      return users.filter((u) => where.id.in.includes(u.id) && u.passwordSetAt).length;
    },
    async delete({ where }) {
      deleted.push(where.id);
      users = users.filter((u) => u.id !== where.id);
    },
  },
};
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: fakePrisma };

const service = require('../src/services/emailAudit.service');

function reset() {
  deleted.length = 0;
  users = [
    // Signed up (stored dotless, activated, registered) + imported duplicate.
    { id: 1, role: 'USER', email: 'juandelacruz@gmail.com', passwordSetAt: new Date(), regs: 2 },
    { id: 2, role: 'USER', email: 'juan.dela.cruz@gmail.com', passwordSetAt: null },
    // Two never-activated imports on one inbox: neither is the "real" one.
    { id: 3, role: 'USER', email: 'ana.reyes@gmail.com', passwordSetAt: null },
    { id: 4, role: 'USER', email: 'anareyes+x@gmail.com', passwordSetAt: null },
    // An unactivated duplicate that nonetheless holds a payment.
    { id: 5, role: 'USER', email: 'ben.cruz@gmail.com', passwordSetAt: new Date() },
    { id: 6, role: 'USER', email: 'bencruz@gmail.com', passwordSetAt: null, pays: 1 },
    // A normal, single account.
    { id: 7, role: 'USER', email: 'solo.member@gmail.com', passwordSetAt: new Date() },
  ];
}

async function main() {
  reset();
  const report = await service.gmailIdentityReport();
  assert.strictEqual(report.gmailMembers, 7);
  assert.strictEqual(report.affected, 5, 'addresses with a dot or + are counted');
  assert.strictEqual(report.duplicates.length, 3, 'three inboxes have more than one account');
  const flags = Object.fromEntries(report.duplicates.flatMap((d) => d.accounts).map((a) => [a.id, a.removable]));
  assert.strictEqual(flags[2], true, 'the unused import beside an activated account is removable');
  assert.strictEqual(flags[1], false, 'the activated account is never removable');
  assert.strictEqual(flags[3], false, 'with no activated account on the inbox, nothing is removable');
  assert.strictEqual(flags[4], false);
  assert.strictEqual(flags[6], false, 'an account with a payment is kept even if never activated');
  assert.strictEqual(report.removable, 1);

  const result = await service.removeUnusedDuplicates();
  assert.deepStrictEqual(deleted, [2], 'only the unused duplicate is deleted');
  assert.strictEqual(result.removed.length, 1);

  // Changed between the check and the delete: the duplicate was activated.
  reset();
  const realFindUnique = fakePrisma.user.findUnique;
  fakePrisma.user.findUnique = async (args) => {
    if (args.where.id === 2) users.find((u) => u.id === 2).passwordSetAt = new Date();
    return realFindUnique(args);
  };
  const raced = await service.removeUnusedDuplicates();
  fakePrisma.user.findUnique = realFindUnique;
  assert.deepStrictEqual(deleted, [], 'an account activated in the meantime is left alone');
  assert.strictEqual(raced.skipped.length, 1);

  console.log('Email audit tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
