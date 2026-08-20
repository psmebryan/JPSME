const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { toPublicUser } = require('./auth.service');
const mailService = require('./mail.service');
const auditService = require('./audit.service');
const sheetsSyncService = require('./sheetsSync.service');
const normalizeName = (value) => String(value || '').trim().toUpperCase();

async function listByStatus(status) {
  const where = status ? { status } : {};
  const users = await prisma.user.findMany({
    where: { ...where, role: { not: 'ADMIN' } },
    orderBy: { createdAt: 'desc' },
    include: { chapter: true },
  });
  return users.map(toPublicUser);
}

// The single choke point for every status transition, manual or automatic —
// admin.api.js's approve/reject buttons and payment.service.js's
// auto-approve-on-payment both call this, never touch User.status directly.
// That's what makes the audit trail below actually complete: every reason a
// status ever changes is forced through here, so there's nowhere to change
// it without leaving a record. `actorId` is the admin who clicked
// approve/reject (omitted — logged as null — for the automatic path, so the
// trail itself distinguishes "an admin did this" from "the system did this"
// without needing a separate flag). `reason`/`paymentId` give a human-usable
// answer to "why was this member approved?" without needing to cross-reference
// timestamps against the payments table by hand.
async function setStatus(userId, status, { actorId = null, reason = null, paymentId = null } = {}) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);
  if (user.role === 'ADMIN') throw new AppError('Cannot change status of an admin account', 400);

  const updated = await prisma.user.update({
    where: { id: Number(userId) },
    data: { status },
    include: { chapter: true },
  });

  // Skip logging a no-op "changed from X to X" (e.g. re-approving an
  // already-approved account) — only genuine transitions are meaningful here.
  if (user.status !== status) {
    await auditService.log({
      action: 'USER_STATUS_CHANGED',
      actorId,
      targetUserId: Number(userId),
      paymentId,
      metadata: { from: user.status, to: status, reason },
    });
  }

  // Only send on a genuine PENDING/REJECTED -> APPROVED transition, not a
  // redundant re-approval of an already-approved account.
  if (status === 'APPROVED' && user.status !== 'APPROVED') {
    mailService.sendMemberApprovedEmail(updated);
  }

  if (user.status !== status) {
    sheetsSyncService.syncMembership();
  }

  return toPublicUser(updated);
}

// For the audit-log page's "Actor" filter dropdown — only ADMIN-role users
// ever appear as an actorId on an audit entry, since every audited action
// (approve/reject, refund, reconcile) is already MAIN_ADMIN-only.
async function listAdmins() {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: { firstName: 'asc' },
  });
  return admins;
}

// List users by chapter (members)
async function listByChapter(chapterId) {
  const users = await prisma.user.findMany({
    where: { chapterId: Number(chapterId) },
    orderBy: { createdAt: 'desc' },
    include: { chapter: true },
  });
  return users.map(toPublicUser);
}

async function getById(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) }, include: { chapter: true } });
  if (!user) throw new AppError('User not found', 404);
  return toPublicUser(user);
}

async function updateUser(userId, data) {
  // Prevent promoting someone to ADMIN via chapter member edit
  if (data.role && data.role === 'ADMIN') {
    throw new AppError('Cannot assign ADMIN role via chapter member management', 403);
  }

  // Whitelist fields that may be updated via this function to avoid passing
  // extraneous form fields (e.g. _csrf) to Prisma.
  const allowed = {};

  if (Object.prototype.hasOwnProperty.call(data, 'firstName')) {
    allowed.firstName = data.firstName ? normalizeName(data.firstName) : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'lastName')) {
    allowed.lastName = data.lastName ? normalizeName(data.lastName) : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'middleInitial')) {
    allowed.middleInitial = data.middleInitial && String(data.middleInitial).trim() ? normalizeName(data.middleInitial) : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'phone')) {
    allowed.phone = data.phone && String(data.phone).trim() ? String(data.phone).trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'school')) {
    allowed.school = data.school && String(data.school).trim() ? String(data.school).trim() : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'role')) {
    // Only allow role changes to CHAPTER_ADMIN or USER here; ADMIN is blocked above.
    const roleVal = data.role;
    if (roleVal === 'CHAPTER_ADMIN' || roleVal === 'USER') allowed.role = roleVal;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'chapterId')) {
    if (data.chapterId === '' || data.chapterId === null || data.chapterId === undefined) {
      allowed.chapterId = null;
    } else {
      const val = Number(data.chapterId);
      if (Number.isNaN(val)) throw new AppError('Invalid chapter selection', 400);
      allowed.chapterId = val;
    }
  }

  const updated = await prisma.user.update({ where: { id: Number(userId) }, data: allowed, include: { chapter: true } });
  return toPublicUser(updated);
}

async function deleteUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);
  if (user.role === 'ADMIN') throw new AppError('Cannot delete ADMIN account', 400);
  await prisma.user.delete({ where: { id: Number(userId) } });
  return { deleted: true };
}

module.exports = { listByStatus, setStatus, listAdmins, listByChapter, getById, updateUser, deleteUser };
