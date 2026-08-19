ALTER TABLE "KnowledgeUploadItem"
  DROP CONSTRAINT "KnowledgeUploadItem_state_check";

ALTER TABLE "KnowledgeUploadItem"
  ADD CONSTRAINT "KnowledgeUploadItem_state_check" CHECK (
    (
      "state" IN ('QUEUED', 'UPLOADING', 'STORED')
      AND "storageKey" IS NOT NULL
      AND "sourceId" IS NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NULL
    )
    OR
    (
      "state" = 'NEEDS_ATTENTION'
      AND "sourceId" IS NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NOT NULL
    )
    OR
    (
      "state" = 'PROCESSING'
      AND "storageKey" IS NULL
      AND "sourceId" IS NOT NULL
      AND "sourceVersionId" IS NOT NULL
      AND (("documentId" IS NULL) = ("documentVersionId" IS NULL))
      AND "settledAt" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NULL
    )
    OR
    (
      "state" = 'REUSED'
      AND "storageKey" IS NULL
      AND "sourceId" IS NOT NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "errorCode" IS NULL
    )
    OR
    (
      "state" = 'CANCELLED'
      AND "storageKey" IS NULL
      AND "sourceId" IS NULL
      AND "sourceVersionId" IS NULL
      AND "documentId" IS NULL
      AND "documentVersionId" IS NULL
      AND "settledAt" IS NULL
      AND "cancelledAt" IS NOT NULL
      AND "errorCode" IS NULL
    )
  );
