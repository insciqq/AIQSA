-- Dispatch manifest v2 replaces the legacy planner marker with the focused
-- runtime marker. Existing v1 manifests remain readable for recovery and
-- retention, while all new writes use v2.
ALTER TABLE "KnowledgeEvidenceDispatchManifest"
  DROP CONSTRAINT "KnowledgeEvidenceDispatchManifest_contract_check";

ALTER TABLE "KnowledgeEvidenceDispatchManifest"
  ADD CONSTRAINT "KnowledgeEvidenceDispatchManifest_contract_check" CHECK (
    "version" IN (1, 2)
    AND "totalBytes" >= 0
    AND "totalTokens" >= 0
    AND "itemCount" >= 0
    AND "excludedCount" >= 0
    AND "shortenedCount" BETWEEN 0 AND "itemCount"
    AND (
      (
        "purgedAt" IS NULL
        AND "messageText" IS NOT NULL
        AND "messageHash" ~ '^[0-9a-f]{64}$'
        AND octet_length("messageText") = "totalBytes"
      )
      OR (
        "purgedAt" IS NOT NULL
        AND "messageText" IS NULL
        AND "messageHash" IS NULL
        AND "coverage" IS NULL
        AND cardinality("profileRevisionIds") = 0
      )
    )
  ) NOT VALID;

ALTER TABLE "KnowledgeEvidenceDispatchManifest"
  VALIDATE CONSTRAINT "KnowledgeEvidenceDispatchManifest_contract_check";
