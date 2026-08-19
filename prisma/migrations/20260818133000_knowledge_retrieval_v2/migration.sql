ALTER TABLE "KnowledgeRun"
  DROP CONSTRAINT "KnowledgeRun_limits_check";

ALTER TABLE "KnowledgeRun"
  ADD CONSTRAINT "KnowledgeRun_limits_check" CHECK (
    fusion::text IN ('rrf_k60'::text, 'weighted_rrf_v2'::text)
    AND "invocationOrdinal" >= 1
    AND "invocationOrdinal" <= 3
    AND "candidateLimit" >= 1
    AND "candidateLimit" <= 100
    AND "resultLimit" >= 1
    AND "resultLimit" <= 8
    AND "candidateLimit" >= "resultLimit"
    AND "candidateCount" >= 0
    AND threshold >= 0::double precision
    AND threshold <= 1::double precision
    AND "durationMs" >= 0
  );
