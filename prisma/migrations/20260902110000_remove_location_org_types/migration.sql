-- Drops ADMIN_REGION / PROVINCE / CITY from OrganizationType.
-- These were added to let the tree express location-style levels
-- (Visayas -> Region VI -> Aklan -> Toledo), which turned out not to be
-- needed. No rows ever used them, so this narrows the enum without touching
-- data. REGION is deliberately kept: 18 organizations use it and it is part
-- of the official JPSME legend (MOTHER ORG / REGION / CLUSTER / CHAPTER /
-- STUDENT UNIT).
ALTER TABLE `organizations` MODIFY `type` ENUM('NATIONAL', 'MOTHER_ORG', 'REGION', 'CLUSTER', 'CHAPTER', 'STUDENT_UNIT') NOT NULL;
