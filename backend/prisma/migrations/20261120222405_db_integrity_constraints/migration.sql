-- Phase M — database integrity constraints (CHECK only; no existing migration edited).
--
-- Prisma generated this migration as empty because CHECK constraints cannot be
-- expressed in schema.prisma. The SQL below is the reviewed, SQL-only part of
-- this migration. No native PostgreSQL enum is added: every string status below
-- stays a TEXT column with a CHECK-in-list, so the allowed set can be evolved by
-- a future reviewed migration without ALTER TYPE / Prisma enum churn.
--
-- Already enforced by 20261026085618_init and deliberately NOT duplicated here:
--   * Charge/Payment/Refund/Expense/PaymentAllocation amountMinor > 0
--   * Appointment doctor overlap exclusion (appointment_no_doctor_overlap)
--   * all existing unique indexes and foreign keys
--
-- Every new constraint is added NOT VALID and then VALIDATED in this same
-- transaction. On a non-empty database with an offending row, VALIDATE fails,
-- the transaction rolls back, and no partial constraint is left behind.
--
-- Rollback: see backend/prisma/migrations/20261120222405_db_integrity_constraints/rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Status / kind allow-lists (CHECK-in-list, not native enums)
-- ---------------------------------------------------------------------------

ALTER TABLE "Charge" ADD CONSTRAINT "Charge_status_allowed"
  CHECK ("status" IN ('OPEN', 'SETTLED', 'VOID')) NOT VALID;

