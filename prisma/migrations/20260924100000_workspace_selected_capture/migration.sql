CREATE UNIQUE INDEX "WorkspaceRunBinding_modelRunId_workspaceSessionId_key"
ON "WorkspaceRunBinding" ("modelRunId", "workspaceSessionId");

CREATE TABLE "WorkspaceSelectedCapture" (
  "id" CHAR(32) PRIMARY KEY,
  "modelRunId" TEXT NOT NULL,
  "workspaceSessionId" TEXT NOT NULL,
  "runtimeSandboxId" TEXT NOT NULL,
  "requestKey" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "producerGeneration" INTEGER NOT NULL,
  "producerOwner" VARCHAR(160) NOT NULL,
  "selection" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'CAPTURING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sealedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceSelectedCapture_binding_fkey" FOREIGN KEY ("modelRunId", "workspaceSessionId")
    REFERENCES "WorkspaceRunBinding" ("modelRunId", "workspaceSessionId") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceSelectedCapture_identity_check" CHECK (
    "id" ~ '^[a-f0-9]{32}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND "producerGeneration" > 0
    AND length("runtimeSandboxId") BETWEEN 1 AND 256 AND length("requestKey") > 0
    AND "producerOwner" = 'run:' || "modelRunId"
    AND jsonb_typeof("selection") = 'object'
    AND "selection" ? 'files' AND "selection" ? 'producerOperation'
    AND jsonb_typeof("selection"->'files') = 'array'
    AND jsonb_array_length("selection"->'files') BETWEEN 1 AND 100
    AND "selection"->'producerOperation' = jsonb_build_object('generation', "producerGeneration", 'owner', "producerOwner")
  ),
  CONSTRAINT "WorkspaceSelectedCapture_state_check" CHECK (
    ("state" = 'CAPTURING' AND "sealedAt" IS NULL AND "releasedAt" IS NULL)
    OR ("state" = 'CAPTURED' AND "sealedAt" IS NOT NULL AND "releasedAt" IS NULL)
    OR ("state" = 'RELEASED' AND "releasedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "WorkspaceSelectedCapture_modelRunId_requestKey_key" ON "WorkspaceSelectedCapture" ("modelRunId", "requestKey");
CREATE INDEX "WorkspaceSelectedCapture_workspaceSessionId_state_idx" ON "WorkspaceSelectedCapture" ("workspaceSessionId", "state");

CREATE TABLE "WorkspaceCapturedFile" (
  "id" TEXT PRIMARY KEY,
  "captureId" CHAR(32) NOT NULL,
  "relativePath" VARCHAR(512) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "mimeType" VARCHAR(255) NOT NULL,
  "storageKey" TEXT,
  "storageState" VARCHAR(16) NOT NULL DEFAULT 'NONE',
  "storageToken" VARCHAR(64),
  "storageLeaseExpiresAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceCapturedFile_captureId_fkey" FOREIGN KEY ("captureId")
    REFERENCES "WorkspaceSelectedCapture" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCapturedFile_identity_check" CHECK (
    "byteSize" >= 0 AND "checksum" ~ '^[a-f0-9]{64}$' AND length("mimeType") > 0
    AND "relativePath" ~ '^(inbox|project|output)/.+'
  ),
  CONSTRAINT "WorkspaceCapturedFile_storage_check" CHECK (
    ("storageState" = 'NONE' AND "storageKey" IS NULL AND "storageToken" IS NULL AND "storageLeaseExpiresAt" IS NULL)
    OR ("storageState" = 'STORING' AND "storageKey" IS NOT NULL AND "storageToken" IS NOT NULL AND "storageLeaseExpiresAt" IS NOT NULL)
    OR ("storageState" = 'READY' AND "storageKey" IS NOT NULL AND "storageToken" IS NULL AND "storageLeaseExpiresAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "WorkspaceCapturedFile_captureId_relativePath_key" ON "WorkspaceCapturedFile" ("captureId", "relativePath");
CREATE UNIQUE INDEX "WorkspaceCapturedFile_storageKey_key" ON "WorkspaceCapturedFile" ("storageKey");

CREATE TABLE "WorkspaceCaptureReference" (
  "captureId" CHAR(32) NOT NULL,
  "consumerRunId" TEXT NOT NULL,
  "consumerKey" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "WorkspaceCaptureReference_pkey" PRIMARY KEY ("captureId", "consumerRunId", "consumerKey"),
  CONSTRAINT "WorkspaceCaptureReference_captureId_fkey" FOREIGN KEY ("captureId")
    REFERENCES "WorkspaceSelectedCapture" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCaptureReference_consumerRunId_fkey" FOREIGN KEY ("consumerRunId")
    REFERENCES "ModelRun" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "WorkspaceCaptureReference_key_check" CHECK (length("consumerKey") > 0)
);
CREATE INDEX "WorkspaceCaptureReference_consumerRunId_idx" ON "WorkspaceCaptureReference" ("consumerRunId");

CREATE TABLE "WorkspaceCaptureReadLease" (
  "token" VARCHAR(64) PRIMARY KEY,
  "captureId" CHAR(32) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkspaceCaptureReadLease_captureId_fkey" FOREIGN KEY ("captureId")
    REFERENCES "WorkspaceSelectedCapture" ("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "WorkspaceCaptureReadLease_captureId_expiresAt_idx" ON "WorkspaceCaptureReadLease" ("captureId", "expiresAt");

CREATE FUNCTION "workspace_selected_capture_immutable"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."modelRunId", NEW."workspaceSessionId", NEW."runtimeSandboxId", NEW."requestKey",
      NEW."requestHash", NEW."producerGeneration", NEW."producerOwner", NEW."selection", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."modelRunId", OLD."workspaceSessionId", OLD."runtimeSandboxId", OLD."requestKey",
      OLD."requestHash", OLD."producerGeneration", OLD."producerOwner", OLD."selection", OLD."createdAt")
    OR (OLD."state" = 'RELEASED' AND NEW IS DISTINCT FROM OLD)
    OR (OLD."sealedAt" IS NOT NULL AND NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt")
    OR (OLD."state" = 'CAPTURED' AND NEW."state" NOT IN ('CAPTURED', 'RELEASED')) THEN
    RAISE EXCEPTION 'workspace_capture_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" = 'CAPTURING' AND NEW."state" = 'CAPTURED' AND (
    SELECT count(*) FROM "WorkspaceCapturedFile" WHERE "captureId" = NEW."id"
  ) <> jsonb_array_length(NEW."selection"->'files') THEN
    RAISE EXCEPTION 'workspace_capture_incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceSelectedCapture_immutable" BEFORE UPDATE ON "WorkspaceSelectedCapture"
FOR EACH ROW EXECUTE FUNCTION "workspace_selected_capture_immutable"();

CREATE FUNCTION "workspace_capture_reference_scope"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."captureId", NEW."consumerRunId", NEW."consumerKey", NEW."createdAt") IS DISTINCT FROM
    ROW(OLD."captureId", OLD."consumerRunId", OLD."consumerKey", OLD."createdAt")
    OR (OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt")
  ) THEN
    RAISE EXCEPTION 'workspace_capture_reference_immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "WorkspaceSelectedCapture" capture
    JOIN "ModelRun" producer ON producer."id" = capture."modelRunId"
    JOIN "ModelRun" consumer ON consumer."id" = NEW."consumerRunId" AND consumer."chatId" = producer."chatId"
    WHERE capture."id" = NEW."captureId"
      AND (TG_OP <> 'INSERT' OR capture."state" <> 'RELEASED')
  ) THEN
    RAISE EXCEPTION 'workspace_capture_scope_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceCaptureReference_scope" BEFORE INSERT OR UPDATE ON "WorkspaceCaptureReference"
FOR EACH ROW EXECUTE FUNCTION "workspace_capture_reference_scope"();

CREATE FUNCTION "workspace_captured_file_identity"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "WorkspaceSelectedCapture" capture,
      jsonb_array_elements(capture."selection"->'files') selected
    WHERE capture."id" = NEW."captureId" AND capture."state" = 'CAPTURING'
      AND (selected->>'root') || '/' || (selected->>'relativePath') = NEW."relativePath"
  ) THEN
    RAISE EXCEPTION 'workspace_capture_already_sealed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."id", NEW."captureId", NEW."relativePath", NEW."byteSize", NEW."checksum", NEW."mimeType") IS DISTINCT FROM
    ROW(OLD."id", OLD."captureId", OLD."relativePath", OLD."byteSize", OLD."checksum", OLD."mimeType")
    OR (OLD."storageState" = 'READY' AND NEW IS DISTINCT FROM OLD)
  ) THEN
    RAISE EXCEPTION 'workspace_capture_file_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceCapturedFile_identity" BEFORE INSERT OR UPDATE ON "WorkspaceCapturedFile"
FOR EACH ROW EXECUTE FUNCTION "workspace_captured_file_identity"();

-- Cascades from chat, temporary-chat, Project or account deletion retain cleanup
-- authority even after all private capture metadata has been erased.
CREATE FUNCTION "workspace_captured_file_cleanup"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WorkspaceSelectedCapture" WHERE "id" = OLD."captureId" AND "state" IN ('CAPTURED', 'RELEASED')) THEN
    RAISE EXCEPTION 'workspace_capture_file_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."storageKey" IS NOT NULL THEN
    INSERT INTO "AttachmentDeletionJob" ("id", "storageKey", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, OLD."storageKey", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("storageKey") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "WorkspaceCapturedFile_cleanup" BEFORE DELETE ON "WorkspaceCapturedFile"
FOR EACH ROW EXECUTE FUNCTION "workspace_captured_file_cleanup"();
