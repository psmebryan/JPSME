-- A verdict for the same ticket presented twice at the same door.
--
-- The room door decides direction from where the person currently is, which is
-- what makes it one button — and also means a repeat scan does the OPPOSITE of
-- the first. A scanner gun that double-fires, or staff re-scanning because they
-- were not sure the first one took, marked somebody as having left the hall
-- they were walking into. Both scans were genuine entries in an append-only
-- log, so nothing could be recovered afterwards.
--
-- The window itself is CHECKIN_DUPLICATE_WINDOW_MS (see src/config). This is
-- only the value the refusal is recorded under, which is deliberately its own
-- rather than folded into ALREADY_CHECKED_IN: that one means "this person is
-- already admitted", and this one means "nothing happened, try again in a
-- moment". Counting them together would hide a scanner misbehaving all morning.
--
-- The enum value goes in before any code can write it: this server runs a
-- non-strict sql_mode, where an unrecognised value is silently truncated to ''
-- and only surfaces as "Value '' not found in enum" on a much later read.
--
-- Written by hand rather than generated: "prisma migrate diff" also emits a
-- DROP TABLE for `sessions` (owned by express-mysql-session, so it reads as
-- drift on every diff), and running that would sign out every logged-in user.
ALTER TABLE `event_check_ins`
    MODIFY `result` ENUM(
        'SUCCESS','ALREADY_CHECKED_IN','INVALID_QR','WRONG_EVENT','NOT_REGISTERED',
        'CANCELLED','UNPAID','REJECTED','UNDONE','ROOM_FULL','ROOM_CLOSED','DUPLICATE_SCAN'
    ) NOT NULL;
