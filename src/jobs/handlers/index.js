const prisma = require('../../config/prisma');
const mailService = require('../../services/mail.service');
const certificateService = require('../../services/certificate.service');

// One handler per Job.type. Each rehydrates its own data from the DB by ID
// rather than trusting anything richer in the payload — a job can run long
// after it was enqueued (worker was down, backoff retry, etc.), so the
// user/event/etc. it references must be looked up fresh, not carried stale
// in the payload itself. A handler's return value (must be small and
// JSON-serializable) becomes the Job's `result`, which a polling caller
// reads back via jobService.getJob.
const handlers = {
  async SEND_EVENT_REGISTRATION_EMAIL({ userId, eventId }) {
    const [user, event] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.event.findUnique({ where: { id: eventId } }),
    ]);
    // Both rows existing is the normal case; a user/event deleted between
    // enqueue and processing means there's nothing left to email about, not
    // a failure worth retrying.
    if (!user || !event) return;
    await mailService.sendEventRegistrationEmail(user, event);
  },

  // Was a synchronous request handler (bulkGenerateEventCertificates) —
  // moved here because PDF rendering is CPU-bound and a large event's "all
  // pending" batch could otherwise hold the admin's request open for a long
  // time. The service function itself is unchanged (still yields to the
  // event loop between renders); only the caller changed from "await it
  // inline" to "enqueue it and poll".
  async GENERATE_EVENT_CERTIFICATES({ eventId, userIds, force, adminUserId }) {
    const result = await certificateService.generateEventCertificatesBulk({ eventId, userIds, force, adminUserId });
    return { generatedCount: result.generated.length, skippedCount: result.skipped.length };
  },
};

module.exports = handlers;
