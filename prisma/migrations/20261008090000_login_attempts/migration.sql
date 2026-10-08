-- Failed sign-ins, counted server-side so the login page can ask for the human
-- check after a few failures, per account and per address. Kept in the
-- database rather than in memory so the count survives a restart and is shared
-- by every instance of the app, and so clearing cookies does not reset it.
--
-- The email is stored only as a SHA-256 of its canonical form (emailKey): the
-- count needs to match repeats, not to know who they were. The audit log is
-- where an administrator reads which address was tried.
--
-- Rows older than a day are deleted as new ones are written, so the table stays
-- small. CREATE ... IF NOT EXISTS, so a retry after a partial run is harmless.

CREATE TABLE IF NOT EXISTS `login_attempts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `emailKey` VARCHAR(64) NOT NULL,
  `ip` VARCHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `login_attempts_emailKey_createdAt_idx`(`emailKey`, `createdAt`),
  INDEX `login_attempts_ip_createdAt_idx`(`ip`, `createdAt`),
  INDEX `login_attempts_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
