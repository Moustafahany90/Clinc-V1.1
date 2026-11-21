-- Phase M rollback: drop only the constraints added by
-- 20261120222405_db_integrity_constraints. Existing constraints and data are
-- untouched.
--
-- Bookkeeping (Prisma-native ONLY; never edit the migration ledger):
--   * If the migration FAILED during deploy, Prisma leaves it in a failed
--     state. After confirming the DDL is absent, use:
--       npx prisma migrate resolve --rolled-back 20261120222405_db_integrity_constraints
--   * If the migration SUCCEEDED, --rolled-back is rejected (P3012) and this
--     file only drops constraints: it does not change migration history. Do
--     not modify the ledger to force a re-apply. To reverse the effect safely,
--     author and deploy a NEW forward migration that re-creates the constraints,
--     or restore from a verified backup under the approved rollback procedure.
--   * Record the chosen reconciliation, operator and evidence in the change
--     log. See docs/PRODUCTION_ROLLBACK_RUNBOOK.md.

ALTER TABLE "Charge" DROP CONSTRAINT IF EXISTS "Charge_status_allowed";
ALTER TABLE "Charge" DROP CONSTRAINT IF EXISTS "Charge_void_fields_consistent";
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_status_allowed";
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_void_fields_consistent";
ALTER TABLE "ReportUpdateRequest" DROP CONSTRAINT IF EXISTS "ReportUpdateRequest_status_allowed";
ALTER TABLE "ReportUpdateRequest" DROP CONSTRAINT IF EXISTS "ReportUpdateRequest_resolved_fields_consistent";
ALTER TABLE "FileAsset" DROP CONSTRAINT IF EXISTS "FileAsset_kind_allowed";
ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS "Service_price_nonnegative";
ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS "Service_duration_positive";
ALTER TABLE "ClinicSettings" DROP CONSTRAINT IF EXISTS "ClinicSettings_appointment_minutes_positive";
ALTER TABLE "ClinicSettings" DROP CONSTRAINT IF EXISTS "ClinicSettings_slot_interval_positive";
ALTER TABLE "FileAsset" DROP CONSTRAINT IF EXISTS "FileAsset_size_positive";
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "Appointment_duration_positive";
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "Appointment_end_after_start";
ALTER TABLE "Report" DROP CONSTRAINT IF EXISTS "Report_version_positive";
ALTER TABLE "ReportVersion" DROP CONSTRAINT IF EXISTS "ReportVersion_version_positive";
ALTER TABLE "ReportDelivery" DROP CONSTRAINT IF EXISTS "ReportDelivery_version_positive";
ALTER TABLE "ReportDelivery" DROP CONSTRAINT IF EXISTS "ReportDelivery_attempts_positive";
ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_position_positive";
ALTER TABLE "QueueEntry" DROP CONSTRAINT IF EXISTS "QueueEntry_timestamp_order";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_failed_login_count_nonnegative";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_token_version_nonnegative";
ALTER TABLE "Sequence" DROP CONSTRAINT IF EXISTS "Sequence_value_nonnegative";
ALTER TABLE "PaymentMethod" DROP CONSTRAINT IF EXISTS "PaymentMethod_sort_order_nonnegative";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_day_of_week_range";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_open_minute_range";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_close_minute_range";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_break_start_range";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_break_end_range";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_open_before_close";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_break_order_and_window";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_day_of_week_range";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_open_minute_range";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_close_minute_range";
ALTER TABLE "DoctorAvailability" DROP CONSTRAINT IF EXISTS "DoctorAvailability_open_before_close";
ALTER TABLE "ScheduleException" DROP CONSTRAINT IF EXISTS "ScheduleException_open_minute_range";
ALTER TABLE "ScheduleException" DROP CONSTRAINT IF EXISTS "ScheduleException_close_minute_range";
ALTER TABLE "ScheduleException" DROP CONSTRAINT IF EXISTS "ScheduleException_open_before_close";
