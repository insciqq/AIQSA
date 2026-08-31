-- Snapshot V19 reserves the complete two-call semantic correction after one
-- structural repair on the five-call Scope-closure path. Evidence V35 keeps
-- the resulting bounded eight-operation receipt content-free.
ALTER TABLE "KnowledgeGroundingResult"
  DROP CONSTRAINT "KnowledgeGroundingResult_evidence_version_check";

ALTER TABLE "KnowledgeGroundingResult"
  ADD CONSTRAINT "KnowledgeGroundingResult_evidence_version_check" CHECK (
    "version" = 5 AND "evidence" IS NULL
    OR "version" IN (7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35)
      AND "evidence" IS NOT NULL
      AND jsonb_typeof("evidence") = 'object'
      AND pg_column_size("evidence") <= 65536
      AND ("evidence" ->> 'version')::integer = "version"
    OR "version" = 13 AND (
      "evidence" IS NULL
      OR jsonb_typeof("evidence") = 'object'
        AND pg_column_size("evidence") <= 65536
        AND ("evidence" ->> 'version')::integer = 13
    )
  );
