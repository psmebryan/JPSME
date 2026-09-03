-- Year level for student members. Nullable: members attached above
-- student-unit level (chapter or cluster officers) are not studying a year.
ALTER TABLE `user` ADD COLUMN `yearLevel` ENUM('FIRST', 'SECOND', 'THIRD', 'FOURTH') NULL;
