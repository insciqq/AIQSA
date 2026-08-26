ALTER TABLE "MemoryJob"
  DROP CONSTRAINT "MemoryJob_relation_target_shape_check";

ALTER TABLE "MemoryJob"
  ADD CONSTRAINT "MemoryJob_relation_target_shape_check" CHECK (
    (
      "kind" = 'RESOLVE_FACT_RELATIONS'::"MemoryJobKind"
      AND "targetFactVersionId" IS NOT NULL
      AND "sourceMessageId" IS NOT NULL
      AND "chatId" IS NOT NULL
      AND "activeLeafMessageId" IS NOT NULL
      AND "branchGeneration" IS NOT NULL
      AND "sourceRevision" IS NOT NULL
      AND "sourceHash" IS NOT NULL
    )
    OR (
      "kind" = 'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
      AND "sourceMessageId" IS NULL
      AND "chatId" IS NULL
      AND "activeLeafMessageId" IS NULL
      AND "branchGeneration" IS NULL
      AND "sourceRevision" IS NULL
      AND "sourceHash" IS NULL
    )
    OR (
      "kind" NOT IN (
        'RESOLVE_FACT_RELATIONS'::"MemoryJobKind",
        'SYNTHESIZE_MEMORIES'::"MemoryJobKind"
      )
      AND "targetFactVersionId" IS NULL
    )
  );
