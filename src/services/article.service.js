const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const storageService = require('./storage.service');

// FormData sends checkbox state as the literal string "true"/"false" (the
// admin form explicitly sets this, since FormData omits unchecked boxes
// entirely otherwise) — plain Boolean(x) would treat "false" as truthy since
// it's a non-empty string, so this coerces string forms explicitly instead.
function toBool(value) {
  return value === true || value === 'true';
}

async function listPublishedArticles(category) {
  return prisma.article.findMany({
    where: { isPublished: true, ...(category ? { category } : {}) },
    orderBy: { publishedAt: 'desc' },
  });
}

async function listCategories() {
  const rows = await prisma.article.findMany({
    where: { isPublished: true, category: { not: null } },
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  });
  return rows.map((r) => r.category).filter(Boolean);
}

async function getPublishedArticleById(id) {
  const article = await prisma.article.findUnique({ where: { id: Number(id) } });
  if (!article || !article.isPublished) throw new AppError('Article not found', 404);
  return article;
}

async function listAllArticles() {
  return prisma.article.findMany({ orderBy: { createdAt: 'desc' } });
}

async function getArticleById(id) {
  const article = await prisma.article.findUnique({ where: { id: Number(id) } });
  if (!article) throw new AppError('Article not found', 404);
  return article;
}

async function createArticle(data) {
  const isPublished = data.isPublished !== undefined ? toBool(data.isPublished) : false;
  return prisma.article.create({
    data: {
      title: data.title,
      category: data.category || null,
      authorName: data.authorName || null,
      coverImage: data.imageUrl || null,
      body: data.body,
      isPublished,
      // Set once, the moment an article is first published — never
      // overwritten by a later edit, so it reflects when it actually went
      // live rather than when it was last touched.
      publishedAt: isPublished ? new Date() : null,
    },
  });
}

async function updateArticle(id, data) {
  const existing = await getArticleById(id);

  if (data.imageUrl !== undefined && existing.coverImage) {
    await storageService.remove(existing.coverImage).catch((err) => {
      console.error('Failed to remove previous article cover image:', err.message || err);
    });
  }

  const willBePublished = data.isPublished !== undefined ? toBool(data.isPublished) : existing.isPublished;
  const publishedAt = willBePublished && !existing.isPublished ? new Date() : existing.publishedAt;

  return prisma.article.update({
    where: { id: Number(id) },
    data: {
      title: data.title,
      category: data.category || null,
      authorName: data.authorName || null,
      coverImage: data.imageUrl !== undefined ? (data.imageUrl || null) : undefined,
      body: data.body,
      isPublished: willBePublished,
      publishedAt,
    },
  });
}

async function deleteArticle(id) {
  const existing = await getArticleById(id);
  if (existing.coverImage) {
    await storageService.remove(existing.coverImage).catch((err) => {
      console.error('Failed to remove article cover image on delete:', err.message || err);
    });
  }
  await prisma.article.delete({ where: { id: Number(id) } });
}

module.exports = {
  listPublishedArticles,
  listCategories,
  getPublishedArticleById,
  listAllArticles,
  getArticleById,
  createArticle,
  updateArticle,
  deleteArticle,
};
