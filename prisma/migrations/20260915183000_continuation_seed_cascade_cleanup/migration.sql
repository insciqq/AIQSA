BEGIN;

CREATE OR REPLACE FUNCTION abandon_continuation_workspace_seeds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ChatContinuationWorkspaceSeed" SET "status" = 'ABANDONED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE ("sourceChatId" = OLD."id" AND "newChatId" IS NULL) OR "newChatId" = OLD."id";
  INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, "storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "ChatContinuationWorkspaceSeed"
  WHERE (("sourceChatId" = OLD."id" AND "newChatId" IS NULL) OR "newChatId" = OLD."id") AND "storageKey" IS NOT NULL
  ON CONFLICT ("storageKey") DO NOTHING;

  -- A bulk parent deletion can have removed the destination while its seed's
  -- ON DELETE CASCADE is still queued. Updating that seed would recheck the
  -- already-missing destination FK. Finish only that owed child deletion and
  -- retain object cleanup before detaching surviving source references.
  WITH deleted AS (
    DELETE FROM "ChatContinuationWorkspaceSeed" seed
    WHERE seed."sourceChatId" = OLD."id" AND seed."newChatId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Chat" destination WHERE destination."id" = seed."newChatId")
    RETURNING seed."storageKey"
  )
  INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, "storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM deleted WHERE "storageKey" IS NOT NULL
  ON CONFLICT ("storageKey") DO NOTHING;

  -- Detach before the source's continuation cascade updates surviving seeds.
  UPDATE "ChatContinuationWorkspaceSeed" SET "sourceChatId" = NULL
  WHERE "sourceChatId" = OLD."id";
  RETURN OLD;
END $$;

COMMIT;
