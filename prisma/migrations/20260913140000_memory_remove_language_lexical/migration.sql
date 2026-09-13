-- Current writers store only the canonical normalized Unicode text. These
-- unused generated projections can be removed without rewriting source rows
-- or changing the existing simple-vector and raw-Unicode n-gram indexes.
DROP INDEX "MemorySearchEntry_english_gin_idx";
DROP INDEX "MemorySearchEntry_russian_gin_idx";
DROP INDEX "MemorySearchEntry_trigram_gin_idx";

ALTER TABLE "MemorySearchEntry"
  DROP COLUMN "searchVectorEnglish",
  DROP COLUMN "searchVectorRussian",
  DROP COLUMN "trigramSearchText";

DROP FUNCTION aiqsa_memory_transliterate_ru(text);
