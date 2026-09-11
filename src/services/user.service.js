const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { toPublicUser } = require('./auth.service');
const mailService = require('./mail.service');
const auditService = require('./audit.service');
const sheetsSyncService = require('./sheetsSync.service');
const organizationService = require('./organization.service');
const normalizeName = (value) => String(value || '').trim().toUpperCase();

// `status` takes one value or several. Several matters for the invitation
// picker, which needs approved and pending accounts together: approval is an
// admin's own to-do list, not a fact about the person, and somebody who has
// paid in full is still PENDING until that button is pressed.
async function listByStatus(status) {
  const where = status
    ? { status: Array.isArray(status) ? { in: status } : status }
    : {};
  const users = await prisma.user.findMany({
    where: { ...where, role: { not: 'ADMIN' } },
    orderBy: { createdAt: 'desc' },
    include: { organization: true },
  });
  return users.map(toPublicUser);
}

// Paginated + searchable listing for the admin "Manage Users" table — the
// full member roster, which is the one place in the app most likely to
// actually reach thousands of rows. Deliberately separate from
// listByStatus() above, which stays unbounded on purpose: it also backs the
// invitation member-picker and a few other small internal lookups that need
// every matching row at once, not a page of them.
// `organizationIds` is a subtree (from req.orgScope.descendantIds), not a
// single id — a scoped admin sees their own organization AND everything
// beneath it. `organizationId` alone filters to exactly one organization,
// which is what the admin's filter dropdown passes.
async function listMembersForAdmin({
  status, organizationId, organizationIds, search, membership, paymentStatus, page = 1, pageSize = 25,
} = {}) {
  const where = { role: { not: 'ADMIN' } };
  if (status) where.status = status;

  // Membership is derived from membershipExpiresAt rather than stored, so the
  // filter has to express the same comparison the badge does: inside its year
  // is a Member, everything else — never paid or lapsed — is not. LAPSED and
  // NEVER split the Non-Member case, since "used to be a member" and "never
  // joined" call for very different follow-up.
  const now = new Date();
  if (membership === 'MEMBER') where.membershipExpiresAt = { gt: now };
  else if (membership === 'NON_MEMBER') {
    // Pushed onto AND rather than assigned to where.OR: the name/email search
    // below also uses OR, and assigning here would let whichever ran last
    // silently discard the other's filter.
    where.AND = [
      ...(where.AND || []),
      { OR: [{ membershipExpiresAt: null }, { membershipExpiresAt: { lte: now } }] },
    ];
  } else if (membership === 'LAPSED') where.membershipExpiresAt = { lte: now };
  else if (membership === 'NEVER') where.membershipExpiresAt = null;

  // Payment filters on the membership fee specifically, not event fees.
  //
  // UNPAID means "no membership payment on file at all", which is exactly what
  // the Unpaid badge in the table means. It deliberately does NOT mean "no
  // successful payment": someone whose payment failed shows a Failed badge, so
  // sweeping them into Unpaid would make the filter disagree with the column
  // it is filtering. Use the FAILED option to find those.
  //
  // Note this is a different question from membership=NEVER — a member whose
  // year lapsed still has a PAID payment on file.
  if (paymentStatus === 'UNPAID') {
    where.payments = { none: { purpose: 'MEMBERSHIP_REGISTRATION' } };
  } else if (paymentStatus) {
    where.payments = { some: { purpose: 'MEMBERSHIP_REGISTRATION', status: paymentStatus } };
  }
  if (Array.isArray(organizationIds)) where.organizationId = { in: organizationIds };
  else if (organizationId) where.organizationId = Number(organizationId);
  const term = (search || '').trim();
  if (term) {
    where.OR = [
      { firstName: { contains: term } },
      { lastName: { contains: term } },
      { email: { contains: term } },
    ];
  }

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { organization: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    users: users.map(toPublicUser),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
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
    include: { organization: true },
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
  //
  // And never to an address that has not been verified yet. An unverified
  // account still appears in the approvals queue, so an admin can approve one
  // without realising — and the result was two contradictory emails: "here is
  // your verification code" followed by "your membership has been approved",
  // while logging in still answered "please verify your email address first".
  //
  // The approval itself stands; it is only the email that waits. Verifying
  // sends it (see emailVerification.service), which is the first moment the
  // message is both true and deliverable to an address we know they own.
  if (status === 'APPROVED' && user.status !== 'APPROVED' && updated.emailVerifiedAt) {
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

// Members of an organization SUBTREE — the organization itself plus every
// descendant. Replaces listByChapter(), which could only ever match one exact
// chapter; a cluster admin now correctly sees members of the chapters and
// student units beneath them.
async function listByOrganization(organizationId, { includeDescendants = true } = {}) {
  const where = includeDescendants
    ? { organizationId: { in: await organizationService.getDescendantIds(organizationId) } }
    : { organizationId: Number(organizationId) };
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { organization: true },
  });
  return users.map(toPublicUser);
}

async function getById(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) }, include: { organization: true } });
  if (!user) throw new AppError('User not found', 404);
  return toPublicUser(user);
}

