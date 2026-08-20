/*
  Warnings:

  - Added the required column `middleInitial` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `user` ADD COLUMN `middleInitial` VARCHAR(191) NOT NULL;
