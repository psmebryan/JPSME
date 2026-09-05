const PDFDocument = require('pdfkit');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const qrService = require('./qr.service');
const { formatDate } = require('../utils/templateTokens');

// The e-ticket: the thing a member actually brings to the door, on a phone or
// on paper. It carries only what the door needs to read out loud — event, name,
// registration number — plus the QR that does the real work. No email, phone,
// school, organization or payment information: a ticket gets photographed,
// forwarded, and left on tables, so anything printed on it should be something
// the holder would not mind a stranger seeing.

// Loads a registration for someone who is entitled to see its ticket, or
// explains why there isn't one to see.
//
// The status check is the same rule the door enforces, applied here so a member
// cannot download a ticket the scanner would reject anyway — a printed code that
// fails at the entrance is worse than no code at all, because it is discovered
// at the front of a queue.
async function getTicket(userId, eventId) {
  const registration = await prisma.eventRegistration.findUnique({
    where: { userId_eventId: { userId: Number(userId), eventId: Number(eventId) } },
    include: { event: true },
  });

  if (!registration) throw new AppError('You are not registered for this event', 404);
  if (registration.status === 'PENDING_PAYMENT') {
    throw new AppError('Your ticket will be issued once your payment is confirmed', 409);
  }
  if (registration.status === 'CANCELLED') {
    throw new AppError('This registration was cancelled, so it has no ticket', 409);
  }
  if (!registration.qrToken) {
    // A confirmed registration with no token means the backfill has not reached
    // it. Say so plainly rather than rendering a ticket with an empty square.
    throw new AppError('This ticket has not been issued yet. Please contact the organisers.', 409);
  }

  return registration;
}

function ticketFilename(registration) {
  return `${registration.registrationNumber || `registration-${registration.id}`}.pdf`;
}

const INK = '#101934';
const MUTED = '#5b6785';
const RULE = '#d5dbe8';

function label(doc, text, x, y) {
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8)
    .text(text.toUpperCase(), x, y, { characterSpacing: 1.2 });
}

function value(doc, text, x, y, size = 14) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(size).text(text, x, y);
}

// A4 portrait: the shape a member's home printer defaults to, and the shape a
// phone screen crops least awkwardly.
async function renderETicketPdf(registration) {
  const event = registration.event;
  // Rendered at 600px so the code stays sharp when the PDF is printed rather
  // than only viewed — a QR downscaled from a larger bitmap survives a cheap
  // printer far better than one upscaled from a small one.
  const qrPng = await qrService.renderQrPng(registration.qrToken, { width: 600 });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { width } = doc.page;
    const M = 56;
    const inner = width - M * 2;

    // Header band
    doc.rect(0, 0, width, 96).fill(INK);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
      .text('PSME EVENT', M, 34, { characterSpacing: 2 });
    doc.fillColor('#94a3bd').font('Helvetica').fontSize(10)
      .text('Junior Philippine Society of Mechanical Engineers', M, 62);

    let y = 136;

    label(doc, 'Event', M, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(19)
      .text(event.title, M, y + 14, { width: inner });
    y = doc.y + 18;

    label(doc, 'Date', M, y);
    value(doc, formatDate(event.startDate), M, y + 14, 13);

    label(doc, 'Venue', M + inner / 2, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
      .text(event.modality === 'ONLINE' ? 'Online' : (event.location || 'To be announced'),
        M + inner / 2, y + 14, { width: inner / 2 });
    y = doc.y + 22;

    doc.moveTo(M, y).lineTo(width - M, y).lineWidth(1).strokeColor(RULE).stroke();
    y += 22;

    label(doc, 'Registrant', M, y);
    value(doc, registration.fullName, M, y + 14, 16);
    y = doc.y + 18;

    label(doc, 'Registration Number', M, y);
    doc.fillColor(INK).font('Courier-Bold').fontSize(16)
      .text(registration.registrationNumber || '—', M, y + 14);
    y = doc.y + 26;

    // The QR, centred and given room. 260pt square at A4 is comfortably above
    // the size a handheld scanner needs from across a table.
    const qrSize = 260;
    const qrX = (width - qrSize) / 2;
    doc.image(qrPng, qrX, y, { width: qrSize, height: qrSize });
    y += qrSize + 14;

    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text('Present this code at the entrance. It is unique to this registration.',
        M, y, { width: inner, align: 'center' });
    y += 30;

    // Status pill
    const pillW = 150;
    const pillX = (width - pillW) / 2;
    doc.roundedRect(pillX, y, pillW, 30, 15).fill('#e7f6ec');
    doc.fillColor('#1c7a3e').font('Helvetica-Bold').fontSize(12)
      .text('CONFIRMED', pillX, y + 9, { width: pillW, align: 'center' });

    // Footer
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Issued ${formatDate(registration.qrGeneratedAt || new Date())}`,
        M, doc.page.height - 56, { width: inner, align: 'center' });

    doc.end();
  });
}

// Used by the confirmation email. Returns null rather than throwing, because a
// missing ticket must never be the reason a member does not get told their
// registration went through — the email still sends, just without the
// attachment, and the ticket stays available on their profile.
async function buildTicketAttachment(userId, eventId) {
  try {
    const registration = await getTicket(userId, eventId);
    return {
      filename: ticketFilename(registration),
      content: await renderETicketPdf(registration),
      contentType: 'application/pdf',
    };
  } catch (err) {
    return null;
  }
}

module.exports = {
  getTicket,
  ticketFilename,
  renderETicketPdf,
  buildTicketAttachment,
};
