CREATE TABLE "WorkspaceOutputCheckpoint" (
  "id" TEXT PRIMARY KEY,
  "modelRunId" TEXT NOT NULL REFERENCES "WorkspaceRunBinding"("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT,
  "toolCallId" TEXT NOT NULL UNIQUE,
  "requestHash" CHAR(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "description" VARCHAR(300) NOT NULL CHECK (length("description") BETWEEN 1 AND 300),
  "selection" JSONB NOT NULL CHECK (jsonb_typeof("selection") = 'array' AND jsonb_array_length("selection") BETWEEN 1 AND 8),
  "arguments" JSONB NOT NULL CHECK (jsonb_typeof("arguments") = 'object'),
  "captureId" CHAR(32) REFERENCES "WorkspaceSelectedCapture"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "state" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceOutputCheckpoint_toolCall_fkey" FOREIGN KEY ("modelRunId", "toolCallId") REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceOutputCheckpoint_state_check" CHECK (
    ("state" = 'PENDING' AND "result" IS NULL AND "settledAt" IS NULL AND "failureCode" IS NULL)
    OR ("state" = 'SETTLED' AND "captureId" IS NOT NULL AND "result" IS NOT NULL AND "settledAt" IS NOT NULL AND "failureCode" IS NULL)
    OR ("state" = 'UNAVAILABLE' AND "settledAt" IS NOT NULL AND "failureCode" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "WorkspaceOutputCheckpoint_id_captureId_key" ON "WorkspaceOutputCheckpoint"("id", "captureId");
CREATE UNIQUE INDEX "WorkspaceOutputCheckpoint_modelRunId_toolCallId_key" ON "WorkspaceOutputCheckpoint"("modelRunId", "toolCallId");
CREATE INDEX "WorkspaceOutputCheckpoint_modelRunId_createdAt_idx" ON "WorkspaceOutputCheckpoint"("modelRunId", "createdAt");
CREATE INDEX "WorkspaceOutputCheckpoint_state_updatedAt_idx" ON "WorkspaceOutputCheckpoint"("state", "updatedAt");
CREATE TABLE "WorkspaceCheckpointFile" (
  "checkpointId" TEXT NOT NULL,
  "captureId" CHAR(32) NOT NULL,
  "relativePath" VARCHAR(512) NOT NULL CHECK ("relativePath" ~ '^(project|output)/.+' AND "relativePath" !~ '(^|/)\.'),
  "attachmentId" TEXT NOT NULL UNIQUE REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  PRIMARY KEY ("checkpointId", "relativePath"),
  FOREIGN KEY ("checkpointId", "captureId") REFERENCES "WorkspaceOutputCheckpoint"("id", "captureId") ON DELETE CASCADE ON UPDATE RESTRICT,
  FOREIGN KEY ("captureId", "relativePath") REFERENCES "WorkspaceCapturedFile"("captureId", "relativePath") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE FUNCTION "workspace_checkpoint_guard"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."id", NEW."modelRunId", NEW."toolCallId", NEW."requestHash", NEW."description", NEW."selection", NEW."arguments", NEW."createdAt") IS DISTINCT FROM
    ROW(OLD."id", OLD."modelRunId", OLD."toolCallId", OLD."requestHash", OLD."description", OLD."selection", OLD."arguments", OLD."createdAt")
    OR (OLD."captureId" IS NOT NULL AND NEW."captureId" IS DISTINCT FROM OLD."captureId")
    OR (OLD."state" <> 'PENDING' AND NEW IS DISTINCT FROM OLD)
  ) THEN RAISE EXCEPTION 'workspace_checkpoint_immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ModelRunToolCall" t WHERE t."id" = NEW."toolCallId" AND t."modelRunId" = NEW."modelRunId" AND t."toolName" = 'checkpoint_outputs') THEN
    RAISE EXCEPTION 'workspace_checkpoint_tool_scope' USING ERRCODE = '23514'; END IF;
  IF NEW."captureId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkspaceSelectedCapture" c JOIN "ModelRun" producer ON producer."id" = c."modelRunId"
    JOIN "ModelRun" consumer ON consumer."id" = NEW."modelRunId" WHERE c."id" = NEW."captureId" AND producer."chatId" = consumer."chatId"
  ) THEN RAISE EXCEPTION 'workspace_checkpoint_capture_scope' USING ERRCODE = '23514'; END IF;
  IF NEW."state" = 'SETTLED' AND (SELECT count(*) FROM "WorkspaceCheckpointFile" f WHERE f."checkpointId" = NEW."id") <> jsonb_array_length(NEW."selection") THEN
    RAISE EXCEPTION 'workspace_checkpoint_incomplete' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceOutputCheckpoint_guard" BEFORE INSERT OR UPDATE ON "WorkspaceOutputCheckpoint" FOR EACH ROW EXECUTE FUNCTION "workspace_checkpoint_guard"();
CREATE FUNCTION "workspace_checkpoint_file_guard"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'workspace_checkpoint_file_immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceOutputCheckpoint" p JOIN "ModelRun" r ON r."id" = p."modelRunId"
    JOIN "Chat" chat ON chat."id" = r."chatId"
    JOIN "WorkspaceCapturedFile" f ON f."captureId" = NEW."captureId" AND f."relativePath" = NEW."relativePath"
    JOIN "Attachment" a ON a."id" = NEW."attachmentId"
    WHERE p."id" = NEW."checkpointId" AND p."captureId" = NEW."captureId" AND p."state" = 'PENDING'
    AND f."storageState" = 'READY' AND a."status" = 'ready' AND a."origin" = 'WORKSPACE_OUTPUT'
    AND a."producerModelRunId" = r."id" AND a."chatId" = r."chatId" AND a."messageId" = r."assistantMessageId"
    AND a."projectId" IS NOT DISTINCT FROM chat."projectId"
    AND (chat."projectId" IS NOT NULL OR a."userId" = r."userId")
    AND ROW(a."storageKey", a."checksum", a."byteSize", a."mimeType") = ROW(f."storageKey", f."checksum", f."byteSize", f."mimeType")
    AND p."selection" @> jsonb_build_array(jsonb_build_object('root', split_part(NEW."relativePath", '/', 1), 'relativePath', substring(NEW."relativePath" from position('/' in NEW."relativePath") + 1)))
  ) THEN RAISE EXCEPTION 'workspace_checkpoint_file_scope' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceCheckpointFile_guard" BEFORE INSERT OR UPDATE ON "WorkspaceCheckpointFile" FOR EACH ROW EXECUTE FUNCTION "workspace_checkpoint_file_guard"();
