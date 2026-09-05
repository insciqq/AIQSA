-- A classified transcription failure may settle only an already admitted
-- Workspace document as original-only. Ordinary document gates remain strict.
BEGIN;

ALTER TABLE "ChatPdfAttachmentPreparation" DROP CONSTRAINT "ChatPdfAttachmentPreparation_shape";
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_shape" CHECK (
  "route" IN ('direct_pdf', 'system_vision', 'selected_model_vision', 'local_text') AND
  "state" IN ('checking', 'preparing', 'assembling', 'ready', 'original_only', 'failed', 'cancelled') AND
  "sourceChecksum" ~ '^[a-f0-9]{64}$' AND "compatibilityKey" ~ '^[a-f0-9]{64}$' AND
  "sourceByteSize" > 0 AND ("pageCount" IS NULL OR "pageCount" BETWEEN 1 AND 500) AND
  "completedPages" BETWEEN 0 AND COALESCE("pageCount", 0) AND
  (NOT "retryable" OR "state" = 'failed') AND
  ("workPlan" IS NULL OR jsonb_typeof("workPlan") = 'object' AND
    COALESCE(("workPlan"->>'version')::int = 1, false) AND
    jsonb_typeof("workPlan"->'units') = 'array' AND octet_length("workPlan"::text) <= 1048576) AND
  (("route" = 'local_text' AND "providerModelId" IS NULL AND "credentialVersionId" IS NULL
    AND "bindingSnapshot" IS NULL AND "bindingAuthority" IS NULL AND "policyVersion" IS NULL) OR
   ("route" <> 'local_text' AND "providerModelId" IS NOT NULL AND "credentialVersionId" IS NOT NULL
    AND "bindingSnapshot" IS NOT NULL AND "bindingAuthority" IS NOT NULL
    AND jsonb_typeof("bindingSnapshot") = 'object' AND jsonb_typeof("bindingAuthority") = 'object')) AND
  (("route" = 'system_vision' AND "policyVersion" IS NOT NULL AND "policyVersion" >= 1) OR
    ("route" <> 'system_vision' AND "policyVersion" IS NULL)) AND
  ("state" <> 'ready' OR "route" = 'direct_pdf' OR
    "documentArtifactId" IS NOT NULL AND "pageCount" IS NOT NULL AND "completedPages" = "pageCount")
);

