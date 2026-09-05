const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const certificateService = require('./certificate.service');
const emailTemplateService = require('./emailTemplate.service');
const sheetsSyncService = require('./sheetsSync.service');
const storageService = require('./storage.service');

const DEFAULT_PAGE_SIZE = 5;

async function listActiveEvents() {
  return prisma.event.findMany({
    where: { isPublished: true },
    orderBy: { startDate: 'asc' },
  });
}

async function listPublishedEvents() {
  return prisma.event.findMany({
    where: { isPublished: true },
    orderBy: { startDate: 'asc' },
  });
}

async function listAllEvents() {
  return prisma.event.findMany({
    orderBy: { startDate: 'asc' },
    include: { _count: { select: { registrations: true } } },
  });
}

async function getEventById(id) {
  const event = await prisma.event.findUnique({ where: { id: Number(id) } });
  if (!event) throw new AppError('Event not found', 404);
  return event;
}

async function createEvent(data) {
  const event = await prisma.event.create({
    data: {
      title: data.title,
      description: data.description || null,
      location: data.location || null,
      modality: data.modality || 'FACE_TO_FACE',
      imageUrl: data.imageUrl || null,
      zoomLink: data.zoomLink || null,
      featured: data.featured !== undefined ? Boolean(data.featured) : false,
      startDate: new Date(data.startDate),
      endDate: data.endDate ? new Date(data.endDate) : null,
      capacity: data.capacity ? Number(data.capacity) : null,
      isPublished: data.isPublished !== undefined ? Boolean(data.isPublished) : true,
      // feeCentavos is always an explicit integer by the time it reaches here
      // (event.api.js converts the admin form's peso decimal), never trusted
      // as raw client input. 0/undefined both mean free, matching the
      // column's own default.
      feeCentavos: data.feeCentavos !== undefined ? Number(data.feeCentavos) : 0,
    },
  });
  // Seeds the event's tab immediately (0 registrations, 0% filled) rather
  // than waiting for the first registrant to trigger it.
  sheetsSyncService.syncEventRegistrations(event.id);
  return event;
}

async function updateEvent(id, data) {
  const existing = await getEventById(id);

  // If a new imageUrl was provided and the existing image is an uploaded
  // file (not an external URL), remove it — storageService.remove() already
  // no-ops for anything it doesn't manage, so no separate check is needed
  // here first.
  if (data.imageUrl !== undefined && existing.imageUrl) {
    await storageService.remove(existing.imageUrl).catch((err) => {
      // swallow errors — failure to delete should not prevent the update
      console.error('Failed to remove previous event image:', err.message || err);
    });
  }

  const updated = await prisma.event.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      description: data.description || null,
      location: data.location || null,
      modality: data.modality || undefined,
      imageUrl: data.imageUrl !== undefined ? (data.imageUrl || null) : undefined,
      zoomLink: data.zoomLink !== undefined ? (data.zoomLink || null) : undefined,
      featured: data.featured !== undefined ? Boolean(data.featured) : undefined,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate !== undefined ? (data.endDate ? new Date(data.endDate) : null) : undefined,
      capacity: data.capacity !== undefined ? (data.capacity ? Number(data.capacity) : null) : undefined,
      isPublished: data.isPublished !== undefined ? Boolean(data.isPublished) : undefined,
      feeCentavos: data.feeCentavos !== undefined ? Number(data.feeCentavos) : undefined,
    },
  });
  // Renames the tab if the title changed and refreshes capacity/fee-derived %.
  sheetsSyncService.syncEventRegistrations(updated.id);
  return updated;
}

async function deleteEvent(id) {
  const existing = await getEventById(id);

  // Payment.event is onDelete: Restrict (DB-level backstop), but check here
  // first for a friendly error instead of a raw FK-violation 500 — an event
  // with any payment history (pending, processing, paid, or refunded) must
  // never be deleted out from under its financial records.
  const paymentInProgressOrSettled = await prisma.payment.findFirst({
    where: { eventId: Number(id), status: { in: ['PENDING', 'PROCESSING', 'PAID'] } },
  });
  if (paymentInProgressOrSettled) {
    throw new AppError('This event has payment history and cannot be deleted. Resolve or refund outstanding payments first.', 409);
  }

  // Remove uploaded image file if present
  if (existing.imageUrl) {
    await storageService.remove(existing.imageUrl).catch((err) => {
      console.error('Failed to remove event image on delete:', err.message || err);
    });
  }
  // Remove the event's certificate template background + any generated certificate
  // PDFs so deleting an event doesn't orphan files (DB rows cascade automatically).
  await certificateService.deleteEventCertificateAssets(id).catch((err) => {
    console.error('Failed to remove event certificate assets on delete:', err.message || err);
  });
  // Same for the event's email template attachment image, if one was uploaded.
  await emailTemplateService.deleteEventTemplateAssets(id).catch((err) => {
    console.error('Failed to remove event email template assets on delete:', err.message || err);
  });
  await prisma.event.delete({ where: { id: Number(id) } });
  sheetsSyncService.deleteEventTab(id);
  sheetsSyncService.deleteEventInvitationsTab(id);
}

