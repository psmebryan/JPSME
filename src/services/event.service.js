const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const fs = require('fs').promises;
const path = require('path');
const certificateService = require('./certificate.service');
const emailTemplateService = require('./emailTemplate.service');
const sheetsSyncService = require('./sheetsSync.service');

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

  // If a new imageUrl was provided and the existing image is an uploaded file, try to remove it.
  if (data.imageUrl !== undefined && existing.imageUrl) {
    try {
      const prev = existing.imageUrl;
      // Only unlink files that are in the local uploads/events folder (avoid removing external URLs)
      if (prev.startsWith('/uploads/events/') || prev.startsWith('uploads/events/')) {
        const relative = prev.replace(/^\//, ''); // remove leading slash if present
        const filePath = path.join(__dirname, '..', '..', 'public', relative);
        await fs.unlink(filePath).catch(() => {});
      }
    } catch (err) {
      // swallow errors — failure to delete should not prevent the update
      console.error('Failed to remove previous event image:', err.message || err);
    }
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
  if (existing.imageUrl && (existing.imageUrl.startsWith('/uploads/events/') || existing.imageUrl.startsWith('uploads/events/'))) {
    try {
      const relative = existing.imageUrl.replace(/^\//, '');
      const filePath = path.join(__dirname, '..', '..', 'public', relative);
      await fs.unlink(filePath).catch(() => {});
    } catch (err) {
      console.error('Failed to remove event image on delete:', err.message || err);
    }
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
      where: { isPublished: true, featured: true, startDate: { gte: now } },
      orderBy: { startDate: 'asc' },
      take: 2,
    }),
    prisma.event.count({
      where: { isPublished: true, startDate: { gte: now } },
    }),
    prisma.event.findMany({
      where: { isPublished: true, startDate: { gte: now } },
      orderBy: { startDate: 'asc' },
      skip: (upcomingPage - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({
      where: { isPublished: true, startDate: { lt: now } },
    }),
    prisma.event.findMany({
      where: { isPublished: true, startDate: { lt: now } },
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
  const upcomingWhere = { ...baseWhere, startDate: { gte: now } };
  const endedWhere = { ...baseWhere, startDate: { lt: now } };

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
      where: { ...baseWhere, featured: true, startDate: { gte: now } },
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