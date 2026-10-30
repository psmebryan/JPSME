const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const articleService = require('../../services/article.service');
const storageService = require('../../services/storage.service');
const articleFormat = require('../../utils/articleFormat');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

// Saved under the type their bytes were checked as (verifyImageSignatures),
// never the name the browser sent.
function saveImage(file) {
  return storageService.saveUpload(file.buffer, { folder: 'articles', prefix: 'articles', extension: file.detectedExtension });
}

// The cover ("image") and new gallery photos ("gallery") from one form post.
async function payloadFrom(req) {
  const payload = { ...req.body };
  const files = req.files || {};
  if (files.image && files.image[0]) payload.imageUrl = await saveImage(files.image[0]);
  else if (req.body.removeCover === 'true') payload.imageUrl = null;
  if (files.gallery && files.gallery.length) {
    payload.galleryUrls = [];
    for (const file of files.gallery) payload.galleryUrls.push(await saveImage(file));
  }
  return payload;
}

const listPublicArticles = asyncHandler(async (req, res) => {
  const result = await articleService.listPublishedArticles({
    category: req.query.category || undefined, year: req.query.year, q: req.query.q, page: req.query.page,
  });
  return success(res, result);
});

const listAllArticles = asyncHandler(async (req, res) => {
  const articles = await articleService.listAllArticles();
  return success(res, { articles });
});

const getArticle = asyncHandler(async (req, res) => {
  const article = await articleService.getArticleById(req.params.id);
  return success(res, { article });
});

const createArticle = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const article = await articleService.createArticle(await payloadFrom(req));
  return success(res, { article }, 'Article created', 201);
});

const updateArticle = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const article = await articleService.updateArticle(req.params.id, await payloadFrom(req));
  return success(res, { article }, 'Article updated');
});

const deleteArticle = asyncHandler(async (req, res) => {
  await articleService.deleteArticle(req.params.id);
  return success(res, null, 'Article deleted');
});

// The editor's Preview tab: the body as the public page will show it, from
// the same formatter, so the preview can never disagree with the page.
const previewArticle = asyncHandler(async (req, res) => {
  const body = String(req.body.body || '').slice(0, 200000);
  return success(res, { html: articleFormat.render(body) });
});

module.exports = { listPublicArticles, listAllArticles, getArticle, createArticle, updateArticle, deleteArticle, previewArticle };
