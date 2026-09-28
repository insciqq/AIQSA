ALTER TABLE "ModelPolicy"
  ALTER COLUMN "maxToolCalls" SET DEFAULT 80,
  ALTER COLUMN "maxToolRounds" SET DEFAULT 32;

-- Adopt each former default once, preserving independently customized limits.
-- Accepted runs keep their frozen budgets in normalizedRequest unchanged.
UPDATE "ModelPolicy"
SET "maxToolCalls" = CASE WHEN "maxToolCalls" = 20 THEN 80 ELSE "maxToolCalls" END,
    "maxToolRounds" = CASE WHEN "maxToolRounds" = 8 THEN 32 ELSE "maxToolRounds" END,
    "version" = "version" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "maxToolCalls" = 20 OR "maxToolRounds" = 8;
