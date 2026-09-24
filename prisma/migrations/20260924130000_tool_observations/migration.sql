-- Additive: previous writers keep their existing inline result contract.
CREATE TABLE "ToolObservation" (
  "id" CHAR(32) NOT NULL,
  "modelRunId" TEXT NOT NULL,
  "toolCallId" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "sourceKind" VARCHAR(16) NOT NULL,
  "sourceBinding" JSONB,
  "executionReceipt" JSONB,
  "state" VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  "executionOutcome" VARCHAR(16),
  "reservedBytes" INTEGER NOT NULL,
  "byteSize" INTEGER,
  "checksum" CHAR(64),
  "storageMode" VARCHAR(16),
  "inlineText" TEXT,
  "storageKey" VARCHAR(512),
  "projection" JSONB,
  "sourceTruncated" BOOLEAN NOT NULL DEFAULT false,
  "maskable" BOOLEAN NOT NULL DEFAULT false,
  "leaseToken" CHAR(32),
  "leaseExpiresAt" TIMESTAMP(3),
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ToolObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ToolObservation_modelRunId_fkey" FOREIGN KEY ("modelRunId")
    REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ToolObservation_modelRunId_toolCallId_fkey" FOREIGN KEY ("modelRunId", "toolCallId")
    REFERENCES "ModelRunToolCall"("modelRunId", "id") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "ToolObservation_shape" CHECK (
    "id" ~ '^[a-f0-9]{32}$' AND "formatVersion" = 1
    AND "sourceKind" IN ('mcp', 'workspace', 'search', 'skill', 'knowledge')
    AND ("sourceBinding" IS NULL OR (jsonb_typeof("sourceBinding") = 'object' AND octet_length("sourceBinding"::text) <= 8192))
    AND ("executionReceipt" IS NULL OR ("sourceKind" = 'search' AND jsonb_typeof("executionReceipt") = 'object' AND octet_length("executionReceipt"::text) <= 65536))
    AND "state" IN ('RESERVED', 'STORING', 'READY', 'UNAVAILABLE')
    AND ("executionOutcome" IS NULL OR "executionOutcome" IN ('complete', 'error', 'unknown'))
    AND "reservedBytes" BETWEEN 0 AND 33554432
    AND ("byteSize" IS NULL OR "byteSize" BETWEEN 1 AND 33554432)
    AND ("checksum" IS NULL OR "checksum" ~ '^[a-f0-9]{64}$')
    AND ("storageMode" IS NULL OR "storageMode" IN ('INLINE', 'OBJECT', 'SOURCE'))
    AND ("inlineText" IS NULL OR octet_length("inlineText") <= 8192)
    AND ("projection" IS NULL OR octet_length("projection"::text) <= 32768)
    AND ("storageKey" IS NULL OR "storageKey" LIKE 'tool-observations/v1/%')
    AND ("sourceKind" <> 'skill' OR NOT "maskable")
  ),
  CONSTRAINT "ToolObservation_ready" CHECK (
    "state" <> 'READY' OR (
      "executionOutcome" IS NOT NULL AND "executionOutcome" IN ('complete', 'error')
      AND "byteSize" IS NOT NULL AND "checksum" IS NOT NULL
      AND "storageMode" IS NOT NULL AND "reservedBytes" = "byteSize"
      AND (
        ("storageMode" = 'INLINE' AND "inlineText" IS NOT NULL AND "storageKey" IS NULL
          AND octet_length("inlineText") = "byteSize")
        OR ("storageMode" = 'OBJECT' AND "storageKey" IS NOT NULL AND "inlineText" IS NULL)
        OR ("storageMode" = 'SOURCE' AND "storageKey" IS NULL AND "inlineText" IS NULL
          AND "sourceKind" IN ('skill', 'knowledge'))
      )
    )
  ),
  CONSTRAINT "ToolObservation_storing" CHECK (
    "state" <> 'STORING' OR (
      "executionOutcome" IS NOT NULL AND "executionOutcome" IN ('complete', 'error')
      AND "byteSize" IS NOT NULL AND "checksum" IS NOT NULL
      AND "storageMode" IS NOT NULL AND "storageMode" = 'OBJECT' AND "storageKey" IS NOT NULL
      AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX "ToolObservation_toolCallId_key" ON "ToolObservation"("toolCallId");
CREATE UNIQUE INDEX "ToolObservation_modelRunId_toolCallId_key" ON "ToolObservation"("modelRunId", "toolCallId");
CREATE UNIQUE INDEX "ToolObservation_storageKey_key" ON "ToolObservation"("storageKey");
CREATE INDEX "ToolObservation_modelRunId_createdAt_idx" ON "ToolObservation"("modelRunId", "createdAt");
CREATE INDEX "ToolObservation_state_leaseExpiresAt_idx" ON "ToolObservation"("state", "leaseExpiresAt");

CREATE FUNCTION "guard_tool_observation_immutability"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."id", NEW."modelRunId", NEW."toolCallId", NEW."formatVersion", NEW."sourceKind", NEW."sourceBinding")
    IS DISTINCT FROM ROW(OLD."id", OLD."modelRunId", OLD."toolCallId", OLD."formatVersion", OLD."sourceKind", OLD."sourceBinding") THEN
    RAISE EXCEPTION 'tool_observation_identity_immutable';
  END IF;
  IF OLD."executionOutcome" IN ('complete', 'error') AND NEW."executionOutcome" IS DISTINCT FROM OLD."executionOutcome" THEN
    RAISE EXCEPTION 'tool_observation_outcome_immutable';
  END IF;
  IF OLD."executionReceipt" IS NOT NULL AND NEW."executionReceipt" IS DISTINCT FROM OLD."executionReceipt" THEN
    RAISE EXCEPTION 'tool_observation_execution_receipt_immutable';
  END IF;
  IF (OLD."state" = 'UNAVAILABLE' AND NEW."state" <> 'UNAVAILABLE')
    OR (OLD."state" = 'STORING' AND NEW."state" = 'RESERVED') THEN
    RAISE EXCEPTION 'tool_observation_terminal';
  END IF;
  IF OLD."storageKey" IS NOT NULL AND ROW(NEW."storageKey", NEW."byteSize", NEW."checksum")
    IS DISTINCT FROM ROW(OLD."storageKey", OLD."byteSize", OLD."checksum") THEN
    RAISE EXCEPTION 'tool_observation_object_immutable';
  END IF;
  IF OLD."state" = 'READY' AND ROW(NEW."state", NEW."executionOutcome", NEW."reservedBytes", NEW."byteSize",
    NEW."checksum", NEW."storageMode", NEW."inlineText", NEW."storageKey", NEW."projection", NEW."sourceTruncated", NEW."maskable")
    IS DISTINCT FROM ROW(OLD."state", OLD."executionOutcome", OLD."reservedBytes", OLD."byteSize",
    OLD."checksum", OLD."storageMode", OLD."inlineText", OLD."storageKey", OLD."projection", OLD."sourceTruncated", OLD."maskable") THEN
    RAISE EXCEPTION 'tool_observation_original_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ToolObservation_immutable" BEFORE UPDATE ON "ToolObservation"
FOR EACH ROW EXECUTE FUNCTION "guard_tool_observation_immutability"();
