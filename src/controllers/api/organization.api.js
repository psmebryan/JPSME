const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const organizationService = require('../../services/organization.service');

// Public, read-only, and paginated — this backs the registration form's
// organization picker, so an unauthenticated visitor must be able to search it.
// Only active organizations are returned and only presentational fields are
// exposed; nothing here reveals members or admin structure.
const searchOrganizations = asyncHandler(async (req, res) => {
  const { q, type, page } = req.query;
  const result = await organizationService.searchOrganizations({
    q: q || undefined,
    type: type || undefined,
    page: Math.max(1, Number(page) || 1),
    pageSize: 20,
  });
  return success(res, {
    organizations: result.organizations.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      institution: o.institution,
      pathLabel: o.pathLabel,
    })),
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
  });
});

// The full ancestor chain for one organization — used to confirm a selection
// back to the member ("JPSME National › Luzon › Cavite Chapter") so they can
// see they picked the right branch before submitting.
const getOrganizationPath = asyncHandler(async (req, res) => {
  const organization = await organizationService.getOrganization(req.params.id);
  if (!organization || !organization.isActive) return error(res, 'Organization not found', 404);
  const chain = await organizationService.getOrganizationPath(organization.id);
  return success(res, {
    organization: { id: organization.id, name: organization.name, type: organization.type },
    path: chain.map((o) => ({ id: o.id, name: o.name, type: o.type })),
    pathLabel: chain.map((o) => o.name).join(' › '),
  });
});

// The first rung of the registration cascade: whatever sits directly under the
// national root. Returned as-is rather than filtered to a fixed type, because
// the level below National is not uniform — it holds mother orgs, and also
// clusters and chapters whose real parent is still being resolved.
const getTopLevel = asyncHandler(async (req, res) => {
  const root = await organizationService.getRoot();
  if (!root) return success(res, { root: null, children: [] });
  const children = await organizationService.getChildren(root.id, { activeOnly: true });
  return success(res, {
    root: { id: root.id, name: root.name, type: root.type },
    children: children.map((c) => ({ id: c.id, name: c.name, type: c.type })),
  });
});

const getChildren = asyncHandler(async (req, res) => {
  const organization = await organizationService.getOrganization(req.params.id);
  if (!organization || !organization.isActive) return error(res, 'Organization not found', 404);
  const children = await organizationService.getChildren(organization.id, { activeOnly: true });
  return success(res, {
    children: children.map((c) => ({ id: c.id, name: c.name, type: c.type })),
  });
});

module.exports = { searchOrganizations, getOrganizationPath, getChildren, getTopLevel };
