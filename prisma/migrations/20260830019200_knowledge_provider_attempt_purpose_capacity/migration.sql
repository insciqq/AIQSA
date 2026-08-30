-- Versioned Draft/Selector operation identifiers are strict allow-listed values,
-- but the V12+ supplement/final variants are 37 characters long. Preserve the
-- allow-list constraints while giving the physical identifier column headroom.
ALTER TABLE "KnowledgeProviderAttempt"
  ALTER COLUMN "purpose" TYPE VARCHAR(64);
