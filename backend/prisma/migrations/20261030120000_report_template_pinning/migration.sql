-- Report templates gain a default flag and print-layout options.
ALTER TABLE "ReportTemplate" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReportTemplate" ADD COLUMN IF NOT EXISTS "layout" JSONB;

-- Reports pin the template revision they were created/finalized with.
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "templateSnapshot" JSONB;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "templateVersion" TEXT;

CREATE INDEX IF NOT EXISTS "ReportTemplate_isDefault_idx" ON "ReportTemplate"("isDefault");
