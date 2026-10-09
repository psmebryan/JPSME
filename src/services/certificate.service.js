const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');
// A leaf module on purpose — importing payment.service here would close the
// loop payment -> registration -> event -> certificate.
const membershipService = require('./membership.service');
const { substituteTokens, formatDate, fullName } = require('../utils/templateTokens');
const settingsService = require('./settings.service');

// --- Layout -------------------------------------------------------------------
//
// Two ways to draw an event certificate:
//
//   text  The original: the background (or a plain border) with the title and
//         body text printed over it.
//   name  A finished design made elsewhere (Canva), uploaded as the background
//         with its own wording and signatures already on it. Only the
//         recipient's name is printed, at the spot the design leaves for it.
//
// The defaults are measured from the 16th SNC design: the NAME placeholder's
// baseline sits 50.78% down an A4 landscape page, its capitals are 31.2pt tall
// (44.3pt Helvetica Bold, the size Canva reports), in #2b508c, centred, and the
// rule under it spans 69% of the width — a longer name is shrunk to fit it.
//
// Kept as JSON in site settings, keyed by event, so a design change needs no
// database migration.
const NAME_FONTS = ['Helvetica-Bold', 'Helvetica', 'Times-Bold', 'Times-Roman'];
const LAYOUT_DEFAULTS = {
  mode: 'text',
  nameColor: '#2b508c',
  nameSize: 44.3,
  nameBaseline: 50.78,
  nameCenterX: 50,
  nameMaxWidth: 69,
  nameFont: 'Helvetica-Bold',
  nameUppercase: false,
};

function layoutKey(eventId) {
  return `certificate_layout_event_${Number(eventId)}`;
}

// Anything missing or out of range falls back to the default rather than
// drawing a name off the page.
function sanitizeLayout(input = {}) {
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : dflt;
  };
  return {
    mode: input.mode === 'name' ? 'name' : 'text',
    nameColor: /^#[0-9a-fA-F]{6}$/.test(String(input.nameColor || '')) ? input.nameColor : LAYOUT_DEFAULTS.nameColor,
    nameSize: num(input.nameSize, 6, 150, LAYOUT_DEFAULTS.nameSize),
    nameBaseline: num(input.nameBaseline, 3, 97, LAYOUT_DEFAULTS.nameBaseline),
    nameCenterX: num(input.nameCenterX, 10, 90, LAYOUT_DEFAULTS.nameCenterX),
    nameMaxWidth: num(input.nameMaxWidth, 20, 100, LAYOUT_DEFAULTS.nameMaxWidth),
    nameFont: NAME_FONTS.includes(input.nameFont) ? input.nameFont : LAYOUT_DEFAULTS.nameFont,
    nameUppercase: input.nameUppercase === true || input.nameUppercase === 'true' || input.nameUppercase === 'on',
  };
}

async function getEventLayout(eventId) {
  const raw = await settingsService.getSetting(layoutKey(eventId), null);
  if (!raw) return { ...LAYOUT_DEFAULTS };
  try { return sanitizeLayout(JSON.parse(raw)); } catch (err) { return { ...LAYOUT_DEFAULTS }; }
}

async function setEventLayout(eventId, layout) {
  const clean = sanitizeLayout(layout);
  await settingsService.setSetting(layoutKey(eventId), JSON.stringify(clean));
  return clean;
}

// Draws just the recipient's name, centred on its baseline, shrinking a long
// name so it never runs past the line the design gives it.
function drawNameOnly(doc, layout, fields) {
  const { width, height } = doc.page;
  let text = String(fields.fullName || '').trim();
  if (layout.nameUppercase) text = text.toUpperCase();
  let size = layout.nameSize;
  doc.font(layout.nameFont).fontSize(size);
  const maxWidth = (width * layout.nameMaxWidth) / 100;
  const natural = doc.widthOfString(text);
  if (natural > maxWidth) {
    size = (size * maxWidth) / natural;
    doc.fontSize(size);
  }
  const textWidth = doc.widthOfString(text);
  const x = (width * layout.nameCenterX) / 100 - textWidth / 2;
  // pdfkit places text by the top of its line box; move up by the font's
  // ascender so the baseline lands exactly where the design's placeholder sat.
  const baseline = (height * layout.nameBaseline) / 100;
  const top = baseline - (doc._font.ascender / 1000) * size;
  doc.fillColor(layout.nameColor).text(text, x, top, { lineBreak: false });
}

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

    if (template.layout && template.layout.mode === 'name') {
      drawNameOnly(doc, template.layout, fields);
      doc.end();
      return;
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
  return { ...updated, layout: savedLayout };
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
  // The layout travels with the template, so every render — preview, bulk
  // generate, send — draws the same design.
  return { ...template, layout: await getEventLayout(eventId) };
}

