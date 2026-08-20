-- AlterTable
ALTER TABLE `user` ADD COLUMN `chapterId` INTEGER NULL,
    ADD COLUMN `profileImage` VARCHAR(191) NULL,
    MODIFY `middleInitial` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `User_chapterId_idx` ON `User`(`chapterId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_chapterId_fkey` FOREIGN KEY (`chapterId`) REFERENCES `chapters`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
