-- Chat digests and history enrichment are retired: history indexing makes no
-- model calls and past chats are found through raw chunks only. Their derived
-- tables and source guards go; every digest row and retained enrichment output
-- is derived and has no remaining reader. Execution bindings and usage of the
-- past calls stay as accounting history. A previous-release writer during
-- Compose replacement fails its digest or retained-output statement and its
-- job runs again under this release; a history call it leaves unsettled is
-- settled once by recovery as an unknown outcome, never sent again.
DROP TABLE "ChatMemoryDigestChunk", "ChatMemoryDigestMessage", "ChatMemoryDigest",
  "MemoryHistoryExecution";

DROP FUNCTION aiqsa_memory_digest_row_source_trigger();
DROP FUNCTION aiqsa_memory_digest_map_source_trigger();
DROP FUNCTION aiqsa_memory_assert_digest_sources_once(text);
DROP FUNCTION aiqsa_memory_assert_digest_sources(text);
DROP FUNCTION aiqsa_memory_history_execution_guard();

-- The history source assert loses only its digest branch. The installed
-- definition keeps its later version-literal and active-path rewrites, so it
-- is edited in place; every other condition, signature, error code and message
-- is unchanged.
DO $migration$
DECLARE
  definition text;
  digest_branch text;
BEGIN
  definition := pg_get_functiondef('aiqsa_memory_assert_history_source(text,text)'::regprocedure);
  digest_branch := $old$ OR EXISTS (
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
  )$old$;
  -- Exactly one installed digest branch is removed, and no digest read remains.
  IF length(definition) - length(replace(definition, digest_branch, ''))
      <> length(digest_branch) THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_history_source digest branch not found';
  END IF;
  definition := replace(definition, digest_branch, '');
  IF position('ChatMemoryDigest' IN definition) > 0 THEN
    RAISE EXCEPTION 'Memory source guard aiqsa_memory_assert_history_source digest removal incomplete';
  END IF;
  EXECUTE definition;
END;
$migration$;
