const prisma = require('../../config/prisma');
const mailService = require('../../services/mail.service');

// One handler per Job.type. Each rehydrates its own data from the DB by ID
// rather than trusting anything richer in the payload — a job can run long
// after it was enqueued (worker was down, backoff retry, etc.), so the
// user/event/etc. it references must be looked up fresh, not carried stale
// in the payload itself.
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
};

module.exports = handlers;