// `allowAdminRole` is passed only by the controller path a full admin reaches,
// never by the chapter-scoped one. Defaulting it to false keeps the original
// guarantee — a chapter admin cannot mint an ADMIN, whatever they post — while
// letting the person who already holds the role hand it to someone else, which
// previously required a database they cannot reach.
async function updateUser(userId, data, { allowAdminRole = false, actorId = null } = {}) {
  const target = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { id: true, role: true, email: true },
  });
  if (!target) throw new AppError('User not found', 404);

  const wantsAdmin = data.role === 'ADMIN';
  if (wantsAdmin && !allowAdminRole) {
    throw new AppError('Cannot assign ADMIN role via chapter member management', 403);
  }

  const losesAdmin = target.role === 'ADMIN' && data.role && data.role !== 'ADMIN';

  // Two ways to lock everyone out of the admin panel, both easy to do by
  // accident and neither recoverable from inside the app — the role can only
  // be restored by an admin, and there would be none.
  if (losesAdmin) {
    if (actorId && Number(actorId) === target.id) {
      throw new AppError('You cannot remove your own administrator role. Ask another admin to do it.', 400);
    }
    const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (admins <= 1) {
      throw new AppError('This is the only administrator account — promote someone else first.', 400);
    }
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
  if (Object.prototype.hasOwnProperty.call(data, 'yearLevel')) {
    // Empty clears it — members above student-unit level have no year.
    const yl = data.yearLevel;
    allowed.yearLevel = ['FIRST', 'SECOND', 'THIRD', 'FOURTH'].includes(yl) ? yl : null;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'role')) {
    const roleVal = data.role;
    const assignable = allowAdminRole
      ? ['ADMIN', 'CHAPTER_ADMIN', 'USER']
      : ['CHAPTER_ADMIN', 'USER'];
    if (assignable.includes(roleVal)) allowed.role = roleVal;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'organizationId')) {
    if (data.organizationId === '' || data.organizationId === null || data.organizationId === undefined) {
      allowed.organizationId = null;
    } else {
      const val = Number(data.organizationId);
      if (Number.isNaN(val)) throw new AppError('Invalid organization selection', 400);
      allowed.organizationId = val;
    }
  }

  const updated = await prisma.user.update({ where: { id: Number(userId) }, data: allowed, include: { organization: true } });

  // Logged after the write, so nothing claims a change that did not happen.
  // Awaited rather than fired and forgotten: granting ADMIN hands over every
  // member's personal details and the entire payment history, and an audit
  // trail that silently drops the one entry that matters is worse than none.
  if (allowed.role && allowed.role !== target.role) {
    await auditService.log({
      action: 'USER_ROLE_CHANGED',
      actorId,
      targetUserId: target.id,
      metadata: { from: target.role, to: allowed.role, email: target.email },
    });
  }

  return toPublicUser(updated);
}

async function deleteUser(userId) {
  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);
  if (user.role === 'ADMIN') throw new AppError('Cannot delete ADMIN account', 400);
  await prisma.user.delete({ where: { id: Number(userId) } });
  return { deleted: true };
}

module.exports = { listByStatus, listMembersForAdmin, setStatus, listAdmins, listByOrganization, getById, updateUser, deleteUser };
