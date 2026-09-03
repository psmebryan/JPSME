-- DropForeignKey
ALTER TABLE `chapter_admin_audit` DROP FOREIGN KEY `chapter_admin_audit_changedBy_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_admin_audit` DROP FOREIGN KEY `chapter_admin_audit_chapterId_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_admin_audit` DROP FOREIGN KEY `chapter_admin_audit_newUserId_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_admin_audit` DROP FOREIGN KEY `chapter_admin_audit_oldUserId_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_admins` DROP FOREIGN KEY `chapter_admins_chapterId_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_admins` DROP FOREIGN KEY `chapter_admins_userId_fkey`;

-- DropForeignKey
ALTER TABLE `chapter_areas` DROP FOREIGN KEY `chapter_areas_regionId_fkey`;

-- DropForeignKey
ALTER TABLE `chapters` DROP FOREIGN KEY `chapters_areaId_fkey`;

-- DropForeignKey
ALTER TABLE `user` DROP FOREIGN KEY `User_chapterId_fkey`;

-- AlterTable
ALTER TABLE `eventregistration` ADD COLUMN `organizationId` INTEGER NULL,
    ADD COLUMN `organizationPath` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `user` DROP COLUMN `chapterId`,
    ADD COLUMN `organizationId` INTEGER NULL;

-- DropTable
DROP TABLE `chapter_admin_audit`;

-- DropTable
DROP TABLE `chapter_admins`;

-- DropTable
DROP TABLE `chapter_areas`;

-- DropTable
DROP TABLE `chapter_regions`;

-- DropTable
DROP TABLE `chapters`;

-- CreateTable
CREATE TABLE `organizations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NULL,
    `type` ENUM('NATIONAL', 'REGION', 'CLUSTER', 'CHAPTER', 'STUDENT_UNIT') NOT NULL,
    `parentId` INTEGER NULL,
    `path` VARCHAR(191) NOT NULL DEFAULT '/',
    `depth` INTEGER NOT NULL DEFAULT 0,
    `needsReview` BOOLEAN NOT NULL DEFAULT false,
    `importNote` TEXT NULL,
    `sourceSheet` VARCHAR(191) NULL,
    `institution` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `facebookUrl` VARCHAR(191) NULL,
    `subRegion` VARCHAR(191) NULL,
    `yearFounded` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizations_slug_key`(`slug`),
    INDEX `organizations_parentId_idx`(`parentId`),
    INDEX `organizations_type_idx`(`type`),
    INDEX `organizations_path_idx`(`path`),
    INDEX `organizations_needsReview_idx`(`needsReview`),
    INDEX `organizations_parentId_isActive_idx`(`parentId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_admins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `organizationId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `organization_admins_userId_key`(`userId`),
    INDEX `organization_admins_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organization_admin_audit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `organizationId` INTEGER NOT NULL,
    `oldUserId` INTEGER NULL,
    `newUserId` INTEGER NULL,
    `changedBy` INTEGER NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `note` VARCHAR(191) NULL,

    INDEX `organization_admin_audit_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `EventRegistration_organizationId_idx` ON `EventRegistration`(`organizationId`);

-- CreateIndex
CREATE INDEX `User_organizationId_idx` ON `User`(`organizationId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EventRegistration` ADD CONSTRAINT `EventRegistration_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admins` ADD CONSTRAINT `organization_admins_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admins` ADD CONSTRAINT `organization_admins_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admin_audit` ADD CONSTRAINT `organization_admin_audit_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admin_audit` ADD CONSTRAINT `organization_admin_audit_oldUserId_fkey` FOREIGN KEY (`oldUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admin_audit` ADD CONSTRAINT `organization_admin_audit_newUserId_fkey` FOREIGN KEY (`newUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organization_admin_audit` ADD CONSTRAINT `organization_admin_audit_changedBy_fkey` FOREIGN KEY (`changedBy`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

