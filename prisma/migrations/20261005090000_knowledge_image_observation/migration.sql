-- A Knowledge run reads the current message's images only as one frozen
-- description made before its grounded answer, by the answer model or the
-- System Vision Model. The row is the dispatch fence: it exists before the
-- provider request, so a dispatched description is never sent again. Its usage
-- receipt is a UsageEvent flagged "visionAnalysis".
CREATE TABLE "KnowledgeImageObservation" (
  "modelRunId" TEXT NOT NULL,
  "providerBindingKey" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "images" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'dispatched',
  "result" JSONB,
  "failureCode" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgeImageObservation_pkey" PRIMARY KEY ("modelRunId"),
  CONSTRAINT "KnowledgeImageObservation_modelRunId_fkey" FOREIGN KEY ("modelRunId")
    REFERENCES "ModelRun"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Run deletion cascades through the run and its provider bindings in either order.
  CONSTRAINT "KnowledgeImageObservation_binding_fkey" FOREIGN KEY ("modelRunId", "providerBindingKey")
    REFERENCES "ProviderRunBinding"("modelRunId", "bindingKey") ON DELETE NO ACTION ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "KnowledgeImageObservation_binding_check" CHECK ("providerBindingKey" IN ('answer', 'vision_analysis')),
  CONSTRAINT "KnowledgeImageObservation_state_check" CHECK ("state" IN ('dispatched', 'settled', 'ambiguous')),
  CONSTRAINT "KnowledgeImageObservation_images_check" CHECK (jsonb_typeof("images") = 'array' AND jsonb_array_length("images") BETWEEN 1 AND 8),
  CONSTRAINT "KnowledgeImageObservation_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$')
);

ALTER TABLE "UsageEvent" ADD COLUMN "knowledgeImageObservationRunId" TEXT;
CREATE UNIQUE INDEX "UsageEvent_knowledgeImageObservationRunId_key" ON "UsageEvent"("knowledgeImageObservationRunId");
-- Deferred: run deletion detaches the receipt through two actions (the run and the
-- observation both SET NULL on it); an earlier write to the receipt in the same
-- transaction would otherwise recheck the link between them.
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledgeImageObservationRunId_fkey"
  FOREIGN KEY ("knowledgeImageObservationRunId") REFERENCES "KnowledgeImageObservation"("modelRunId") ON DELETE SET NULL ON UPDATE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
-- The receipt is image analysis accounting, never the run's answer usage that is re-recorded.
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_knowledge_image_observation_link_check"
  CHECK ("knowledgeImageObservationRunId" IS NULL OR "visionAnalysis");
