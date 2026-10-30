-- The National President role (admin -> Site Settings -> National President
-- access). A President signs in to the admin and can open only the modules
-- the main admin ticks; which ones is a site setting (presidentModules), not
-- stored here.
--
-- Only adds a value to the list, so every existing account keeps its role.
-- Guarded: runs only while PRESIDENT is missing, so a retry is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'role'
     AND COLUMN_TYPE LIKE '%PRESIDENT%') = 0,
  'ALTER TABLE `User` MODIFY `role` ENUM(''USER'', ''ADMIN'', ''CHAPTER_ADMIN'', ''PRESIDENT'') NOT NULL DEFAULT ''USER''',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
