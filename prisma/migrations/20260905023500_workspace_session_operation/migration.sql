ALTER TABLE "WorkspaceSession"
  ADD COLUMN "operationOwner" VARCHAR(160),
  ADD COLUMN "operationExpiresAt" TIMESTAMP(3);

ALTER TABLE "WorkspaceSession"
  ADD CONSTRAINT "WorkspaceSession_operation_lease_owner_check"
  CHECK ("operationExpiresAt" IS NULL OR "operationOwner" IS NOT NULL),
  ADD CONSTRAINT "WorkspaceSession_operation_owner_shape_check"
  CHECK ("operationOwner" IS NULL OR (
    octet_length("operationOwner") BETWEEN 1 AND 160
    AND "operationOwner" !~ '[[:cntrl:]]'
  ));
