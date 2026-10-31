-- CreateEnum
CREATE TYPE "ReportDeliveryChannel" AS ENUM ('WHATSAPP');

-- CreateEnum
CREATE TYPE "ReportDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ReportDelivery" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "sentById" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "channel" "ReportDeliveryChannel" NOT NULL DEFAULT 'WHATSAPP',
    "status" "ReportDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'META_CLOUD',
    "recipientLast4" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportDelivery_patientId_createdAt_idx" ON "ReportDelivery"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ReportDelivery_status_updatedAt_idx" ON "ReportDelivery"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDelivery_reportId_versionNumber_channel_key" ON "ReportDelivery"("reportId", "versionNumber", "channel");

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDelivery" ADD CONSTRAINT "ReportDelivery_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill the new delivery permission for existing doctors.
UPDATE "User"
SET "permissions" = array_append("permissions", 'REPORTS_SEND')
WHERE "role" = 'DOCTOR' AND NOT ('REPORTS_SEND' = ANY("permissions"));
