-- Splits the one approval email into two.
--
-- MEMBER_APPROVED now means what it says: sent when a membership payment is
-- confirmed, and the only message allowed to tell somebody they are a member.
-- ACCOUNT_APPROVED is the new one, sent when an admin approves the account
-- itself -- true of a non-member too, since approval and membership are
-- different things.
--
-- One enum value, no data change. Existing MEMBER_APPROVED rows keep their
-- wording and their attachment; the new template is created on first read with
-- its own default text (see emailTemplate.service).
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
ALTER TABLE `email_templates` MODIFY `purpose` ENUM(
  'MEMBER_APPROVED',
  'ACCOUNT_APPROVED',
  'EVENT_REGISTRATION',
  'EVENT_INVITATION'
) NOT NULL;