// An event is over when it has ENDED, not when it has started. A convention
// running 5–12 September is still on on the 8th, and listing it under "past
// events" on its second morning — while people are literally at it — is what
// this pair of helpers exists to prevent.
//
// endDate is optional, so both fall back to startDate when there isn't one.
// That leaves a single-day event with no end time counted as over the moment
// its start time passes, which is the behaviour this project has always had;
// see the note in the git history if that ever needs revisiting.
// The same question as the two where-builders below, asked about a row already
// in hand instead of in SQL. Kept beside them so the two can't drift: if the
// fallback rule changes, it changes here for both.
function hasEventEnded(event, now = new Date()) {
  const end = event.endDate || event.startDate;
  return new Date(end) < now;
}

function notEndedWhere(now) {
  return { OR: [{ endDate: { gte: now } }, { endDate: null, startDate: { gte: now } }] };
}

function hasEndedWhere(now) {
  return { OR: [{ endDate: { lt: now } }, { endDate: null, startDate: { lt: now } }] };
}

/**
 * Public /events page listing.
 * Only published events, split by date into upcoming/ended, each independently
 * paginated, plus a small featured banner (upcoming + featured only).
 */
async function getPublicEventsListing({
  upcomingPage = 1,
  endedPage = 1,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  const now = new Date();

  const [
    featuredEvents,
    upcomingTotal,
    upcomingEvents,
    endedTotal,
    endedEvents,
  ] = await Promise.all([
    prisma.event.findMany({
      where: { AND: [{ isPublished: true, featured: true }, notEndedWhere(now)] },
      orderBy: { startDate: 'asc' },
      take: 2,
    }),
    prisma.event.count({
      where: { AND: [{ isPublished: true }, notEndedWhere(now)] },
    }),
    prisma.event.findMany({
      where: { AND: [{ isPublished: true }, notEndedWhere(now)] },
      orderBy: { startDate: 'asc' },
      skip: (upcomingPage - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({
      where: { AND: [{ isPublished: true }, hasEndedWhere(now)] },
    }),
    prisma.event.findMany({
      where: { AND: [{ isPublished: true }, hasEndedWhere(now)] },
      orderBy: { startDate: 'desc' },
      skip: (endedPage - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    featuredEvents,
    upcomingEvents,
    upcomingPage,
    upcomingTotalPages: Math.max(1, Math.ceil(upcomingTotal / pageSize)),
    endedEvents,
    endedPage,
    endedTotalPages: Math.max(1, Math.ceil(endedTotal / pageSize)),
  };
}

function buildAdminEventsWhere({ search, modality, published }) {
  const where = {};
  if (search) {
    where.title = { contains: search };
  }
  if (modality === 'FACE_TO_FACE' || modality === 'ONLINE') {
    where.modality = modality;
  }
  if (published === 'true') {
    where.isPublished = true;
  } else if (published === 'false') {
    where.isPublished = false;
  }
  return where;
}

/**
 * Admin /admin/events page listing.
 * Respects search/modality/published filters across all three sections
 * (featured/upcoming/ended) AND the flat management table, which additionally
 * includes drafts (no isPublished filter applied unless the admin picks one)
 * and a registration count per event.
 */
async function getAdminEventsListing({
  search,
  modality,
  published,
  upcomingPage = 1,
  endedPage = 1,
  tablePage = 1,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  const now = new Date();
  const baseWhere = buildAdminEventsWhere({ search, modality, published });
  const upcomingWhere = { AND: [baseWhere, notEndedWhere(now)] };
  const endedWhere = { AND: [baseWhere, hasEndedWhere(now)] };

  const [
    featuredEvents,
    upcomingTotal,
    upcomingEvents,
    endedTotal,
    endedEvents,
    tableTotal,
    tableEvents,
  ] = await Promise.all([
    prisma.event.findMany({
      where: { AND: [baseWhere, { featured: true }, notEndedWhere(now)] },
      orderBy: { startDate: 'asc' },
      take: 2,
    }),
    prisma.event.count({ where: upcomingWhere }),
    prisma.event.findMany({
      where: upcomingWhere,
      orderBy: { startDate: 'asc' },
      skip: (upcomingPage - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({ where: endedWhere }),
    prisma.event.findMany({
      where: endedWhere,
      orderBy: { startDate: 'desc' },
      skip: (endedPage - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({ where: baseWhere }),
    prisma.event.findMany({
      where: baseWhere,
      orderBy: { startDate: 'desc' },
      skip: (tablePage - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { registrations: true } } },
    }),
  ]);

  return {
    featuredEvents,
    upcomingEvents,
    upcomingPage,
    upcomingTotalPages: Math.max(1, Math.ceil(upcomingTotal / pageSize)),
    endedEvents,
    endedPage,
    endedTotalPages: Math.max(1, Math.ceil(endedTotal / pageSize)),
    tableEvents,
    tablePage,
    tableTotalPages: Math.max(1, Math.ceil(tableTotal / pageSize)),
  };
}

module.exports = {
  hasEventEnded,
  notEndedWhere,
  hasEndedWhere,
  listActiveEvents,
  listPublishedEvents,
  listAllEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  getPublicEventsListing,
  getAdminEventsListing,
};