CREATE OR REPLACE FUNCTION chat_pdf_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."state" <> OLD."state" AND NOT (
      NEW."state" IN ('failed','cancelled') OR
      OLD."state" IN ('checking','preparing','assembling') AND NEW."state" = 'original_only' OR
      OLD."state" = 'checking' AND NEW."state" = 'preparing' OR
      OLD."state" = 'preparing' AND NEW."state" = 'assembling' OR
      OLD."state" = 'assembling' AND NEW."state" = 'ready'
    ) THEN RAISE EXCEPTION 'chat_pdf_transition_invalid' USING ERRCODE = '23514'; END IF;
    IF (to_jsonb(NEW) - ARRAY['state','pageCount','completedPages','workPlan','localArtifactId',
        'documentArtifactId','errorCode','retryable','updatedAt']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','pageCount','completedPages','workPlan','localArtifactId',
        'documentArtifactId','errorCode','retryable','updatedAt']) OR
       (OLD."workPlan" IS NOT NULL AND NEW."workPlan" IS DISTINCT FROM OLD."workPlan") OR
       (OLD."pageCount" IS NOT NULL AND NEW."pageCount" IS DISTINCT FROM OLD."pageCount") OR
       NEW."completedPages" < OLD."completedPages" OR
       (OLD."state" IN ('ready','original_only','failed','cancelled') AND NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'chat_pdf_preparation_immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Attachment" a
    JOIN "ModelRun" r ON r."id" = NEW."modelRunId"
    JOIN "Chat" c ON c."id" = r."chatId"
    WHERE a."id" = NEW."attachmentId" AND a."kind" = 'pdf'
      AND a."checksum" = NEW."sourceChecksum" AND a."byteSize" = NEW."sourceByteSize"
      AND a."messageId" = r."userMessageId" AND a."chatId" = r."chatId"
      AND ((c."projectId" IS NULL AND a."userId" = r."userId" AND a."projectId" IS NULL)
        OR (c."projectId" IS NOT NULL AND a."projectId" = c."projectId" AND a."userId" IS NULL))
  ) THEN RAISE EXCEPTION 'chat_pdf_scope_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."route" <> 'local_text' AND (
    NEW."bindingSnapshot"->>'providerModelId' IS DISTINCT FROM NEW."providerModelId" OR
    NEW."bindingSnapshot"->>'credentialVersionId' IS DISTINCT FROM NEW."credentialVersionId" OR
    NOT EXISTS (
      SELECT 1 FROM "ProviderModel" m JOIN "ProviderCredentialVersion" v ON v."id" = NEW."credentialVersionId"
      JOIN "ProviderCredential" k ON k."id" = v."credentialId"
      WHERE m."id" = NEW."providerModelId" AND m."connectionId" = k."connectionId"
        AND k."id" = NEW."bindingSnapshot"->>'credentialId'
        AND m."connectionId" = NEW."bindingSnapshot"->>'connectionId'
    )
  ) THEN RAISE EXCEPTION 'chat_pdf_binding_invalid' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."route" = 'system_vision' AND NOT EXISTS (
    SELECT 1 FROM "SystemModelPolicy" p WHERE p."id" = 'installation'
      AND p."chatPdfPreparationAllowed" AND p."version" = NEW."policyVersion"
      AND p."chatPdfProviderModelId" = NEW."providerModelId"
  ) THEN RAISE EXCEPTION 'chat_pdf_policy_changed' USING ERRCODE = '23514'; END IF;
  IF NEW."route" IN ('direct_pdf','selected_model_vision') AND NOT EXISTS (
    SELECT 1 FROM "ProviderRunBinding" b WHERE b."modelRunId" = NEW."modelRunId" AND b."role" = 'answer'
      AND b."providerModelId" = NEW."providerModelId" AND b."credentialVersionId" = NEW."credentialVersionId"
      AND b."executionSnapshot" = NEW."bindingSnapshot"
  ) THEN RAISE EXCEPTION 'chat_pdf_answer_binding_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."workPlan" IS NOT NULL AND (
    (NEW."workPlan"->>'pageCount')::int IS DISTINCT FROM NEW."pageCount" OR
    NEW."workPlan"->>'compatibilityKey' IS DISTINCT FROM NEW."compatibilityKey" OR
    jsonb_array_length(NEW."workPlan"->'units') IS DISTINCT FROM NEW."pageCount" OR
    EXISTS (SELECT 1 FROM generate_series(1, NEW."pageCount") page_number WHERE
      (SELECT count(*) FROM jsonb_array_elements(NEW."workPlan"->'units') unit
        WHERE (unit->>'page')::int = page_number AND unit->>'route' IN ('native_only','vision_required')
          AND unit->>'key' ~ '^[a-f0-9]{64}$') <> 1)
  ) THEN RAISE EXCEPTION 'chat_pdf_plan_invalid' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM "ChatPdfArtifact" a
    WHERE a."id" IN (NEW."localArtifactId", NEW."documentArtifactId") AND
      (a."attachmentId" <> NEW."attachmentId" OR a."sourceChecksum" <> NEW."sourceChecksum"
        OR a."route" <> NEW."route" OR a."state" <> 'ready'
        OR a."preparationGeneration" <> NEW."modelRunId" OR a."pageCount" <> NEW."pageCount"
        OR (a."id" = NEW."localArtifactId" AND a."kind" <> 'local')
        OR (a."id" = NEW."documentArtifactId" AND a."kind" <> 'document'))
  ) THEN RAISE EXCEPTION 'chat_pdf_artifact_scope_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."state" = 'original_only' AND (
    NEW."route" = 'direct_pdf' OR NEW."documentArtifactId" IS NOT NULL OR NEW."retryable" OR
    NEW."errorCode" IS NULL OR NEW."errorCode" NOT IN ('pdf_local_text_unusable','pdf_transcription_failed') OR
    NOT EXISTS (SELECT 1 FROM "WorkspaceRunBinding" w JOIN "ModelRun" r ON r."id" = w."modelRunId"
      WHERE w."modelRunId" = NEW."modelRunId" AND r."status" = 'preparing')
  ) THEN RAISE EXCEPTION 'chat_pdf_workspace_original_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION chat_pdf_answer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('queued','streaming','in_progress') AND EXISTS (
    SELECT 1 FROM "ChatPdfAttachmentPreparation" p WHERE p."modelRunId" = NEW."id"
      AND p."route" <> 'direct_pdf' AND NOT (p."state" = 'ready' OR
        p."state" = 'original_only' AND EXISTS (
          SELECT 1 FROM "WorkspaceRunBinding" w WHERE w."modelRunId" = NEW."id"))
  ) THEN RAISE EXCEPTION 'chat_pdf_answer_not_ready' USING ERRCODE = '23514'; END IF;
  IF OLD."status" = 'preparing' AND NEW."status" IN ('queued','streaming','in_progress')
    AND EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" WHERE "modelRunId" = NEW."id")
    AND EXISTS (SELECT 1 FROM "Chat" WHERE "id" = NEW."chatId" AND "projectId" IS NULL AND "memoryMode" <> 'TEMPORARY')
    AND NOT EXISTS (SELECT 1 FROM "ModelRunMemoryBinding" WHERE "modelRunId" = NEW."id") THEN
    RAISE EXCEPTION 'chat_pdf_memory_not_ready' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.aiqsa_memory_assert_run_preparation(p_run_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run_status "ModelRunStatus";
  live_attempt_count integer;
  pdf_state text;
  pending_pdf_count integer;
  pdf_count integer;
BEGIN
  SELECT "status" INTO run_status FROM "ModelRun" WHERE "id" = p_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) INTO live_attempt_count FROM "MemoryRetrievalAttempt"
    WHERE "modelRunId" = p_run_id AND "state" IN ('PENDING','EXECUTING','READY');
  SELECT "state" INTO pdf_state FROM "ChatPdfRunPreparation" WHERE "modelRunId" = p_run_id;
  IF pdf_state IN ('pending','preparing','answer_ready') THEN
    SELECT count(*), count(*) FILTER (WHERE NOT ("state" = 'ready' OR
      "state" = 'original_only' AND EXISTS (SELECT 1 FROM "WorkspaceRunBinding" w WHERE w."modelRunId" = p_run_id)))
      INTO pdf_count, pending_pdf_count FROM "ChatPdfAttachmentPreparation" WHERE "modelRunId" = p_run_id;
    IF pdf_count = 0 OR live_attempt_count > 1 OR
      (pending_pdf_count > 0 AND live_attempt_count <> 0) OR
      (run_status = 'preparing' AND pdf_state = 'answer_ready') OR
      (run_status <> 'preparing' AND (pdf_state <> 'answer_ready' OR pending_pdf_count <> 0 OR live_attempt_count <> 0)) THEN
      RAISE EXCEPTION 'chat_pdf_preparation_gate_invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF run_status = 'preparing' AND live_attempt_count <> 1 THEN
    RAISE EXCEPTION 'preparing_run_requires_durable_gate' USING ERRCODE = '23514';
  ELSIF run_status <> 'preparing' AND live_attempt_count <> 0 THEN
    RAISE EXCEPTION 'dispatchable_run_has_live_memory_gate' USING ERRCODE = '23514';
  END IF;
END $$;

COMMIT;
