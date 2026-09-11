ALTER TABLE "User"
  ADD COLUMN "workspaceBrowserSequence" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "workspaceBrowserManualSequence" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "User_workspace_browser_sequence" CHECK (
    "workspaceBrowserSequence" >= "workspaceBrowserManualSequence" AND "workspaceBrowserManualSequence" >= 0
  );
ALTER TABLE "WorkspaceRunBinding"
  ADD COLUMN "browserSessionSequence" BIGINT,
  ADD COLUMN "browserSessionSave" JSONB,
  ADD CONSTRAINT "WorkspaceRunBinding_browser_sequence" CHECK ("browserSessionSequence" IS NULL OR "browserSessionSequence" > 0);
ALTER TABLE "WorkspaceSecret"
  ADD COLUMN "browserFileName" VARCHAR(255),
  ADD COLUMN "browserWriterSequence" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "WorkspaceSecret_browser_sequence" CHECK ("browserWriterSequence" >= 0);
CREATE UNIQUE INDEX "WorkspaceSecret_userId_browserFileName_key" ON "WorkspaceSecret"("userId", "browserFileName");
ALTER TABLE "WorkspaceSecretValue"
  ADD COLUMN "autoSaved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "checksum" CHAR(64),
  DROP CONSTRAINT "WorkspaceSecretValue_shape",
  ADD CONSTRAINT "WorkspaceSecretValue_shape" CHECK (
    "kind" IN ('ssh_key', 'env', 'text', 'file', 'browser_session') AND
    "byteSize" > 0 AND "byteSize" <= 786432 AND
    octet_length("payloadEnvelope") <= 1048704 AND "payloadEnvelope" LIKE 'v2.%' AND
    cardinality("envNames") <= 64 AND array_position("envNames", NULL) IS NULL AND
    CASE WHEN "kind" = 'browser_session' THEN
      "byteSize" <= 524288 AND "originalName" IS NOT NULL AND "originalName" LIKE '%.json' AND
      "checksum" IS NOT NULL AND "checksum" ~ '^[0-9a-f]{64}$' AND NOT "sshProtected" AND cardinality("envNames") = 0
    ELSE "checksum" IS NULL AND NOT "autoSaved" END
  );

CREATE FUNCTION "workspace_browser_binding_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."browserSessionSequence" IS DISTINCT FROM OLD."browserSessionSequence" THEN
    RAISE EXCEPTION 'workspace_browser_binding_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceRunBinding_browser_immutable" BEFORE UPDATE ON "WorkspaceRunBinding"
  FOR EACH ROW EXECUTE FUNCTION "workspace_browser_binding_immutable"();

CREATE FUNCTION "workspace_browser_identity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "WorkspaceSecretValue" v WHERE v."id" = NEW."valueId" AND
    CASE WHEN v."kind" = 'browser_session' THEN
      NEW."browserFileName" IS NOT NULL AND NEW."browserFileName" = v."originalName" AND NEW."browserWriterSequence" > 0
    ELSE NEW."browserFileName" IS NULL AND NEW."browserWriterSequence" = 0 END) THEN
    RAISE EXCEPTION 'workspace_browser_identity_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceSecret_browser_identity" BEFORE INSERT OR UPDATE ON "WorkspaceSecret"
  FOR EACH ROW EXECUTE FUNCTION "workspace_browser_identity_guard"();
