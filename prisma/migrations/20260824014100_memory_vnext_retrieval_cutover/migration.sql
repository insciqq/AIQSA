-- Retire the legacy candidate writer without deleting archaeology. The vNext
-- extraction job is the only active automatic semantic writer after this
-- migration, so unfinished legacy work is terminal and cannot be reclaimed by
-- a mixed-version worker.

UPDATE "MemoryJob"
SET
  "state" = 'TERMINAL_FAILED'::"MemoryJobState",
  "completedAt" = CURRENT_TIMESTAMP,
  "errorCode" = 'memory_job_handler_unavailable',
  "errorMessage" = NULL,
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "nextAttemptAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" IN (
    'CONSOLIDATE_CANDIDATE'::"MemoryJobKind",
    'VERIFY_CANDIDATE'::"MemoryJobKind"
  )
  AND "state" IN (
    'QUEUED'::"MemoryJobState",
    'WAITING_FOR_EGRESS_CONSENT'::"MemoryJobState",
    'CLAIMED'::"MemoryJobState",
    'RETRYABLE_FAILED'::"MemoryJobState"
  );

UPDATE "MemoryCandidateDecision"
SET
  "state" = 'STALE'::"MemoryCandidateDecisionState",
  "resolvedAt" = COALESCE("resolvedAt", CURRENT_TIMESTAMP)
WHERE "state" = 'PENDING_VERIFICATION'::"MemoryCandidateDecisionState";

UPDATE "MemoryCandidate"
SET
  "state" = 'STALE'::"MemoryCandidateState",
  "reasonCode" = 'legacy_runtime_retired',
  "resolvedAt" = COALESCE("resolvedAt", CURRENT_TIMESTAMP)
WHERE "state" IN (
  'PENDING'::"MemoryCandidateState",
  'DEFERRED'::"MemoryCandidateState"
);

-- Retrieval uses pointer/lifecycle time, expiry, and exact vNext evidence as
-- independent hard filters. These partial indexes keep those bounded probes
-- owner-local without embedding any content in the cutover migration.
CREATE INDEX "MemoryFactVersion_retrieval_lifecycle_idx"
  ON "MemoryFactVersion"("userId", "state", "systemTo", "systemFrom", "id")
  WHERE "contentPurgedAt" IS NULL
    AND "state" IN (
      'ACTIVE'::"MemoryFactVersionState",
      'SUPERSEDED'::"MemoryFactVersionState"
    );

CREATE INDEX "MemoryFactVersion_retrieval_expiry_idx"
  ON "MemoryFactVersion"("userId", "expiresAt", "id")
  WHERE "contentPurgedAt" IS NULL AND "expiresAt" IS NOT NULL;

CREATE INDEX "MemoryEvidence_vnext_retrieval_idx"
  ON "MemoryEvidence"("userId", "factVersionId", "createdAt", "id")
  WHERE "evidenceFingerprint" IS NOT NULL
    AND "sourceMessageContentHash" IS NOT NULL
    AND "sourceStartOffset" IS NOT NULL
    AND "sourceEndOffset" IS NOT NULL
    AND "stance" = 'SUPPORTS'::"MemoryEvidenceStance"
    AND "sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
    AND "sourceRole" = 'user';
