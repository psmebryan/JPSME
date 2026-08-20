/*
  Warnings:

  - You are about to drop the column `isActive` on the `event` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `event` DROP COLUMN `isActive`,
    ADD COLUMN `featured` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `imageUrl` VARCHAR(191) NULL,
    ADD COLUMN `isPublished` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `modality` ENUM('FACE_TO_FACE', 'ONLINE') NOT NULL DEFAULT 'FACE_TO_FACE';
