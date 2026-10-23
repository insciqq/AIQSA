-- The Memory lexical OpenSearch projection is retired (operator decision
-- 2026-10-23): Memory lexical search reads PostgreSQL only. Stop capturing
-- projection work for every Memory search entry and generation change.
--
-- The projection tables, their enums and the enqueue function stay for one
-- release: the previous image still calls the enqueue function and reads the
-- tables while Compose replaces it and after a rollback. The next release drops
-- them. Nothing here touches PostgreSQL lexical data.

DROP TRIGGER IF EXISTS "MemorySearchEntry_lexical_projection_insert" ON "MemorySearchEntry";
DROP TRIGGER IF EXISTS "MemorySearchEntry_lexical_projection_update" ON "MemorySearchEntry";
DROP TRIGGER IF EXISTS "MemorySearchEntry_lexical_projection_delete" ON "MemorySearchEntry";
DROP TRIGGER IF EXISTS "MemoryIndexGeneration_lexical_projection_purge" ON "MemoryIndexGeneration";

DROP FUNCTION IF EXISTS aiqsa_capture_memory_lexical_projection();
DROP FUNCTION IF EXISTS aiqsa_capture_memory_generation_purge();
DROP FUNCTION IF EXISTS aiqsa_memory_lexical_revision(TEXT, TEXT);
