-- The storage that replaces Personal Memory (operator decision 2026-11-22): one short
-- note per user, the agent's offers to change it, the old Memory's facts waiting for
-- their owner, and the past-chat search index with its per-chat bookkeeping, plus the
-- three user switches and the past-chat embedding role. Expand only: nothing reads or
-- writes these tables yet, the new columns are nullable or default to true, and no
-- existing row or column changes, so the previous release's writers stay safe while
-- Compose replaces containers. The old Memory tables are untouched.

-- CreateEnum
CREATE TYPE "MemoryNoteAuthor" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "MemoryNoteOperation" AS ENUM ('ADD', 'REPLACE', 'REMOVE');

-- CreateEnum
CREATE TYPE "MemoryNoteOfferState" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "MemoryLegacySuggestionOrigin" AS ENUM ('AUTOMATIC', 'SAVED_OVERFLOW');

-- AlterTable: constant defaults, so PostgreSQL adds the columns without rewriting rows.
ALTER TABLE "UserSettings"
  ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pastChatSearchEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "memorySuggestionsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: the past-chat embedding role, beside the reranker role and like it.
-- NULL configuredAt means an administrator never saved or cleared the role.
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "embeddingProviderModelId" TEXT,
  ADD COLUMN "embeddingConfiguredAt" TIMESTAMP(3);

-- CreateTable: the note's limit counts characters as char_length does (Unicode code
-- points), as MEMORY_NOTE_MAX_CHARACTERS in lib/contracts/memoryNote.ts does.
CREATE TABLE "UserMemoryNote" (
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastChangedBy" "MemoryNoteAuthor" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemoryNote_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserMemoryNote_text_check" CHECK (char_length("text") <= 6000),
    CONSTRAINT "UserMemoryNote_revision_check" CHECK ("revision" >= 1)
);

-- CreateTable: an offer names the text it takes out (beforeText) and puts in
-- (afterText) as its operation needs, each a non-blank text within the note limit.
CREATE TABLE "MemoryNoteOffer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "operation" "MemoryNoteOperation" NOT NULL,
    "beforeText" TEXT,
    "afterText" TEXT,
    "state" "MemoryNoteOfferState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryNoteOffer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MemoryNoteOffer_operation_check" CHECK (
      ("operation" = 'ADD'::"MemoryNoteOperation" AND "beforeText" IS NULL AND "afterText" IS NOT NULL)
      OR ("operation" = 'REPLACE'::"MemoryNoteOperation" AND "beforeText" IS NOT NULL AND "afterText" IS NOT NULL
        AND "beforeText" <> "afterText")
      OR ("operation" = 'REMOVE'::"MemoryNoteOperation" AND "beforeText" IS NOT NULL AND "afterText" IS NULL)
    ),
    CONSTRAINT "MemoryNoteOffer_text_check" CHECK (
      ("beforeText" IS NULL OR (char_length("beforeText") BETWEEN 1 AND 6000 AND "beforeText" ~ '[^[:space:]]'))
      AND ("afterText" IS NULL OR (char_length("afterText") BETWEEN 1 AND 6000 AND "afterText" ~ '[^[:space:]]'))
    ),
    CONSTRAINT "MemoryNoteOffer_decision_check" CHECK (("state" = 'PENDING'::"MemoryNoteOfferState") = ("decidedAt" IS NULL))
);

-- CreateTable: a suggestion fits the note, so Keep can always move it there.
CREATE TABLE "MemoryLegacySuggestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "origin" "MemoryLegacySuggestionOrigin" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryLegacySuggestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MemoryLegacySuggestion_text_check" CHECK (char_length("text") BETWEEN 1 AND 6000 AND "text" ~ '[^[:space:]]')
);

-- CreateTable: a retry is scheduled only for a dirty chat, and a failure is recorded
-- only as a content-free code.
CREATE TABLE "ChatSearchState" (
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "indexedLeafMessageId" TEXT,
    "dirtyAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(64),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSearchState_pkey" PRIMARY KEY ("chatId"),
    CONSTRAINT "ChatSearchState_attempt_check" CHECK ("attemptCount" >= 0 AND ("nextAttemptAt" IS NULL OR "dirtyAt" IS NOT NULL)),
    CONSTRAINT "ChatSearchState_error_code_check" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z][a-z0-9_]{0,63}$')
);

