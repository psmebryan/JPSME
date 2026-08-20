-- AlterTable
ALTER TABLE `user` MODIFY `role` ENUM('USER', 'ADMIN', 'CHAPTER_ADMIN') NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE `chapter_admins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chapterId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `chapter_admins_chapterId_key`(`chapterId`),
    UNIQUE INDEX `chapter_admins_userId_key`(`userId`),
    INDEX `chapter_admins_chapterId_idx`(`chapterId`),
    INDEX `chapter_admins_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chapter_admin_audit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chapterId` INTEGER NOT NULL,
    `oldUserId` INTEGER NULL,
    `newUserId` INTEGER NULL,
    `changedBy` INTEGER NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `chapter_admins` ADD CONSTRAINT `chapter_admins_chapterId_fkey` FOREIGN KEY (`chapterId`) REFERENCES `chapters`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chapter_admins` ADD CONSTRAINT `chapter_admins_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chapter_admin_audit` ADD CONSTRAINT `chapter_admin_audit_chapterId_fkey` FOREIGN KEY (`chapterId`) REFERENCES `chapters`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chapter_admin_audit` ADD CONSTRAINT `chapter_admin_audit_oldUserId_fkey` FOREIGN KEY (`oldUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chapter_admin_audit` ADD CONSTRAINT `chapter_admin_audit_newUserId_fkey` FOREIGN KEY (`newUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chapter_admin_audit` ADD CONSTRAINT `chapter_admin_audit_changedBy_fkey` FOREIGN KEY (`changedBy`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
