-- Persist the accepted Project provider admission request and fingerprint so
-- resumed/background work can revalidate shared authority before external I/O.
ALTER TABLE "ProjectRunBinding"
  ADD COLUMN "providerAdmissionFingerprint" TEXT,
  ADD COLUMN "providerConnectionId" TEXT,
  ADD COLUMN "providerModelId" TEXT,
  ADD COLUMN "providerSearchPlan" JSONB,
  ADD COLUMN "providerRequiresClientTools" BOOLEAN NOT NULL DEFAULT false;
