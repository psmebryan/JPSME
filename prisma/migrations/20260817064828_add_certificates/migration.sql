-- CreateTable
CREATE TABLE `certificate_templates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('MEMBERSHIP', 'EVENT') NOT NULL,
    `eventId` INTEGER NULL,
    `backgroundImage` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL DEFAULT 'Certificate',
    `bodyText` TEXT NOT NULL,
    `textColor` VARCHAR(191) NOT NULL DEFAULT '#1a1a2e',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `certificate_templates_eventId_key`(`eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_certificates` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `filePath` VARCHAR(191) NOT NULL,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `generatedBy` INTEGER NOT NULL,

    UNIQUE INDEX `event_certificates_eventId_userId_key`(`eventId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `certificate_templates` ADD CONSTRAINT `certificate_templates_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_certificates` ADD CONSTRAINT `event_certificates_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_certificates` ADD CONSTRAINT `event_certificates_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
