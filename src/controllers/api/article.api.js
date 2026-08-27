const path = require('path');
const { validationResult } = require('express-validator');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const articleService = require('../../services/article.service');
const storageService = require('../../services/storage.service');

function checkValidation(req, res) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    error(res, 'Validation failed', 422, result.array());
    return false;
  }
  return true;
}

const listPublicArticles = asyncHandler(async (req, res) => {
  const articles = await articleService.listPublishedArticles(req.query.category || undefined);
  return success(res, { articles });
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
  const payload = { ...req.body };
  if (req.file) {
    payload.imageUrl = await storageService.saveUpload(req.file.buffer, {
      folder: 'articles',
      prefix: 'articles',
      extension: path.extname(req.file.originalname).toLowerCase(),
    });
  }
  const article = await articleService.createArticle(payload);
  return success(res, { article }, 'Article created', 201);
});

const updateArticle = asyncHandler(async (req, res) => {
  if (!checkValidation(req, res)) return;
  const payload = { ...req.body };
  if (req.file) {
    payload.imageUrl = await storageService.saveUpload(req.file.buffer, {
      folder: 'articles',
      prefix: 'articles',
      extension: path.extname(req.file.originalname).toLowerCase(),
    });
  }
  const article = await articleService.updateArticle(req.params.id, payload);
  return success(res, { article }, 'Article updated');
});

const deleteArticle = asyncHandler(async (req, res) => {
  await articleService.deleteArticle(req.params.id);
  return success(res, null, 'Article deleted');
});

module.exports = { listPublicArticles, listAllArticles, getArticle, createArticle, updateArticle, deleteArticle };
