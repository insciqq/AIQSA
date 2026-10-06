/** Synthetic pre-upgrade state; migration-contract owns the disposable database. */
export const RETIRE_MEMORY_DIGESTS_MIGRATION =
  "20261006121500_memory_retire_chat_digests_history_execution";

// The exact digest branch the migration removes from the installed assert.
const digestBranch = ` OR EXISTS (
    SELECT 1 FROM "ChatMemoryDigest" AS digest
    WHERE digest."userId" = p_user_id AND digest."chatId" = p_chat_id
      AND digest."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND (
        chat_row."memoryMode" <> 'NORMAL'::"MemoryChatMode"
        OR digest."sourceFolderId" IS DISTINCT FROM chat_row."folderId"
        OR ((digest."branchGeneration" <> chat_row."memoryBranchGeneration"
          OR digest."sourceRevisionAtCreation" <> chat_row."memorySourceRevision"
          OR digest."activeLeafMessageId" IS DISTINCT FROM chat_row."activeLeafMessageId")
          AND NOT current_leaf_in_pause)
      )
  )`;

// Replica mode skips guards and foreign keys: these rows exercise only the
// cleanup and the guards' event set, never their source checks.
export const digestRows = (digestId: string, userId: string, chatId: string) => `
INSERT INTO "ChatMemoryDigest" (id, "userId", "chatId", "anchorChunkId", "branchGeneration",
  "sourceRevisionAtCreation", "activeLeafMessageId", "sourceContentHash", "contentHash", summary,
  "safeDigestText", "normalizedSafeSearchText", "languageCode", "occurredFrom", "occurredTo",
  "safetyClass", "redactionState", "pipelineVersion", "sourceFingerprint", "inputFingerprint",
  "rebuildPolicyVersion", "updateMode", "sourceProjectionVersion", "safetyPolicyVersion")
VALUES ('${digestId}', '${userId}', '${chatId}', '${digestId}-chunk-1', 0, 0, '${digestId}-message',
  repeat('a', 64), repeat('b', 64), 'Synthetic digest', 'Synthetic digest', 'synthetic digest', 'en',
  now(), now(), 'NORMAL', 'NOT_NEEDED', 'memory-chat-digest-v5', repeat('c', 64), repeat('d', 64),
  'synthetic-rebuild-v1', 'FULL_REBUILD', 'memory-history-source-projection-v3', 'synthetic-policy-v1');
INSERT INTO "ChatMemoryDigestChunk" ("userId", "chatId", "digestId", "chunkId", ordinal)
VALUES ('${userId}', '${chatId}', '${digestId}', '${digestId}-chunk-0', 0),
  ('${userId}', '${chatId}', '${digestId}', '${digestId}-chunk-1', 1);
INSERT INTO "ChatMemoryDigestMessage" ("userId", "chatId", "digestId", "messageId", ordinal,
  "sourceMessageContentHash", "sourceMessageUpdatedAt")
VALUES ('${userId}', '${chatId}', '${digestId}', '${digestId}-message', 0, repeat('e', 64), now());
`;

// One previous-release row in each retired table. The installed assert carries
// earlier in-place rewrites; the proof compares against it rather than against
// any migration text.
export const retireMemoryDigestsFixtureSql = `
BEGIN;
SET LOCAL session_replication_role = replica;
${digestRows("memory-digest-retire-fixture", "memory-digest-retire-fixture-owner", "memory-digest-retire-fixture-chat")}
INSERT INTO "MemoryHistoryExecution" (id, "userId", "memoryJobId", "executionBindingId", "inputHash",
  "acceptedOutputHash", "acceptedOutput", "recoverableUntil")
VALUES ('memory-digest-retire-execution', 'memory-digest-retire-fixture-owner', 'memory-digest-retire-job',
  'memory-digest-retire-binding', repeat('a', 64), repeat('b', 64), '{"keys":["synthetic"]}'::jsonb,
  now() + interval '1 day');
COMMIT;
CREATE TABLE "MemoryDigestRetireAdoptionFixture" AS
SELECT pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure) AS definition;
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const retireMemoryDigestsProofSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-digest-retire-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('memory-digest-retire-chat', 'memory-digest-retire-owner', 'Synthetic chat', now());
DO $proof$ BEGIN
  -- Previous-release writers still use the storage during Compose replacement.
  IF to_regclass('public."ChatMemoryDigest"') IS NULL
    OR to_regclass('public."ChatMemoryDigestChunk"') IS NULL
    OR to_regclass('public."ChatMemoryDigestMessage"') IS NULL
    OR to_regclass('public."MemoryHistoryExecution"') IS NULL
  THEN RAISE EXCEPTION 'memory_digest_storage_dropped_before_overlap'; END IF;
  IF to_regprocedure('aiqsa_memory_assert_digest_sources(text)') IS NULL
    OR to_regprocedure('aiqsa_memory_assert_digest_sources_once(text)') IS NULL
    OR to_regprocedure('aiqsa_memory_digest_row_source_trigger()') IS NULL
    OR to_regprocedure('aiqsa_memory_digest_map_source_trigger()') IS NULL
    OR to_regprocedure('aiqsa_memory_history_execution_guard()') IS NULL
  THEN RAISE EXCEPTION 'memory_digest_functions_dropped_before_overlap'; END IF;
  IF EXISTS (SELECT 1 FROM "ChatMemoryDigest") OR EXISTS (SELECT 1 FROM "ChatMemoryDigestChunk")
    OR EXISTS (SELECT 1 FROM "ChatMemoryDigestMessage") OR EXISTS (SELECT 1 FROM "MemoryHistoryExecution")
  THEN RAISE EXCEPTION 'memory_digest_derived_rows_retained'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MemoryHistoryExecution_binding_fkey')
  THEN RAISE EXCEPTION 'memory_history_execution_binding_restricts_deletion'; END IF;
  IF (SELECT count(*) FROM pg_trigger
      WHERE tgname IN ('ChatMemoryDigest_exact_sources_guard', 'ChatMemoryDigestChunk_exact_sources_guard',
        'ChatMemoryDigestMessage_exact_sources_guard')
        AND tgtype = 5 AND tgdeferrable AND tginitdeferred) <> 3
  THEN RAISE EXCEPTION 'memory_digest_source_guards_not_insert_only'; END IF;
  IF (SELECT replace(definition, $branch$${digestBranch}$branch$, '')
      FROM "MemoryDigestRetireAdoptionFixture")
    IS DISTINCT FROM pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure)
  THEN RAISE EXCEPTION 'memory_history_source_guard_not_preserved'; END IF;
  -- The rewritten guard still evaluates every remaining branch for a chat.
  PERFORM aiqsa_memory_assert_history_source('memory-digest-retire-owner', 'memory-digest-retire-chat');
END $proof$;
-- A digest a previous-release writer stores during replacement: a cascade of
-- this release that removes one of its sources must not reach a digest guard.
SET LOCAL session_replication_role = replica;
${digestRows("memory-digest-retire-overlap", "memory-digest-retire-owner", "memory-digest-retire-chat")}
SET LOCAL session_replication_role = origin;
DELETE FROM "ChatMemoryDigestChunk" WHERE "digestId" = 'memory-digest-retire-overlap' AND ordinal = 0;
DELETE FROM "ChatMemoryDigestMessage" WHERE "digestId" = 'memory-digest-retire-overlap';
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
`;
