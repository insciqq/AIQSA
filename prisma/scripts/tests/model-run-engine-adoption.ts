export const MODEL_RUN_ENGINE_MIGRATION = "20261023120000_model_run_engine";

const runColumns = `id, "userId", "chatId", "userMessageId", provider, "modelId", status, "normalizedRequest", "updatedAt"`;

// An answer the previous release is still streaming while the migration runs.
export const modelRunEngineFixtureSql = `
INSERT INTO "User" (id, "displayName", status, "updatedAt") VALUES ('engine-owner', 'Synthetic owner', 'active', now());
INSERT INTO "Chat" (id, "userId", title, "updatedAt") VALUES ('engine-chat', 'engine-owner', 'Synthetic chat', now());
INSERT INTO "Message" (id, "chatId", role, content, "updatedAt")
VALUES ('engine-question', 'engine-chat', 'user', '{"blocks":[{"type":"text","text":"Synthetic question"}]}', now());
INSERT INTO "ModelRun" (${runColumns})
VALUES ('engine-in-flight', 'engine-owner', 'engine-chat', 'engine-question', 'fake', 'fake-qsa', 'streaming', '{}', now());
CREATE TABLE "_ModelRunEngineFixture" AS SELECT to_jsonb(run) AS run FROM "ModelRun" run WHERE id = 'engine-in-flight';
`;

// The in-flight run becomes an old-core run and is otherwise unchanged. The
// previous release keeps settling runs and starting new ones without naming the
// column; one active run per chat holds across engines; only known engines fit.
export const modelRunEngineProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" run CROSS JOIN "_ModelRunEngineFixture" f
      WHERE run.id = 'engine-in-flight' AND run.engine = 'v1' AND to_jsonb(run) - 'engine' = f.run)
    THEN RAISE EXCEPTION 'model_run_engine_changed_in_flight_run'; END IF;
END $$;
BEGIN;
UPDATE "ModelRun" SET status = 'complete' WHERE id = 'engine-in-flight';
INSERT INTO "ModelRun" (${runColumns})
VALUES ('engine-previous-writer', 'engine-owner', 'engine-chat', 'engine-question', 'fake', 'fake-qsa', 'streaming', '{}', now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ModelRun" WHERE id = 'engine-previous-writer' AND engine = 'v1')
    THEN RAISE EXCEPTION 'model_run_engine_previous_writer_not_v1'; END IF;
  BEGIN
    INSERT INTO "ModelRun" (${runColumns}, engine)
    VALUES ('engine-native-beside', 'engine-owner', 'engine-chat', 'engine-question', 'fake', 'fake-qsa', 'streaming', '{}', now(), 'native');
    RAISE EXCEPTION 'model_run_engine_second_active_run_accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE "ModelRun" SET engine = 'unknown' WHERE id = 'engine-previous-writer';
    RAISE EXCEPTION 'model_run_engine_unknown_value_accepted';
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
END $$;
ROLLBACK;
`;