ALTER TABLE "Charge" ADD CONSTRAINT "Charge_void_fields_consistent"
  CHECK (
    ("status" = 'VOID' AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)
    OR ("status" <> 'VOID' AND "voidedAt" IS NULL AND "voidReason" IS NULL)
  ) NOT VALID;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_status_allowed"
  CHECK ("status" IN ('RECORDED', 'VOID')) NOT VALID;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_void_fields_consistent"
  CHECK (
    ("status" = 'VOID' AND "voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL)
    OR ("status" <> 'VOID' AND "voidedAt" IS NULL AND "voidReason" IS NULL)
  ) NOT VALID;

-- No application writer exists yet for ReportUpdateRequest; the allowed set is
-- the schema default OPEN plus the RESOLVED lifecycle implied by resolvedAt.
ALTER TABLE "ReportUpdateRequest" ADD CONSTRAINT "ReportUpdateRequest_status_allowed"
  CHECK ("status" IN ('OPEN', 'RESOLVED')) NOT VALID;

ALTER TABLE "ReportUpdateRequest" ADD CONSTRAINT "ReportUpdateRequest_resolved_fields_consistent"
  CHECK ("resolvedAt" IS NULL OR "status" = 'RESOLVED') NOT VALID;

-- The only application writer hard-codes CLINICAL. Other kinds would require a
-- reviewed migration before they can be persisted.
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_kind_allowed"
  CHECK ("kind" IN ('CLINICAL')) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Numeric ranges
-- ---------------------------------------------------------------------------

-- priceMinor = 0 is legitimate (free service); duration must be positive.
ALTER TABLE "Service" ADD CONSTRAINT "Service_price_nonnegative"
  CHECK ("priceMinor" >= 0) NOT VALID;

ALTER TABLE "Service" ADD CONSTRAINT "Service_duration_positive"
  CHECK ("durationMinutes" > 0) NOT VALID;

ALTER TABLE "ClinicSettings" ADD CONSTRAINT "ClinicSettings_appointment_minutes_positive"
  CHECK ("defaultAppointmentMinutes" > 0) NOT VALID;

ALTER TABLE "ClinicSettings" ADD CONSTRAINT "ClinicSettings_slot_interval_positive"
  CHECK ("slotIntervalMinutes" > 0) NOT VALID;

-- MIME sniffing rejects buffers shorter than 12 bytes, so zero is never written.
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_size_positive"
  CHECK ("sizeBytes" > 0) NOT VALID;

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_duration_positive"
  CHECK ("durationMinutes" > 0) NOT VALID;

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_end_after_start"
  CHECK ("endAt" > "startAt") NOT VALID;

ALTER TABLE "Report" ADD CONSTRAINT "Report_version_positive"
  CHECK ("versionNumber" > 0) NOT VALID;

ALTER TABLE "ReportVersion" ADD CONSTRAINT "ReportVersion_version_positive"
  CHECK ("versionNumber" > 0) NOT VALID;

ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_version_positive"
  CHECK ("versionNumber" > 0) NOT VALID;

-- Every writer sets attempts = 1 or increments it; default 0 is never persisted.
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_attempts_positive"
  CHECK ("attempts" >= 1) NOT VALID;

ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_position_positive"
  CHECK ("position" IS NULL OR "position" > 0) NOT VALID;

ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_timestamp_order"
  CHECK (
    ("arrivedAt" IS NULL OR "calledAt" IS NULL OR "arrivedAt" <= "calledAt")
    AND ("calledAt" IS NULL OR "examStartedAt" IS NULL OR "calledAt" <= "examStartedAt")
    AND ("examStartedAt" IS NULL OR "examEndedAt" IS NULL OR "examStartedAt" <= "examEndedAt")
  ) NOT VALID;

ALTER TABLE "User" ADD CONSTRAINT "User_failed_login_count_nonnegative"
  CHECK ("failedLoginCount" >= 0) NOT VALID;

ALTER TABLE "User" ADD CONSTRAINT "User_token_version_nonnegative"
  CHECK ("tokenVersion" >= 0) NOT VALID;

ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_value_nonnegative"
  CHECK ("value" >= 0) NOT VALID;

ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_sort_order_nonnegative"
  CHECK ("sortOrder" >= 0) NOT VALID;

-- ---------------------------------------------------------------------------
-- 3. Time-window / cross-column consistency
-- ---------------------------------------------------------------------------

-- WorkingHours: Zod allows open 0..1439 and close/breakEnd 1..1440 (1440 = midnight).
-- Order rules are conditional on isOpen because closed days keep stored minutes
-- but must not be rejected for historical rows.
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_day_of_week_range"
  CHECK ("dayOfWeek" BETWEEN 1 AND 7) NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_open_minute_range"
  CHECK ("openMinute" BETWEEN 0 AND 1439) NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_close_minute_range"
  CHECK ("closeMinute" BETWEEN 1 AND 1440) NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_break_start_range"
  CHECK ("breakStartMinute" IS NULL OR "breakStartMinute" BETWEEN 0 AND 1439) NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_break_end_range"
  CHECK ("breakEndMinute" IS NULL OR "breakEndMinute" BETWEEN 1 AND 1440) NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_open_before_close"
  CHECK ("isOpen" = false OR "closeMinute" > "openMinute") NOT VALID;

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_break_order_and_window"
  CHECK (
    "isOpen" = false
    OR "breakStartMinute" IS NULL
    OR "breakEndMinute" IS NULL
    OR (
      "breakEndMinute" > "breakStartMinute"
      AND "breakStartMinute" >= "openMinute"
      AND "breakEndMinute" <= "closeMinute"
    )
  ) NOT VALID;

-- DoctorAvailability: order rule conditional on isWorking for the same reason.
ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_day_of_week_range"
  CHECK ("dayOfWeek" BETWEEN 1 AND 7) NOT VALID;

ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_open_minute_range"
  CHECK ("openMinute" BETWEEN 0 AND 1439) NOT VALID;

ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_close_minute_range"
  CHECK ("closeMinute" BETWEEN 1 AND 1440) NOT VALID;

ALTER TABLE "DoctorAvailability" ADD CONSTRAINT "DoctorAvailability_open_before_close"
  CHECK ("isWorking" = false OR "closeMinute" > "openMinute") NOT VALID;

-- ScheduleException: one-sided windows are legal on closed exceptions, so the
-- order rule applies only when both endpoints are present.
ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_open_minute_range"
  CHECK ("openMinute" IS NULL OR "openMinute" BETWEEN 0 AND 1439) NOT VALID;

ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_close_minute_range"
  CHECK ("closeMinute" IS NULL OR "closeMinute" BETWEEN 1 AND 1440) NOT VALID;

ALTER TABLE "ScheduleException" ADD CONSTRAINT "ScheduleException_open_before_close"
  CHECK (
    "openMinute" IS NULL OR "closeMinute" IS NULL OR "closeMinute" > "openMinute"
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- 4. Validate all added constraints in the same transaction
-- ---------------------------------------------------------------------------

ALTER TABLE "Charge" VALIDATE CONSTRAINT "Charge_status_allowed";
ALTER TABLE "Charge" VALIDATE CONSTRAINT "Charge_void_fields_consistent";
ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_status_allowed";
ALTER TABLE "Expense" VALIDATE CONSTRAINT "Expense_void_fields_consistent";
ALTER TABLE "ReportUpdateRequest" VALIDATE CONSTRAINT "ReportUpdateRequest_status_allowed";
ALTER TABLE "ReportUpdateRequest" VALIDATE CONSTRAINT "ReportUpdateRequest_resolved_fields_consistent";
ALTER TABLE "FileAsset" VALIDATE CONSTRAINT "FileAsset_kind_allowed";
ALTER TABLE "Service" VALIDATE CONSTRAINT "Service_price_nonnegative";
ALTER TABLE "Service" VALIDATE CONSTRAINT "Service_duration_positive";
ALTER TABLE "ClinicSettings" VALIDATE CONSTRAINT "ClinicSettings_appointment_minutes_positive";
ALTER TABLE "ClinicSettings" VALIDATE CONSTRAINT "ClinicSettings_slot_interval_positive";
ALTER TABLE "FileAsset" VALIDATE CONSTRAINT "FileAsset_size_positive";
ALTER TABLE "Appointment" VALIDATE CONSTRAINT "Appointment_duration_positive";
ALTER TABLE "Appointment" VALIDATE CONSTRAINT "Appointment_end_after_start";
ALTER TABLE "Report" VALIDATE CONSTRAINT "Report_version_positive";
ALTER TABLE "ReportVersion" VALIDATE CONSTRAINT "ReportVersion_version_positive";
ALTER TABLE "ReportDelivery" VALIDATE CONSTRAINT "ReportDelivery_version_positive";
ALTER TABLE "ReportDelivery" VALIDATE CONSTRAINT "ReportDelivery_attempts_positive";
ALTER TABLE "QueueEntry" VALIDATE CONSTRAINT "QueueEntry_position_positive";
ALTER TABLE "QueueEntry" VALIDATE CONSTRAINT "QueueEntry_timestamp_order";
ALTER TABLE "User" VALIDATE CONSTRAINT "User_failed_login_count_nonnegative";
ALTER TABLE "User" VALIDATE CONSTRAINT "User_token_version_nonnegative";
ALTER TABLE "Sequence" VALIDATE CONSTRAINT "Sequence_value_nonnegative";
ALTER TABLE "PaymentMethod" VALIDATE CONSTRAINT "PaymentMethod_sort_order_nonnegative";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_day_of_week_range";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_open_minute_range";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_close_minute_range";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_break_start_range";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_break_end_range";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_open_before_close";
ALTER TABLE "WorkingHours" VALIDATE CONSTRAINT "WorkingHours_break_order_and_window";
ALTER TABLE "DoctorAvailability" VALIDATE CONSTRAINT "DoctorAvailability_day_of_week_range";
ALTER TABLE "DoctorAvailability" VALIDATE CONSTRAINT "DoctorAvailability_open_minute_range";
ALTER TABLE "DoctorAvailability" VALIDATE CONSTRAINT "DoctorAvailability_close_minute_range";
ALTER TABLE "DoctorAvailability" VALIDATE CONSTRAINT "DoctorAvailability_open_before_close";
ALTER TABLE "ScheduleException" VALIDATE CONSTRAINT "ScheduleException_open_minute_range";
ALTER TABLE "ScheduleException" VALIDATE CONSTRAINT "ScheduleException_close_minute_range";
ALTER TABLE "ScheduleException" VALIDATE CONSTRAINT "ScheduleException_open_before_close";
