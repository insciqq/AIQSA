ALTER TABLE "MemoryCandidateDecision"
  DROP CONSTRAINT "MemoryCandidateDecision_shape_check";

ALTER TABLE "MemoryCandidateDecision"
  ADD CONSTRAINT "MemoryCandidateDecision_shape_check" CHECK (
    "id" ~ '^[a-f0-9]{64}$'::text
    AND "relatedSnapshotHash"::text ~ '^[a-f0-9]{64}$'::text
    AND "consolidationInputHash"::text ~ '^[a-f0-9]{64}$'::text
    AND "consolidationOutputHash"::text ~ '^[a-f0-9]{64}$'::text
    AND (
      "verificationInputHash" IS NULL
      OR "verificationInputHash"::text ~ '^[a-f0-9]{64}$'::text
    )
    AND (
      "verificationOutputHash" IS NULL
      OR "verificationOutputHash"::text ~ '^[a-f0-9]{64}$'::text
    )
    AND "reasonCode"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text
    AND (
      (
        "operation" = ANY (
          ARRAY[
            'ADD'::"MemoryConsolidationOperation",
            'DEFER'::"MemoryConsolidationOperation"
          ]
        )
        AND num_nonnulls("targetFactId", "targetVersionId") = 0
      )
      OR (
        "operation" = 'NOOP'::"MemoryConsolidationOperation"
        AND num_nonnulls("targetFactId", "targetVersionId") = ANY (ARRAY[0, 2])
      )
      OR (
        "operation" = ANY (
          ARRAY[
            'REINFORCE'::"MemoryConsolidationOperation",
            'SUPERSEDE'::"MemoryConsolidationOperation",
            'CONFLICT'::"MemoryConsolidationOperation",
            'EXPIRE'::"MemoryConsolidationOperation"
          ]
        )
        AND num_nonnulls("targetFactId", "targetVersionId") = 2
      )
    )
    AND (
      "operation" = 'SUPERSEDE'::"MemoryConsolidationOperation"
      OR "effectiveFrom" IS NULL
    )
    AND "requiresVerification" = (
      num_nonnulls("verificationJobId", "verificationInputHash") = 2
    )
    AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = ANY (
      ARRAY[0, 2]
    )
    AND (
      (
        "state" = 'PENDING_VERIFICATION'::"MemoryCandidateDecisionState"
        AND "requiresVerification"
        AND "resolvedAt" IS NULL
        AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 0
      )
      OR (
        "state" = 'APPLIED'::"MemoryCandidateDecisionState"
        AND "resolvedAt" IS NOT NULL
        AND (
          (
            NOT "requiresVerification"
            AND num_nonnulls(
              "verificationJobId",
              "verificationInputHash",
              "verificationExecutionId",
              "verificationOutputHash"
            ) = 0
          )
          OR (
            "requiresVerification"
            AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 2
          )
        )
      )
      OR (
        "state" = 'REJECTED'::"MemoryCandidateDecisionState"
        AND "requiresVerification"
        AND "resolvedAt" IS NOT NULL
        AND num_nonnulls("verificationExecutionId", "verificationOutputHash") = 2
      )
      OR (
        "state" = 'STALE'::"MemoryCandidateDecisionState"
        AND "resolvedAt" IS NOT NULL
      )
    )
  );
