-- One-year membership validity. Set to paidAt + 1 year when a membership
-- payment is confirmed. NULL means never paid for, which is a normal state
-- since membership payment is optional — distinct from expired.
ALTER TABLE `User` ADD COLUMN `membershipExpiresAt` DATETIME(3) NULL;
CREATE INDEX `User_membershipExpiresAt_idx` ON `User`(`membershipExpiresAt`);
