const prisma = require('../../config/prisma');
const mailService = require('../../services/mail.service');
const certificateService = require('../../services/certificate.service');
const emailVerificationService = require('../../services/emailVerification.service');

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

  // Sending the sign-up verification code.
  //
  // Was awaited inside the registration request, which is why "Creating your
  // account…" sat there long after the email had arrived: the response was
  // waiting on Brevo's API, roughly a second on a good connection and up to the
  // 15-second client timeout on a bad one. The code row is written before this
  // job is enqueued, so the code is valid from the instant the person can type
  // it — nothing about correctness depended on the send finishing first.
  //
  // Re-read rather than carried in the payload, like every handler here: the
  // code itself is NOT in the payload, because a job row is a place a secret
  // would sit in plain text long after it expired.
  async SEND_VERIFICATION_EMAIL({ userId }) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    // Deleted between enqueue and send, or verified already by another route —
    // nothing to send, and not a failure worth retrying.
    if (!user || user.emailVerifiedAt) return;
    // The code is minted HERE rather than passed in the payload. A job row is
    // a place a plaintext secret would sit in the database long after the code
    // it holds has expired; only its hash is ever stored, by this call.
    await emailVerificationService.issueVerificationCode(user);
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
