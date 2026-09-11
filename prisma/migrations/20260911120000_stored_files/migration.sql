-- Uploaded files move into the database.
--
-- The host wipes the filesystem on every deploy, so a logo uploaded through the
-- admin panel lasted until the next publish and then 404'd on every page. The
-- site logo and every sponsor image were already in that state.
--
-- LONGBLOB rather than BLOB (64KB) or MEDIUMBLOB (16MB): the cap that actually
-- bites is MySQL's max_allowed_packet, not the column type, and there is no
-- cost to the larger declaration since storage is per-row actual length.
--
-- `key` keeps the exact identifier the filesystem driver used as a path, so no
-- existing row storing "/uploads/logo/..." needs rewriting.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
CREATE TABLE `stored_files` (
    `key` VARCHAR(255) NOT NULL,
    `mimeType` VARCHAR(127) NOT NULL,
    `size` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stored_files_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
