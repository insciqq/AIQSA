/** Synthetic projection rows of the previous release; migration-contract owns the disposable database. */
export const STOP_MEMORY_LEXICAL_PROJECTION_CAPTURE_MIGRATION =
  "20261023200000_stop_memory_lexical_projection_capture";

// Rows the previous release's capture triggers and purge path left behind. The
// tables have no foreign keys, so no Memory owner is needed.
export const stopMemoryLexicalProjectionCaptureFixtureSql = `
INSERT INTO "MemoryLexicalProjectionEvent" (id, "userId", "indexGenerationId", "searchEntryId", operation,
  "memoryRevisionSnapshot", "idempotencyFingerprint")
VALUES ('00000000-0000-4000-8000-0000000000a1', 'projection-capture-owner', 'projection-capture-generation',
  'projection-capture-entry', 'SYNC_ENTRY', 3, 'projection-capture-sync');
INSERT INTO "MemoryLexicalProjectionState" ("userId", "indexGenerationId", "backendKind", "mappingVersion",
  "normalizationVersion", "analysisProfile", "retrievalPipelineVersion", status, "enqueuedThroughSequence",
  "targetMemoryRevision")
SELECT 'projection-capture-owner', 'projection-capture-generation', 'retired_lexical_backend_v1',
  'memory-lexical-mapping-v1', 'memory-unicode-query-analysis-v1', 'memory-unicode-icu-v1',
  'memory-personal-retrieval-v63', 'CATCHING_UP', max(sequence), 3
FROM "MemoryLexicalProjectionEvent" WHERE "userId" = 'projection-capture-owner';
`;

/** Capture is off and its functions are gone; the rows stay, and the
 * previous release's explicit account purge still enqueues through the
 * retained function. Runs in a rolled-back transaction, so it also proves a
 * repeated deploy. */
export const stopMemoryLexicalProjectionCaptureProofSql = `
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'MemorySearchEntry_lexical_projection_insert', 'MemorySearchEntry_lexical_projection_update',
      'MemorySearchEntry_lexical_projection_delete', 'MemoryIndexGeneration_lexical_projection_purge'))
    OR to_regprocedure('aiqsa_capture_memory_lexical_projection()') IS NOT NULL
    OR to_regprocedure('aiqsa_capture_memory_generation_purge()') IS NOT NULL
    OR to_regprocedure('aiqsa_memory_lexical_revision(text,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'memory_lexical_projection_capture_retained'; END IF;
  IF (SELECT count(*) FROM "MemoryLexicalProjectionEvent" WHERE "userId" = 'projection-capture-owner') <> 1
    OR (SELECT count(*) FROM "MemoryLexicalProjectionState" WHERE "userId" = 'projection-capture-owner'
      AND status = 'CATCHING_UP' AND "targetMemoryRevision" = 3) <> 1
  THEN RAISE EXCEPTION 'memory_lexical_projection_rows_not_preserved'; END IF;
  PERFORM aiqsa_enqueue_memory_lexical_projection_event(
    'projection-capture-owner', NULL, NULL, 'PURGE_USER', 4);
  IF NOT EXISTS (SELECT 1 FROM "MemoryLexicalProjectionEvent" WHERE "userId" = 'projection-capture-owner'
      AND operation = 'PURGE_USER' AND state = 'PENDING')
  THEN RAISE EXCEPTION 'memory_lexical_projection_previous_purge_refused'; END IF;
END $$;
ROLLBACK;
`;
