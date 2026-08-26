ALTER TYPE "KnowledgeRunOutcome"
  ADD VALUE IF NOT EXISTS 'no_relevant_evidence';

ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_negative_outcome_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_negative_outcome_check" CHECK (
    CASE "outcome"::text
      WHEN 'base_empty' THEN "candidateCount" = 0
      WHEN 'no_relevant_evidence' THEN "candidateCount" = 0
      WHEN 'zero_above_threshold' THEN CASE
        WHEN "operation" IN ('find_exact', 'discover_sources')
          THEN "candidateCount" = 0
        ELSE "candidateCount" > 0
      END
      ELSE true
    END
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_negative_outcome_check";
