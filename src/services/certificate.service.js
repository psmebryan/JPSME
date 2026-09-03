const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');
const { substituteTokens, formatDate, fullName } = require('../utils/templateTokens');

const DEFAULT_MEMBERSHIP_TITLE = 'Certificate of Membership';
const DEFAULT_MEMBERSHIP_BODY =
  'This certifies that {{fullName}} is an official member of the Junior Philippine Society of Mechanical Engineers, {{chapterName}} Chapter, issued on {{issuedDate}}.';

const DEFAULT_EVENT_TITLE = 'Certificate of Participation';
const DEFAULT_EVENT_BODY = 'This certifies that {{fullName}} participated in {{eventTitle}} held on {{eventDate}}.';

function drawFallbackBackground(doc, width, height) {
  doc.rect(0, 0, width, height).fill('#fdfaf3');
  doc.rect(24, 24, width - 48, height - 48).lineWidth(3).stroke('#c9a24b');
  doc.rect(34, 34, width - 68, height - 68).lineWidth(1).stroke('#c9a24b');
}

async function renderCertificatePdf(template, fields) {
  // Resolved up front (storageService is async) so the actual pdfkit
  // rendering below — inherently event/stream-based — only ever deals with
  // a plain Buffer, never a path. pdfkit's doc.image() accepts a Buffer
  // directly, so this needs no on-disk temp file either way.
  let backgroundBuffer = null;
  if (template.backgroundImage) {
    try {
      if (await storageService.exists(template.backgroundImage)) {
        backgroundBuffer = await storageService.read(template.backgroundImage);
      }
    } catch (err) {
      backgroundBuffer = null;
    }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { width, height } = doc.page;
    let drewBackground = false;

    if (backgroundBuffer) {
      try {
        doc.image(backgroundBuffer, 0, 0, { width, height });
        drewBackground = true;
      } catch (err) {
        drewBackground = false;
      }
    }
    if (!drewBackground) {
      drawFallbackBackground(doc, width, height);
    }

    const color = /^#[0-9a-fA-F]{6}$/.test(template.textColor) ? template.textColor : '#1a1a2e';
    const title = substituteTokens(template.title, fields);
    const body = substituteTokens(template.bodyText, fields);

    doc
      .fillColor(color)
      .font('Times-Bold')
      .fontSize(36)
      .text(title, 60, height * 0.32, { width: width - 120, align: 'center' });

    doc
      .fillColor(color)
      .font('Times-Roman')
      .fontSize(18)
      .text(body, 100, height * 0.48, { width: width - 200, align: 'center', lineGap: 6 });

    doc.end();
  });
}

// --- Membership template (single global row) ---

async function getMembershipTemplate() {
  let template = await prisma.certificateTemplate.findFirst({ where: { type: 'MEMBERSHIP' } });
  if (!template) {
    template = await prisma.certificateTemplate.create({
      data: { type: 'MEMBERSHIP', title: DEFAULT_MEMBERSHIP_TITLE, bodyText: DEFAULT_MEMBERSHIP_BODY },
    });
  }
  return template;
}

async function upsertMembershipTemplate({ title, bodyText, textColor }) {
  const template = await getMembershipTemplate();
  return prisma.certificateTemplate.update({
    where: { id: template.id },
    data: {
      title: title !== undefined ? title : template.title,
      bodyText: bodyText !== undefined ? bodyText : template.bodyText,
      textColor: textColor !== undefined ? textColor : template.textColor,
    },
  });
}

async function setMembershipTemplateBackground(publicPath) {
  const template = await getMembershipTemplate();
  if (template.backgroundImage) await storageService.remove(template.backgroundImage);
  return prisma.certificateTemplate.update({ where: { id: template.id }, data: { backgroundImage: publicPath } });
}

// --- Event template (one row per event) ---

async function getEventTemplate(eventId) {
  let template = await prisma.certificateTemplate.findUnique({ where: { eventId: Number(eventId) } });
  if (!template) {
    const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
    if (!event) throw new AppError('Event not found', 404);
    template = await prisma.certificateTemplate.create({
      data: { type: 'EVENT', eventId: Number(eventId), title: DEFAULT_EVENT_TITLE, bodyText: DEFAULT_EVENT_BODY },
    });
  }
  return template;
}

async function upsertEventTemplate(eventId, { title, bodyText, textColor }) {
  const template = await getEventTemplate(eventId);
  return prisma.certificateTemplate.update({
    where: { id: template.id },
    data: {
      title: title !== undefined ? title : template.title,
      bodyText: bodyText !== undefined ? bodyText : template.bodyText,
      textColor: textColor !== undefined ? textColor : template.textColor,
    },
  });
}

async function setEventTemplateBackground(eventId, publicPath) {
  const template = await getEventTemplate(eventId);
  if (template.backgroundImage) await storageService.remove(template.backgroundImage);
  return prisma.certificateTemplate.update({ where: { id: template.id }, data: { backgroundImage: publicPath } });
}

// --- Membership certificate (generated on demand, never stored) ---

