const path = require('path');
const config = require('../config');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { transporter, MAIL_FROM } = require('../config/mailer');
const storageService = require('./storage.service');
const { substituteTokens, fullName } = require('../utils/templateTokens');

const SEND_INTERVAL_MS = config.jobs.broadcastSendIntervalMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See mail.service.js's attachmentFor — attachments travel as bytes rather
// than as a path, because the file lives in the database and there is no path
// to give. nodemailer accepts { filename, content } just as readily.
//
// Read once here rather than per recipient: a broadcast goes to everybody, and
// re-reading the same image a few hundred times would be a few hundred queries
// for one unchanging file.
async function attachmentFor(publicPath) {
  try {
    const content = await storageService.read(String(publicPath).replace(/^\/+/, ''));
    return { filename: path.basename(publicPath), content };
  } catch (err) {
    console.error('broadcast: attachment could not be read, sending without it:', err.message);
    return null;
  }
}

function textToHtml(text) {
  return String(text || '').replace(/\n/g, '<br>');
}

// scope 'all' -> every APPROVED USER (optionally narrowed to one organization
// subtree — organizationIds carries the org plus its descendants);
// scope 'selected' -> exactly the given userIds. Never trusts a client-sent
// recipient LIST for 'all' — only the filter criteria.
function buildAudienceWhere({ scope, status, organizationId, organizationIds, userIds }) {
  if (scope === 'selected') {
    const ids = (userIds || []).map(Number).filter((id) => Number.isInteger(id));
    return { id: { in: ids } };
  }
  const where = { role: 'USER', status: status || 'APPROVED' };
  if (Array.isArray(organizationIds)) where.organizationId = { in: organizationIds };
  else if (organizationId) where.organizationId = Number(organizationId);
  return where;
}

async function resolveAudience(filter) {
  return prisma.user.findMany({
    where: buildAudienceWhere(filter),
    select: { id: true, firstName: true, middleInitial: true, lastName: true, email: true },
  });
}

async function previewAudienceCount(filter) {
  return prisma.user.count({ where: buildAudienceWhere(filter) });
}

async function listBroadcasts() {
  return prisma.emailBroadcast.findMany({ orderBy: { createdAt: 'desc' } });
}

async function getBroadcast(id) {
  const broadcast = await prisma.emailBroadcast.findUnique({ where: { id: Number(id) } });
  if (!broadcast) throw new AppError('Broadcast not found', 404);
  return broadcast;
}

// Never trust a client-sent recipient count/list beyond the filter criteria —
// the audience is always freshly resolved from the database here.
async function createBroadcast({ subject, bodyHtml, attachmentPath, audience, createdBy }) {
  if (!subject || !bodyHtml) throw new AppError('Subject and body are required', 422);

  const recipients = await resolveAudience(audience);
  if (recipients.length === 0) throw new AppError('No recipients match that audience', 422);

  const broadcast = await prisma.emailBroadcast.create({
    data: {
      subject,
      bodyHtml,
      attachmentImage: attachmentPath || null,
      audienceFilter: JSON.stringify(audience),
      totalRecipients: recipients.length,
      createdBy: Number(createdBy),
      status: 'PENDING',
    },
  });

  // Fire-and-forget: the admin's request returns immediately rather than
  // waiting for however long hundreds of paced sends take.
  processBroadcastSending(broadcast.id, recipients).catch((err) => {
    console.error('Broadcast sending failed unexpectedly:', broadcast.id, err.message);
  });

  return broadcast;
}

async function processBroadcastSending(broadcastId, recipients) {
  const broadcast = await prisma.emailBroadcast.update({ where: { id: broadcastId }, data: { status: 'SENDING' } });

  const attachments = [];
  if (broadcast.attachmentImage) {
    const attachment = await attachmentFor(broadcast.attachmentImage);
    if (attachment) attachments.push(attachment);
  }

  let sentCount = 0;
  let failedCount = 0;
  const failedEmails = [];

  for (const recipient of recipients) {
    // Paced, and yields to the event loop each iteration — a large blast
    // must not stall other requests being served by this same worker, and
    // must stay comfortably under the mail provider's rate limit.
    // eslint-disable-next-line no-await-in-loop
    await sleep(SEND_INTERVAL_MS);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));

    const fields = {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      fullName: fullName(recipient),
      email: recipient.email,
    };

    try {
      // eslint-disable-next-line no-await-in-loop
      await transporter.sendMail({
        from: MAIL_FROM,
        to: recipient.email,
        subject: substituteTokens(broadcast.subject, fields),
        html: textToHtml(substituteTokens(broadcast.bodyHtml, fields)),
        attachments,
      });
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      failedEmails.push(recipient.email);
      console.error('Broadcast send failed for', recipient.email, ':', err.message);
    }

    // eslint-disable-next-line no-await-in-loop
    await prisma.emailBroadcast.update({
      where: { id: broadcastId },
      data: { sentCount, failedCount, failedEmails: JSON.stringify(failedEmails) },
    });
  }

  await prisma.emailBroadcast.update({ where: { id: broadcastId }, data: { status: 'COMPLETED' } });
}

module.exports = {
  resolveAudience,
  previewAudienceCount,
  listBroadcasts,
  getBroadcast,
  createBroadcast,
};
