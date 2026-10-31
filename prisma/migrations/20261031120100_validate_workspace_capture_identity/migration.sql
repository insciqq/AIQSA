-- Validates the wider identity check `20261031120000_workspace_capture_shared_operation_owner` added NOT VALID.
-- VALIDATE CONSTRAINT scans under a lock that lets reads and writes go on.
ALTER TABLE "WorkspaceSelectedCapture" VALIDATE CONSTRAINT "WorkspaceSelectedCapture_identity_check";
