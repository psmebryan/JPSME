const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');
const { excerpt, safeHref } = require('../utils/articleFormat');

// Articles: the public News pages and their admin.
//
//   An article has a title, a category (Circular, Newsletter, ...), an author,
//   a cover image, a body written with a few simple marks (see
//   utils/articleFormat), an optional summary for cards, an optional external
//   link shown as a button, and a gallery of extra photos in order.
//
//   publishedAt is set the first time an article is published and can be
//   changed by the admin, so an older circular can be posted under its real
//   date; it orders the News pages and groups them By Year.

const MAX_GALLERY = 12;
const PAGE_SIZE = 12;

// FormData sends checkbox state as the literal string "true"/"false" (the
// admin form explicitly sets this, since FormData omits unchecked boxes
// entirely otherwise) — plain Boolean(x) would treat "false" as truthy since
// it's a non-empty string, so this coerces string forms explicitly instead.
function toBool(value) {
  return value === true || value === 'true';
}

// "2026-10-26" from the form, read as that day in the Philippines (noon, so
// no timezone shift moves it to the day before). Empty = not given.
function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new AppError('Enter the publish date as a date', 422);
  }
  return new Date(`${text}T12:00:00+08:00`);
}

function cleanLink(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  if (!safeHref(text) || text.startsWith('mailto:')) throw new AppError('The link must start with https:// or http://', 422);
  return text.slice(0, 500);
}

const optional = (v, max) => {
  const text = String(v == null ? '' : v).trim();
  return text ? text.slice(0, max) : null;
};

// What a card or list needs: the article plus a teaser.
function withTeaser(a, max) {
  return { ...a, teaser: a.summary || excerpt(a.body, max) };
}

const PUBLISHED = { isPublished: true };
const NEWEST = [{ publishedAt: 'desc' }, { id: 'desc' }];

// --- public ----------------------------------------------------------------------------

// Published categories, newest activity first, each with how many articles.
async function listCategories() {
  const rows = await prisma.article.groupBy({
    by: ['category'],
    where: { ...PUBLISHED, category: { not: null } },
    _count: { _all: true },
    _max: { publishedAt: true },
  });
  return rows.filter((r) => r.category)
    .sort((a, b) => new Date(b._max.publishedAt || 0) - new Date(a._max.publishedAt || 0))
    .map((r) => ({ name: r.category, count: r._count._all }));
}

// The years that have published articles, newest first.
async function listYears() {
  const rows = await prisma.article.findMany({ where: PUBLISHED, select: { publishedAt: true } });
  const years = new Set(rows.filter((r) => r.publishedAt).map((r) => new Date(r.publishedAt).getUTCFullYear()));
  return [...years].sort((a, b) => b - a);
}

// The News landing page: each category with its latest few, plus anything
// uncategorised under "More news".
async function newsLanding(perSection = 4) {
  const [categories, years, uncategorised] = await Promise.all([
    listCategories(),
    listYears(),
    prisma.article.findMany({ where: { ...PUBLISHED, category: null }, orderBy: NEWEST, take: perSection }),
  ]);
  const sections = await Promise.all(categories.map(async (c) => ({
    name: c.name,
    count: c.count,
    articles: (await prisma.article.findMany({ where: { ...PUBLISHED, category: c.name }, orderBy: NEWEST, take: perSection }))
      .map((a) => withTeaser(a, 220)),
  })));
  if (uncategorised.length) {
    sections.push({ name: null, count: await prisma.article.count({ where: { ...PUBLISHED, category: null } }), articles: uncategorised.map((a) => withTeaser(a, 220)) });
  }
  return { sections, years, categories };
}

// "View All", one category, one year, or a search; paged.
async function listPublishedArticles({ category, year, q, page = 1 } = {}) {
  const and = [PUBLISHED];
  if (category) and.push({ category });
  const y = Number(year);
  if (Number.isInteger(y) && y > 1900 && y < 3000) {
    and.push({ publishedAt: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } });
  }
  String(q || '').trim().slice(0, 100).split(/\s+/).filter(Boolean).forEach((w) => {
    and.push({ OR: [{ title: { contains: w } }, { body: { contains: w } }, { category: { contains: w } }, { summary: { contains: w } }] });
  });
  const where = { AND: and };
  const total = await prisma.article.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), totalPages);
  const articles = await prisma.article.findMany({ where, orderBy: NEWEST, skip: (p - 1) * PAGE_SIZE, take: PAGE_SIZE });
  return { articles: articles.map((a) => withTeaser(a, 160)), total, page: p, totalPages };
}

async function getPublishedArticleById(id) {
  const article = await prisma.article.findUnique({
    where: { id: Number(id) || 0 },
    include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!article || !article.isPublished) throw new AppError('Article not found', 404);
  return article;
}

// "Explore More": the same category first, then the newest of the rest.
async function relatedArticles(article, take = 4) {
  const same = article.category ? await prisma.article.findMany({
    where: { ...PUBLISHED, category: article.category, id: { not: article.id } }, orderBy: NEWEST, take,
  }) : [];
  const more = same.length < take ? await prisma.article.findMany({
    where: { ...PUBLISHED, id: { notIn: [article.id, ...same.map((a) => a.id)] } }, orderBy: NEWEST, take: take - same.length,
  }) : [];
  return [...same, ...more].map((a) => withTeaser(a, 120));
}

// --- admin -----------------------------------------------------------------------------

async function listAllArticles() {
  const articles = await prisma.article.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { _count: { select: { images: true } } },
  });
  return articles.map((a) => withTeaser(a, 140));
}

