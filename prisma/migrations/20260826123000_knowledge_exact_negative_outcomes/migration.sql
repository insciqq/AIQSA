-- Exact/source discovery legitimately return zero candidates when no match is
-- found. Vector and lexical passage searches retain the stronger invariant
-- that zero_above_threshold follows examination of at least one candidate.
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
