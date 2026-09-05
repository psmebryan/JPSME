const asyncHandler = require('../../utils/asyncHandler');
const ticketService = require('../../services/ticket.service');
const qrService = require('../../services/qr.service');

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

module.exports = { downloadTicketPdf, downloadTicketQrPng };
