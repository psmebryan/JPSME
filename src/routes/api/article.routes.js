const { Router } = require('express');
const { body } = require('express-validator');
const articleApi = require('../../controllers/api/article.api');
const { apiAdmin } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadArticleImage } = require('../../middleware/upload.middleware');
const { verifyImageSignatures } = require('../../middleware/verifyImageSignature');
const { MAX_GALLERY } = require('../../services/article.service');

const router = Router();

const articleValidators = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 200 }),
  body('category').optional({ checkFalsy: true }).trim().isLength({ max: 60 }),
  body('authorName').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
  body('summary').optional({ checkFalsy: true }).trim().isLength({ max: 300 }).withMessage('Keep the summary under 300 characters'),
  body('linkUrl').optional({ checkFalsy: true }).trim().isLength({ max: 500 }),
  body('linkLabel').optional({ checkFalsy: true }).trim().isLength({ max: 100 }),
  body('publishedAt').optional({ checkFalsy: true }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Enter the publish date as a date'),
  body('body').trim().notEmpty().withMessage('Article content is required'),
  body('isPublished').optional().isBoolean().withMessage('isPublished must be true or false'),
];

// The cover and the new gallery photos arrive in the same form post.
const articleImages = [
  uploadArticleImage.fields([{ name: 'image', maxCount: 1 }, { name: 'gallery', maxCount: MAX_GALLERY }]),
  verifyImageSignatures,
];

// Note: specific routes (admin/all, preview) must be declared before the generic '/:id' route.
router.get('/admin/all', apiAdmin, articleApi.listAllArticles);
router.post('/preview', apiAdmin, verifyCsrfToken, articleApi.previewArticle);

// Public
router.get('/', articleApi.listPublicArticles);

// Admin management — MAIN_ADMIN only (apiAdmin checks role === 'ADMIN' exactly).
router.post('/', apiAdmin, verifyCsrfToken, articleImages, articleValidators, articleApi.createArticle);
router.get('/:id', apiAdmin, articleApi.getArticle);
router.put('/:id', apiAdmin, verifyCsrfToken, articleImages, articleValidators, articleApi.updateArticle);
router.delete('/:id', apiAdmin, verifyCsrfToken, articleApi.deleteArticle);

module.exports = router;
