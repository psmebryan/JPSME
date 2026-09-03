-- Adds MOTHER_ORG / ADMIN_REGION / PROVINCE / CITY to OrganizationType.
-- These are vocabulary only (see the enum's doc comment in schema.prisma) --
-- no row's parentId or ordering logic depends on which type it carries.
ALTER TABLE `organizations` MODIFY `type` ENUM('NATIONAL', 'MOTHER_ORG', 'REGION', 'ADMIN_REGION', 'PROVINCE', 'CITY', 'CLUSTER', 'CHAPTER', 'STUDENT_UNIT') NOT NULL;
