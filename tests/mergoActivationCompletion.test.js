// Dev-database check that a Mergo attempt becomes activated only when its
// JPSME one-time link is successfully used.
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');
const passwordReset = require('../src/services/passwordReset.service');

const EMAIL = `__mergo_activation_completion_${process.pid}@example.invalid`;
let userId = null;
let attemptId = null;

async function cleanup() {
  if (userId) {
    await prisma.auditLog.deleteMany({ where: { targetUserId: userId, action: 'ACCOUNT_ACTIVATED' } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

async function main() {
  await cleanup();
  const organization = await prisma.organization.findFirst({ where: { isActive: true }, select: { id: true } });
  assert(organization, 'an active organization is available in the dev database');

  const user = await prisma.user.create({
    data: {
      firstName: 'MERGO', lastName: 'ACTIVATION TEST', email: EMAIL,
      password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
      role: 'USER', status: 'PENDING', passwordSetAt: null,
    },
  });
  userId = user.id;
  attemptId = `ACT-TEST-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const issued = await passwordReset.issueResetLink(user.id, {
    ttlMs: passwordReset.ACTIVATION_TTL_MS,
  });
  const token = new URL(issued.url).searchParams.get('token');
  assert(token, 'the link contains a bearer token for the member');

  await prisma.activationInvite.create({
    data: {
      userId: user.id,
      attemptId,
      email: user.email,
      tokenHash: issued.tokenHash,
      channel: 'MERGO',
      status: 'DELIVERED',
      providerStatus: 'OPENED',
      openedAt: new Date(),
      campaignId: 'JPSME-ACT-TEST',
    },
  });

  const result = await passwordReset.completeReset({
    userId: user.id,
    token,
    password: 'MergoActivationTest2026!',
    organizationId: organization.id,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.activated, true);

  const [updatedUser, updatedAttempt, audit] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { passwordSetAt: true, status: true } }),
    prisma.activationInvite.findUnique({ where: { attemptId } }),
    prisma.auditLog.findFirst({ where: { targetUserId: user.id, action: 'ACCOUNT_ACTIVATED' }, orderBy: { createdAt: 'desc' } }),
  ]);
  assert(updatedUser.passwordSetAt, 'JPSME records the actual account activation');
  assert.strictEqual(updatedUser.status, 'APPROVED');
  assert(updatedAttempt.activatedAt, 'the matching attempt is stamped activated');
  assert.strictEqual(updatedAttempt.providerStatus, 'OPENED', 'email status remains independent from account activation');
  assert(audit && JSON.parse(audit.metadata).attemptId === attemptId, 'activation audit links to the attempt without the plaintext token');

  console.log('Mergo activation completion test passed');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await prisma.$disconnect(); });
