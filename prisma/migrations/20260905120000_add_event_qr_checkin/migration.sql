-- Event-specific QR code + check-in system, phase 1 (schema only).
--
-- NOTE: "prisma migrate diff" also emitted a DROP TABLE for the `sessions` table
-- here. That table belongs to express-mysql-session, not Prisma, so it shows
-- up as drift on every diff; it was removed by hand. Running it would sign out
-- every logged-in user. Do not re-add it when regenerating this file.
--
-- All new columns are nullable and every new table is empty, so this migration
-- is additive: existing registrations keep working untouched and simply have no
-- QR until the phase 3 backfill assigns one.

-- AlterTable
ALTER TABLE `audit_logs` MODIFY `action` ENUM('PAYMENT_CREATED', 'PAYMENT_PROCESSING', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'WEBHOOK_RECEIVED', 'WEBHOOK_REJECTED', 'WEBHOOK_DUPLICATE', 'REFUND_REQUESTED', 'REFUND_SUCCEEDED', 'REFUND_FAILED', 'UNAUTHORIZED_PAYMENT_ACCESS', 'SUSPICIOUS_PAYMENT_MISMATCH', 'PAYMENT_RECONCILED', 'USER_STATUS_CHANGED', 'AUTO_APPROVAL_FAILED', 'QR_GENERATED', 'QR_REGENERATED', 'CHECKIN_ACCESS_GRANTED', 'CHECKIN_ACCESS_REVOKED') NOT NULL;

-- AlterTable
ALTER TABLE `eventregistration` ADD COLUMN `checkedInAt` DATETIME(3) NULL,
    ADD COLUMN `qrGeneratedAt` DATETIME(3) NULL,
    ADD COLUMN `qrToken` VARCHAR(191) NULL,
    ADD COLUMN `registrationNumber` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `event_check_ins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventRegistrationId` INTEGER NULL,
    `eventId` INTEGER NOT NULL,
    `sessionId` INTEGER NULL,
    `scannedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `scannedBy` INTEGER NULL,
    `scannerIdentifier` VARCHAR(191) NULL,
    `action` ENUM('CHECK_IN', 'CHECK_OUT', 'MANUAL_CHECK_IN') NOT NULL DEFAULT 'CHECK_IN',
    `result` ENUM('SUCCESS', 'ALREADY_CHECKED_IN', 'INVALID_QR', 'WRONG_EVENT', 'NOT_REGISTERED', 'CANCELLED', 'UNPAID', 'REJECTED') NOT NULL,
    `ipAddress` VARCHAR(191) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `event_check_ins_eventRegistrationId_idx`(`eventRegistrationId`),
    INDEX `event_check_ins_eventId_scannedAt_idx`(`eventId`, `scannedAt`),
    INDEX `event_check_ins_eventId_result_idx`(`eventId`, `result`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_check_in_staff` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `grantedBy` INTEGER NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `revokedBy` INTEGER NULL,

    INDEX `event_check_in_staff_userId_idx`(`userId`),
    UNIQUE INDEX `event_check_in_staff_eventId_userId_key`(`eventId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `EventRegistration_registrationNumber_key` ON `EventRegistration`(`registrationNumber`);

-- CreateIndex
CREATE UNIQUE INDEX `EventRegistration_qrToken_key` ON `EventRegistration`(`qrToken`);

-- AddForeignKey
ALTER TABLE `event_check_ins` ADD CONSTRAINT `event_check_ins_eventRegistrationId_fkey` FOREIGN KEY (`eventRegistrationId`) REFERENCES `EventRegistration`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_ins` ADD CONSTRAINT `event_check_ins_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_ins` ADD CONSTRAINT `event_check_ins_scannedBy_fkey` FOREIGN KEY (`scannedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_in_staff` ADD CONSTRAINT `event_check_in_staff_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_in_staff` ADD CONSTRAINT `event_check_in_staff_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_in_staff` ADD CONSTRAINT `event_check_in_staff_grantedBy_fkey` FOREIGN KEY (`grantedBy`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_check_in_staff` ADD CONSTRAINT `event_check_in_staff_revokedBy_fkey` FOREIGN KEY (`revokedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

