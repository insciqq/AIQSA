ALTER TABLE "UserSettings" ALTER COLUMN "defaultSearchStrategyId" SET DEFAULT 'search-auto';

UPDATE "UserSettings"
SET "defaultSearchStrategyId" = 'search-auto'
WHERE "defaultSearchStrategyId" = 'search-disabled';
