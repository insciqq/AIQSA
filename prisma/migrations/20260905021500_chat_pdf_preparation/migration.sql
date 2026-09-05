-- AlterTable
ALTER TABLE "SystemModelPolicy" ADD COLUMN     "chatPdfPreparationAllowed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN     "chatPdfPageAttemptId" TEXT;

-- CreateTable
CREATE TABLE "ChatPdfRunPreparation" (
    "modelRunId" TEXT NOT NULL,
    "admissionKey" CHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "admissionResult" JSONB,
    "state" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastWorkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorCode" VARCHAR(64),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPdfRunPreparation_pkey" PRIMARY KEY ("modelRunId")
);

-- CreateTable
CREATE TABLE "ChatPdfAttachmentPreparation" (
    "id" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "route" VARCHAR(32) NOT NULL,
    "sourceChecksum" CHAR(64) NOT NULL,
    "sourceByteSize" INTEGER NOT NULL,
    "providerModelId" TEXT,
    "credentialVersionId" TEXT,
    "bindingSnapshot" JSONB,
    "bindingAuthority" JSONB,
    "policyVersion" INTEGER,
    "compatibilityKey" CHAR(64) NOT NULL,
    "state" VARCHAR(24) NOT NULL DEFAULT 'checking',
    "pageCount" INTEGER,
    "completedPages" INTEGER NOT NULL DEFAULT 0,
    "workPlan" JSONB,
    "localArtifactId" TEXT,
    "documentArtifactId" TEXT,
    "errorCode" VARCHAR(64),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPdfAttachmentPreparation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPdfArtifact" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "preparationGeneration" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "route" VARCHAR(32) NOT NULL,
    "sourceChecksum" CHAR(64) NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'reserved',
    "storageKey" TEXT NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPdfArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPdfPageAttempt" (
    "id" TEXT NOT NULL,
    "preparationId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "workKey" CHAR(64) NOT NULL,
    "requestDigest" CHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'reserved',
    "resultArtifactId" TEXT,
    "reusedFromAttemptId" TEXT,
    "usage" JSONB,
    "errorCode" VARCHAR(64),
    "dispatchedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPdfPageAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatPdfRunPreparation_admissionKey_key" ON "ChatPdfRunPreparation"("admissionKey");

-- CreateIndex
CREATE INDEX "ChatPdfRunPreparation_state_lastWorkedAt_modelRunId_idx" ON "ChatPdfRunPreparation"("state", "lastWorkedAt", "modelRunId");

-- CreateIndex
CREATE INDEX "ChatPdfAttachmentPreparation_attachmentId_compatibilityKey__idx" ON "ChatPdfAttachmentPreparation"("attachmentId", "compatibilityKey", "state");

-- CreateIndex
CREATE INDEX "ChatPdfAttachmentPreparation_providerModelId_idx" ON "ChatPdfAttachmentPreparation"("providerModelId");

-- CreateIndex
CREATE INDEX "ChatPdfAttachmentPreparation_credentialVersionId_idx" ON "ChatPdfAttachmentPreparation"("credentialVersionId");

-- CreateIndex
CREATE INDEX "ChatPdfAttachmentPreparation_localArtifactId_idx" ON "ChatPdfAttachmentPreparation"("localArtifactId");

-- CreateIndex
CREATE INDEX "ChatPdfAttachmentPreparation_documentArtifactId_idx" ON "ChatPdfAttachmentPreparation"("documentArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPdfAttachmentPreparation_modelRunId_attachmentId_key" ON "ChatPdfAttachmentPreparation"("modelRunId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPdfArtifact_storageKey_key" ON "ChatPdfArtifact"("storageKey");

-- CreateIndex
CREATE INDEX "ChatPdfArtifact_attachmentId_preparationGeneration_idx" ON "ChatPdfArtifact"("attachmentId", "preparationGeneration");

-- CreateIndex
CREATE INDEX "ChatPdfPageAttempt_workKey_requestDigest_state_idx" ON "ChatPdfPageAttempt"("workKey", "requestDigest", "state");

-- CreateIndex
CREATE INDEX "ChatPdfPageAttempt_resultArtifactId_idx" ON "ChatPdfPageAttempt"("resultArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPdfPageAttempt_preparationId_page_key" ON "ChatPdfPageAttempt"("preparationId", "page");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_chatPdfPageAttemptId_key" ON "UsageEvent"("chatPdfPageAttemptId");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_chatPdfPageAttemptId_fkey" FOREIGN KEY ("chatPdfPageAttemptId") REFERENCES "ChatPdfPageAttempt"("id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfRunPreparation" ADD CONSTRAINT "ChatPdfRunPreparation_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_providerModelId_fkey" FOREIGN KEY ("providerModelId") REFERENCES "ProviderModel"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_credentialVersionId_fkey" FOREIGN KEY ("credentialVersionId") REFERENCES "ProviderCredentialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_localArtifactId_fkey" FOREIGN KEY ("localArtifactId") REFERENCES "ChatPdfArtifact"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_documentArtifactId_fkey" FOREIGN KEY ("documentArtifactId") REFERENCES "ChatPdfArtifact"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "ChatPdfArtifact" ADD CONSTRAINT "ChatPdfArtifact_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfPageAttempt" ADD CONSTRAINT "ChatPdfPageAttempt_preparationId_fkey" FOREIGN KEY ("preparationId") REFERENCES "ChatPdfAttachmentPreparation"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatPdfPageAttempt" ADD CONSTRAINT "ChatPdfPageAttempt_resultArtifactId_fkey" FOREIGN KEY ("resultArtifactId") REFERENCES "ChatPdfArtifact"("id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "ChatPdfRunPreparation" ADD CONSTRAINT "ChatPdfRunPreparation_shape" CHECK (
  "admissionKey" ~ '^[a-f0-9]{64}$' AND
  "state" IN ('pending', 'preparing', 'answer_ready', 'dispatched', 'failed', 'cancelled') AND
  jsonb_typeof("snapshot") = 'object' AND octet_length("snapshot"::text) <= 33554432 AND
  ("admissionResult" IS NULL OR jsonb_typeof("admissionResult") = 'object') AND
  ("claimToken" IS NULL) = ("claimedAt" IS NULL) AND
  (NOT "retryable" OR "state" = 'failed')
);
ALTER TABLE "ChatPdfAttachmentPreparation" ADD CONSTRAINT "ChatPdfAttachmentPreparation_shape" CHECK (
  "route" IN ('direct_pdf', 'system_vision', 'selected_model_vision', 'local_text') AND
  "state" IN ('checking', 'preparing', 'assembling', 'ready', 'failed', 'cancelled') AND
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
ALTER TABLE "ChatPdfArtifact" ADD CONSTRAINT "ChatPdfArtifact_shape" CHECK (
  "kind" IN ('local', 'page', 'document') AND "state" IN ('reserved', 'ready') AND
  "route" IN ('system_vision', 'selected_model_vision', 'local_text') AND
  "sourceChecksum" ~ '^[a-f0-9]{64}$' AND "checksum" ~ '^[a-f0-9]{64}$' AND
  "pageCount" BETWEEN 1 AND 500 AND "byteSize" BETWEEN 1 AND 33554432 AND
  "storageKey" = 'chat-pdf/' || "attachmentId" || '/' || "preparationGeneration" || '/' || "id" || '.json'
);
ALTER TABLE "ChatPdfPageAttempt" ADD CONSTRAINT "ChatPdfPageAttempt_shape" CHECK (
  "page" BETWEEN 1 AND 500 AND "workKey" ~ '^[a-f0-9]{64}$' AND "requestDigest" ~ '^[a-f0-9]{64}$' AND
  "state" IN ('reserved', 'dispatched', 'settled', 'ambiguous') AND
  ("state" NOT IN ('dispatched', 'ambiguous') OR "dispatchedAt" IS NOT NULL) AND
  ("state" <> 'settled' OR "settledAt" IS NOT NULL) AND
  ("resultArtifactId" IS NULL OR "state" = 'settled') AND
  ("usage" IS NULL OR jsonb_typeof("usage") = 'object' AND octet_length("usage"::text) <= 4096)
);

CREATE FUNCTION chat_pdf_preparation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."state" <> OLD."state" AND NOT (
      NEW."state" IN ('failed','cancelled') OR
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
       (OLD."state" IN ('ready','failed','cancelled') AND NEW IS DISTINCT FROM OLD) THEN
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
      AND p."providerModelId" = NEW."providerModelId"
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
  RETURN NEW;
END $$;
CREATE TRIGGER "ChatPdfAttachmentPreparation_guard" BEFORE INSERT OR UPDATE ON "ChatPdfAttachmentPreparation"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_preparation_guard();

CREATE FUNCTION chat_pdf_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR
    OLD."state" = 'ready' AND NEW."state" <> 'ready') THEN
    RAISE EXCEPTION 'chat_pdf_artifact_immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Attachment" a WHERE a."id" = NEW."attachmentId"
    AND a."kind" = 'pdf' AND a."checksum" = NEW."sourceChecksum") THEN
    RAISE EXCEPTION 'chat_pdf_artifact_source_invalid' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "ChatPdfAttachmentPreparation" p
    JOIN "ChatPdfRunPreparation" j ON j."modelRunId" = p."modelRunId"
    JOIN "ModelRun" r ON r."id" = p."modelRunId"
    WHERE p."modelRunId" = NEW."preparationGeneration" AND p."attachmentId" = NEW."attachmentId"
      AND p."route" = NEW."route" AND p."pageCount" = NEW."pageCount"
      AND p."state" IN ('checking','preparing','assembling')
      AND r."status" = 'preparing' AND j."state" IN ('pending','preparing')
      AND j."claimToken" IS NOT NULL) THEN
    RAISE EXCEPTION 'chat_pdf_artifact_generation_inactive' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ChatPdfArtifact_guard" BEFORE INSERT OR UPDATE ON "ChatPdfArtifact"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_artifact_guard();

CREATE FUNCTION chat_pdf_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE p."id" = NEW."preparationId" AND p."route" IN ('system_vision','selected_model_vision')
      AND p."workPlan" IS NOT NULL AND NEW."page" <= p."pageCount"
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."workPlan"->'units') u
        WHERE (u->>'page')::int = NEW."page" AND u->>'key' = NEW."workKey"
          AND u->>'route' = 'vision_required')) THEN
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
CREATE TRIGGER "ChatPdfPageAttempt_guard" BEFORE INSERT OR UPDATE ON "ChatPdfPageAttempt"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_attempt_guard();

-- Cascades from every attachment/account/Project/chat deletion retain object
-- obligations. A write lease covers a bounded put racing with deletion.
CREATE FUNCTION chat_pdf_artifact_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "claimToken", "claimedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, OLD."storageKey", gen_random_uuid()::text,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("storageKey") DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER "ChatPdfArtifact_delete" AFTER DELETE ON "ChatPdfArtifact"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_artifact_delete();

CREATE FUNCTION chat_pdf_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','claimToken','claimedAt','lastWorkedAt','errorCode',
      'retryable','updatedAt','admissionResult','snapshot']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','claimToken','claimedAt','lastWorkedAt','errorCode',
      'retryable','updatedAt','admissionResult','snapshot']) OR
     (OLD."admissionResult" IS NOT NULL AND NEW."admissionResult" IS DISTINCT FROM OLD."admissionResult") OR
     (NEW."snapshot" IS DISTINCT FROM OLD."snapshot" AND
       NOT (NEW."state" IN ('failed','cancelled','dispatched') AND NEW."snapshot" = '{}'::jsonb)) OR
     (OLD."state" IN ('failed','cancelled','dispatched') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'chat_pdf_run_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ChatPdfRunPreparation_guard" BEFORE UPDATE ON "ChatPdfRunPreparation"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_run_guard();

CREATE FUNCTION chat_pdf_answer_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('queued','streaming','in_progress') AND EXISTS (
    SELECT 1 FROM "ChatPdfAttachmentPreparation" p WHERE p."modelRunId" = NEW."id"
      AND p."route" <> 'direct_pdf' AND p."state" <> 'ready'
  ) THEN RAISE EXCEPTION 'chat_pdf_answer_not_ready' USING ERRCODE = '23514'; END IF;
  IF OLD."status" = 'preparing' AND NEW."status" IN ('queued','streaming','in_progress')
    AND EXISTS (SELECT 1 FROM "ChatPdfRunPreparation" WHERE "modelRunId" = NEW."id")
    AND EXISTS (SELECT 1 FROM "Chat" WHERE "id" = NEW."chatId" AND "projectId" IS NULL AND "memoryMode" <> 'TEMPORARY')
    AND NOT EXISTS (SELECT 1 FROM "ModelRunMemoryBinding" WHERE "modelRunId" = NEW."id") THEN
    RAISE EXCEPTION 'chat_pdf_memory_not_ready' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ModelRun_chat_pdf_gate" BEFORE UPDATE OF "status" ON "ModelRun"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_answer_gate();

CREATE FUNCTION chat_pdf_terminal_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'preparing' AND NEW."status" = 'streaming' THEN
    UPDATE "ChatPdfRunPreparation" SET "state" = 'answer_ready', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "modelRunId" = NEW."id" AND "state" IN ('pending','preparing');
  END IF;
  IF NEW."status" IN ('cancelled','error') THEN
    UPDATE "ChatPdfAttachmentPreparation" SET
      "state" = CASE WHEN NEW."status" = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      "errorCode" = CASE WHEN NEW."errorPayload"->>'code' ~ '^pdf_[a-z_]{1,59}$'
        THEN NEW."errorPayload"->>'code' ELSE 'pdf_preparation_failed' END,
      "retryable" = NEW."status" = 'error' AND COALESCE((NEW."errorPayload"->>'retryable')::boolean, true),
      "updatedAt" = CURRENT_TIMESTAMP
      WHERE "modelRunId" = NEW."id" AND "state" IN ('checking','preparing','assembling');
    UPDATE "ChatPdfRunPreparation" SET
      "state" = CASE WHEN NEW."status" = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
      "claimToken" = NULL, "claimedAt" = NULL,
      "errorCode" = CASE WHEN NEW."errorPayload"->>'code' ~ '^pdf_[a-z_]{1,59}$'
        THEN NEW."errorPayload"->>'code' ELSE 'pdf_preparation_failed' END,
      "retryable" = NEW."status" = 'error' AND COALESCE((NEW."errorPayload"->>'retryable')::boolean, true),
      "updatedAt" = CURRENT_TIMESTAMP
      WHERE "modelRunId" = NEW."id" AND "state" IN ('pending','preparing','answer_ready');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ModelRun_chat_pdf_terminal" AFTER UPDATE OF "status" ON "ModelRun"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_terminal_run();

-- Compose the existing deferred Memory invariant with the document gate.
-- No private preparing run may lose its durable continuation, and Memory may
-- begin only after all accepted document artifacts exist.
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
    SELECT count(*), count(*) FILTER (WHERE "state" <> 'ready')
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
CREATE CONSTRAINT TRIGGER "ChatPdfRunPreparation_memory_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatPdfRunPreparation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();
CREATE CONSTRAINT TRIGGER "ChatPdfAttachmentPreparation_memory_gate"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatPdfAttachmentPreparation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aiqsa_memory_run_preparation_trigger();

-- A detached PDF receipt retains its purpose and reported usage after its
-- attachment/attempt is deleted. Unknown token counts remain NULL.
ALTER TABLE "UsageEvent" ADD COLUMN "chatPdfPreparation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UsageEvent"
  DROP CONSTRAINT "UsageEvent_knowledge_shape_check";

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_knowledge_shape_check" CHECK (
    (NOT "chatPdfPreparation" AND "chatPdfPageAttemptId" IS NULL AND (
    (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NOT NULL
      AND "knowledgeIndexGenerationId" IS NOT NULL
      AND "knowledgeDocumentVersionId" IS NOT NULL
      AND "knowledgeBatchIndex" >= 0
      AND "knowledgePdfProcessingAttemptId" IS NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NOT NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    OR (
      "memoryExecutionBindingId" IS NULL
      AND "providerModelId" IS NOT NULL
      AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL
      AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL
      AND "knowledgePdfProcessingAttemptId" IS NOT NULL
      AND "modelRunId" IS NULL
      AND "chatId" IS NULL
    )
    )) OR (
      "chatPdfPreparation" AND "providerModelId" IS NOT NULL
      AND "memoryExecutionBindingId" IS NULL AND "knowledgeBaseId" IS NULL
      AND "knowledgeIndexGenerationId" IS NULL AND "knowledgeDocumentVersionId" IS NULL
      AND "knowledgeBatchIndex" IS NULL AND "knowledgePdfProcessingAttemptId" IS NULL
    )
  );

CREATE FUNCTION chat_pdf_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."chatPdfPreparation" IS DISTINCT FROM OLD."chatPdfPreparation" OR
    OLD."chatPdfPreparation" AND (
      (OLD."inputTokens" IS NOT NULL AND
        ROW(NEW."inputTokens",NEW."cachedInputTokens",NEW."cacheWriteInputTokens",NEW."outputTokens",
          NEW."reasoningTokens",NEW."totalTokens",NEW."estimatedCostMicros") IS DISTINCT FROM
        ROW(OLD."inputTokens",OLD."cachedInputTokens",OLD."cacheWriteInputTokens",OLD."outputTokens",
          OLD."reasoningTokens",OLD."totalTokens",OLD."estimatedCostMicros")) OR
      ROW(NEW."userId",NEW."provider",NEW."modelId",NEW."providerModelId") IS DISTINCT FROM
      ROW(OLD."userId",OLD."provider",OLD."modelId",OLD."providerModelId") OR
      (NEW."chatPdfPageAttemptId" IS NOT NULL AND NEW."chatPdfPageAttemptId" IS DISTINCT FROM OLD."chatPdfPageAttemptId")
    )) THEN RAISE EXCEPTION 'chat_pdf_usage_immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND NEW."chatPdfPreparation" AND NOT EXISTS (
    SELECT 1 FROM "ChatPdfPageAttempt" a
    JOIN "ChatPdfAttachmentPreparation" p ON p."id" = a."preparationId"
    JOIN "ModelRun" r ON r."id" = p."modelRunId"
    WHERE a."id" = NEW."chatPdfPageAttemptId" AND a."state" = 'dispatched'
      AND p."providerModelId" = NEW."providerModelId" AND p."modelRunId" = NEW."modelRunId"
      AND r."userId" = NEW."userId" AND r."chatId" = NEW."chatId"
  ) THEN RAISE EXCEPTION 'chat_pdf_usage_scope_invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "UsageEvent_chat_pdf_guard" BEFORE INSERT OR UPDATE ON "UsageEvent"
  FOR EACH ROW EXECUTE FUNCTION chat_pdf_usage_guard();
