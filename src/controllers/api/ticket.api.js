const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const prisma = require('../../config/prisma');
const AppError = require('../../utils/AppError');
const ticketService = require('../../services/ticket.service');
const qrService = require('../../services/qr.service');
const jobService = require('../../services/job.service');

// A member's own e-ticket. Ownership is not a parameter — every lookup here is
// keyed on req.session.user.id, so there is no id in the URL for someone to
// change in order to fetch a stranger's ticket. That matters more than usual: a
// ticket is a credential, and one that could be enumerated would let anyone
// walk in as anyone.

const downloadTicketPdf = asyncHandler(async (req, res) => {
  const registration = await ticketService.getTicket(req.session.user.id, req.params.id);
  const pdf = await ticketService.renderETicketPdf(registration);

  res.setHeader('Content-Type', 'application/pdf');
  // inline, so tapping the link on a phone opens the ticket rather than
  // dropping it into Downloads for the member to go hunting for at the door.
  res.setHeader('Content-Disposition', `inline; filename="${ticketService.ticketFilename(registration)}"`);
  // Tickets are reissued on regeneration and on re-registration, so a cached
  // copy can be a dead code. Better a fresh request at the entrance than a
  // stale image that fails the scan.
  res.setHeader('Cache-Control', 'no-store, private');
  res.send(pdf);
});

const downloadTicketQrPng = asyncHandler(async (req, res) => {
  const registration = await ticketService.getTicket(req.session.user.id, req.params.id);
  const png = await qrService.renderQrPng(registration.qrToken, { width: 800 });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${(registration.registrationNumber || `registration-${registration.id}`)}.png"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.send(png);
});

// Admin action: kill a ticket and issue a replacement. Main admin only — this
// invalidates a code somebody may already be holding at a door, which is not a
// thing to hand out alongside ordinary event editing.
const regenerateTicket = asyncHandler(async (req, res) => {
  const registration = await prisma.eventRegistration.findUnique({
    where: { id: Number(req.params.registrationId) },
  });
  if (!registration) throw new AppError('Registration not found', 404);
  // The registration id alone would be enough to find the row, but the event in
  // the URL has to match it — otherwise the path claims something the data does
  // not, and an admin acting from one event's page could regenerate a ticket
  // belonging to another.
  if (registration.eventId !== Number(req.params.id)) {
    throw new AppError('That registration does not belong to this event', 400);
  }

  const updated = await qrService.regenerateQr({
    registrationId: registration.id,
    adminUserId: req.session.user.id,
    ipAddress: req.ip,
  });

  // Send the replacement. Without this the member is left holding a code that
  // silently stopped working, and would only find out at the entrance — which
  // is the one place it cannot be fixed. Queued rather than awaited so a mail
  // problem cannot fail the regeneration that already happened.
  jobService.enqueue('SEND_EVENT_REGISTRATION_EMAIL', {
    userId: registration.userId,
    eventId: registration.eventId,
  }).catch((err) => {
    console.error('regenerateTicket: could not queue the replacement email:', err.message);
  });

  return success(res, {
    registrationNumber: updated.registrationNumber,
    qrGeneratedAt: updated.qrGeneratedAt,
  }, 'New QR issued. The previous code no longer works, and a replacement has been emailed.');
});

module.exports = { downloadTicketPdf, downloadTicketQrPng, regenerateTicket };