-- CreateTable: the full-text column is generated from the stored (already redacted)
-- text, like MemorySearchEntry's. The vector column has no fixed dimension; a row's
-- vector, its model and its dimension are all set or all null, and agree.
CREATE TABLE "ChatSearchPassage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT NOT NULL,
    "turnAt" TIMESTAMP(3) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "searchVectorSimple" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "text")) STORED,
    "embedding" vector,
    "embeddingProviderModelId" TEXT,
    "embeddingDimension" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatSearchPassage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChatSearchPassage_shape_check" CHECK (
      "ordinal" >= 0
      AND "userMessageId" <> "assistantMessageId"
      AND char_length("text") BETWEEN 1 AND 16000
      AND "contentHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "ChatSearchPassage_embedding_check" CHECK (
      num_nonnulls("embedding", "embeddingProviderModelId", "embeddingDimension") = 0
      OR (
        num_nonnulls("embedding", "embeddingProviderModelId", "embeddingDimension") = 3
        AND "embeddingDimension" > 0
        AND vector_dims("embedding") = "embeddingDimension"
      )
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryNoteOffer_runId_toolCallId_key" ON "MemoryNoteOffer"("runId", "toolCallId");

-- CreateIndex
CREATE INDEX "MemoryNoteOffer_chatId_assistantMessageId_idx" ON "MemoryNoteOffer"("chatId", "assistantMessageId");

-- CreateIndex
CREATE INDEX "MemoryNoteOffer_userId_createdAt_idx" ON "MemoryNoteOffer"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryLegacySuggestion_userId_createdAt_idx" ON "MemoryLegacySuggestion"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatSearchState_userId_idx" ON "ChatSearchState"("userId");

-- CreateIndex
CREATE INDEX "ChatSearchState_dirtyAt_idx" ON "ChatSearchState"("dirtyAt");

-- CreateIndex: the indexer replaces one turn's windows by this key.
CREATE UNIQUE INDEX "ChatSearchPassage_chatId_userMessageId_ordinal_key" ON "ChatSearchPassage"("chatId", "userMessageId", "ordinal");

-- CreateIndex
CREATE INDEX "ChatSearchPassage_chatId_assistantMessageId_idx" ON "ChatSearchPassage"("chatId", "assistantMessageId");

-- CreateIndex: one owner's passages by time, for recent chats, date filters and the
-- exact vector scan. Deliberately no approximate (ivfflat/hnsw) index.
CREATE INDEX "ChatSearchPassage_userId_turnAt_idx" ON "ChatSearchPassage"("userId", "turnAt");

-- CreateIndex
CREATE INDEX "ChatSearchPassage_simple_gin_idx" ON "ChatSearchPassage" USING gin ("searchVectorSimple");

-- CreateIndex: SystemModelPolicy holds one row.
CREATE INDEX "SystemModelPolicy_embeddingProviderModelId_idx" ON "SystemModelPolicy"("embeddingProviderModelId");

-- AddForeignKey
ALTER TABLE "UserMemoryNote" ADD CONSTRAINT "UserMemoryNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: an offer goes with its chat, its run, its answer and its tool call;
-- the keys carry the owner and the chat, so an offer cannot point across them.
ALTER TABLE "MemoryNoteOffer" ADD CONSTRAINT "MemoryNoteOffer_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryNoteOffer" ADD CONSTRAINT "MemoryNoteOffer_userId_chatId_runId_fkey" FOREIGN KEY ("userId", "chatId", "runId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryNoteOffer" ADD CONSTRAINT "MemoryNoteOffer_chatId_assistantMessageId_fkey" FOREIGN KEY ("chatId", "assistantMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryNoteOffer" ADD CONSTRAINT "MemoryNoteOffer_runId_toolCallId_fkey" FOREIGN KEY ("runId", "toolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemoryLegacySuggestion" ADD CONSTRAINT "MemoryLegacySuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: the reranker role's behaviour; a passage's model stays a plain value.
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_embeddingProviderModelId_fkey" FOREIGN KEY ("embeddingProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: the owner is the chat's owner; the account's deletion reaches these
-- rows through its chats.
ALTER TABLE "ChatSearchState" ADD CONSTRAINT "ChatSearchState_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatSearchPassage" ADD CONSTRAINT "ChatSearchPassage_userId_chatId_fkey" FOREIGN KEY ("userId", "chatId") REFERENCES "Chat"("userId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey: deleting either message of a turn (its branch, its chat) removes the
-- turn's passages at once, before any reindex.
ALTER TABLE "ChatSearchPassage" ADD CONSTRAINT "ChatSearchPassage_chatId_userMessageId_fkey" FOREIGN KEY ("chatId", "userMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatSearchPassage" ADD CONSTRAINT "ChatSearchPassage_chatId_assistantMessageId_fkey" FOREIGN KEY ("chatId", "assistantMessageId") REFERENCES "Message"("chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- CreateTrigger: a chat fenced for permanent deletion takes no new passages, as it
-- takes no new messages; readers still filter fenced chats.
CREATE TRIGGER "ChatSearchPassage_permanent_chat_write_guard"
  BEFORE INSERT OR UPDATE OF "chatId" ON "ChatSearchPassage"
  FOR EACH ROW EXECUTE FUNCTION aiqsa_permanent_chat_child_write_guard();
