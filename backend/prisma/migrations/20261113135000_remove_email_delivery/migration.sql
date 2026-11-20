-- Remove the outbound email delivery subsystem.
-- EmailLog only ever held outbound mail metadata; the feature is retired.

ALTER TABLE "ClinicSettings"
  DROP COLUMN "emailEnabled",
  DROP COLUMN "emailProvider",
  DROP COLUMN "emailFromAddress",
  DROP COLUMN "dailyDoctorDigest",
  DROP COLUMN "digestSendHour";

DROP TABLE "EmailLog";
