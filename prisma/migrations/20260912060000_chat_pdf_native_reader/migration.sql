-- Preserve the existing vision assignment and explicit page-image fallback.
-- Native PDF reading is independent and intentionally starts unassigned.
BEGIN;
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "chatPdfNativeProviderModelId" TEXT,
  ADD COLUMN "chatPdfNativeReasoningEffort" VARCHAR(32);
CREATE INDEX "SystemModelPolicy_chatPdfNativeProviderModelId_idx" ON "SystemModelPolicy"("chatPdfNativeProviderModelId");
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_chatPdfNativeProviderModelId_fkey"
  FOREIGN KEY ("chatPdfNativeProviderModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SystemModelPolicy" ADD CONSTRAINT "SystemModelPolicy_chatPdfNativeReasoning_shape" CHECK (
  "chatPdfNativeReasoningEffort" IS NULL OR "chatPdfNativeProviderModelId" IS NOT NULL AND length("chatPdfNativeReasoningEffort") BETWEEN 1 AND 32
    AND btrim("chatPdfNativeReasoningEffort") = "chatPdfNativeReasoningEffort" AND "chatPdfNativeReasoningEffort" !~ '[[:cntrl:]]'
);
ALTER TABLE "ChatPdfAttachmentPreparation"
  ADD COLUMN "processingMode" VARCHAR(32), ADD COLUMN "fallbackMethod" VARCHAR(32),
  ADD COLUMN "answerModelName" VARCHAR(256), ADD COLUMN "readerModelName" VARCHAR(256);
-- Null policy fields belong to accepted historical rows and the previous writer
-- during the short replacement window; new admission always freezes the policy.
ALTER TABLE "ChatPdfAttachmentPreparation" DROP CONSTRAINT "ChatPdfAttachmentPreparation_shape";
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_shape" CHECK (
  "route" IN ('direct_pdf', 'system_pdf', 'system_vision', 'selected_model_vision', 'local_text') AND
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
  (("route" IN ('system_pdf','system_vision') AND "policyVersion" IS NOT NULL AND "policyVersion" >= 1) OR
    ("route" = 'direct_pdf' AND (("processingMode" IS NULL AND "policyVersion" IS NULL) OR "processingMode" IS NOT NULL AND "policyVersion" >= 1)) OR
    ("route" IN ('selected_model_vision','local_text') AND "policyVersion" IS NULL)) AND
  (("processingMode" IS NULL AND "fallbackMethod" IS NULL AND "route" <> 'system_pdf') OR
    ("processingMode" IS NOT NULL AND "fallbackMethod" IS NOT NULL AND "policyVersion" IS NOT NULL AND
      "processingMode" IN ('prefer_chat_model','use_pdf_reader','read_page_images') AND "fallbackMethod" IN ('pdf_reader','page_images') AND
      (("processingMode" = 'prefer_chat_model' AND ("route" = 'direct_pdf' OR
        "fallbackMethod" = 'pdf_reader' AND "route" = 'system_pdf' OR "fallbackMethod" = 'page_images' AND "route" = 'system_vision')) OR
       "processingMode" = 'use_pdf_reader' AND "route" = 'system_pdf' OR
       "processingMode" = 'read_page_images' AND "route" = 'system_vision'))) AND
  ("state" <> 'ready' OR "route" = 'direct_pdf' OR
    "documentArtifactId" IS NOT NULL AND "pageCount" IS NOT NULL AND "completedPages" = "pageCount")
);
ALTER TABLE "ChatPdfArtifact" DROP CONSTRAINT "ChatPdfArtifact_shape";
ALTER TABLE "ChatPdfArtifact" ADD CONSTRAINT "ChatPdfArtifact_shape" CHECK (
  "kind" IN ('local', 'page', 'document') AND "state" IN ('reserved', 'ready') AND
  "route" IN ('system_pdf', 'system_vision', 'selected_model_vision', 'local_text') AND
  "sourceChecksum" ~ '^[a-f0-9]{64}$' AND "checksum" ~ '^[a-f0-9]{64}$' AND
  "pageCount" BETWEEN 1 AND 500 AND "byteSize" BETWEEN 1 AND 33554432 AND
  "storageKey" = 'chat-pdf/' || "attachmentId" || '/' || "preparationGeneration" || '/' || "id" || '.json'
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
  IF TG_OP = 'INSERT' AND (NEW."processingMode" IS NOT NULL OR NEW."route" = 'system_vision') AND NOT EXISTS (
    SELECT 1 FROM "SystemModelPolicy" p WHERE p."id" = 'installation' AND p."version" = NEW."policyVersion"
      AND (NEW."processingMode" IS NULL OR (p."chatPdfProcessingMode"::text = upper(NEW."processingMode")
        AND p."chatPdfFallbackMethod"::text = upper(NEW."fallbackMethod")))
      AND (NEW."route" = 'direct_pdf' OR NEW."route" = 'system_vision' AND p."chatPdfProviderModelId" = NEW."providerModelId"
        OR NEW."route" = 'system_pdf' AND p."chatPdfNativeProviderModelId" = NEW."providerModelId")
  ) THEN RAISE EXCEPTION 'chat_pdf_policy_changed' USING ERRCODE = '23514'; END IF;
  IF NEW."route" = 'system_pdf' AND NEW."bindingSnapshot"->'model'->'capabilities'->>'nativePdfInput' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'chat_pdf_binding_invalid' USING ERRCODE = '23514';
  END IF;
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
        WHERE (unit->>'page')::int = page_number AND (NEW."route" = 'system_pdf' AND unit->>'route' = 'pdf_required' OR
          NEW."route" <> 'system_pdf' AND unit->>'route' IN ('native_only','vision_required'))
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

CREATE OR REPLACE FUNCTION chat_pdf_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - ARRAY['state','resultArtifactId','usage','errorCode','dispatchedAt','settledAt','updatedAt'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','resultArtifactId','usage','errorCode','dispatchedAt','settledAt','updatedAt']) OR
    OLD."state" = 'settled' AND NEW IS DISTINCT FROM OLD OR
    OLD."state" IN ('dispatched','ambiguous') AND NEW."state" = 'reserved' OR
    OLD."state" = 'ambiguous' AND NEW."state" = 'dispatched' OR
    OLD."state" = 'reserved' AND NEW."state" = 'settled'
  ) THEN RAISE EXCEPTION 'chat_pdf_attempt_immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChatPdfAttachmentPreparation" p
    WHERE p."id" = NEW."preparationId" AND p."route" IN ('system_pdf','system_vision','selected_model_vision')
      AND p."workPlan" IS NOT NULL AND NEW."page" <= p."pageCount"
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."workPlan"->'units') u
        WHERE (u->>'page')::int = NEW."page" AND u->>'key' = NEW."workKey"
          AND (p."route" = 'system_pdf' AND u->>'route' = 'pdf_required' OR
            p."route" <> 'system_pdf' AND u->>'route' = 'vision_required'))) THEN
    RAISE EXCEPTION 'chat_pdf_attempt_work_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."resultArtifactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfArtifact" a JOIN "ChatPdfAttachmentPreparation" p ON p."id" = NEW."preparationId"
    WHERE a."id" = NEW."resultArtifactId" AND a."attachmentId" = p."attachmentId"
      AND a."sourceChecksum" = p."sourceChecksum" AND a."route" = p."route"
      AND a."kind" = 'page' AND a."state" = 'ready'
  ) THEN RAISE EXCEPTION 'chat_pdf_attempt_result_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."reusedFromAttemptId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfPageAttempt" prior
    JOIN "ChatPdfAttachmentPreparation" original ON original."id" = prior."preparationId"
    JOIN "ChatPdfAttachmentPreparation" current ON current."id" = NEW."preparationId"
    WHERE prior."id" = NEW."reusedFromAttemptId" AND prior."state" = 'settled' AND prior."errorCode" IS NULL
      AND prior."resultArtifactId" = NEW."resultArtifactId" AND prior."page" = NEW."page"
      AND prior."requestDigest" = NEW."requestDigest" AND prior."workKey" = NEW."workKey"
      AND original."attachmentId" = current."attachmentId" AND original."sourceChecksum" = current."sourceChecksum"
      AND original."compatibilityKey" = current."compatibilityKey"
  ) THEN RAISE EXCEPTION 'chat_pdf_attempt_reuse_invalid' USING ERRCODE = '23514'; END IF;
  IF NEW."resultArtifactId" IS NOT NULL AND NEW."reusedFromAttemptId" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfArtifact" a JOIN "ChatPdfAttachmentPreparation" p ON p."id" = NEW."preparationId"
    WHERE a."id" = NEW."resultArtifactId" AND a."preparationGeneration" = p."modelRunId"
  ) THEN RAISE EXCEPTION 'chat_pdf_attempt_generation_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
COMMIT;