async function renderMembershipCertificateForUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) }, include: { organization: true } });
  if (!user) throw new AppError('User not found', 404);
  if (user.status !== 'APPROVED') {
    throw new AppError('Only approved members can download a membership certificate', 403);
  }

  const template = await getMembershipTemplate();
  const fields = {
    firstName: user.firstName,
    lastName: user.lastName,
    middleInitial: user.middleInitial || '',
    fullName: fullName(user),
    // {{organizationName}} is the current name; {{chapterName}} is kept as an
    // alias so certificate templates saved before the organization migration
    // keep substituting instead of silently rendering a literal token.
    organizationName: user.organization ? user.organization.name : 'JPSME National',
    chapterName: user.organization ? user.organization.name : 'JPSME National',
    issuedDate: formatDate(new Date()),
  };

  return renderCertificatePdf(template, fields);
}

// Sample data for the admin "Preview" button — lets the admin see the design
// without needing a real registrant on hand.
async function renderPreviewCertificate(template, overrides = {}) {
  const fields = {
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    middleInitial: 'A',
    fullName: 'Juan A. Dela Cruz',
    organizationName: 'Sample Organization',
    chapterName: 'Sample Organization',
    eventTitle: 'Sample Event',
    eventDate: formatDate(new Date()),
    issuedDate: formatDate(new Date()),
    ...overrides,
  };
  return renderCertificatePdf(template, fields);
}

// --- Event certificates (persisted, admin-generated) ---

async function generateEventCertificatesBulk({ eventId, userIds, adminUserId, force = false }) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const template = await getEventTemplate(eventId);

  const registrationWhere = { eventId: Number(eventId), status: 'REGISTERED' };
  if (Array.isArray(userIds) && userIds.length > 0) {
    registrationWhere.userId = { in: userIds.map(Number) };
  }

  const registrations = await prisma.eventRegistration.findMany({
    where: registrationWhere,
    include: { user: { include: { organization: true } } },
  });

  const existing = await prisma.eventCertificate.findMany({
    where: { eventId: Number(eventId), userId: { in: registrations.map((r) => r.userId) } },
  });
  const existingByUser = new Map(existing.map((c) => [c.userId, c]));

  const generated = [];
  const skipped = [];

  for (const reg of registrations) {
    const existingCert = existingByUser.get(reg.userId);
    if (existingCert && !force) {
      skipped.push({ userId: reg.userId, name: fullName(reg.user) });
      continue;
    }

    const fields = {
      firstName: reg.user.firstName,
      lastName: reg.user.lastName,
      middleInitial: reg.user.middleInitial || '',
      fullName: fullName(reg.user),
      organizationName: reg.user.organization ? reg.user.organization.name : '',
      chapterName: reg.user.organization ? reg.user.organization.name : '',
      eventTitle: event.title,
      eventDate: formatDate(event.startDate),
    };

    // Yield to the event loop between renders so a large bulk-generate (PDF
    // rendering is CPU-bound) doesn't stall other requests being served by
    // this same worker process for the whole batch.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));

    // eslint-disable-next-line no-await-in-loop -- certificates are rendered sequentially to avoid spiking memory on large bulk runs
    const buffer = await renderCertificatePdf(template, fields);
    // eslint-disable-next-line no-await-in-loop
    const filePath = await storageService.saveGenerated(buffer, {
      folder: `certificates/events/${eventId}`,
      prefix: `cert-${reg.userId}`,
      extension: '.pdf',
    });

    if (existingCert) {
      // eslint-disable-next-line no-await-in-loop
      await storageService.remove(existingCert.filePath);
      // Regenerated content should be re-reviewed before members can download it again.
      // eslint-disable-next-line no-await-in-loop
      const updated = await prisma.eventCertificate.update({
        where: { id: existingCert.id },
        data: {
          filePath,
          generatedAt: new Date(),
          generatedBy: Number(adminUserId),
          released: false,
          releasedAt: null,
          releasedBy: null,
        },
      });
      generated.push({ userId: reg.userId, name: fullName(reg.user), certificate: updated });
    } else {
      // eslint-disable-next-line no-await-in-loop
      const created = await prisma.eventCertificate.create({
        data: {
          eventId: Number(eventId),
          userId: reg.userId,
          filePath,
          generatedBy: Number(adminUserId),
        },
      });
      generated.push({ userId: reg.userId, name: fullName(reg.user), certificate: created });
    }
  }

  return { generated, skipped };
}

