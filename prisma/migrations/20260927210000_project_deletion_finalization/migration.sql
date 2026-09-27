-- The accepted Project deletion survives caller loss and runtime outages.
ALTER TABLE "Project"
  ADD COLUMN "deletionLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deletionLastErrorCode" TEXT,
  ADD COLUMN "deletionClaimToken" TEXT,
  ADD COLUMN "deletionClaimExpiresAt" TIMESTAMP(3);

ALTER TABLE "Project" ADD CONSTRAINT "Project_deletion_claim_shape"
  CHECK (("deletionClaimToken" IS NULL) = ("deletionClaimExpiresAt" IS NULL));
