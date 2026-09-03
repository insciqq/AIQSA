-- Ordinary Knowledge receipts retain at least one authorized Base evidence
-- entry. A classified search outage is deliberately content-free and is the
-- sole outcome allowed to persist an empty Base evidence array.
ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_evidence_shape_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_evidence_shape_check" CHECK (
    jsonb_typeof("baseEvidence") = 'array'
    AND jsonb_array_length("baseEvidence") <= 128
    AND (
      jsonb_array_length("baseEvidence") >= 1
      OR outcome::text = 'search_unavailable'
    )
    AND jsonb_typeof(results) = 'array'
    AND jsonb_array_length(results) <= 100
    AND jsonb_typeof("embeddingUsage") = 'array'
    AND jsonb_array_length("embeddingUsage") <= 128
    AND octet_length("providerText") BETWEEN 1 AND 49152
  ) NOT VALID;

ALTER TABLE "KnowledgeRun"
  VALIDATE CONSTRAINT "KnowledgeRun_evidence_shape_check";
