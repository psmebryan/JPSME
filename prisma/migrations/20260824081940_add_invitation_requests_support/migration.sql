-- AlterTable
ALTER TABLE `email_templates` MODIFY `purpose` ENUM('MEMBER_APPROVED', 'EVENT_REGISTRATION', 'EVENT_INVITATION') NOT NULL;

-- AlterTable
ALTER TABLE `event_invitations` ADD COLUMN `company` VARCHAR(191) NULL;

-- CreateIndex (must exist before dropping the old one — MySQL requires some
-- index to remain backing the eventId foreign key at all times; the new
-- composite index has eventId as its leading column, so it can take over)
CREATE UNIQUE INDEX `email_templates_eventId_purpose_key` ON `email_templates`(`eventId`, `purpose`);

-- DropIndex
DROP INDEX `email_templates_eventId_key` ON `email_templates`;
