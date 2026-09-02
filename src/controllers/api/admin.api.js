const path = require('path');
const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const userService = require('../../services/user.service');
const settingsService = require('../../services/settings.service');
const sponsorService = require('../../services/sponsor.service');
const paymentService = require('../../services/payment.service');
const storageService = require('../../services/storage.service');
const organizationAdminService = require('../../services/organizationAdmin.service');
const organizationService = require('../../services/organization.service');

// Enriches each user with their latest membership-payment status so the admin
// can see who's paid before approving — one batched query, not N.
async function withMembershipPaymentStatus(users) {
  const statusByUser = await paymentService.getLatestMembershipStatusForUsers(users.map((u) => u.id));
  return users.map((u) => {
    const payment = statusByUser.get(u.id);
    return {
      ...u,
      membershipPayment: payment ? { status: payment.status, paidAt: payment.paidAt } : null,
    };
  });
}

const listUsers = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const users = await userService.listByStatus(status);
  return success(res, { users: await withMembershipPaymentStatus(users) });
});

// Paginated + searchable — backs the "Manage Users" table specifically
// (listUsers above stays unbounded for the approvals queue, which is
// naturally small regardless of total membership size).
const listMembers = asyncHandler(async (req, res) => {
  const { status, organizationId, search, page } = req.query;
  const result = await userService.listMembersForAdmin({
    status: status || undefined,
    organizationId: organizationId || undefined,
    search: search || undefined,
    page: Math.max(1, Number(page) || 1),
  });
  const users = await withMembershipPaymentStatus(result.users);
  return success(res, { ...result, users });
});

// Members of an organization and everything beneath it. A scoped admin is
// confined to their own subtree (req.orgScope); a main admin may pass any
// organizationId, or none to list everyone.
const listOrganizationMembers = asyncHandler(async (req, res) => {
  const requested = req.query.organizationId;

  if (req.orgScope) {
    // A scoped admin may only ever query inside their own subtree.
    if (requested && !req.orgScope.descendantIds.includes(Number(requested))) {
      return error(res, 'Access denied', 403);
    }
    const users = await userService.listByOrganization(requested || req.orgScope.id);
    return success(res, { users });
  }

  if (requested) {
    const users = await userService.listByOrganization(requested);
    return success(res, { users });
  }
  const users = await userService.listByStatus();
  return success(res, { users });
});

const approveUser = asyncHandler(async (req, res) => {
  const user = await userService.setStatus(req.params.id, 'APPROVED', {
    actorId: req.session.user.id,
    reason: 'ADMIN_MANUAL_APPROVAL',
  });
  return success(res, { user }, 'User approved');
});

const rejectUser = asyncHandler(async (req, res) => {
  const user = await userService.setStatus(req.params.id, 'REJECTED', {
    actorId: req.session.user.id,
    reason: 'ADMIN_MANUAL_REJECTION',
  });
  return success(res, { user }, 'User rejected');
});

const updateUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  let payload = { ...req.body };

  if (req.orgScope) {
    const target = await userService.getById(userId);
    if (!req.orgScope.descendantIds.includes(Number(target.organizationId))) {
      return error(res, 'Access denied', 403);
    }

    // Scoped admins may only touch these fields on their own members —
    // never email, role, or organizationId, even if sent directly to the API.
    const allowedFields = ['firstName', 'middleInitial', 'lastName', 'phone', 'school'];
    payload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => allowedFields.includes(key))
    );
  }

  const user = await userService.updateUser(userId, payload);
  return success(res, { user }, 'User updated');
});

const deleteUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (req.orgScope) {
    const target = await userService.getById(userId);
    const targetOrgId = target.organizationId ?? (target.organization && target.organization.id);
    if (!req.orgScope.descendantIds.includes(Number(targetOrgId))) {
      return error(res, 'Access denied', 403);
    }
  }
  const result = await userService.deleteUser(userId);
  return success(res, { result }, 'User deleted');
});

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No logo file uploaded', 400);

  const publicPath = await storageService.saveUpload(req.file.buffer, {
    folder: 'logo',
    prefix: 'logo',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  await settingsService.setLogoUrl(publicPath);
  return success(res, { logoUrl: publicPath }, 'Logo updated');
});

const getLogo = asyncHandler(async (req, res) => {
  const logoUrl = await settingsService.getLogoUrl();
  return success(res, { logoUrl });
});

// feePhp arrives as a decimal peso string (e.g. "500.00") from the admin form;
// stored internally as integer centavos to avoid float currency math. This
// controls what every future applicant is charged, so it's validated directly
// here rather than trusted from the route-level check alone.
const updateMembershipFee = asyncHandler(async (req, res) => {
  const feePhp = Number(req.body.feePhp);
  if (!Number.isFinite(feePhp) || feePhp < 0 || feePhp > 1000000) {
    return error(res, 'Enter a valid fee amount', 422);
  }
  const centavos = Math.round(feePhp * 100);
  await settingsService.setMembershipFeeCentavos(centavos);
  return success(res, { feeCentavos: centavos }, 'Membership fee updated');
});

const updateGatewaySurchargePercent = asyncHandler(async (req, res) => {
  const percent = Number(req.body.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return error(res, 'Enter a valid percentage', 422);
  }
  await settingsService.setGatewaySurchargePercent(percent);
  return success(res, { percent }, 'Payment processing surcharge updated');
});

