-- Egress receipts record accepted work; they must not preempt the run's own
-- tool/round/deadline policy or prevent its final synthesis. Keep positive Int
-- ordinals and every content, ownership, dispatch and uniqueness constraint.
-- Existing receipts and previous-release writers remain valid.
ALTER TABLE "MemoryToolEgressReceipt"
  DROP CONSTRAINT "MemoryToolEgressReceipt_shape_check",
  ADD CONSTRAINT "MemoryToolEgressReceipt_shape_check" CHECK (
    "requestOrdinal" >= 1
    AND "destinationKind"::text ~ '^[A-Za-z0-9._-]{1,64}$'::text
    AND "destinationFingerprint"::text ~ '^[a-f0-9]{64}$'::text
    AND "requestEvidenceHash"::text ~ '^[a-f0-9]{64}$'::text
    AND ("requestPreviewHash" IS NULL OR "requestPreviewHash"::text ~ '^[a-f0-9]{64}$'::text)
    AND pg_column_size("destinationSnapshot") <= 32768
    AND (jsonb_typeof("destinationSnapshot") = ANY (ARRAY['object'::text, 'array'::text]))
    AND ("errorCode" IS NULL OR "errorCode"::text ~ '^[A-Za-z0-9._-]{1,128}$'::text)
    AND (
      mode = 'PROVIDER_REQUEST'::"MemoryToolEgressMode" AND "modelRunToolCallId" IS NULL
      OR mode = 'TOOL_CALL'::"MemoryToolEgressMode" AND "modelRunToolCallId" IS NOT NULL
    )
    AND (
      "dispatchState" = 'DISPATCHED'::"MemoryToolEgressDispatchState"
        AND "dispatchStartedAt" IS NOT NULL AND "dispatchCompletedAt" IS NULL AND "errorCode" IS NULL
      OR "dispatchState" = 'COMPLETED'::"MemoryToolEgressDispatchState"
        AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2 AND "errorCode" IS NULL
      OR "dispatchState" = 'BLOCKED'::"MemoryToolEgressDispatchState"
        AND "dispatchStartedAt" IS NULL AND "dispatchCompletedAt" IS NOT NULL AND "errorCode" IS NOT NULL
      OR "dispatchState" = 'FAILED'::"MemoryToolEgressDispatchState"
        AND num_nonnulls("dispatchStartedAt", "dispatchCompletedAt") = 2 AND "errorCode" IS NOT NULL
    )
    AND ("dispatchCompletedAt" IS NULL OR "dispatchStartedAt" IS NULL OR "dispatchCompletedAt" >= "dispatchStartedAt")
  );
