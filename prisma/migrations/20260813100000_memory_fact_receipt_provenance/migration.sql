-- Automatic fact receipts freeze their exact supporting message identity.
-- Unlike history chunks, message evidence has a chat/branch identity but no
-- chunk revision or content hash, so keep that shape distinct and closed.
BEGIN;

ALTER TABLE "MemoryRetrievalAttemptItem"
  DROP CONSTRAINT "MemoryRetrievalAttemptItem_shape_check",
  ADD CONSTRAINT "MemoryRetrievalAttemptItem_shape_check"
    CHECK (
      "ordinal" >= 0
      AND char_length("exactItemId") BETWEEN 1 AND 256
      AND char_length("exactSafeText") BETWEEN 1 AND 4000
      AND (
        (
          "itemType" = 'FACT_VERSION'
          AND "factVersionId" IS NOT NULL
          AND "exactItemId" = "factVersionId"
          AND num_nonnulls("episodeId", "recallChunkId") = 0
          AND (
            num_nonnulls(
              "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
              "sourceRevisionSnapshot", "sourceContentHashSnapshot"
            ) IN (0, 4)
            OR (
              num_nonnulls(
                "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot"
              ) = 2
              AND num_nonnulls(
                "sourceRevisionSnapshot", "sourceContentHashSnapshot"
              ) = 0
            )
          )
        )
        OR (
          "itemType" = 'EPISODE'
          AND "episodeId" IS NOT NULL
          AND "exactItemId" = "episodeId"
          AND num_nonnulls("factVersionId", "recallChunkId") = 0
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
        OR (
          "itemType" = 'RECALL_CHUNK'
          AND "recallChunkId" IS NOT NULL
          AND "exactItemId" = "recallChunkId"
          AND num_nonnulls("factVersionId", "episodeId") = 0
          AND num_nonnulls(
            "sourceChatIdSnapshot", "sourceBranchGenerationSnapshot",
            "sourceRevisionSnapshot", "sourceContentHashSnapshot"
          ) = 4
        )
      )
      AND ("sourceBranchGenerationSnapshot" IS NULL
        OR "sourceBranchGenerationSnapshot" >= 0)
      AND ("sourceRevisionSnapshot" IS NULL OR "sourceRevisionSnapshot" >= 0)
    );

COMMIT;
