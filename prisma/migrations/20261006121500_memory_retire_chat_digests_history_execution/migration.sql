-- Chat digests and history enrichment are retired: history indexing makes no
-- model calls and past chats are found through raw chunks only. This release
-- never reads or writes the digest and retained-output tables, but the previous
-- release still does during Compose replacement, so the tables, their functions
-- and their triggers stay until the next release drops them. Every row is
-- derived content without a reader, and Forget no longer reaches it, so the
-- rows go now. Execution bindings and usage of the past calls stay as
-- accounting history. A previous-release job whose retained output is gone
-- falls back to raw history, as after expiry.
--
-- Previous-release writers take these tables in both orders, so every lock is
-- taken up front and a deadlock retries instead of failing the upgrade. The
-- binding table is locked for the foreign key dropped below.
DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "MemoryExecutionBinding", "ChatMemoryDigest", "ChatMemoryDigestChunk",
        "ChatMemoryDigestMessage", "MemoryHistoryExecution" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

-- No per-row guard runs: no remaining invariant reads these rows.
TRUNCATE "ChatMemoryDigest", "ChatMemoryDigestChunk", "ChatMemoryDigestMessage",
  "MemoryHistoryExecution";

-- A row a previous-release writer adds during replacement stays inert. This
-- release deletes bindings, history chunks and messages and detaches assistants
-- without removing such a row first: its binding no longer restricts deletion,
-- and the exact-source guards still check every row that writer inserts (it
-- rewrites the source maps of each digest it stores) but no longer the
-- cascades of this release.
ALTER TABLE "MemoryHistoryExecution" DROP CONSTRAINT "MemoryHistoryExecution_binding_fkey";
DROP TRIGGER "ChatMemoryDigest_exact_sources_guard" ON "ChatMemoryDigest";
CREATE CONSTRAINT TRIGGER "ChatMemoryDigest_exact_sources_guard"
  AFTER INSERT ON "ChatMemoryDigest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_row_source_trigger();
DROP TRIGGER "ChatMemoryDigestChunk_exact_sources_guard" ON "ChatMemoryDigestChunk";
CREATE CONSTRAINT TRIGGER "ChatMemoryDigestChunk_exact_sources_guard"
  AFTER INSERT ON "ChatMemoryDigestChunk"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_map_source_trigger();
DROP TRIGGER "ChatMemoryDigestMessage_exact_sources_guard" ON "ChatMemoryDigestMessage";
CREATE CONSTRAINT TRIGGER "ChatMemoryDigestMessage_exact_sources_guard"
  AFTER INSERT ON "ChatMemoryDigestMessage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION aiqsa_memory_digest_map_source_trigger();

-- The history source assert loses only its digest branch, so a digest never
-- decides whether chat history is current. The installed definition keeps its
-- later version-literal and active-path rewrites, so it is edited in place;
-- every other condition, signature, error code and message is unchanged.
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
