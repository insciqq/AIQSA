/** Synthetic predecessor state; the caller owns disposable database guards. */
export const GEMINI_GROUNDING_MIGRATION = "20260905070000_durable_gemini_grounding";

export const geminiGroundingAdoptionFixtureSql = `
BEGIN;
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('grounding-adoption-owner', 'Fixture owner', 'active', now());
DO $$
DECLARE lifecycle text; prefix text;
BEGIN
  FOREACH lifecycle IN ARRAY ARRAY['complete','error','cancelled','queued','streaming','in_progress'] LOOP
    prefix := 'grounding-adoption-' || lifecycle;
    INSERT INTO "Chat" (id, "userId", title, "memoryMode", "updatedAt")
    VALUES (prefix, 'grounding-adoption-owner', 'Fixture chat', 'EXCLUDED', now());
    INSERT INTO "Message" (id, "chatId", role, content, status, "updatedAt")
    VALUES (prefix || '-q', prefix, 'user', '{"blocks":[{"type":"text","text":"Fixture question"}]}', 'complete', now());
    INSERT INTO "Message" (id, "chatId", "parentMessageId", role, content, status,
      "groundedAt", "groundingProvider", "groundingStrategy", "updatedAt")
    VALUES (prefix || '-a', prefix, prefix || '-q', 'assistant',
      '{"blocks":[{"type":"text","text":"Grounded answer was not retained."}]}',
      CASE WHEN lifecycle = 'in_progress' THEN 'streaming' ELSE lifecycle END::"MessageStatus",
      now(), 'gemini', 'gemini-google-search', now());
    INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId",
      provider, "modelId", status, "normalizedRequest", "updatedAt")
    VALUES (prefix || '-run', prefix, 'grounding-adoption-owner', prefix || '-q', prefix || '-a',
      'gemini', 'fixture', lifecycle::"ModelRunStatus", '{"accepted":"unchanged"}', now());
    UPDATE "Chat" SET "activeLeafMessageId" = prefix || '-a' WHERE id = prefix;
  END LOOP;
END $$;
INSERT INTO "Message" (id, "chatId", "parentMessageId", role, content, status, "updatedAt")
VALUES ('grounding-adoption-ordinary', 'grounding-adoption-complete', 'grounding-adoption-complete-q',
  'assistant', '{"blocks":[{"type":"text","text":"Ordinary retained answer"}]}', 'complete', now());
INSERT INTO "ChatMemoryCheckpoint" (id, "userId", "chatId", "activeLeafMessageId", "branchGeneration",
  "sourceRevision", "sourceContentHash", "pipelineVersion", status, "updatedAt")
VALUES ('grounding-adoption-checkpoint', 'grounding-adoption-owner', 'grounding-adoption-complete',
  'grounding-adoption-complete-a', 0, 0, repeat('a',64), 'memory-history-incremental-v7', 'PENDING', now());
COMMIT;
`;

export const geminiGroundingAdoptionProofSql = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'Message' AND column_name IN ('groundedAt','groundingProvider','groundingStrategy')) THEN
    RAISE EXCEPTION 'obsolete_grounding_provenance_survived';
  END IF;
  IF (SELECT count(*) FROM "ModelRun" WHERE id LIKE 'grounding-adoption-%'
    AND status = 'error' AND "errorPayload"->>'recoveryTerminal' = 'true') <> 4 THEN
    RAISE EXCEPTION 'legacy_grounding_replay_not_fenced';
  END IF;
  IF (SELECT count(*) FROM "ModelRun" WHERE id LIKE 'grounding-adoption-%'
    AND status IN ('complete','cancelled')) <> 2 THEN
    RAISE EXCEPTION 'terminal_grounding_status_changed';
  END IF;
  IF (SELECT count(*) FROM "Message" WHERE id LIKE 'grounding-adoption-%-a'
    AND content->'blocks'->0->>'text' = 'Grounded answer was not retained.') <> 6 THEN
    RAISE EXCEPTION 'discarded_answer_was_fabricated';
  END IF;
  IF EXISTS (SELECT 1 FROM "Message" WHERE id LIKE 'grounding-adoption-%-a'
    AND status IN ('queued','streaming')) THEN RAISE EXCEPTION 'legacy_message_left_active'; END IF;
  IF EXISTS (SELECT 1 FROM "ModelRun" WHERE id LIKE 'grounding-adoption-%'
    AND "normalizedRequest" <> '{"accepted":"unchanged"}'::jsonb) THEN
    RAISE EXCEPTION 'accepted_request_changed';
  END IF;
  IF (SELECT content->'blocks'->0->>'text' FROM "Message" WHERE id = 'grounding-adoption-ordinary')
    <> 'Ordinary retained answer' THEN RAISE EXCEPTION 'ordinary_answer_changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChatMemoryCheckpoint" WHERE id = 'grounding-adoption-checkpoint'
    AND status = 'STALE' AND "pipelineVersion" = 'memory-history-rebuild-required-v5') THEN
    RAISE EXCEPTION 'old_memory_proof_relabelled';
  END IF;
END $$;
`;