const getPaymentsEnabled = asyncHandler(async (req, res) => {
  const enabled = await settingsService.getPaymentsEnabled();
  return success(res, { enabled });
});

// Kill switch: lets MAIN_ADMIN stop new checkout creation (membership or
// event fees) without taking the rest of the site down — e.g. during a
// PayMongo outage. Never blocks webhook processing for already-issued
// checkouts (enforced in payment.service.js's createCheckout, not here).
const updatePaymentsEnabled = asyncHandler(async (req, res) => {
  const enabled = req.body.enabled === true || req.body.enabled === 'true';
  await settingsService.setPaymentsEnabled(enabled);
  return success(res, { enabled }, enabled ? 'Payments enabled' : 'Payments disabled');
});

const listSponsors = asyncHandler(async (req, res) => {
  const sponsors = await sponsorService.listSponsors();
  return success(res, { sponsors });
});

const createSponsor = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'A sponsor logo is required', 400);
  const name = (req.body.name || '').trim();
  if (!name) return error(res, 'Sponsor name is required', 422);
  const logoUrl = await storageService.saveUpload(req.file.buffer, {
    folder: 'sponsors',
    prefix: 'sponsors',
    extension: path.extname(req.file.originalname).toLowerCase(),
  });
  const sponsor = await sponsorService.createSponsor({
    name,
    logoUrl,
    websiteUrl: (req.body.websiteUrl || '').trim(),
  });
  return success(res, { sponsor }, 'Sponsor added', 201);
});

const deleteSponsor = asyncHandler(async (req, res) => {
  await sponsorService.deleteSponsor(req.params.id);
  return success(res, null, 'Sponsor removed');
});

// Organization admin assignments
const listOrganizationAdmins = asyncHandler(async (req, res) => {
  const assignments = await organizationAdminService.listAssignments();
  return success(res, { assignments });
});

const assignOrganizationAdmin = asyncHandler(async (req, res) => {
  const { organizationId, userId, note } = req.body;
  const changedBy = req.session.user.id;
  const assignment = await organizationAdminService.assignOrganizationAdmin({ organizationId, userId, changedBy, note });
  return success(res, { assignment }, 'Organization admin assigned');
});

const removeOrganizationAdmin = asyncHandler(async (req, res) => {
  const { userId, note } = req.body;
  const changedBy = req.session.user.id;
  const result = await organizationAdminService.removeAssignment({ userId, changedBy, note });
  return success(res, { result }, 'Organization admin removed');
});

// One level of the organization tree for the admin's expandable view. Lazy by
// level rather than serialising the whole hierarchy, so cost stays flat as the
// organization count grows. `id` omitted means the root's own level.
const getOrganizationTreeLevel = asyncHandler(async (req, res) => {
  const { id } = req.query;
  if (id) {
    const children = await organizationService.getChildrenForTree(Number(id));
    return success(res, { children });
  }
  const root = await organizationService.getRoot();
  if (!root) return success(res, { root: null, children: [] });
  const children = await organizationService.getChildrenForTree(root.id);
  const counts = await organizationService.getChildrenForTree(null);
  return success(res, { root: counts[0] || { id: root.id, name: root.name, type: root.type }, children });
});

// Creates directly beneath a chosen node — the "Add Child" action, where the
// parent is already known so the admin never has to hunt for it in a list.
const createChildOrganization = asyncHandler(async (req, res) => {
  const { parentId, name, type, code } = req.body;
  if (!parentId) return error(res, 'A parent organization is required', 400);
  const created = await organizationService.createOrganization({
    parentId: Number(parentId),
    name,
    type,
    code: code || null,
  });
  const pathLabel = await organizationService.getOrganizationPathLabel(created.id);
  return success(res, { organization: { id: created.id, name: created.name, type: created.type }, pathLabel }, 'Organization created');
});

// Permanent removal, and only ever for an organization with nothing attached —
// the service refuses if it has children, members, or past registrations, and
// points the admin at deactivation instead.
const deleteOrganizationApi = asyncHandler(async (req, res) => {
  await organizationService.deleteOrganization(Number(req.params.id));
  return success(res, { deleted: true }, 'Organization deleted');
});

// Retire or restore. The reversible option, and the correct one for anything
// that already has history behind it.
const setOrganizationActiveApi = asyncHandler(async (req, res) => {
  const isActive = req.body.isActive === true || req.body.isActive === 'true';
  const result = await organizationService.setOrganizationActive(Number(req.params.id), isActive);
  return success(res, result, isActive ? 'Organization reactivated' : 'Organization deactivated');
});

module.exports = { listUsers, listMembers, listOrganizationMembers, approveUser, rejectUser, updateUser, deleteUser, uploadLogo, getLogo, updateMembershipFee, updateGatewaySurchargePercent, getPaymentsEnabled, updatePaymentsEnabled, listSponsors, createSponsor, deleteSponsor, listOrganizationAdmins, assignOrganizationAdmin, removeOrganizationAdmin, getOrganizationTreeLevel, createChildOrganization, deleteOrganizationApi, setOrganizationActiveApi };
