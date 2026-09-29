export const MEMORY_SEARCH_RECEIPT_MIGRATION = "20260929181000_memory_search_receipts";

export const memorySearchReceiptFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-receipt-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('memory-receipt-chat', 'memory-receipt-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('memory-receipt-question', 'memory-receipt-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
       ('memory-receipt-answer', 'memory-receipt-chat', 'assistant', 'streaming', '{"text":""}', 'memory-receipt-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('memory-receipt-run', 'memory-receipt-chat', 'memory-receipt-owner', 'memory-receipt-question',
        'memory-receipt-answer', 'fake', 'synthetic-model', 'streaming', '{}', now());
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, result, "updatedAt")
VALUES ('memory-receipt-legacy-call', 'memory-receipt-run', 1, 0, 'legacy-call', 'memory_search', '{}', 'complete', '{}', now());
INSERT INTO "MemoryHistoryRun" (id, "userId", "modelRunId", "modelRunToolCallId", "invocationOrdinal",
  query, "queryHash", "privateRequest", "indexingEvidence", state)
VALUES ('memory-receipt-legacy', 'memory-receipt-owner', 'memory-receipt-run', 'memory-receipt-legacy-call', 1,
  'Synthetic legacy query', repeat('a',64), '{}', '{}', 'RUNNING');
