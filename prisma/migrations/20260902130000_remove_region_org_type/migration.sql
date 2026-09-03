-- Drops REGION from OrganizationType.
-- The 18 sub-region rows that used it (Central NCR, Northern LUZON, ...) were
-- synthesized by the importer from the workbook's REGION column keyword rather
-- than being real JPSME bodies, and have been removed with their children
-- lifted to the mother org above them. The level is now unused, so the tree is
-- National -> Mother Org -> Cluster / Chapter -> Student Unit, with levels
-- still skippable as before.
ALTER TABLE `organizations` MODIFY `type` ENUM('NATIONAL', 'MOTHER_ORG', 'CLUSTER', 'CHAPTER', 'STUDENT_UNIT') NOT NULL;
