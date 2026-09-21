-- Keep existing optional consumers and their ownership unchanged. Catalog
-- filtering happens before run admission and retains its own dispatch receipt.
ALTER TABLE "OptionalDecisionAttempt"
  DROP CONSTRAINT "OptionalDecisionAttempt_purpose_check",
  ADD CONSTRAINT "OptionalDecisionAttempt_purpose_check" CHECK (
    ("purpose" = 'mcp_discovery' AND "modelRunId" IS NOT NULL)
    OR ("purpose" = 'skill_suggestions' AND "modelRunId" IS NULL)
    OR ("purpose" = 'skill_catalog_relevance' AND "modelRunId" IS NULL)
  );
