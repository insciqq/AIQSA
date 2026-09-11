CREATE TABLE "WorkspaceSecretValue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "payloadEnvelope" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "envNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "originalName" VARCHAR(255),
    "sshProtected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceSecretValue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceSecretValue_shape" CHECK (
      "kind" IN ('ssh_key', 'env', 'text', 'file') AND
      "byteSize" > 0 AND "byteSize" <= 786432 AND
      octet_length("payloadEnvelope") <= 1048704 AND
      "payloadEnvelope" LIKE 'v2.%' AND
      cardinality("envNames") <= 64 AND array_position("envNames", NULL) IS NULL
    )
);

CREATE TABLE "WorkspaceSecret" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkspaceSecret_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceRunSecret" (
    "modelRunId" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,
    CONSTRAINT "WorkspaceRunSecret_pkey" PRIMARY KEY ("modelRunId", "secretId")
);

CREATE UNIQUE INDEX "WorkspaceSecret_valueId_key" ON "WorkspaceSecret"("valueId");
CREATE INDEX "WorkspaceSecret_userId_createdAt_idx" ON "WorkspaceSecret"("userId", "createdAt");
CREATE INDEX "WorkspaceSecretValue_userId_secretId_idx" ON "WorkspaceSecretValue"("userId", "secretId");
CREATE INDEX "WorkspaceRunSecret_valueId_idx" ON "WorkspaceRunSecret"("valueId");

ALTER TABLE "WorkspaceSecretValue" ADD CONSTRAINT "WorkspaceSecretValue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "WorkspaceSecret" ADD CONSTRAINT "WorkspaceSecret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "WorkspaceSecret" ADD CONSTRAINT "WorkspaceSecret_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "WorkspaceSecretValue"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "WorkspaceRunSecret" ADD CONSTRAINT "WorkspaceRunSecret_modelRunId_fkey" FOREIGN KEY ("modelRunId") REFERENCES "WorkspaceRunBinding"("modelRunId") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "WorkspaceRunSecret" ADD CONSTRAINT "WorkspaceRunSecret_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "WorkspaceSecretValue"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "workspace_secret_value_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workspace_secret_value_immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "WorkspaceSecretValue_immutable" BEFORE UPDATE ON "WorkspaceSecretValue"
  FOR EACH ROW EXECUTE FUNCTION "workspace_secret_value_immutable"();

CREATE FUNCTION "workspace_secret_identity_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'WorkspaceSecret' THEN
    IF NOT EXISTS (SELECT 1 FROM "WorkspaceSecretValue" v
      WHERE v."id" = NEW."valueId" AND v."secretId" = NEW."id" AND v."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'workspace_secret_identity_invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "WorkspaceSecretValue" v
      JOIN "ModelRun" r ON r."id" = NEW."modelRunId"
      JOIN "Chat" c ON c."id" = r."chatId"
      WHERE v."id" = NEW."valueId" AND v."secretId" = NEW."secretId"
        AND v."userId" = r."userId" AND c."userId" = r."userId" AND c."projectId" IS NULL) THEN
      RAISE EXCEPTION 'workspace_secret_identity_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WorkspaceSecret_identity" BEFORE INSERT OR UPDATE ON "WorkspaceSecret"
  FOR EACH ROW EXECUTE FUNCTION "workspace_secret_identity_guard"();
CREATE TRIGGER "WorkspaceRunSecret_identity" BEFORE INSERT ON "WorkspaceRunSecret"
  FOR EACH ROW EXECUTE FUNCTION "workspace_secret_identity_guard"();
CREATE TRIGGER "WorkspaceRunSecret_immutable" BEFORE UPDATE ON "WorkspaceRunSecret"
  FOR EACH ROW EXECUTE FUNCTION "workspace_secret_value_immutable"();
