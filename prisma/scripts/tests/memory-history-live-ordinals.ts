export const MEMORY_HISTORY_LIVE_ORDINALS_MIGRATION = "20260918180000_memory_history_live_ordinals";

export const memoryHistoryLiveOrdinalsFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('live-ordinal-owner', 'Fixture owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('live-ordinal-chat', 'live-ordinal-owner', 'Fixture source', now());
INSERT INTO "MemoryRecallChunk" (id, "userId", "chatId", "branchGeneration",
  "sourceRevisionAtCreation", "chunkOrdinal", "contentHash", "safeProjectedText",
  "normalizedSafeSearchText", "languageCode", "occurredFrom", "occurredTo",
  state, "chunkingVersion", "sourceProjectionVersion", "safetyClass", "redactionState", "invalidatedAt")
SELECT 'live-ordinal-' || state, 'live-ordinal-owner', 'live-ordinal-chat', 0, 0, ordinal,
  repeat(ordinal::text, 64), 'Fixture text', 'fixture text', 'en', now(), now(),
  state::"MemoryHistoryItemState", 'fixture-chunk-v1', 'fixture-source-v1', 'NORMAL', 'NOT_NEEDED',
  CASE WHEN state = 'INVALIDATED' THEN now() END
FROM (VALUES ('ACTIVE', 0), ('INVALIDATED', 1)) states(state, ordinal);
CREATE TABLE "MemoryLiveOrdinalFixture" AS
SELECT id, to_jsonb(chunk) AS snapshot FROM "MemoryRecallChunk" chunk WHERE "userId" = 'live-ordinal-owner';
`;

export const memoryHistoryLiveOrdinalsProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "MemoryLiveOrdinalFixture" original
    JOIN "MemoryRecallChunk" chunk USING(id) WHERE original.snapshot = to_jsonb(chunk)) <> 2
  THEN RAISE EXCEPTION 'live_ordinal_changed_historical_identity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'MemoryRecallChunk_source_ordinal_key' AND i.indisunique AND i.indisvalid
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%ACTIVE%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%SUPPRESSED%')
  THEN RAISE EXCEPTION 'live_ordinal_missing_current_uniqueness'; END IF;
END $$;
BEGIN;
INSERT INTO "MemoryRecallChunk" SELECT (jsonb_populate_record(NULL::"MemoryRecallChunk",
  snapshot || jsonb_build_object('id', 'live-ordinal-retired-replacement'))).*
FROM "MemoryLiveOrdinalFixture" WHERE id = 'live-ordinal-INVALIDATED';
DO $$ BEGIN
  BEGIN
    INSERT INTO "MemoryRecallChunk" SELECT (jsonb_populate_record(NULL::"MemoryRecallChunk",
      snapshot || jsonb_build_object('id', 'live-ordinal-duplicate'))).*
    FROM "MemoryLiveOrdinalFixture" WHERE id = 'live-ordinal-ACTIVE';
    RAISE EXCEPTION 'live_ordinal_accepted_active_duplicate';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
ROLLBACK;
`;
