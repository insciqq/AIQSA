export const TOOL_OBSERVATION_MIGRATION = "20260924130000_tool_observations";

export const toolObservationFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('observation-adoption-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('observation-adoption-chat', 'observation-adoption-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('observation-adoption-question', 'observation-adoption-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
       ('observation-adoption-answer', 'observation-adoption-chat', 'assistant', 'streaming', '{"text":""}', 'observation-adoption-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('observation-adoption-run', 'observation-adoption-chat', 'observation-adoption-owner', 'observation-adoption-question',
        'observation-adoption-answer', 'fake', 'synthetic-model', 'streaming', '{"toolMode":"auto"}', now());
INSERT INTO "ModelRunToolCall" (id, "modelRunId", "roundIndex", ordinal, "providerCallId", "toolName", arguments, state, result, "updatedAt")
VALUES ('observation-adoption-call', 'observation-adoption-run', 1, 0, 'synthetic-call', 'synthetic_tool', '{}', 'complete',
        '{"callId":"synthetic-call","name":"synthetic_tool","status":"complete","content":[{"type":"text","text":"accepted inline bytes"}]}', now());
CREATE TABLE "_ObservationUpgradeFixture" AS
SELECT to_jsonb(r) AS run, to_jsonb(c) AS call FROM "ModelRun" r JOIN "ModelRunToolCall" c ON c."modelRunId" = r.id
WHERE r.id = 'observation-adoption-run';
`;

export const toolObservationProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "_ObservationUpgradeFixture" f
    JOIN "ModelRun" r ON r.id = 'observation-adoption-run'
    JOIN "ModelRunToolCall" c ON c.id = 'observation-adoption-call'
    WHERE f.run = to_jsonb(r) AND f.call = to_jsonb(c))
    THEN RAISE EXCEPTION 'observation_upgrade_changed_accepted_inline_result'; END IF;
  IF EXISTS (SELECT 1 FROM "ToolObservation")
    THEN RAISE EXCEPTION 'observation_upgrade_invented_receipt'; END IF;
END $$;
INSERT INTO "ToolObservation" (id, "modelRunId", "toolCallId", "sourceKind", state, "executionOutcome", "reservedBytes",
  "byteSize", checksum, "storageMode", "inlineText", "updatedAt")
VALUES (repeat('a',32), 'observation-adoption-run', 'observation-adoption-call', 'workspace', 'READY', 'complete',
        2, 2, repeat('a',64), 'INLINE', '{}', now());
DO $$ BEGIN
  BEGIN
    UPDATE "ToolObservation" SET "inlineText" = '[]' WHERE id = repeat('a',32);
    RAISE EXCEPTION 'observation_original_was_mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'tool_observation_original_immutable' THEN RAISE; END IF;
  END;
END $$;
DROP TABLE "_ObservationUpgradeFixture";
`;
