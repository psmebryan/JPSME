const { Router } = require('express');
const { param, query } = require('express-validator');
const organizationApi = require('../../controllers/api/organization.api');

const router = Router();

// Public and read-only by design: the registration form's organization picker
// has to work before an account exists. Everything here is bounded/paginated
// (no unbounded tree loads) and exposes presentational fields only.
router.get(
  '/search',
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Invalid page'),
  query('type').optional({ checkFalsy: true })
    .isIn(['NATIONAL', 'MOTHER_ORG', 'CLUSTER', 'CHAPTER', 'STUDENT_UNIT'])
    .withMessage('Invalid type'),
  organizationApi.searchOrganizations
);
// Must precede /:id/* so "top-level" is not parsed as an id.
router.get('/top-level', organizationApi.getTopLevel);
router.get('/:id/path', param('id').isInt(), organizationApi.getOrganizationPath);
router.get('/:id/children', param('id').isInt(), organizationApi.getChildren);

module.exports = router;
