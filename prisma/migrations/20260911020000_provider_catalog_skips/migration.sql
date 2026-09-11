ALTER TABLE "ProviderConnection"
  ADD COLUMN "catalogSkippedIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "ProviderConnection"
  ADD CONSTRAINT "ProviderConnection_catalog_skips_bound"
  CHECK (cardinality("catalogSkippedIds") <= 256 AND array_position("catalogSkippedIds", NULL) IS NULL);