CREATE TABLE "_MemoryReceiptFixture" AS
SELECT to_jsonb(receipt) AS receipt FROM "MemoryHistoryRun" receipt WHERE id = 'memory-receipt-legacy';
`;

export const memorySearchReceiptProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryHistoryRun" receipt CROSS JOIN "_MemoryReceiptFixture" fixture
    WHERE receipt.id = 'memory-receipt-legacy' AND receipt."receiptVersion" IS NULL
      AND to_jsonb(receipt) - 'receiptVersion' = fixture.receipt)
    THEN RAISE EXCEPTION 'memory_search_receipt_upgrade_changed_legacy'; END IF;
  BEGIN
    UPDATE "MemoryHistoryRun" SET "invocationOrdinal" = 3 WHERE id = 'memory-receipt-legacy';
    RAISE EXCEPTION 'memory_search_receipt_weakened_legacy_limit';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, result, "updatedAt")
VALUES ('memory-receipt-native-call', 'memory-receipt-run', 1, 1, 'native-call', 'memory_search', '{}', 'complete', '{}', now()),
       ('memory-receipt-other-call', 'memory-receipt-run', 1, 2, 'other-call', 'memory_search', '{}', 'complete', '{}', now());
INSERT INTO "MemoryHistoryRun" (id, "userId", "modelRunId", "modelRunToolCallId", "receiptVersion", "invocationOrdinal",
  query, "queryHash", "privateRequest", "indexingEvidence", state, outcome, "completedAt", "durationMs",
  "resultCount", results, "providerResult", "resultHash")
VALUES ('memory-receipt-native', 'memory-receipt-owner', 'memory-receipt-run', 'memory-receipt-native-call',
  'memory-search-v1', 3, repeat('x',1000), repeat('b',64), '{"version":"memory-search-v1"}', '{"delivered":true}',
  'COMPLETE', 'DEGRADED', now(), 10, 1,
  '{"version":"memory-search-v1","results":[{"exactItemId":"synthetic-version","itemType":"FACT_VERSION","factVersionId":"synthetic-version"}]}',
  '{}', repeat('c',64));
DO $$ BEGIN
  BEGIN
    UPDATE "MemoryHistoryRun" SET "invocationOrdinal" = 4 WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_fourth_call';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET "resultCount" = 31 WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_31_results';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET "resultCount" = 0 WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_count_mismatch';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET query = repeat('x', 2001) WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_long_query';
  EXCEPTION WHEN check_violation OR string_data_right_truncation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET "receiptVersion" = 'future' WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_unknown_version';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET "privateRequest" = '{}'::jsonb WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_missing_request_version';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "MemoryHistoryRun" SET results = '{"results":[{}]}'::jsonb WHERE id = 'memory-receipt-native';
    RAISE EXCEPTION 'memory_search_receipt_allowed_missing_results_version';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO "MemoryScope" (id, "userId", "scopeType")
  VALUES ('memory-receipt-scope', 'memory-receipt-owner', 'GLOBAL_USER');
  INSERT INTO "MemoryFact" (id, "userId", "scopeId", "canonicalKey", category, "currentVersionId")
  VALUES ('memory-receipt-fact', 'memory-receipt-owner', 'memory-receipt-scope',
    'synthetic.preference', 'general', 'memory-receipt-version');
  INSERT INTO "MemoryEvent" (id, "userId", operation, "actorType", "actorUserId")
  VALUES ('memory-receipt-save-event', 'memory-receipt-owner', 'EXPLICIT_SAVE', 'USER', 'memory-receipt-owner');
  INSERT INTO "MemoryFactVersion" (id, "userId", "factId", "displayText", "normalizedSearchText",
    "languageCode", "structuredValue", category, modality, "sourceMode", confidence, importance,
    directness, "sensitivityClass", "createdByEventId", "pipelineVersion")
  VALUES ('memory-receipt-version', 'memory-receipt-owner', 'memory-receipt-fact', 'Synthetic preference',
    'synthetic preference', 'en', '{}'::jsonb, 'general', 'PREFERENCE', 'EXPLICIT', 1, 0.5,
    'DIRECT', 'NORMAL', 'memory-receipt-save-event', 'synthetic-v1');
  UPDATE "MemoryHistoryRun" SET results =
    '{"version":"memory-search-v1","results":[{"exactItemId":"memory-receipt-version","itemType":"FACT_VERSION","factVersionId":"memory-receipt-version"}]}'::jsonb
    WHERE id = 'memory-receipt-native';
  INSERT INTO "MemoryEvent" (id, "userId", operation, "actorType", "actorUserId",
    "factId", "factVersionId", metadata)
  VALUES ('memory-receipt-feedback-event', 'memory-receipt-owner', 'USER_FEEDBACK', 'USER',
    'memory-receipt-owner', 'memory-receipt-fact', 'memory-receipt-version',
    '{"schemaVersion":"memory-feedback-event-v1","feedbackId":"memory-receipt-feedback","feedbackType":"NOT_USEFUL"}'::jsonb);
  BEGIN
    INSERT INTO "MemoryFeedback" (id, "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId", "modelRunToolCallId", "memoryEventId")
    VALUES ('memory-receipt-feedback', 'memory-receipt-owner', repeat('d',64), 'synthetic-request',
      'NOT_USEFUL', 'FACT_VERSION', 'memory-receipt-fact', 'memory-receipt-version',
      'memory-receipt-run', 'memory-receipt-other-call', 'memory-receipt-feedback-event');
    RAISE EXCEPTION 'memory_search_feedback_accepted_undelivered_call';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "MemoryHistoryRun" SET "indexingEvidence" = '{"delivered":false}'::jsonb
    WHERE id = 'memory-receipt-native';
  BEGIN
    INSERT INTO "MemoryFeedback" (id, "userId", "idempotencyFingerprint", "requestId", "feedbackType",
      "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId", "modelRunToolCallId", "memoryEventId")
    VALUES ('memory-receipt-feedback', 'memory-receipt-owner', repeat('d',64), 'synthetic-request',
      'NOT_USEFUL', 'FACT_VERSION', 'memory-receipt-fact', 'memory-receipt-version',
      'memory-receipt-run', 'memory-receipt-native-call', 'memory-receipt-feedback-event');
    RAISE EXCEPTION 'memory_search_feedback_accepted_undelivered_evidence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "MemoryHistoryRun" SET "indexingEvidence" = '{"delivered":true}'::jsonb
    WHERE id = 'memory-receipt-native';
  INSERT INTO "MemoryFeedback" (id, "userId", "idempotencyFingerprint", "requestId", "feedbackType",
    "targetKind", "memoryFactId", "memoryFactVersionId", "modelRunId", "modelRunToolCallId", "memoryEventId")
  VALUES ('memory-receipt-feedback', 'memory-receipt-owner', repeat('d',64), 'synthetic-request',
    'NOT_USEFUL', 'FACT_VERSION', 'memory-receipt-fact', 'memory-receipt-version',
    'memory-receipt-run', 'memory-receipt-native-call', 'memory-receipt-feedback-event');
  UPDATE "MemoryHistoryRun" SET query = NULL, "privateRequest" = '{}', results = NULL,
    "providerResult" = NULL, "resultHash" = NULL, "retentionState" = 'SCRUBBED',
    "plaintextPurgedAt" = now() WHERE id = 'memory-receipt-native';
  IF NOT EXISTS (SELECT 1 FROM "MemoryHistoryRun" WHERE id = 'memory-receipt-native'
    AND "receiptVersion" = 'memory-search-v1' AND "invocationOrdinal" = 3
    AND "resultCount" = 1 AND "retentionState" = 'SCRUBBED')
    THEN RAISE EXCEPTION 'memory_search_receipt_scrubbed_shape_invalid'; END IF;
END $$;
`;

export const memorySearchReceiptRepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "MemoryHistoryRun" WHERE id = 'memory-receipt-native'
    AND "receiptVersion" = 'memory-search-v1' AND "retentionState" = 'SCRUBBED')
    THEN RAISE EXCEPTION 'memory_search_receipt_repeated_migration_changed_receipt'; END IF;
END $$;
DROP TABLE "_MemoryReceiptFixture";
`;
