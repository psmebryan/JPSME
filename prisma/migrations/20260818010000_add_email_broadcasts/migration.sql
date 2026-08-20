
-- CreateTable
CREATE TABLE `email_broadcasts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `subject` VARCHAR(191) NOT NULL,
    `bodyHtml` TEXT NOT NULL,
    `attachmentImage` VARCHAR(191) NULL,
    `audienceFilter` TEXT NOT NULL,
    `totalRecipients` INTEGER NOT NULL DEFAULT 0,
    `sentCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `failedEmails` TEXT NULL,
    `status` ENUM('PENDING', 'SENDING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `createdBy` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `email_broadcasts` ADD CONSTRAINT `email_broadcasts_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

