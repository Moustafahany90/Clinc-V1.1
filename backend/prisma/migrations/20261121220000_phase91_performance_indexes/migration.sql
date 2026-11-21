-- Phase 9.1: four read-path indexes identified by the Phase 9 EXPLAIN harness.
-- Tables are empty pre-launch, so plain CREATE INDEX is used here. For a
-- populated production database, CREATE INDEX CONCURRENTLY should be considered.
CREATE INDEX "Refund_refundedAt_idx" ON "Refund"("refundedAt");
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");
CREATE INDEX "Measurement_visitId_measuredAt_idx" ON "Measurement"("visitId", "measuredAt");
CREATE INDEX "FileAsset_patientId_createdAt_idx" ON "FileAsset"("patientId", "createdAt");
