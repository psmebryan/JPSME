-- Email verification moves from a clicked link to a typed six-digit code.
--
-- tokenHash is dropped rather than migrated: it held a 256-bit link token, and
-- there is no way to turn one into a code anybody knows. Verified against the
-- live database first - zero rows outstanding - so nobody is stranded mid-
-- signup by this. Anyone who somehow is simply requests a new code.
--
-- NOTE: "prisma migrate diff" also emitted a DROP TABLE for the `sessions` table
-- here. That table belongs to express-mysql-session, not Prisma, so it shows
-- up as drift on every diff; removed by hand. Running it would sign out every
-- logged-in user. Do not re-add it when regenerating this file.

-- DropIndex
DROP INDEX `EmailVerificationToken_tokenHash_key` ON `emailverificationtoken`;

-- AlterTable
ALTER TABLE `emailverificationtoken` DROP COLUMN `tokenHash`,
    ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `codeHash` VARCHAR(191) NOT NULL;


