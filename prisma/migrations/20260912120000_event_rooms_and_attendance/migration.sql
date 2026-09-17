-- Rooms, sessions, and where each attendee currently is.
--
-- Event arrival check-in already exists and is unchanged. What this adds is the
-- layer below it: a person can arrive at the venue and then enter and leave a
-- hall repeatedly, and those are different facts. EventRegistration.checkedInAt
-- stays exactly what it is — the FIRST successful arrival, one-shot, the column
-- the scan hot path gates on. Room state lives in room_attendance instead.
--
-- event_check_ins.sessionId has existed since the check-in migration, reserved
-- for this and always null. It finally has a table to point at, so it becomes a
-- real foreign key here rather than a bare column.
--
-- The enum additions go in before any code can write them: this server runs a
-- non-strict sql_mode, where an unrecognised enum value is silently truncated
-- to '' on write and only surfaces as "Value '' not found in enum" on a later
-- read, a long way from the cause.
--
-- Table names: this server runs lower_case_table_names=1, and the Event and
-- EventRegistration models carry no @@map — so their tables are `event` and
-- `eventregistration`, not the pluralised names the mapped models use. The
-- foreign keys below reference the real names; do not tidy them.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.

-- New scan verdicts, and the administrative actions around rooms.
ALTER TABLE `event_check_ins`
    MODIFY `result` ENUM(
        'SUCCESS','ALREADY_CHECKED_IN','INVALID_QR','WRONG_EVENT','NOT_REGISTERED',
        'CANCELLED','UNPAID','REJECTED','UNDONE','ROOM_FULL','ROOM_CLOSED'
    ) NOT NULL;

ALTER TABLE `audit_logs`
    MODIFY `action` ENUM(
        'PAYMENT_CREATED','PAYMENT_PROCESSING','PAYMENT_SUCCEEDED','PAYMENT_FAILED',
        'WEBHOOK_RECEIVED','WEBHOOK_REJECTED','WEBHOOK_DUPLICATE','REFUND_REQUESTED',
        'REFUND_SUCCEEDED','REFUND_FAILED','UNAUTHORIZED_PAYMENT_ACCESS',
        'SUSPICIOUS_PAYMENT_MISMATCH','PAYMENT_RECONCILED','USER_STATUS_CHANGED',
        'AUTO_APPROVAL_FAILED','QR_GENERATED','QR_REGENERATED',
        'CHECKIN_ACCESS_GRANTED','CHECKIN_ACCESS_REVOKED','CHECKIN_UNDONE',
        'USER_ROLE_CHANGED','ROOM_CREATED','ROOM_UPDATED','ROOM_DELETED',
        'ROOM_ATTENDANCE_OVERRIDDEN'
    ) NOT NULL;

CREATE TABLE `event_rooms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `capacity` INTEGER NULL,
    `location` VARCHAR(191) NULL,
    `isOpen` BOOLEAN NOT NULL DEFAULT true,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `event_rooms_eventId_name_key`(`eventId`, `name`),
    INDEX `event_rooms_eventId_isOpen_idx`(`eventId`, `isOpen`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `event_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `roomId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `startTime` DATETIME(3) NULL,
    `endTime` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `event_sessions_eventId_startTime_idx`(`eventId`, `startTime`),
    INDEX `event_sessions_roomId_idx`(`roomId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per person per room. The unique key is what makes the conditional
-- UPDATE in roomScan() a safe decision-and-write in one statement.
CREATE TABLE `room_attendance` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `roomId` INTEGER NOT NULL,
    `eventRegistrationId` INTEGER NOT NULL,
    `state` ENUM('INSIDE','OUTSIDE') NOT NULL DEFAULT 'OUTSIDE',
    `firstEnteredAt` DATETIME(3) NULL,
    `lastEnteredAt` DATETIME(3) NULL,
    `lastExitedAt` DATETIME(3) NULL,
    `entryCount` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `room_attendance_roomId_eventRegistrationId_key`(`roomId`, `eventRegistrationId`),
    INDEX `room_attendance_roomId_state_idx`(`roomId`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `event_check_ins` ADD COLUMN `roomId` INTEGER NULL;
CREATE INDEX `event_check_ins_roomId_scannedAt_idx` ON `event_check_ins`(`roomId`, `scannedAt`);

ALTER TABLE `event_rooms` ADD CONSTRAINT `event_rooms_eventId_fkey`
    FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `event_sessions` ADD CONSTRAINT `event_sessions_eventId_fkey`
    FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `event_sessions` ADD CONSTRAINT `event_sessions_roomId_fkey`
    FOREIGN KEY (`roomId`) REFERENCES `event_rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `room_attendance` ADD CONSTRAINT `room_attendance_roomId_fkey`
    FOREIGN KEY (`roomId`) REFERENCES `event_rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `room_attendance` ADD CONSTRAINT `room_attendance_eventRegistrationId_fkey`
    FOREIGN KEY (`eventRegistrationId`) REFERENCES `eventregistration`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `event_check_ins` ADD CONSTRAINT `event_check_ins_roomId_fkey`
    FOREIGN KEY (`roomId`) REFERENCES `event_rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `event_check_ins` ADD CONSTRAINT `event_check_ins_sessionId_fkey`
    FOREIGN KEY (`sessionId`) REFERENCES `event_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
