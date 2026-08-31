-- The active generic PostgreSQL fallback matches the versioned Unicode
-- normalized projection directly. Legacy transliterated projection indexes
-- remain available only for rollback/shadow comparison.
CREATE INDEX "MemorySearchEntry_normalizedSearchText_trgm_idx"
  ON "MemorySearchEntry" USING gin ("normalizedSearchText" gin_trgm_ops);
