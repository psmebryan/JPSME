-- Assigned seating, per event.
--
-- Optional and off by default: event.seatingEnabled is the only switch. A
-- general-admission seminar never sees a seat map and needs no configuration;
-- a convention turns it on and builds one. No code path differs between them.
--
-- Sections hang off a room rather than off the event directly. Seats are in a
-- place, and that place is the thing people are admitted to — so the seat map
-- and the occupancy board describe the same room instead of two parallel ideas
-- of where somebody is.
--
-- The live state of a seat lives on the seat row, not in seat_assignments.
-- Claiming a seat has to be one conditional UPDATE or two people tapping A15
-- at the same instant both get it; seat_assignments is the append-only log of
-- how the seat ended up where it did.
--
-- Table names: lower_case_table_names=1 here, and Event/EventRegistration/User
-- carry no @@map — so their tables are `event`, `eventregistration` and `user`,
-- not the pluralised names the mapped models use. Do not tidy the references.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.

-- Enum values go in before any code can write them: this server runs a
-- non-strict sql_mode, where an unrecognised value is silently truncated to ''
-- and only surfaces as "Value '' not found in enum" on a much later read.
ALTER TABLE `audit_logs`
    MODIFY `action` ENUM(
        'PAYMENT_CREATED','PAYMENT_PROCESSING','PAYMENT_SUCCEEDED','PAYMENT_FAILED',
        'WEBHOOK_RECEIVED','WEBHOOK_REJECTED','WEBHOOK_DUPLICATE','REFUND_REQUESTED',
        'REFUND_SUCCEEDED','REFUND_FAILED','UNAUTHORIZED_PAYMENT_ACCESS',
        'SUSPICIOUS_PAYMENT_MISMATCH','PAYMENT_RECONCILED','USER_STATUS_CHANGED',
        'AUTO_APPROVAL_FAILED','QR_GENERATED','QR_REGENERATED',
        'CHECKIN_ACCESS_GRANTED','CHECKIN_ACCESS_REVOKED','CHECKIN_UNDONE',
        'SEATING_UPDATED','SEAT_OVERRIDDEN',
        'USER_ROLE_CHANGED','ROOM_CREATED','ROOM_UPDATED','ROOM_DELETED',
        'ROOM_ATTENDANCE_OVERRIDDEN'
    ) NOT NULL;

ALTER TABLE `event` ADD COLUMN `seatingEnabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `seating_sections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `roomId` INTEGER NULL,
    `name` VARCHAR(191) NOT NULL,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `seating_sections_eventId_name_key`(`eventId`, `name`),
    INDEX `seating_sections_roomId_idx`(`roomId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `sectionId` INTEGER NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `rowLabel` VARCHAR(191) NULL,
    `number` INTEGER NULL,
    `type` ENUM('REGULAR','VIP','ACCESSIBLE','TABLE') NOT NULL DEFAULT 'REGULAR',
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `heldByRegistrationId` INTEGER NULL,
    `heldUntil` DATETIME(3) NULL,
    `assignedRegistrationId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    -- One registration can hold at most one seat anywhere. A registration
    -- belongs to exactly one event, so this is "one seat per person per event"
    -- enforced by the database rather than by remembering to check.
    UNIQUE INDEX `seats_assignedRegistrationId_key`(`assignedRegistrationId`),
    UNIQUE INDEX `seats_sectionId_label_key`(`sectionId`, `label`),
    INDEX `seats_sectionId_rowLabel_idx`(`sectionId`, `rowLabel`),
    INDEX `seats_heldUntil_idx`(`heldUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seat_assignments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `seatId` INTEGER NOT NULL,
    `registrationId` INTEGER NULL,
    `action` ENUM('HELD','HOLD_EXPIRED','ASSIGNED','RELEASED','BLOCKED','UNBLOCKED') NOT NULL,
    `actorId` INTEGER NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `notes` TEXT NULL,

    INDEX `seat_assignments_seatId_at_idx`(`seatId`, `at`),
    INDEX `seat_assignments_registrationId_idx`(`registrationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `seating_sections` ADD CONSTRAINT `seating_sections_eventId_fkey`
    FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seating_sections` ADD CONSTRAINT `seating_sections_roomId_fkey`
    FOREIGN KEY (`roomId`) REFERENCES `event_rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `seats` ADD CONSTRAINT `seats_sectionId_fkey`
    FOREIGN KEY (`sectionId`) REFERENCES `seating_sections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seats` ADD CONSTRAINT `seats_assignedRegistrationId_fkey`
    FOREIGN KEY (`assignedRegistrationId`) REFERENCES `eventregistration`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `seats` ADD CONSTRAINT `seats_heldByRegistrationId_fkey`
    FOREIGN KEY (`heldByRegistrationId`) REFERENCES `eventregistration`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `seat_assignments` ADD CONSTRAINT `seat_assignments_seatId_fkey`
    FOREIGN KEY (`seatId`) REFERENCES `seats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seat_assignments` ADD CONSTRAINT `seat_assignments_registrationId_fkey`
    FOREIGN KEY (`registrationId`) REFERENCES `eventregistration`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `seat_assignments` ADD CONSTRAINT `seat_assignments_actorId_fkey`
    FOREIGN KEY (`actorId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