async function listEventCertificateStatus(eventId, filter = 'all') {
  const [registrations, certificates] = await Promise.all([
    prisma.eventRegistration.findMany({
      where: { eventId: Number(eventId), status: 'REGISTERED' },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.eventCertificate.findMany({ where: { eventId: Number(eventId) } }),
  ]);

  const certByUser = new Map(certificates.map((c) => [c.userId, c]));

  const rows = registrations.map((reg) => {
    const cert = certByUser.get(reg.userId);
    return {
      userId: reg.userId,
      fullName: fullName(reg.user),
      email: reg.user.email,
      phone: reg.phone,
      school: reg.school,
      generated: Boolean(cert),
      generatedAt: cert ? cert.generatedAt : null,
      released: Boolean(cert && cert.released),
    };
  });

  if (filter === 'generated') return rows.filter((r) => r.generated);
  if (filter === 'not_generated') return rows.filter((r) => !r.generated);
  return rows;
}

// Main-admin-only gate on whether a member is allowed to self-download their
// already-generated event certificate yet.
async function setEventCertificateReleased(eventId, userId, released, adminUserId) {
  const record = await getEventCertificateRecord(eventId, userId);
  return prisma.eventCertificate.update({
    where: { id: record.id },
    data: released
      ? { released: true, releasedAt: new Date(), releasedBy: Number(adminUserId) }
      : { released: false, releasedAt: null, releasedBy: null },
  });
}

async function exportEventCertificatesExcel(eventId) {
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);
  const rows = await listEventCertificateStatus(eventId, 'all');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Certificates');
  sheet.columns = [
    { header: 'Name', key: 'fullName', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'School', key: 'school', width: 28 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Generated At', key: 'generatedAt', width: 22 },
    { header: 'Download Allowed', key: 'released', width: 18 },
  ];
  sheet.getRow(1).font = { bold: true };

  rows.forEach((row) => {
    sheet.addRow({
      fullName: row.fullName,
      email: row.email,
      phone: row.phone || '',
      school: row.school || '',
      status: row.generated ? 'Generated' : 'Not generated',
      generatedAt: row.generatedAt ? formatDate(row.generatedAt) : '',
      released: row.generated ? (row.released ? 'Yes' : 'No') : '',
    });
  });

  return workbook.xlsx.writeBuffer();
}

// One row per event with registrant/generated/released counts, for the
// "Event Certificates" hub page so the admin doesn't have to open each
// event individually to see where certificate generation stands.
async function listEventCertificateSummaries() {
  const [events, certificates] = await Promise.all([
    prisma.event.findMany({
      orderBy: { startDate: 'desc' },
      include: { _count: { select: { registrations: { where: { status: 'REGISTERED' } } } } },
    }),
    prisma.eventCertificate.findMany({ select: { eventId: true, released: true } }),
  ]);

  const countsByEvent = new Map();
  certificates.forEach((cert) => {
    const entry = countsByEvent.get(cert.eventId) || { generated: 0, released: 0 };
    entry.generated += 1;
    if (cert.released) entry.released += 1;
    countsByEvent.set(cert.eventId, entry);
  });

  return events.map((event) => {
    const counts = countsByEvent.get(event.id) || { generated: 0, released: 0 };
    return {
      id: event.id,
      title: event.title,
      startDate: event.startDate,
      isPublished: event.isPublished,
      registrantCount: event._count.registrations,
      generatedCount: counts.generated,
      releasedCount: counts.released,
    };
  });
}

async function getEventCertificateRecord(eventId, userId) {
  const record = await prisma.eventCertificate.findUnique({
    where: { eventId_userId: { eventId: Number(eventId), userId: Number(userId) } },
  });
  if (!record) throw new AppError('Certificate not found', 404);
  return record;
}

// Resolves a stored event certificate to a storage key + friendly download
// filename. requireReleased gates the member's own self-download link; the
// main admin can always fetch the file regardless of release status.
async function getEventCertificateDownload(eventId, userId, { requireReleased = false } = {}) {
  const record = await getEventCertificateRecord(eventId, userId);
  if (requireReleased && !record.released) {
    throw new AppError('This certificate is not yet available for download', 403);
  }
  const [event, user] = await Promise.all([
    prisma.event.findUnique({ where: { id: Number(eventId) } }),
    prisma.user.findUnique({ where: { id: Number(userId) } }),
  ]);
  const slug = (value) => String(value || '').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '');
  const filename = `certificate-${slug(event && event.title)}-${slug(user && fullName(user))}.pdf`;
  return { key: record.filePath, filename };
}

// Only returns events whose certificate has been released — a generated-but-not-yet-
// released certificate shouldn't show a download link on the member's profile.
async function getCertifiedEventIds(userId, eventIds) {
  if (!eventIds.length) return new Set();
  const certs = await prisma.eventCertificate.findMany({
    where: { userId: Number(userId), eventId: { in: eventIds }, released: true },
    select: { eventId: true },
  });
  return new Set(certs.map((c) => c.eventId));
}

async function deleteEventCertificateAssets(eventId) {
  await storageService.removeFolder(`storage/certificates/events/${eventId}`);

  const template = await prisma.certificateTemplate.findUnique({ where: { eventId: Number(eventId) } });
  if (template && template.backgroundImage) {
    await storageService.remove(template.backgroundImage);
  }
}

module.exports = {
  getMembershipTemplate,
  upsertMembershipTemplate,
  setMembershipTemplateBackground,
  getEventTemplate,
  upsertEventTemplate,
  setEventTemplateBackground,
  renderMembershipCertificateForUser,
  renderPreviewCertificate,
  generateEventCertificatesBulk,
  listEventCertificateStatus,
  listEventCertificateSummaries,
  setEventCertificateReleased,
  exportEventCertificatesExcel,
  getEventCertificateRecord,
  getEventCertificateDownload,
  getCertifiedEventIds,
  deleteEventCertificateAssets,
};
