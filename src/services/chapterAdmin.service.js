const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

async function getAssignmentByChapter(chapterId) {
  return prisma.chapterAdmin.findUnique({ where: { chapterId: Number(chapterId) }, include: { user: true, chapter: true } });
}

async function listAssignments() {
  return prisma.chapterAdmin.findMany({ include: { user: true, chapter: true } });
}

async function assignChapterAdmin({ chapterId, userId, changedBy, note, force }) {
  const chapter = await prisma.chapter.findUnique({ where: { id: Number(chapterId) } });
  if (!chapter) throw new AppError('Chapter not found', 404);

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) throw new AppError('User not found', 404);

  return prisma.$transaction(async (tx) => {
    const existingForChapter = await tx.chapterAdmin.findUnique({
      where: { chapterId: Number(chapterId) },
      include: { user: true },
    });

    // Block if chapter already has a DIFFERENT admin, unless caller explicitly confirms replacement
    if (existingForChapter && existingForChapter.userId !== Number(userId) && !force) {
      throw new AppError(
        `This chapter already has an admin (${existingForChapter.user.firstName} ${existingForChapter.user.lastName}). Remove them first or confirm replacement.`,
        409
      );
    }

    const existingForUser = await tx.chapterAdmin.findUnique({ where: { userId: Number(userId) } });

    let oldUserId = null;

    if (existingForChapter) {
      oldUserId = existingForChapter.userId;
      if (existingForChapter.userId !== Number(userId)) {
        await tx.user.update({ where: { id: existingForChapter.userId }, data: { role: 'USER', chapterId: null } });
      }
      await tx.chapterAdmin.delete({ where: { id: existingForChapter.id } });
    }

    if (existingForUser && existingForUser.chapterId !== Number(chapterId)) {
      await tx.chapterAdmin.delete({ where: { id: existingForUser.id } });
    }

    await tx.user.update({
      where: { id: Number(userId) },
      data: { role: 'CHAPTER_ADMIN', chapterId: Number(chapterId) },
    });

    const newAssign = await tx.chapterAdmin.create({
      data: { chapterId: Number(chapterId), userId: Number(userId) },
    });

    await tx.chapterAdminAudit.create({
      data: {
        chapterId: Number(chapterId),
        oldUserId,
        newUserId: Number(userId),
        changedBy: Number(changedBy),
        note: note || null,
      },
    });

    return newAssign;
  });
}

async function removeAssignment({ chapterId, changedBy, note }) {
  const existing = await prisma.chapterAdmin.findUnique({ where: { chapterId: Number(chapterId) } });
  if (!existing) throw new AppError('No chapter admin assigned', 404);

  // demote user
  await prisma.user.update({ where: { id: existing.userId }, data: { role: 'USER' } });

  // delete assignment
  await prisma.chapterAdmin.delete({ where: { id: existing.id } });

  // audit
  await prisma.chapterAdminAudit.create({ data: { chapterId: Number(chapterId), oldUserId: existing.userId, newUserId: null, changedBy: Number(changedBy), note: note || null } });

  return { removed: true };
}

module.exports = { getAssignmentByChapter, listAssignments, assignChapterAdmin, removeAssignment };