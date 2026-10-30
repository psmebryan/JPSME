-- Who may pick an event fee option (Master List -> Event Fee).
--
--   event_fee_options.audience
--     EVERYONE     anyone registering (the default, as before)
--     MEMBERS      only someone whose membership is active
--     NON_MEMBERS  only someone without an active membership
--
-- So an event can charge members PHP 300 and everyone else PHP 800. Checked by
-- the server when registering, not only hidden on the page.
--
-- Guarded so a retry after a partial run is harmless.

SET @migration_sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event_fee_options' AND COLUMN_NAME = 'audience') = 0,
  'ALTER TABLE `event_fee_options` ADD COLUMN `audience` VARCHAR(12) NOT NULL DEFAULT ''EVERYONE''',
  'SELECT 1'
);
PREPARE migration_stmt FROM @migration_sql; EXECUTE migration_stmt; DEALLOCATE PREPARE migration_stmt;
