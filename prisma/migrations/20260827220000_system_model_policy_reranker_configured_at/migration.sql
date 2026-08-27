-- Track whether an administrator ever explicitly saved or cleared the
-- installation reranker role. NULL permits one-time fresh-install default
-- adoption; automatic adoption never sets this column.
ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "rerankerConfiguredAt" TIMESTAMP(3);
