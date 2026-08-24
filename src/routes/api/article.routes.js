const { Router } = require('express');
const { body } = require('express-validator');
const articleApi = require('../../controllers/api/article.api');
const { apiAdmin } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadArticleImage } = require('../../middleware/upload.middleware');
const verifyImageSignature = require('../../middleware/verifyImageSignature');

const router = Router();

const articleValidators = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('category').optional({ checkFalsy: true }).trim().isLength({ max: 60 }),
  body('authorName').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
  body('body').trim().notEmpty().withMessage('Article content is required'),
  body('isPublished').optional().isBoolean().withMessage('isPublished must be true or false'),
];

// Note: specific routes (admin/all) must be declared before the generic '/:id' route.
router.get('/admin/all', apiAdmin, articleApi.listAllArticles);

// Public
router.get('/', articleApi.listPublicArticles);

// Admin management — MAIN_ADMIN only (apiAdmin checks role === 'ADMIN' exactly).
router.post(
  '/',
  apiAdmin,
  verifyCsrfToken,
  uploadArticleImage.single('image'),
  verifyImageSignature,
  articleValidators,
  articleApi.createArticle
);
router.get('/:id', apiAdmin, articleApi.getArticle);
router.put(
  '/:id',
  apiAdmin,
  verifyCsrfToken,
  uploadArticleImage.single('image'),
  verifyImageSignature,
  articleValidators,
  articleApi.updateArticle
);
router.delete('/:id', apiAdmin, verifyCsrfToken, articleApi.deleteArticle);

module.exports = router;
