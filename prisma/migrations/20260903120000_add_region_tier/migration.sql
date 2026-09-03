-- Adds the REGION tier between NATIONAL and PROVINCE.
-- LUZON / VISAYAS / MINDANAO / NCR are island groups, not provinces —
-- provinces sit beneath them — and only one NATIONAL root is allowed, so
-- there was previously no level they could occupy.
ALTER TABLE `organizations` MODIFY `type` ENUM('NATIONAL', 'REGION', 'PROVINCE', 'STUDENT_UNIT') NOT NULL;
