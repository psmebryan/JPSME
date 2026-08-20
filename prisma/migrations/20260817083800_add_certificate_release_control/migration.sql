-- AlterTable
ALTER TABLE `event_certificates` ADD COLUMN `released` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `releasedAt` DATETIME(3) NULL,
    ADD COLUMN `releasedBy` INTEGER NULL;