// Every category ever used, for the editor's suggestions.
async function listAllCategoryNames() {
  const rows = await prisma.article.findMany({
    where: { category: { not: null } }, select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' },
  });
  return rows.map((r) => r.category).filter(Boolean);
}

async function getArticleById(id) {
  const article = await prisma.article.findUnique({
    where: { id: Number(id) || 0 },
    include: { images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
  });
  if (!article) throw new AppError('Article not found', 404);
  return article;
}

function fieldsFrom(data) {
  return {
    title: data.title,
    category: optional(data.category, 60),
    authorName: optional(data.authorName, 120),
    summary: optional(data.summary, 300),
    linkUrl: cleanLink(data.linkUrl),
    linkLabel: optional(data.linkLabel, 100),
    body: data.body,
  };
}

async function addImages(tx, articleId, urls, startAt) {
  for (let i = 0; i < urls.length; i += 1) {
    await tx.articleImage.create({ data: { articleId, url: urls[i], sortOrder: startAt + i } });
  }
}

async function createArticle(data) {
  const isPublished = data.isPublished !== undefined ? toBool(data.isPublished) : false;
  const chosenDate = parseDate(data.publishedAt);
  const gallery = data.galleryUrls || [];
  if (gallery.length > MAX_GALLERY) throw new AppError(`Up to ${MAX_GALLERY} gallery photos`, 422);
  return prisma.$transaction(async (tx) => {
    const article = await tx.article.create({
      data: {
        ...fieldsFrom(data),
        coverImage: data.imageUrl || null,
        isPublished,
        // When it went live, unless the admin gives the article's own date
        // (an older circular posted now). A draft keeps a chosen date for
        // when it is published.
        publishedAt: chosenDate || (isPublished ? new Date() : null),
      },
    });
    await addImages(tx, article.id, gallery, 0);
    return article;
  });
}

// `removeImageIds`: gallery photos to take out. `imageOrder`: the remaining
// photos' ids in their new order. New photos go after the rest.
async function updateArticle(id, data) {
  const existing = await getArticleById(id);
  const removeIds = new Set(String(data.removeImageIds || '').split(',').map(Number).filter((n) => n > 0));
  const removing = existing.images.filter((img) => removeIds.has(img.id));
  const keeping = existing.images.filter((img) => !removeIds.has(img.id));
  const gallery = data.galleryUrls || [];
  if (keeping.length + gallery.length > MAX_GALLERY) throw new AppError(`Up to ${MAX_GALLERY} gallery photos`, 422);

  const willBePublished = data.isPublished !== undefined ? toBool(data.isPublished) : existing.isPublished;
  const chosenDate = data.publishedAt !== undefined ? parseDate(data.publishedAt) : null;
  let publishedAt = existing.publishedAt;
  if (chosenDate) publishedAt = chosenDate;
  else if (willBePublished && !existing.publishedAt) publishedAt = new Date();

  const order = String(data.imageOrder || '').split(',').map(Number).filter((n) => n > 0);
  const ordered = [...keeping].sort((a, b) => {
    const ia = order.indexOf(a.id); const ib = order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.sortOrder - b.sortOrder;
  });

  const article = await prisma.$transaction(async (tx) => {
    if (removing.length) await tx.articleImage.deleteMany({ where: { id: { in: removing.map((r) => r.id) } } });
    for (let i = 0; i < ordered.length; i += 1) {
      if (ordered[i].sortOrder !== i) await tx.articleImage.update({ where: { id: ordered[i].id }, data: { sortOrder: i } });
    }
    await addImages(tx, existing.id, gallery, ordered.length);
    return tx.article.update({
      where: { id: existing.id },
      data: {
        ...fieldsFrom(data),
        coverImage: data.imageUrl !== undefined ? (data.imageUrl || null) : undefined,
        isPublished: willBePublished,
        publishedAt,
      },
    });
  });

  // Files go only after the database no longer points at them.
  const oldFiles = removing.map((r) => r.url);
  if (data.imageUrl !== undefined && existing.coverImage) oldFiles.push(existing.coverImage);
  await Promise.all(oldFiles.map((url) => storageService.remove(url).catch((err) => {
    console.error('Failed to remove an old article image:', err.message || err);
  })));
  return article;
}

async function deleteArticle(id) {
  const existing = await getArticleById(id);
  await prisma.article.delete({ where: { id: existing.id } });
  const files = [existing.coverImage, ...existing.images.map((i) => i.url)].filter(Boolean);
  await Promise.all(files.map((url) => storageService.remove(url).catch((err) => {
    console.error('Failed to remove article image on delete:', err.message || err);
  })));
}

module.exports = {
  MAX_GALLERY,
  listCategories,
  listYears,
  newsLanding,
  listPublishedArticles,
  getPublishedArticleById,
  relatedArticles,
  listAllArticles,
  listAllCategoryNames,
  getArticleById,
  createArticle,
  updateArticle,
  deleteArticle,
};