async function upsertEventTemplate(eventId, { title, bodyText, textColor, layout }) {
  const template = await getEventTemplate(eventId);
  const savedLayout = layout ? await setEventLayout(eventId, layout) : template.layout;
  const updated = await prisma.certificateTemplate.update({
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

// The certificate is the document that says somebody IS a member of JPSME, so
// the only people who may hold one are members: the fee is paid and the year is
// current. Approval alone used to be enough, which meant any approved account
// could download a certificate of a membership it had never bought.
//
// Enforced here rather than only on the route, because a certificate that
// depends on which handler you came through is one refactor away from being
// issued by a handler that forgot. The route stays gated too — this is the
// backstop, not the only lock.
async function renderMembershipCertificateForUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) }, include: { organization: true } });
  if (!user) throw new AppError('User not found', 404);
  if (user.status !== 'APPROVED') {
    throw new AppError('Only approved members can download a membership certificate', 403);
  }

  const membership = await membershipService.getMembershipStatus(user.id);
  if (membership.tier !== membershipService.MEMBERSHIP_TIERS.MEMBER) {
    // Says which of the two it is. "Not a member" sends somebody who paid last
    // year hunting for a fault that is really just a lapsed year.
    throw new AppError(
      membership.state === 'EXPIRED'
        ? 'Your membership has expired. Renew it to download your certificate again.'
        : 'A membership certificate is issued once your membership payment is confirmed.',
      403
    );
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
          // A corrected certificate has not been sent yet — clearing this is
          // what lets "Send" deliver it.
          emailedAt: null,
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

// `search` matches the registrant's name or email, as on the registrations page.
async function listEventCertificateStatus(eventId, filter = 'all', search = '') {
  const where = { eventId: Number(eventId), status: 'REGISTERED' };
  const term = String(search || '').trim();
  if (term) {
    where.OR = [
      { fullName: { contains: term } },
      { email: { contains: term } },
      { user: { firstName: { contains: term } } },
      { user: { lastName: { contains: term } } },
    ];
  }
  const [registrations, certificates] = await Promise.all([
    prisma.eventRegistration.findMany({
      where,
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
      generated: Boolean(cert),
      generatedAt: cert ? cert.generatedAt : null,
      released: Boolean(cert && cert.released),
      emailedAt: cert ? cert.emailedAt : null,
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

// --- Emailing event certificates --------------------------------------------
//
// Nothing is sent when somebody registers. An admin presses "Send" on the
// event's Certificate page, and each registrant gets their certificate as an
// attached PDF, which is also released for download from their profile.
//
// Queued as one job per person: rendering a PDF is CPU-bound and an event can
// run to hundreds, so this request only decides who is sent to and the job
// worker does the rendering and sending one at a time.
//
// Capped per press (CERTIFICATE_SEND_BATCH_LIMIT, default 250) because every
// site email shares one daily provider quota; whoever is left is sent on the
// next press. Somebody already emailed, or already in the queue, is never
// queued twice — unless `resend` is set, which is for sending one corrected
// certificate again after Regenerate.
async function queueEventCertificateEmails({
  eventId, userIds = null, resend = false, adminUserId = null, limit = 250,
}) {
  // eslint-disable-next-line global-require
  const jobService = require('./job.service');
  const event = await prisma.event.findUnique({ where: { id: Number(eventId) } });
  if (!event) throw new AppError('Event not found', 404);

  const where = { eventId: event.id, status: 'REGISTERED' };
  if (Array.isArray(userIds) && userIds.length) where.userId = { in: userIds.map(Number) };
  const registrations = await prisma.eventRegistration.findMany({ where, select: { userId: true } });

  const certificates = await prisma.eventCertificate.findMany({
    where: { eventId: event.id, userId: { in: registrations.map((r) => r.userId) } },
    select: { userId: true, emailedAt: true },
  });
  const emailed = new Set(certificates.filter((c) => c.emailedAt).map((c) => c.userId));

  // Already waiting in the queue from an earlier press: not queued again.
  const pending = await prisma.job.findMany({
    where: { type: 'SEND_EVENT_CERTIFICATE_EMAIL', status: { in: ['PENDING', 'PROCESSING'] } },
    select: { payload: true },
  });
  const queuedAlready = new Set();
  pending.forEach((j) => {
    try {
      const p = JSON.parse(j.payload);
      if (Number(p.eventId) === event.id) queuedAlready.add(Number(p.userId));
    } catch (err) { /* unreadable payload */ }
  });

  let queued = 0;
  let alreadySent = 0;
  let alreadyQueued = 0;
  let remaining = 0;
  for (const reg of registrations) {
    if (queuedAlready.has(reg.userId)) { alreadyQueued += 1; continue; }
    if (!resend && emailed.has(reg.userId)) { alreadySent += 1; continue; }
    if (queued >= limit) { remaining += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await jobService.enqueue('SEND_EVENT_CERTIFICATE_EMAIL', {
      eventId: event.id, userId: reg.userId, adminUserId,
    });
    queued += 1;
  }

  return { queued, alreadySent, alreadyQueued, remaining, limit, total: registrations.length };
}

// Run by the job worker for one person: generate their certificate if it does
// not exist yet, email it as an attachment, and release it for download from
// their profile.
//
// Only a REGISTERED registration is sent to — somebody who cancelled after the
// press is skipped. A send the provider refuses (a quota, a bad address) is not
// thrown: retrying would only spend more of the quota on the same refusal. The
// certificate is left un-emailed, so the next press picks it up.
async function sendEventCertificateEmail({ eventId, userId, adminUserId = null }) {
  // eslint-disable-next-line global-require
  const mailService = require('./mail.service');
  const registration = await prisma.eventRegistration.findFirst({
    where: { eventId: Number(eventId), userId: Number(userId), status: 'REGISTERED' },
    select: { id: true },
  });
  if (!registration) return { sent: false, reason: 'NOT_REGISTERED' };

  let certificate = await prisma.eventCertificate.findUnique({
    where: { eventId_userId: { eventId: Number(eventId), userId: Number(userId) } },
  });
  if (!certificate) {
    await generateEventCertificatesBulk({ eventId, userIds: [userId], adminUserId: adminUserId || 0 });
    certificate = await prisma.eventCertificate.findUnique({
      where: { eventId_userId: { eventId: Number(eventId), userId: Number(userId) } },
    });
    if (!certificate) return { sent: false, reason: 'NOT_GENERATED' };
  }

  const [user, event, pdf, download] = await Promise.all([
    prisma.user.findUnique({ where: { id: Number(userId) } }),
    prisma.event.findUnique({ where: { id: Number(eventId) } }),
    storageService.read(certificate.filePath),
    getEventCertificateDownload(eventId, userId),
  ]);
  if (!user || !event) return { sent: false, reason: 'NOT_FOUND' };

  const ok = await mailService.sendEventCertificateEmail(user, event, pdf, download.filename);
  if (!ok) return { sent: false, reason: 'SEND_FAILED' };

  const now = new Date();
  await prisma.eventCertificate.update({
    where: { id: certificate.id },
    data: certificate.released
      ? { emailedAt: now }
      : {
        emailedAt: now, released: true, releasedAt: now,
        releasedBy: adminUserId ? Number(adminUserId) : null,
      },
  });
  return { sent: true };
}

async function deleteEventCertificateAssets(eventId) {
  await prisma.siteSetting.deleteMany({ where: { key: layoutKey(eventId) } }).catch(() => {});
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
  queueEventCertificateEmails,
  sendEventCertificateEmail,
  getEventLayout,
  sanitizeLayout,
  LAYOUT_DEFAULTS,
  NAME_FONTS,
};
