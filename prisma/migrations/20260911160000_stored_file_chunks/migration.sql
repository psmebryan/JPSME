-- Uploaded files are stored in pieces.
--
-- The previous migration put the whole file in one LONGBLOB column, and its own
-- comment named the reason that could not work without noticing it: the cap
-- that actually bites is max_allowed_packet, not the column type. MySQL refuses
-- any single statement or result row larger than it, and MariaDB does not even
-- refuse politely — it closes the connection, so a 1.2 MB logo came back as a
-- bare 500 with no message. The default is 1 MB, and on the live host it is a
-- server setting we do not control.
--
-- One chunk per row makes the file's size irrelevant. Every statement carries
-- one chunk and every row returned holds one chunk, so the only thing that ever
-- has to fit inside a packet is a chunk. See CHUNK_SIZE in dbStorage.driver.js.
--
-- `stored_files.data` becomes nullable rather than being dropped: anything
-- written between the two migrations is still readable from it, and the driver
-- falls back to it when a file has no chunks.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
ALTER TABLE `stored_files` MODIFY `data` LONGBLOB NULL;

CREATE TABLE `stored_file_chunks` (
    `key` VARCHAR(255) NOT NULL,
    `seq` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,

    PRIMARY KEY (`key`, `seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `stored_file_chunks`
    ADD CONSTRAINT `stored_file_chunks_key_fkey`
    FOREIGN KEY (`key`) REFERENCES `stored_files`(`key`)
    ON DELETE CASCADE ON UPDATE CASCADE;
