-- Collapses the hierarchy to National -> Province -> Student Unit.
--
-- The MOTHER_ORG / CLUSTER / CHAPTER levels are removed. Cluster and chapter
-- rows were deleted (their children and members lifted to the parent first, so
-- nothing was orphaned); the four mother orgs were reclassified as PROVINCE and
-- keep all 154 student units attached beneath them.
ALTER TABLE `organizations` MODIFY `type` ENUM('NATIONAL', 'PROVINCE', 'STUDENT_UNIT') NOT NULL;
