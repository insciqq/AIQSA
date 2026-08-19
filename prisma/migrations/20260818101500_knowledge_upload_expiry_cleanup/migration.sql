ALTER TABLE "KnowledgeUploadItem"
  DROP CONSTRAINT "KnowledgeUploadItem_transport_check",
  DROP CONSTRAINT "KnowledgeUploadItem_state_check";

ALTER TABLE "KnowledgeUploadItem"
  ADD CONSTRAINT "KnowledgeUploadItem_transport_check" CHECK (
    ("transport" = 'PROXY' AND "multipartUploadId" IS NULL)
    OR
    ("transport" = 'MULTIPART' AND (
      ("state" IN ('QUEUED', 'UPLOADING', 'STORED')
        AND "multipartUploadId" IS NOT NULL
        AND char_length("multipartUploadId") BETWEEN 1 AND 1024)
      OR
      ("state" = 'NEEDS_ATTENTION' AND (
        ("storageKey" IS NOT NULL
          AND "multipartUploadId" IS NOT NULL
          AND char_length("multipartUploadId") BETWEEN 1 AND 1024)
        OR
        ("storageKey" IS NULL AND "multipartUploadId" IS NULL)
      ))
      OR
      ("state" IN ('PROCESSING', 'CANCELLED', 'REUSED') AND "multipartUploadId" IS NULL)
    ))
  ),
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
      AND "documentId" IS NOT NULL
      AND "documentVersionId" IS NOT NULL
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
