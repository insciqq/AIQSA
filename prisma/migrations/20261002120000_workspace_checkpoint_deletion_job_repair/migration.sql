-- A cascaded captured file stages crash cleanup only while no Attachment keeps
-- its key. Every Attachment removal path stages or deletes the last reference.
CREATE OR REPLACE FUNCTION "workspace_captured_file_cleanup"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WorkspaceSelectedCapture" WHERE "id" = OLD."captureId" AND "state" IN ('CAPTURED', 'RELEASED')) THEN
    RAISE EXCEPTION 'workspace_capture_file_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."storageKey" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attachment" WHERE "storageKey" = OLD."storageKey") THEN
    INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, OLD."storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("storageKey") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

-- Earlier releases left the retained-capture obligation behind after checkpoint
-- publication. Such an unclaimed job is inert while the checkpoint Attachment
-- exists, but blocks Save and Use. Claimed jobs stay with their deleter.
DELETE FROM "AttachmentDeletionJob" job WHERE job."claimToken" IS NULL AND EXISTS (SELECT 1 FROM "Attachment" a JOIN "WorkspaceCheckpointFile" f ON f."attachmentId" = a."id" WHERE a."storageKey" = job."storageKey");
