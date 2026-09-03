const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Replaces chapterAdmin.service.js. Two behavioural changes fall out of the
// hierarchy redesign:
//
//   1. An admin is assigned to an ORGANIZATION of any type, not only a
//      chapter — so a cluster or region can have its own admin, and their
//      authority covers that organization's whole subtree (resolved in
//      auth.middleware.js via Organization.path).
//   2. An organization may have more than one admin. The old model enforced
//      one-admin-per-chapter with a unique constraint on chapterId; only
//      userId stays unique now (a user administers at most one organization),
//      so `force` is no longer needed to replace an existing admin.

async function listAssignments() {
  return prisma.organizationAdmin.findMany({
    include: { user: true, organization: true },
    orderBy: { assignedAt: 'desc' },
  });
}

async function getAssignmentsByOrganization(organizationId) {
  return prisma.organizationAdmin.findMany({
    where: { organizationId: Number(organizationId) },
    include: { user: true, organization: true },
  });
}

async function assignOrganizationAdmin({ organizationId, userId, changedBy, note }) {
  const organization = await prisma.organization.findUnique({ where: { id: Number(organizationId) } });
  if (!organization) throw new AppError('Organization not found', 404);

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);
  if (user.role === 'ADMIN') {
    throw new AppError('This account is already a main admin and does not need an organization scope', 400);
  }

  return prisma.$transaction(async (tx) => {
    // A user administers at most one organization — moving them simply
    // replaces their previous assignment rather than erroring.
    const existingForUser = await tx.organizationAdmin.findUnique({ where: { userId: Number(userId) } });
    const previousOrganizationId = existingForUser ? existingForUser.organizationId : null;
    if (existingForUser) {
      await tx.organizationAdmin.delete({ where: { id: existingForUser.id } });
    }

    // Promoting also affiliates them with the organization they administer,
    // matching what the old chapter flow did.
    await tx.user.update({
      where: { id: Number(userId) },
      data: { role: 'CHAPTER_ADMIN', organizationId: Number(organizationId) },
    });

    const assignment = await tx.organizationAdmin.create({
      data: { organizationId: Number(organizationId), userId: Number(userId) },
    });

    await tx.organizationAdminAudit.create({
      data: {
        organizationId: Number(organizationId),
        oldUserId: null,
        newUserId: Number(userId),
        changedBy: Number(changedBy),
        note: note || (previousOrganizationId ? `Reassigned from organization ${previousOrganizationId}` : null),
      },
    });

    return assignment;
  });
}

// Removes one specific admin. Takes a userId rather than an organizationId
// because an organization may now have several admins — targeting by
// organization alone would be ambiguous.
async function removeAssignment({ userId, changedBy, note }) {
  const existing = await prisma.organizationAdmin.findUnique({ where: { userId: Number(userId) } });
  if (!existing) throw new AppError('This user does not administer an organization', 404);

  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: existing.userId }, data: { role: 'USER' } });
    await tx.organizationAdmin.delete({ where: { id: existing.id } });
    await tx.organizationAdminAudit.create({
      data: {
        organizationId: existing.organizationId,
        oldUserId: existing.userId,
        newUserId: null,
        changedBy: Number(changedBy),
        note: note || null,
      },
    });
    return { removed: true };
  });
}

module.exports = {
  listAssignments,
  getAssignmentsByOrganization,
  assignOrganizationAdmin,
  removeAssignment,
};
