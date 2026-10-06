/** Synthetic pre-upgrade state; migration-contract owns the disposable database. */
export const DROP_RETIRED_MEMORY_DIGESTS_MIGRATION =
  "20261006121500_memory_drop_chat_digests_history_execution";

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

// The installed definition carries earlier in-place rewrites; the proof
// compares against it rather than against any migration text.
export const dropRetiredMemoryDigestsFixtureSql = `
CREATE TABLE "MemoryDigestDropAdoptionFixture" AS
SELECT pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure) AS definition;
`;

/** Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const dropRetiredMemoryDigestsProofSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-digest-drop-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('memory-digest-drop-chat', 'memory-digest-drop-owner', 'Synthetic chat', now());
DO $proof$ BEGIN
  IF to_regclass('public."ChatMemoryDigest"') IS NOT NULL
    OR to_regclass('public."ChatMemoryDigestChunk"') IS NOT NULL
    OR to_regclass('public."ChatMemoryDigestMessage"') IS NOT NULL
    OR to_regclass('public."MemoryHistoryExecution"') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_digest_storage_retained'; END IF;
  IF to_regprocedure('aiqsa_memory_assert_digest_sources(text)') IS NOT NULL
    OR to_regprocedure('aiqsa_memory_assert_digest_sources_once(text)') IS NOT NULL
    OR to_regprocedure('aiqsa_memory_digest_row_source_trigger()') IS NOT NULL
    OR to_regprocedure('aiqsa_memory_digest_map_source_trigger()') IS NOT NULL
    OR to_regprocedure('aiqsa_memory_history_execution_guard()') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_digest_functions_retained'; END IF;
  IF (SELECT replace(definition, $branch$${digestBranch}$branch$, '')
      FROM "MemoryDigestDropAdoptionFixture")
    IS DISTINCT FROM pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure)
  THEN RAISE EXCEPTION 'memory_history_source_guard_not_preserved'; END IF;
  -- The rewritten guard still evaluates every remaining branch for a chat.
  PERFORM aiqsa_memory_assert_history_source('memory-digest-drop-owner', 'memory-digest-drop-chat');
END $proof$;
ROLLBACK;
`;
