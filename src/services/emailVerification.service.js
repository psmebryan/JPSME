const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { sendVerificationEmail } = require('./mail.service');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Replaces any previous token for this user, so only the most recently sent link works.
async function issueVerificationToken(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');

  await prisma.emailVerificationToken.upsert({
    where: { userId: user.id },
    update: { tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
    create: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });

  await sendVerificationEmail(user, rawToken);
}

async function verifyEmailToken(rawToken) {
  if (!rawToken) throw new AppError('Missing verification token', 400);

  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  if (!record || record.expiresAt < new Date()) {
    throw new AppError('This verification link is invalid or has expired', 400);
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
    prisma.emailVerificationToken.delete({ where: { userId: record.userId } }),
  ]);

  return record.user;
}

// Always resolves without revealing whether the email exists, to avoid account enumeration.
async function resendVerification(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt) {
    await issueVerificationToken(user);
  }
}

module.exports = { issueVerificationToken, verifyEmailToken, resendVerification };
