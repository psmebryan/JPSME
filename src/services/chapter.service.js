const prisma = require('../config/prisma');

function slugify(text) {
  return text.toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Public: Regions -> Areas -> active Chapters, in display order
async function listChaptersGrouped() {
  const regions = await prisma.chapterRegion.findMany({
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
    include: {
      areas: {
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        include: {
          chapters: {
            where: { isActive: true },
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
          },
        },
      },
    },
  });
  return regions.filter((region) => region.areas.some((area) => area.chapters.length > 0));
}

// Public: Regions with a total active-chapter count, for the Chapters landing page cards.
async function listRegionsWithChapterCounts() {
  const regions = await prisma.chapterRegion.findMany({
    orderBy: [{ order: 'asc' }, { name: 'asc' }],
    include: {
      areas: {
        include: {
          chapters: { where: { isActive: true }, select: { id: true } },
        },
      },
    },
  });

  return regions.map((region) => ({
    id: region.id,
    name: region.name,
    slug: region.slug,
    chapterCount: region.areas.reduce((sum, area) => sum + area.chapters.length, 0),
  }));
}

// Public: one region, with its areas and their active chapters, for the region drill-down page.
async function getRegionWithChapters(regionId) {
  return prisma.chapterRegion.findUnique({
    where: { id: Number(regionId) },
    include: {
      areas: {
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        include: {
          chapters: {
            where: { isActive: true },
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
          },
        },
      },
    },
  });
}

// Public: a single chapter with its area AND region, for the chapter detail page's breadcrumb.
async function getChapterWithRegion(chapterId) {
  return prisma.chapter.findUnique({
    where: { id: Number(chapterId) },
    include: { area: { include: { region: true } } },
  });
}

// Chapters with their assigned leader (if any) and a live member count, for the
// main-admin "Chapter Admins" grid.
const listChaptersWithStats = () => prisma.chapter.findMany({
  orderBy: [{ order: 'asc' }, { name: 'asc' }],
  include: {
    area: { include: { region: true } },
    chapterAdmin: { include: { user: true } },
    _count: { select: { users: true } },
  },
});

// Regions
const listRegions = () => prisma.chapterRegion.findMany({
  orderBy: [{ order: 'asc' }, { name: 'asc' }],
  include: { areas: true },
});
const createRegion = ({ name }) => prisma.chapterRegion.create({ data: { name, slug: slugify(name) } });
const deleteRegion = (id) => prisma.chapterRegion.delete({ where: { id } });

// Areas
const listAreas = () => prisma.chapterArea.findMany({
  orderBy: [{ order: 'asc' }, { name: 'asc' }],
  include: { region: true, chapters: true },
});
const createArea = ({ name, regionId }) => prisma.chapterArea.create({ data: { name, slug: slugify(name), regionId } });
const deleteArea = (id) => prisma.chapterArea.delete({ where: { id } });

// Chapters
const listChapters = () => prisma.chapter.findMany({
  orderBy: [{ order: 'asc' }, { name: 'asc' }],
  include: { area: { include: { region: true } } },
});
const getChapterById = (id) => prisma.chapter.findUnique({ where: { id }, include: { area: true } });
const createChapter = ({ name, yearFounded, areaId, isActive }) =>
  prisma.chapter.create({ data: { name, yearFounded, areaId, isActive } });
const updateChapter = (id, { name, yearFounded, areaId, isActive }) =>
  prisma.chapter.update({ where: { id }, data: { name, yearFounded, areaId, isActive } });
const deleteChapter = (id) => prisma.chapter.delete({ where: { id } });

module.exports = {
  listChaptersGrouped,
  listRegionsWithChapterCounts,
  getRegionWithChapters,
  getChapterWithRegion,
  listRegions, createRegion, deleteRegion,
  listAreas, createArea, deleteArea,
  listChapters, getChapterById, createChapter, updateChapter, deleteChapter,
  listChaptersWithStats,
};