-- Chat digests, history enrichment staging and Dream synthesis staging were
-- emptied by the previous release, which never writes them. The tables go with
-- their indexes, triggers and foreign keys, and so do the functions only their
-- triggers call; the shared history source, permanent chat and once-per-batch
-- source guard functions stay with the live tables that use them. Rows an
-- older writer stored during the previous upgrade overlap were never read
-- again and go with the tables.
--
-- During Compose replacement a previous-release writer still reaches these
-- tables through the foreign keys of the rows it deletes, which cascade into
-- or check them, and through the read-only synthesis staging counts of account
-- inventory and deletion audit. Those counts fail until it stops: account
-- Memory deletion retries, and an administrator repeats the request.
--
-- Dropping a table removes its foreign key triggers from every table it
-- references under an exclusive lock, after locking the dropped tables, while
-- a previous-release writer locks a referenced table before its cascade
-- reaches a dropped one. Every lock is therefore taken up front, referenced
-- tables first, and a deadlock retries instead of failing the upgrade.
DO $migration$
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "Folder", "AssistantDefinition", "MemoryExecutionBinding", "MemoryJob",
        "MemoryRecallChunk", "Message", "Chat", "User",
        "ChatMemoryDigest", "ChatMemoryDigestChunk", "ChatMemoryDigestMessage",
        "MemoryHistoryExecution", "MemorySynthesisExecution" IN ACCESS EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      NULL;
    END;
  END LOOP;
END;
$migration$;

DROP TABLE "ChatMemoryDigestChunk", "ChatMemoryDigestMessage", "ChatMemoryDigest",
  "MemoryHistoryExecution", "MemorySynthesisExecution";

DROP FUNCTION aiqsa_memory_digest_row_source_trigger(),
  aiqsa_memory_digest_map_source_trigger(),
  aiqsa_memory_assert_digest_sources_once(text),
  aiqsa_memory_assert_digest_sources(text),
  aiqsa_memory_history_execution_guard(),
  aiqsa_memory_synthesis_execution_guard();
