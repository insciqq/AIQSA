export const MEMORY_SEARCH_TIMEOUT_MIGRATION = "20260929180000_memory_search_timeout_policy";

export const memorySearchTimeoutFixtureSql = `
UPDATE "ModelPolicy" SET "memoryAdmissionTimeoutSeconds" = 45, version = 7,
  "updatedAt" = TIMESTAMP '2026-09-01 00:00:00'
WHERE id = 'installation';
INSERT INTO "User" (id, "displayName", status, "updatedAt")
VALUES ('memory-timeout-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt")
VALUES ('memory-timeout-chat', 'memory-timeout-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, status, content, "parentMessageId", "updatedAt")
VALUES ('memory-timeout-question', 'memory-timeout-chat', 'user', 'complete', '{"text":"Synthetic question"}', NULL, now()),
       ('memory-timeout-answer', 'memory-timeout-chat', 'assistant', 'streaming', '{"text":""}', 'memory-timeout-question', now());
INSERT INTO "ModelRun" (id, "chatId", "userId", "userMessageId", "assistantMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt")
VALUES ('memory-timeout-run', 'memory-timeout-chat', 'memory-timeout-owner', 'memory-timeout-question',
        'memory-timeout-answer', 'fake', 'synthetic-model', 'streaming', '{"toolMode":"auto"}', now());
CREATE TABLE "_MemorySearchTimeoutFixture" AS
SELECT to_jsonb(policy) AS policy,
  (SELECT to_jsonb(run) FROM "ModelRun" run WHERE run.id = 'memory-timeout-run') AS run
FROM "ModelPolicy" policy WHERE id = 'installation';
`;

export const memorySearchTimeoutProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy" p CROSS JOIN "_MemorySearchTimeoutFixture" f
    WHERE p.id = 'installation' AND p."memorySearchTimeoutSeconds" = 30 AND p.version = 8
      AND p."updatedAt" > (f.policy->>'updatedAt')::timestamp
      AND (to_jsonb(p) - ARRAY['memorySearchTimeoutSeconds', 'version', 'updatedAt']) =
        (f.policy - ARRAY['memoryAdmissionTimeoutSeconds', 'version', 'updatedAt']))
    THEN RAISE EXCEPTION 'memory_search_timeout_upgrade_changed_other_policy'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" run CROSS JOIN "_MemorySearchTimeoutFixture" f
    WHERE run.id = 'memory-timeout-run' AND to_jsonb(run) - ARRAY['scheduledTaskId', 'scheduledOccurrenceId', 'scheduledTaskGeneration'] = f.run)
    THEN RAISE EXCEPTION 'memory_search_timeout_upgrade_changed_accepted_run'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'ModelPolicy' AND column_name = 'memoryAdmissionTimeoutSeconds') <> 0
    OR (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'ModelPolicy' AND column_name = 'memorySearchTimeoutSeconds') IS DISTINCT FROM '30'
    THEN RAISE EXCEPTION 'memory_search_timeout_upgrade_schema_invalid'; END IF;
  BEGIN
    UPDATE "ModelPolicy" SET "memorySearchTimeoutSeconds" = 0 WHERE id = 'installation';
    RAISE EXCEPTION 'memory_search_timeout_allowed_zero';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ModelPolicy" SET "memorySearchTimeoutSeconds" = 121 WHERE id = 'installation';
    RAISE EXCEPTION 'memory_search_timeout_allowed_121';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE "ModelPolicy" SET "memorySearchTimeoutSeconds" = 45, version = 9 WHERE id = 'installation';
END $$;
`;

export const memorySearchTimeoutRepeatProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelPolicy"
    WHERE id = 'installation' AND "memorySearchTimeoutSeconds" = 45 AND version = 9)
    THEN RAISE EXCEPTION 'memory_search_timeout_repeated_after_operator_edit'; END IF;
END $$;
DROP TABLE "_MemorySearchTimeoutFixture";
`;
