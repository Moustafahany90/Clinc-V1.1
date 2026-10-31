-- Drop patient email; referrals are now recorded as free text.
ALTER TABLE "Patient" DROP COLUMN "email";

-- Add optional referring doctor name.
ALTER TABLE "Patient" ADD COLUMN "referringDoctor" TEXT;
