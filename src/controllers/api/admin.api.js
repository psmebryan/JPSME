const asyncHandler = require('../../utils/asyncHandler');
const { success, error } = require('../../utils/apiResponse');
const userService = require('../../services/user.service');
const settingsService = require('../../services/settings.service');
const sponsorService = require('../../services/sponsor.service');
const paymentService = require('../../services/payment.service');

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

const listChapterMembers = asyncHandler(async (req, res) => {
  // If apiAdminOrChapterAdmin is used, controller can check req.chapterScope
  const chapterId = req.query.chapterId || req.chapterScope;
  if (!chapterId) {
    // admin: no chapterId provided -> list all chapters members grouped? We'll return all users if admin
    if (req.session.user && req.session.user.role === 'ADMIN') {
      const users = await userService.listByStatus();
      return success(res, { users });
    }
    return error(res, 'Chapter id required', 400);
  }
  const users = await userService.listByChapter(chapterId);
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

  if (req.chapterScope) {
    const target = await userService.getById(userId);
    if (target.chapterId !== req.chapterScope) return error(res, 'Access denied', 403);

    // Chapter admins may only touch these fields on their own members —
    // never email, role, or chapterId, even if sent directly to the API.
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
  if (req.chapterScope) {
    const target = await userService.getById(userId);
    const targetChapterId = target.chapterId ?? (target.chapter && target.chapter.id);
    if (Number(targetChapterId) !== Number(req.chapterScope)) return error(res, 'Access denied', 403);
  }
  const result = await userService.deleteUser(userId);
  return success(res, { result }, 'User deleted');
});

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) return error(res, 'No logo file uploaded', 400);

  const publicPath = `/uploads/logo/${req.file.filename}`;
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
  const sponsor = await sponsorService.createSponsor({
    name,
    logoUrl: `/uploads/sponsors/${req.file.filename}`,
    websiteUrl: (req.body.websiteUrl || '').trim(),
  });
  return success(res, { sponsor }, 'Sponsor added', 201);
});

const deleteSponsor = asyncHandler(async (req, res) => {
  await sponsorService.deleteSponsor(req.params.id);
  return success(res, null, 'Sponsor removed');
});

// Chapter admin assignments
const listChapterAdmins = asyncHandler(async (req, res) => {
  const assignments = await require('../../services/chapterAdmin.service').listAssignments();
  return success(res, { assignments });
});

const assignChapterAdmin = asyncHandler(async (req, res) => {
  const { chapterId, userId, note, force } = req.body;
  const changedBy = req.session.user.id;
  const assignment = await require('../../services/chapterAdmin.service').assignChapterAdmin({ chapterId, userId, changedBy, note, force });
  return success(res, { assignment }, 'Chapter admin assigned');
});

const removeChapterAdmin = asyncHandler(async (req, res) => {
  const { chapterId, note } = req.body;
  const changedBy = req.session.user.id;
  const result = await require('../../services/chapterAdmin.service').removeAssignment({ chapterId, changedBy, note });
  return success(res, { result }, 'Chapter admin removed');
});

module.exports = { listUsers, listChapterMembers, approveUser, rejectUser, updateUser, deleteUser, uploadLogo, getLogo, updateMembershipFee, updateGatewaySurchargePercent, getPaymentsEnabled, updatePaymentsEnabled, listSponsors, createSponsor, deleteSponsor, listChapterAdmins, assignChapterAdmin, removeChapterAdmin };
