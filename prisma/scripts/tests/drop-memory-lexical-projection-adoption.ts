/** Synthetic retired projection rows; migration-contract owns the disposable database. */
export const DROP_MEMORY_LEXICAL_PROJECTION_MIGRATION =
  "20261025091000_drop_memory_lexical_projection";

// Rows left by the release that still captured projection work, including a
// pending purge the previous image enqueued explicitly. No foreign keys.
export const dropMemoryLexicalProjectionFixtureSql = `
INSERT INTO "MemoryLexicalProjectionEvent" (id, "userId", "indexGenerationId", "searchEntryId", operation,
  "memoryRevisionSnapshot", "idempotencyFingerprint")
VALUES ('00000000-0000-4000-8000-0000000000b1', 'projection-drop-owner', 'projection-drop-generation',
  'projection-drop-entry', 'SYNC_ENTRY', 2, 'projection-drop-sync');
DO $$ BEGIN
  PERFORM aiqsa_enqueue_memory_lexical_projection_event('projection-drop-owner', NULL, NULL, 'PURGE_USER', 3);
END $$;
INSERT INTO "MemoryLexicalProjectionState" ("userId", "indexGenerationId", "backendKind", "mappingVersion",
  "normalizationVersion", "analysisProfile", "retrievalPipelineVersion", status, "targetMemoryRevision")
VALUES ('projection-drop-owner', 'projection-drop-generation', 'retired_lexical_backend_v1',
  'memory-lexical-mapping-v1', 'memory-unicode-query-analysis-v1', 'memory-unicode-icu-v1',
  'memory-personal-retrieval-v63', 'BUILDING', 2);
`;

/** The tables, their enums and functions are gone whatever rows they held.
 * Runs in a rolled-back transaction, so it also proves a repeated deploy. */
export const dropMemoryLexicalProjectionProofSql = `
BEGIN;
DO $$ BEGIN
  IF to_regclass('"MemoryLexicalProjectionEvent"') IS NOT NULL
    OR to_regclass('"MemoryLexicalProjectionState"') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_lexical_projection_tables_retained'; END IF;
  IF to_regtype('"MemoryLexicalProjectionOperation"') IS NOT NULL
    OR to_regtype('"MemoryLexicalProjectionEventState"') IS NOT NULL
    OR to_regtype('"MemoryLexicalProjectionStatus"') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_lexical_projection_types_retained'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN (
      'aiqsa_enqueue_memory_lexical_projection_event', 'aiqsa_guard_memory_lexical_projection_event_admission',
      'aiqsa_capture_memory_lexical_projection', 'aiqsa_capture_memory_generation_purge', 'aiqsa_memory_lexical_revision'))
  THEN RAISE EXCEPTION 'memory_lexical_projection_functions_retained'; END IF;
  IF to_regclass('"MemorySearchEntry"') IS NULL
  THEN RAISE EXCEPTION 'memory_search_entry_dropped'; END IF;
END $$;
ROLLBACK;
`;
