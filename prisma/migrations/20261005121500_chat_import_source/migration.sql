-- A chat imported from an export records its source on the chat itself, so
-- a continuation or a branch copy carries the import marker (never the key)
-- without a separate table. An imported chat, or a copy of one, never feeds
-- Memory: the check keeps it Excluded against every writer, raw SQL included.
CREATE TYPE "ChatImportSource" AS ENUM ('AIQSA', 'CHATGPT', 'CLAUDE');

ALTER TABLE "Chat"
  ADD COLUMN "importSource" "ChatImportSource",
  ADD COLUMN "importSourceKey" CHAR(64),
  ADD COLUMN "importSourceModel" VARCHAR(128),
  ADD CONSTRAINT "Chat_import_memory_excluded_check" CHECK (
    "importSource" IS NULL OR "memoryMode" = 'EXCLUDED'::"MemoryChatMode"
  ),
  ADD CONSTRAINT "Chat_import_source_key_check" CHECK (
    "importSourceKey" IS NULL OR (
      "importSource" IS NOT NULL
      AND "userId" IS NOT NULL
      AND "projectId" IS NULL
      AND "importSourceKey" ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT "Chat_import_source_model_check" CHECK (
    "importSourceModel" IS NULL OR "importSource" IS NOT NULL
  );

-- One live import per owner and source conversation: a second import of the
-- same conversation reports "already imported". A chat pending permanent
-- deletion leaves the index at once, so deleting it frees the key.
CREATE UNIQUE INDEX "Chat_import_source_key"
  ON "Chat" ("userId", "importSource", "importSourceKey")
  WHERE "importSourceKey" IS NOT NULL AND "permanentDeletionAt" IS NULL;
